import fs from 'node:fs';
import path from 'node:path';
import { auditWorkspace, formatAudit } from './audit.mjs';
import { commitMemory, formatCommit } from './commit.mjs';
import { rebuildIndexes } from './index.mjs';
import { installHooks } from './install.mjs';
import {
  DEFAULT_CONFIG,
  FRAGMENT_ROOT,
  SKILL_ROOT,
  TEMPLATE_ROOT,
  UserError,
  configPath,
  fail,
  findWorkspaceRoot,
  isGitRepository,
  normalizeConfig,
  parseArgs,
  realpath,
  registerHub,
  replaceManagedBlock,
  runGit,
  scriptCommand,
  slugify,
  toPosix,
  values,
} from './lib.mjs';

const MARKERS = ['<!-- workspace-memory:start -->', '<!-- workspace-memory:end -->'];

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function fillFragment(name, replacements = {}) {
  let text = fs.readFileSync(path.join(FRAGMENT_ROOT, name), 'utf8');
  const all = {
    CAPTURE: scriptCommand('capture.mjs'),
    SEARCH: scriptCommand('search.mjs'),
    COMMIT: `${scriptCommand('commit.mjs')} --message "<what changed>"`,
    SKILL: `${scriptCommand('SKILL.md').replace(/^node /, '').replace(/\/scripts\/SKILL\.md$/, '')}/SKILL.md`,
    ...replacements,
  };
  for (const [key, value] of Object.entries(all)) text = text.replaceAll(`{{${key}}}`, value);
  return text;
}

// Collects file writes so --dry-run can report exactly what would change.
class Plan {
  constructor(root, dryRun) {
    this.root = root;
    this.dryRun = dryRun;
    this.changes = [];
  }

