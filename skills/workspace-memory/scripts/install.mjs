// Installs (or removes) the lifecycle hooks for Claude Code, Gemini CLI and Codex.
//   local (default): hooks for one folder only, in <dir>/.claude/settings.local.json and
//            <dir>/.gemini/settings.json, running the installed skill. Machine-specific, so both
//            files are kept out of Git via .git/info/exclude. init.mjs runs this for every workspace
//            and linked repo.
//   global:  hooks in ~/.claude/settings.json and ~/.gemini/settings.json (every folder); skill
//            linked into ~/.claude/skills and ~/.agents/skills (read by both Gemini CLI and Codex).
//   project: the same skill folder copied into <project>/.agents/skills, linked from .claude/skills,
//            hooks in the project's committed .claude/ and .gemini/ settings (portable, for teams).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL_ROOT, UserError, fail, isGitRepository, isMain, parseArgs, runGit, toPosix, values } from './lib.mjs';

const NAME = 'workspace-memory';
const AGENTS = ['claude', 'gemini', 'codex'];
const SCOPES = ['local', 'global', 'project'];

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UserError(`Invalid JSON in ${file}: ${error.message}`, 'Fix that file by hand, then re-run the installer. Nothing was changed.');
  }
}

function writeJson(file, data, dryRun, report) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (before === next) return;
  report.push(`${dryRun ? 'would update' : 'updated'} ${file}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
}

function isOurs(handler) {
  const text = `${handler.command || ''} ${(handler.args || []).join(' ')} ${handler.name || ''}`;
  return text.includes('hook.mjs') && (text.includes(NAME) || text.includes('.workspace-memory/scripts'));
}

// Removes every workspace-memory handler (v1 and v2), dropping groups that become empty.
function stripHooks(settings) {
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((handler) => !isOurs(handler)) }))
      .filter((group) => group.hooks.length);
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function addGroup(settings, event, group) {
  settings.hooks ||= {};
  settings.hooks[event] ||= [];
  settings.hooks[event].push(group);
}

function claudeHooks(settings, script) {
  const handler = (mode, timeout, extra = {}) => ({ type: 'command', command: 'node', args: [script, mode], timeout, ...extra });
  addGroup(settings, 'SessionStart', { matcher: 'startup|resume|clear|compact', hooks: [handler('session-start', 15)] });
  addGroup(settings, 'UserPromptSubmit', { hooks: [handler('prompt', 10)] });
  addGroup(settings, 'Stop', { hooks: [handler('nudge', 15)] });
  addGroup(settings, 'Stop', { hooks: [handler('turn-end', 120, { async: true })] });
  addGroup(settings, 'PreCompact', { hooks: [handler('pre-compact', 60)] });
  addGroup(settings, 'SessionEnd', { hooks: [handler('session-end', 60)] });
}

function geminiHooks(settings, scriptShell) {
  const handler = (mode, timeout) => ({
    type: 'command',
    name: `${NAME}-${mode}`,
    command: `node ${scriptShell} ${mode} --agent gemini`,
    timeout,
    description: 'Load and persist Git-backed workspace memory.',
  });
  addGroup(settings, 'SessionStart', { hooks: [handler('session-start', 15_000)] });
  addGroup(settings, 'BeforeAgent', { hooks: [handler('prompt', 10_000)] });
  addGroup(settings, 'AfterAgent', { hooks: [handler('nudge', 15_000), handler('turn-end', 120_000)] });
  addGroup(settings, 'PreCompress', { hooks: [handler('pre-compact', 60_000)] });
  addGroup(settings, 'SessionEnd', { hooks: [handler('session-end', 60_000)] });
}

function updateSettings(file, apply, dryRun, report) {
  const settings = stripHooks(readJson(file));
  if (apply) apply(settings);
  writeJson(file, settings, dryRun, report);
}

function linkSkill(linkPath, target, dryRun, report, uninstall) {
  let stat = null;
  try { stat = fs.lstatSync(linkPath); } catch {}
  if (uninstall) {
    if (stat?.isSymbolicLink() && fs.existsSync(linkPath) && fs.realpathSync(linkPath) === fs.realpathSync(SKILL_ROOT)) {
      report.push(`${dryRun ? 'would remove' : 'removed'} link ${linkPath}`);
      if (!dryRun) fs.unlinkSync(linkPath);
    }
    return;
  }
  if (stat) {
    if (fs.existsSync(linkPath) && fs.realpathSync(linkPath) === fs.realpathSync(SKILL_ROOT)) return;
    report.push(`warning: ${linkPath} already exists and is not this skill; left untouched. Remove it and re-run to link.`);
    return;
  }
  report.push(`${dryRun ? 'would link' : 'linked'} ${linkPath} -> ${target}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  // Windows: directory junctions need no admin rights or developer mode, but must use absolute targets.
  if (process.platform === 'win32') fs.symlinkSync(path.resolve(path.dirname(linkPath), target), linkPath, 'junction');
  else fs.symlinkSync(target, linkPath, 'dir');
}

