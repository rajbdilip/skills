#!/usr/bin/env node

import { access, cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledSkillsDir = join(packageRoot, 'skills');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
const codexHome = () => process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

const agents = {
  'claude-code': {
    label: 'Claude Code',
    aliases: ['claude'],
    projectDir: '.claude/skills',
    globalDir: () => join(claudeHome(), 'skills'),
    detectDirs: () => [claudeHome()],
  },
  codex: {
    label: 'Codex',
    aliases: [],
    projectDir: '.agents/skills',
    globalDir: () => join(codexHome(), 'skills'),
    detectDirs: () => [codexHome()],
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    aliases: ['gemini'],
    projectDir: '.agents/skills',
    globalDir: () => join(homedir(), '.gemini/skills'),
    detectDirs: () => [join(homedir(), '.gemini')],
  },
};

function printHelp() {
  console.log(`Usage: rajbdilip-skills <command> [options]

Commands:
  add                     Install bundled skills (aliases: a, install, i)
  update [skills...]      Update installed skills (alias: upgrade)
  remove [skills...]      Remove installed skills (alias: rm)
  list                    List skills bundled in this npm package (alias: ls)

Options:
  -s, --skill <skills>    Choose skills (space- or comma-separated; '*' for all)
  -a, --agent <agents>    Choose agents (space- or comma-separated; '*' for all)
  -g, --global            Install in user-level agent directories
  -p, --project           Install in the current project (default for add)
  -l, --list              List bundled skills without installing
  -y, --yes               Skip confirmation prompts
      --all               Shorthand for --skill '*' --agent '*' --yes
      --copy              Accepted for skills CLI compatibility (npm installs always copy)
      --force             Also replace or remove symlinked installs
      --dry-run           Show destinations without writing files
      --json              Emit JSON for list output
  -h, --help              Show help
  -v, --version           Show package version

Agents:
  claude-code             Claude Code
  codex                   Codex
  gemini-cli              Gemini CLI

Examples:
  npx rajbdilip-skills add
  npx rajbdilip-skills add --skill workspace-memory --agent codex -g -y
  npx rajbdilip-skills update workspace-memory -g
  npx rajbdilip-skills remove workspace-memory -a claude-code -y
  npx rajbdilip-skills add --all
`);
}

function parseArgs(argv) {
  const options = {
    agents: [],
    skills: [],
    global: false,
    project: false,
    yes: false,
    list: false,
    all: false,
    dryRun: false,
    json: false,
    copy: false,
    force: false,
    help: false,
    version: false,
  };
  const positionals = [];
  const listFlags = new Map([
    ['-a', 'agents'],
    ['--agent', 'agents'],
    ['-s', 'skills'],
    ['--skill', 'skills'],
  ]);
  const booleanFlags = new Map([
    ['-g', 'global'],
    ['--global', 'global'],
    ['-p', 'project'],
    ['--project', 'project'],
    ['-y', 'yes'],
    ['--yes', 'yes'],
    ['-l', 'list'],
    ['--list', 'list'],
    ['--all', 'all'],
    ['--dry-run', 'dryRun'],
    ['--json', 'json'],
    ['-h', 'help'],
    ['--help', 'help'],
    ['-v', 'version'],
    ['--version', 'version'],
    ['--copy', 'copy'],
    ['--force', 'force'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.match(/^(--(?:agent|skill))=(.+)$/);
    if (equals) {
      const key = equals[1] === '--agent' ? 'agents' : 'skills';
      options[key].push(...splitValues(equals[2]));
      continue;
    }
    if (listFlags.has(arg)) {
      const key = listFlags.get(arg);
      let found = false;
      while (index + 1 < argv.length && !argv[index + 1].startsWith('-')) {
        options[key].push(...splitValues(argv[index + 1]));
        index += 1;
        found = true;
      }
      if (!found) throw new Error(`${arg} requires at least one value`);
      continue;
    }
    if (booleanFlags.has(arg)) {
      options[booleanFlags.get(arg)] = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  if (options.global && options.project) throw new Error('Choose either --global or --project, not both');
  if (options.all) {
    options.skills = ['*'];
    options.agents = ['*'];
    options.yes = true;
  }
  return { options, positionals };
}

function splitValues(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readPackage() {
  return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
}

async function discoverSkills() {
  const entries = await readdir(bundledSkillsDir, { withFileTypes: true });
  const discovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(bundledSkillsDir, entry.name, 'SKILL.md');
    if (!(await exists(skillFile))) continue;
    const source = await readFile(skillFile, 'utf8');
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/);
    const unquote = (value) => value?.trim().replace(/^(["'])(.*)\1$/, '$2');
    const name = unquote(frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1]) || entry.name;
    const description = unquote(frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1]) || '';
    discovered.push({ name, directory: entry.name, description });
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

function printSkills(skills, json = false) {
  if (json) {
    console.log(JSON.stringify(skills.map(({ name, description }) => ({ name, description })), null, 2));
    return;
  }
  console.log('Skills bundled in rajbdilip-skills:');
  for (const skill of skills) {
    const description = skill.description.length > 120 ? `${skill.description.slice(0, 117)}...` : skill.description;
    console.log(`  ${skill.name.padEnd(24)} ${description}`);
  }
}

function normalizeAgents(requested) {
  const aliases = new Map();
  for (const [name, config] of Object.entries(agents)) {
    aliases.set(name, name);
    for (const alias of config.aliases) aliases.set(alias, name);
  }
  if (requested.includes('*')) return Object.keys(agents);
  return [...new Set(requested.map((name) => {
    const normalized = aliases.get(name);
    if (!normalized) throw new Error(`Unknown agent '${name}'. Choose: ${Object.keys(agents).join(', ')}`);
    return normalized;
  }))];
}

function selectSkills(requested, available) {
  if (requested.includes('*')) return available;
  const byName = new Map(available.flatMap((skill) => [[skill.name, skill], [skill.directory, skill]]));
  return [...new Set(requested)].map((name) => {
    const skill = byName.get(name);
    if (!skill) throw new Error(`Unknown skill '${name}'. Choose: ${available.map((item) => item.name).join(', ')}`);
    return skill;
  });
}

async function detectedAgents(cwd) {
  const detected = [];
  for (const [name, config] of Object.entries(agents)) {
    const projectRoot = config.projectDir.split('/')[0];
    const candidates = [join(cwd, projectRoot), ...config.detectDirs()];
    if ((await Promise.all(candidates.map(exists))).some(Boolean)) detected.push(name);
  }
  return detected;
}

async function promptSelection(prompt, items, defaults = []) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    items.forEach((item, index) => {
      const marker = defaults.includes(item.value) ? ' (detected)' : '';
      console.log(`  ${index + 1}) ${item.label}${marker}`);
    });
    const fallback = defaults.length ? defaults : items.map((item) => item.value);
    const answer = (await rl.question(`${prompt} [${fallback.join(', ')}]: `)).trim();
    if (!answer) return fallback;
    const selected = splitValues(answer).map((value) => {
      if (/^\d+$/.test(value)) {
        const item = items[Number(value) - 1];
        if (!item) throw new Error(`Invalid selection: ${value}`);
        return item.value;
      }
      return value;
    });
    return selected;
  } finally {
    rl.close();
  }
}

async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// A symlinked install points at a copy managed elsewhere (skills CLI canonical copy, a Git checkout).
// Writing through it would change that source, so symlinks are left alone unless --force.
async function isSymlink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

// Copies into a sibling temp folder, then swaps it in, so files deleted upstream do not linger
// and an interrupted copy never leaves a half-written skill behind.
async function replaceDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.installing-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, filter: (path) => !/(^|[\\/])\.DS_Store$/.test(path) });
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
}

async function partitionSymlinks(operations, force) {
  const writable = [];
  const skipped = [];
  for (const operation of operations) {
    if (!force && (await isSymlink(operation.destination))) skipped.push(operation);
    else writable.push(operation);
  }
  for (const operation of skipped) {
    console.log(`  skipped ${operation.destination}: it is a symlink to a copy managed elsewhere (update that source, or pass --force)`);
  }
  return writable;
}

// Skills that need a one-time machine setup ship scripts/install.mjs; point the user at it.
async function printNextSteps(operations) {
  const seen = new Set();
  for (const operation of operations) {
    if (seen.has(operation.skill.name)) continue;
    seen.add(operation.skill.name);
    const installer = join(operation.destination, 'scripts', 'install.mjs');
    if (await exists(installer)) {
      console.log(`\nNext for ${operation.skill.name}: run its one-time setup (hooks), then read its README:`);
      console.log(`  node "${installer}" --scope global --dry-run`);
      console.log(`  node "${installer}" --scope global`);
      console.log(`  ${join(operation.destination, 'README.md')}`);
    }
  }
}

function destinationFor(agentName, global, cwd) {
  const agent = agents[agentName];
  return global ? agent.globalDir() : join(cwd, agent.projectDir);
}

function buildOperations(selectedSkills, selectedAgents, global, cwd) {
  const operations = new Map();
  for (const agentName of selectedAgents) {
    const base = destinationFor(agentName, global, cwd);
    for (const skill of selectedSkills) {
      const destination = join(base, skill.name);
      const key = `${skill.name}\0${destination}`;
      const existing = operations.get(key);
      if (existing) existing.agentNames.push(agentName);
      else operations.set(key, {
        skill,
        source: join(bundledSkillsDir, skill.directory),
        destination,
        agentNames: [agentName],
      });
    }
  }
  return [...operations.values()];
}

async function chooseForAdd(options, available, cwd) {
  let selectedSkills;
  if (options.skills.length) selectedSkills = selectSkills(options.skills, available);
  else if (available.length === 1 || options.yes) selectedSkills = available;
  else {
    const chosen = await promptSelection('Select skills (numbers or names, comma-separated)', available.map((skill) => ({ value: skill.name, label: skill.name })));
    selectedSkills = selectSkills(chosen, available);
  }

  let selectedAgents;
  if (options.agents.length) selectedAgents = normalizeAgents(options.agents);
  else {
    const detected = await detectedAgents(cwd);
    if (options.yes) {
      if (!detected.length) throw new Error('No agents detected. Pass --agent <name> or --agent "*".');
      selectedAgents = detected;
    } else {
      const chosen = await promptSelection('Select agents (numbers or names, comma-separated)', Object.entries(agents).map(([value, config]) => ({ value, label: `${config.label} (${value})` })), detected);
      selectedAgents = normalizeAgents(chosen);
    }
  }
  return { selectedSkills, selectedAgents };
}

async function runAdd(options, available) {
  if (options.list) {
    printSkills(available, options.json);
    return;
  }
  if (!options.yes && !options.dryRun && !process.stdin.isTTY) {
    throw new Error('Interactive installation requires a terminal. Pass --agent <name> and --yes for non-interactive use.');
  }
  const cwd = process.cwd();
  const { selectedSkills, selectedAgents } = await chooseForAdd(options, available, cwd);
  const operations = buildOperations(selectedSkills, selectedAgents, options.global, cwd);
  console.log(`\n${options.dryRun ? 'Would install' : 'Installing'} ${selectedSkills.map((skill) => skill.name).join(', ')} for ${selectedAgents.join(', ')}:`);
  for (const operation of operations) console.log(`  ${operation.destination} (${operation.agentNames.join(', ')})`);

  if (!options.yes && !options.dryRun && !(await confirm('Continue?'))) {
    console.log('Cancelled.');
    return;
  }
  if (options.dryRun) return;
  const writable = await partitionSymlinks(operations, options.force);
  for (const operation of writable) await replaceDirectory(operation.source, operation.destination);
  console.log(`Installed ${writable.length} skill cop${writable.length === 1 ? 'y' : 'ies'}.`);
  await printNextSteps(writable);
}

async function runUpdate(options, available, positionalSkills) {
  if (!options.yes && !options.dryRun && !process.stdin.isTTY) {
    throw new Error('Interactive update requires a terminal. Pass --yes for non-interactive use.');
  }
  const cwd = process.cwd();
  const requestedSkills = options.skills.length ? options.skills : positionalSkills;
  const selectedSkills = selectSkills(requestedSkills.length ? requestedSkills : ['*'], available);
  const candidateAgents = options.agents.length ? normalizeAgents(options.agents) : Object.keys(agents);
  const operations = buildOperations(selectedSkills, candidateAgents, options.global, cwd);
  const installed = [];
  for (const operation of operations) {
    if (await exists(operation.destination)) installed.push(operation);
  }
  if (!installed.length) {
    throw new Error(`No matching ${options.global ? 'global' : 'project'} installs found. Use 'add' first${options.global ? '' : ' or pass --global'}.`);
  }

  console.log(`\n${options.dryRun ? 'Would update' : 'Updating'} from npm package contents:`);
  for (const operation of installed) console.log(`  ${operation.destination} (${operation.agentNames.join(', ')})`);
  if (!options.yes && !options.dryRun && !(await confirm('Continue?'))) {
    console.log('Cancelled.');
    return;
  }
  if (options.dryRun) return;
  const writable = await partitionSymlinks(installed, options.force);
  for (const operation of writable) await replaceDirectory(operation.source, operation.destination);
  console.log(`Updated ${writable.length} skill cop${writable.length === 1 ? 'y' : 'ies'}.`);
}

async function runRemove(options, available, positionalSkills) {
  if (!options.yes && !options.dryRun && !process.stdin.isTTY) {
    throw new Error('Interactive removal requires a terminal. Pass --yes for non-interactive use.');
  }
  const cwd = process.cwd();
  const requestedSkills = options.skills.length ? options.skills : positionalSkills;
  if (!requestedSkills.length) throw new Error("Name the skills to remove (or --skill '*').");
  const selectedSkills = selectSkills(requestedSkills, available);
  const candidateAgents = options.agents.length ? normalizeAgents(options.agents) : Object.keys(agents);
  const operations = buildOperations(selectedSkills, candidateAgents, options.global, cwd);
  const installed = [];
  for (const operation of operations) {
    if ((await exists(operation.destination)) || (await isSymlink(operation.destination))) installed.push(operation);
  }
  if (!installed.length) {
    throw new Error(`No matching ${options.global ? 'global' : 'project'} installs found${options.global ? '' : ' (pass --global for user-level installs)'}.`);
  }
  console.log(`\n${options.dryRun ? 'Would remove' : 'Removing'}:`);
  for (const operation of installed) console.log(`  ${operation.destination} (${operation.agentNames.join(', ')})`);
  for (const operation of installed) {
    const installer = join(operation.destination, 'scripts', 'install.mjs');
    if (await exists(installer)) {
      console.log(`Note: ${operation.skill.name} may have added hooks. Remove them first with: node "${installer}" --scope global --uninstall`);
      break;
    }
  }
  if (!options.yes && !options.dryRun && !(await confirm('Continue?'))) {
    console.log('Cancelled.');
    return;
  }
  if (options.dryRun) return;
  const removable = await partitionSymlinks(installed, options.force);
  for (const operation of removable) {
    if (await isSymlink(operation.destination)) await rm(operation.destination);
    else await rm(operation.destination, { recursive: true, force: true });
  }
  console.log(`Removed ${removable.length} skill cop${removable.length === 1 ? 'y' : 'ies'}.`);
}

async function main() {
  const raw = process.argv.slice(2);
  const knownCommands = new Set(['add', 'a', 'install', 'i', 'update', 'upgrade', 'remove', 'rm', 'list', 'ls']);
  const command = raw[0] && !raw[0].startsWith('-') && knownCommands.has(raw[0]) ? raw.shift() : 'add';
  const { options, positionals } = parseArgs(raw);
  const packageInfo = await readPackage();
  if (options.version) {
    console.log(packageInfo.version);
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  const available = await discoverSkills();
  if (command === 'list' || command === 'ls') {
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    printSkills(available, options.json);
    return;
  }
  if (command === 'update' || command === 'upgrade') {
    await runUpdate(options, available, positionals);
    return;
  }
  if (command === 'remove' || command === 'rm') {
    await runRemove(options, available, positionals);
    return;
  }
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  await runAdd(options, available);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