  write(relative, content, { onlyIfMissing = false } = {}) {
    const full = path.join(this.root, relative);
    const exists = fs.existsSync(full);
    if (exists && (onlyIfMissing || fs.readFileSync(full, 'utf8') === content)) return;
    this.changes.push({ relative: toPosix(relative), action: exists ? 'update' : 'create' });
    if (this.dryRun) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  managedBlock(relative, fragment) {
    const full = path.join(this.root, relative);
    const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    this.write(relative, replaceManagedBlock(current, MARKERS[0], MARKERS[1], fragment));
  }
}

function copyTemplate(plan, templateDir, targetDir, replacements = {}) {
  for (const source of listFiles(templateDir)) {
    let content = fs.readFileSync(source, 'utf8');
    for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(`{{${key}}}`, value);
    plan.write(path.join(targetDir, path.relative(templateDir, source)), content, { onlyIfMissing: true });
  }
}

function writeConfig(plan, config) {
  plan.write(path.join('.workspace-memory', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function dirtyPaths(root, relatives) {
  if (!isGitRepository(root)) return new Set();
  return new Set(relatives.filter((relative) => runGit(root, ['status', '--porcelain=v1', '--', relative], { allowFailure: true }).stdout));
}

function finish(root, plan, args, message, commitPaths) {
  const lines = [`${plan.dryRun ? 'would change' : 'changed'} ${plan.changes.length} file(s) in ${root}`];
  for (const change of plan.changes) lines.push(`  ${change.action} ${change.relative}`);
  if (plan.dryRun) return lines;
  const config = normalizeConfig(JSON.parse(fs.readFileSync(configPath(root), 'utf8')));
  rebuildIndexes(root, config);
  const audit = auditWorkspace(root, config);
  lines.push(formatAudit(audit));
  if (!audit.ok) {
    process.exitCode = 1;
    return lines;
  }
  registerHub(root);
  if (!args['no-commit'] && isGitRepository(root) && commitPaths.length) {
    lines.push(formatCommit(commitMemory({ root, config, message, paths: commitPaths, bootstrap: true })));
  }
  return lines;
}

function initWorkspace(args) {
  const root = path.resolve(String(values(args, 'target')[0] || '.'));
  const dryRun = Boolean(args['dry-run']);
  if (!fs.existsSync(root)) {
    if (dryRun) throw new UserError(`Target does not exist: ${root}`, 'Create the directory first, or drop --dry-run.');
    fs.mkdirSync(root, { recursive: true });
  }
  if (!fs.statSync(root).isDirectory()) throw new UserError(`Target is not a directory: ${root}`, 'Pass a directory with --target.');
  const parent = findWorkspaceRoot(path.dirname(root));
  if (parent) {
    throw new UserError(`${root} is inside the workspace ${parent}.`, `Use that workspace, or link this folder to it: ${scriptCommand('init.mjs')} --target ${parent} --link ${root}`);
  }
  const scope = values(args, 'scope')[0];
  if (scope && !['workspace', 'memory'].includes(scope)) throw new UserError('--scope must be "workspace" or "memory".', 'workspace = commit every change in the folder; memory = commit only memory/.');
  const push = values(args, 'push')[0];
  if (push && !['auto', 'never'].includes(push)) throw new UserError('--push must be "auto" or "never".', 'Example: --push never');

  const managed = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.workspace-memory/config.json'];
  const dirtyBefore = dirtyPaths(root, managed.filter((relative) => fs.existsSync(path.join(root, relative))));
  const plan = new Plan(root, dryRun);

  const existing = fs.existsSync(configPath(root)) ? JSON.parse(fs.readFileSync(configPath(root), 'utf8')) : null;
  if (!existing) {
    writeConfig(plan, { ...DEFAULT_CONFIG, commit: { ...DEFAULT_CONFIG.commit, ...(scope ? { scope } : {}), ...(push ? { push } : {}) } });
  } else if (args.upgrade || scope || push) {
    const upgraded = normalizeConfig(existing);
    if (scope) upgraded.commit.scope = scope;
    if (push) upgraded.commit.push = push;
    writeConfig(plan, upgraded);
  }
  const memoryRoot = existing ? normalizeConfig(existing).memoryRoot : DEFAULT_CONFIG.memoryRoot;
  copyTemplate(plan, path.join(TEMPLATE_ROOT, 'memory'), memoryRoot);
  plan.managedBlock('AGENTS.md', fillFragment('AGENTS.md'));
  plan.managedBlock('CLAUDE.md', fillFragment('CLAUDE.md'));
  plan.managedBlock('GEMINI.md', fillFragment('GEMINI.md'));

  if (args.upgrade) {
    // v1 vendored scripts and a copied skill into every workspace; v2 runs them from the installed skill.
    for (const legacy of ['.workspace-memory/scripts', '.workspace-memory/tmp', '.agents/skills/workspace-memory', '.claude/skills/workspace-memory']) {
      const full = path.join(root, legacy);
      if (!fs.existsSync(full) || fs.realpathSync(full) === fs.realpathSync(SKILL_ROOT)) continue;
      plan.changes.push({ relative: legacy, action: 'remove (v1 leftover)' });
      if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
    }
  }

  let gitInitialized = false;
  if (!dryRun && !isGitRepository(root) && !args['no-git-init']) {
    runGit(root, ['init', '-q']);
    gitInitialized = true;
  }
  // Hooks go in before the first commit so their machine-specific settings are already excluded from Git.
  const hookLines = args['no-hooks'] ? [] : installHooks({ target: root, dryRun });
  const commitPaths = [...new Set(plan.changes.map((change) => (change.relative.startsWith(`${memoryRoot}/`) ? memoryRoot : change.relative)))]
    .filter((relative) => !dirtyBefore.has(relative));
  const lines = finish(root, plan, args, 'initialize workspace memory', commitPaths);
  if (gitInitialized) lines.splice(1, 0, '  git init (new repository)');
  for (const relative of dirtyBefore) lines.push(`note: ${relative} had uncommitted edits, so it was left for you to commit.`);
  lines.push(...hookLines);
  if (!dryRun && !args['no-hooks']) lines.push('next: start a new agent session in this folder; hooks load memory at session start.');
  return lines;
}

function linkProject(args) {
  const hub = findWorkspaceRoot(path.resolve(String(values(args, 'target')[0] || '.')));
  if (!hub) throw new UserError('Run --link from inside a hub workspace (or pass --target <hub>).', `Initialize one first: ${scriptCommand('init.mjs')} --target <hub-dir>`);
  const repo = realpath(String(values(args, 'link')[0]));
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new UserError(`Repo path does not exist: ${repo}`, 'Pass the path of the code repository.');
  if (repo === realpath(hub)) throw new UserError('A hub cannot link itself.', 'Link a different directory.');
  if (fs.existsSync(configPath(repo))) throw new UserError(`${repo} is itself a workspace.`, 'Link only plain code repositories.');
  const name = slugify(values(args, 'name')[0] || path.basename(repo));
  const config = normalizeConfig(JSON.parse(fs.readFileSync(configPath(hub), 'utf8')));
  const clash = Object.entries(config.projects).find(([other, entry]) => other !== name && realpath(path.resolve(hub, entry.path)) === repo);
  if (clash) throw new UserError(`${repo} is already linked as "${clash[0]}".`, `Use --name ${clash[0]}.`);
  const dryRun = Boolean(args['dry-run']);
  const plan = new Plan(hub, dryRun);
  config.projects[name] = { path: repo };
  writeConfig(plan, config);
  const projectRoot = path.join(config.memoryRoot, 'projects', name);
  copyTemplate(plan, path.join(TEMPLATE_ROOT, 'project'), projectRoot, { name, path: toPosix(repo) });
  const lines = finish(hub, plan, args, `link project ${name}`, ['.workspace-memory/config.json', config.memoryRoot]);
  if (args.pointer) {
    const pointer = new Plan(repo, dryRun);
    pointer.managedBlock('AGENTS.md', fillFragment('POINTER.md', { HUB: toPosix(hub), NAME: name }));
    for (const change of pointer.changes) lines.push(`  ${change.action} ${toPosix(path.join(repo, change.relative))} (pointer block for agents without hooks; commit it yourself if you want it shared)`);
  }
  if (!args['no-hooks']) lines.push(...installHooks({ target: repo, dryRun }));
  lines.push(`linked "${name}" -> ${repo}. Sessions started inside that repo now load memory/projects/${name}/ from this hub.`);
  return lines;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage:
  ${scriptCommand('init.mjs')} --target <dir> [--scope workspace|memory] [--push auto|never] [--dry-run] [--no-commit] [--no-git-init] [--no-hooks] [--upgrade]
  ${scriptCommand('init.mjs')} --target <hub> --link <repo-dir> [--name <name>] [--pointer] [--dry-run] [--no-hooks]

Hooks for Claude Code and Gemini CLI are added for the target folder (and the linked repo) only,
in .claude/settings.local.json and .gemini/settings.json, kept out of Git. Skipped when global
hooks exist. --no-hooks skips them.
`);
    return;
  }
  const lines = values(args, 'link').length ? linkProject(args) : initWorkspace(args);
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch (error) {
  fail(error);
}