function copySkill(destination, dryRun, report) {
  if (fs.existsSync(destination) && fs.realpathSync(destination) === fs.realpathSync(SKILL_ROOT)) return;
  report.push(`${dryRun ? 'would copy' : 'copied'} skill to ${destination}`);
  if (dryRun) return;
  fs.rmSync(destination, { recursive: true, force: true });
  // Development-only files stay behind: the project gets exactly what the skill needs at runtime.
  const skip = new Set(['tests', '.git', '.DS_Store']);
  fs.cpSync(SKILL_ROOT, destination, { recursive: true, filter: (source) => !skip.has(path.basename(source)) || path.dirname(source) !== SKILL_ROOT && path.basename(source) !== '.DS_Store' });
}

function hasHooks(file) {
  return JSON.stringify(readJson(file).hooks || {}).includes(NAME);
}

function isTracked(root, file) {
  return isGitRepository(root) && runGit(root, ['ls-files', '--error-unmatch', '--', file], { allowFailure: true }).status === 0;
}

// Keeps a machine-specific file out of Git without touching the shared .gitignore.
function excludeFromGit(root, file, dryRun, report) {
  if (!isGitRepository(root)) return;
  const exclude = path.resolve(root, runGit(root, ['rev-parse', '--git-path', 'info/exclude']).stdout);
  const entry = `/${runGit(root, ['rev-parse', '--show-prefix']).stdout}${toPosix(path.relative(root, file))}`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes(entry)) return;
  report.push(`${dryRun ? 'would add' : 'added'} ${entry} to ${exclude}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8');
}

function installLocal({ target, agents, dryRun, uninstall, home, report }) {
  const script = toPosix(path.join(SKILL_ROOT, 'scripts', 'hook.mjs'));
  const wiring = [
    ['claude', path.join('.claude', 'settings.local.json'), path.join('.claude', 'settings.json'), (settings) => claudeHooks(settings, script)],
    ['gemini', path.join('.gemini', 'settings.json'), path.join('.gemini', 'settings.json'), (settings) => geminiHooks(settings, JSON.stringify(script))],
  ];
  for (const [agent, relative, globalRelative, apply] of wiring) {
    if (!agents.includes(agent)) continue;
    const file = path.join(target, relative);
    if (uninstall) {
      if (!fs.existsSync(file)) continue;
      const settings = stripHooks(readJson(file));
      if (Object.keys(settings).length) { writeJson(file, settings, dryRun, report); continue; }
      report.push(`${dryRun ? 'would remove' : 'removed'} ${file}`);
      if (dryRun) continue;
      fs.rmSync(file);
      if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file));
      continue;
    }
    if (hasHooks(path.join(home, globalRelative))) {
      report.push(`${agent}: global hooks already cover this folder; nothing added.`);
      continue;
    }
    if (isTracked(target, file)) {
      report.push(`warning: ${file} is committed to Git, so ${agent} hooks were not added (they hold a machine-specific path). fix: node "${toPosix(path.join(SKILL_ROOT, 'scripts', 'install.mjs'))}" --scope global --agents ${agent}`);
      continue;
    }
    updateSettings(file, apply, dryRun, report);
    excludeFromGit(target, file, dryRun, report);
  }
  if (agents.includes('codex') && !uninstall) report.push('codex: no lifecycle hooks; it follows the AGENTS.md block that init.mjs writes into each workspace.');
}

// Used by init.mjs to wire hooks for each new workspace and linked repo. Returns report lines.
export function installHooks({ scope = 'local', target = '.', agents = AGENTS, dryRun = false, uninstall = false } = {}) {
  const home = process.env.WORKSPACE_MEMORY_INSTALL_HOME || os.homedir();
  const report = [];
  const project = path.resolve(String(target));

  // Read every settings file first: a broken one must stop the install before anything changes.
  const base = scope === 'global' ? home : project;
  if (agents.includes('claude')) readJson(path.join(base, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json'));
  if (agents.includes('gemini')) readJson(path.join(base, '.gemini', 'settings.json'));

  if (scope === 'local') {
    installLocal({ target: project, agents, dryRun, uninstall, home, report });
  } else if (scope === 'global') {
    const script = path.join(SKILL_ROOT, 'scripts', 'hook.mjs');
    if (agents.includes('claude')) {
      linkSkill(path.join(home, '.claude', 'skills', NAME), SKILL_ROOT, dryRun, report, uninstall);
      updateSettings(path.join(home, '.claude', 'settings.json'), uninstall ? null : (settings) => claudeHooks(settings, script), dryRun, report);
    }
    if (agents.includes('gemini') || agents.includes('codex')) {
      linkSkill(path.join(home, '.agents', 'skills', NAME), SKILL_ROOT, dryRun, report, uninstall);
    }
    if (agents.includes('gemini')) {
      updateSettings(path.join(home, '.gemini', 'settings.json'), uninstall ? null : (settings) => geminiHooks(settings, JSON.stringify(script)), dryRun, report);
    }
    if (agents.includes('codex') && !uninstall) report.push('codex: no lifecycle hooks; it follows the AGENTS.md block that init.mjs writes into each workspace.');
    if (!uninstall) report.push('note: folders set up earlier with local hooks now run them twice (harmless, but slower). Remove those with --scope local --uninstall --target <dir>.');
  } else {
    const skillDir = path.join(project, '.agents', 'skills', NAME);
    if (uninstall) {
      linkSkill(path.join(project, '.claude', 'skills', NAME), path.join('..', '..', '.agents', 'skills', NAME), dryRun, report, true);
    } else {
      copySkill(skillDir, dryRun, report);
      if (agents.includes('claude')) linkSkill(path.join(project, '.claude', 'skills', NAME), path.join('..', '..', '.agents', 'skills', NAME), dryRun, report, false);
    }
    if (agents.includes('claude')) {
      updateSettings(path.join(project, '.claude', 'settings.json'), uninstall ? null : (settings) => claudeHooks(settings, `\${CLAUDE_PROJECT_DIR}/.agents/skills/${NAME}/scripts/hook.mjs`), dryRun, report);
      if (!uninstall && hasHooks(path.join(home, '.claude', 'settings.json'))) report.push('warning: global workspace-memory hooks are also installed; hooks will run twice (harmless, but slower). Prefer one scope.');
    }
    if (agents.includes('gemini')) {
      updateSettings(path.join(project, '.gemini', 'settings.json'), uninstall ? null : (settings) => geminiHooks(settings, `"$GEMINI_PROJECT_DIR/.agents/skills/${NAME}/scripts/hook.mjs"`), dryRun, report);
    }
    if (uninstall && fs.existsSync(skillDir)) {
      report.push(`${dryRun ? 'would remove' : 'removed'} ${skillDir}`);
      if (!dryRun) fs.rmSync(skillDir, { recursive: true, force: true });
    }
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = values(args, 'scope')[0] || 'local';
  if (!SCOPES.includes(scope)) throw new UserError(`--scope must be one of: ${SCOPES.join(', ')}.`, 'local (default) = this folder only; global = every folder on this machine.');
  const agents = (values(args, 'agents')[0] || AGENTS.join(',')).split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = agents.filter((agent) => !AGENTS.includes(agent));
  if (unknown.length) throw new UserError(`Unknown agent(s): ${unknown.join(', ')}.`, `Use a comma list of: ${AGENTS.join(',')}`);
  const uninstall = Boolean(args.uninstall);
  const dryRun = Boolean(args['dry-run']);
  const report = installHooks({ scope, target: values(args, 'target')[0] || '.', agents, dryRun, uninstall });
  if (!report.length) report.push('already up to date; nothing changed');
  if (!uninstall && !dryRun && scope !== 'local') report.push('next: initialize a workspace with init.mjs --target <dir>, then start a new agent session there.');
  process.stdout.write(`${report.join('\n')}\n`);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error);
  }
}
