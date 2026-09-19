import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.dirname(SCRIPT_ROOT);
export const TEMPLATE_ROOT = path.join(SKILL_ROOT, 'assets', 'templates');
export const FRAGMENT_ROOT = path.join(SKILL_ROOT, 'assets', 'fragments');

// Machine-local state (hub registry, nudge snapshots, locks). Never inside a workspace.
export function stateHome() {
  return process.env.WORKSPACE_MEMORY_HOME || path.join(os.homedir(), '.workspace-memory');
}

// Display form of a script path for instructions and nudges: `~/...` when under $HOME.
export function scriptCommand(name) {
  const full = path.join(SCRIPT_ROOT, name);
  const home = os.homedir();
  if (process.platform === 'win32') return `node "${toPosix(full)}"`;
  const shown = full.startsWith(`${home}${path.sep}`) ? `~/${toPosix(path.relative(home, full))}` : toPosix(full);
  return `node ${shown.includes(' ') ? `"${shown}"` : shown}`;
}

export class UserError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

export function fail(error) {
  process.stderr.write(`error: ${error.message}\n`);
  if (error.fix) process.stderr.write(`fix: ${error.fix}\n`);
  process.exitCode = 1;
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const raw = token.slice(2);
    const separator = raw.indexOf('=');
    const key = separator >= 0 ? raw.slice(0, separator) : raw;
    let value = separator >= 0 ? raw.slice(separator + 1) : true;
    if (separator < 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    }
    if (Object.hasOwn(result, key)) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function values(args, key) {
  if (!Object.hasOwn(args, key)) return [];
  return (Array.isArray(args[key]) ? args[key] : [args[key]])
    .filter((value) => value !== true)
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const DEFAULT_CONFIG = {
  version: 2,
  memoryRoot: 'memory',
  startup: {
    files: ['memory/PROFILE.md', 'memory/CURRENT.md', 'memory/ACTIVE_THREADS.md', 'memory/INDEX.md'],
    charBudgets: {
      'memory/PROFILE.md': 3000,
      'memory/CURRENT.md': 6000,
      'memory/ACTIVE_THREADS.md': 4000,
      'memory/INDEX.md': 3000,
    },
    totalChars: 16000,
  },
  index: { recentSessions: 5, recentDecisions: 5 },
  archive: { sessionAgeDays: 90 },
  commit: { enabled: true, scope: 'workspace', push: 'auto', remote: 'origin', messagePrefix: 'memory', maxFileMB: 10 },
  nudge: { enabled: true, minTurnsBetween: 3, turnsWithoutMemory: 6 },
  review: { everyDays: 14, staleDays: 30 },
  projects: {},
};

function merge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    result[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof base[key] === 'object'
      ? merge(base[key], value)
      : value;
  }
  return result;
}

// Accepts v1 configs (lineBudgets/startupFiles, memory-only commits) and returns a v2 shape.
export function normalizeConfig(raw) {
  const input = { ...raw };
  if (!input.version || input.version < 2) {
    input.startup = { files: input.startupFiles };
    input.commit = { scope: 'memory', ...(input.commit || {}) };
    delete input.startupFiles;
    delete input.lineBudgets;
    input.version = 2;
  }
  const config = merge(DEFAULT_CONFIG, input);
  if (!config.startup.files) config.startup.files = DEFAULT_CONFIG.startup.files;
  const memoryRoot = String(config.memoryRoot || 'memory').replaceAll('\\', '/').replace(/\/+$/, '');
  if (path.isAbsolute(memoryRoot) || memoryRoot.split('/').includes('..')) {
    throw new UserError('memoryRoot must stay inside the workspace.', 'Set "memoryRoot": "memory" in .workspace-memory/config.json.');
  }
  config.memoryRoot = memoryRoot;
  return config;
}

export function configPath(root) {
  return path.join(root, '.workspace-memory', 'config.json');
}

export function loadConfig(root) {
  const file = configPath(root);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UserError(`Cannot read ${file}: ${error.message}`, 'Fix the JSON syntax in that file, or re-run init.mjs.');
  }
  return normalizeConfig(raw);
}

export function findWorkspaceRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(configPath(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readHubs() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateHome(), 'hubs.json'), 'utf8'));
    return Array.isArray(data.hubs) ? data.hubs : [];
  } catch {
    return [];
  }
}

export function registerHub(root) {
  const hubs = readHubs().filter((hub) => fs.existsSync(configPath(hub)));
  const resolved = realpath(root);
  if (!hubs.includes(resolved)) hubs.push(resolved);
  writeText(path.join(stateHome(), 'hubs.json'), JSON.stringify({ hubs }, null, 2));
}

export function realpath(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function isInside(child, parent) {
  const relative = path.relative(realpath(parent), realpath(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Resolves where memory lives for a directory:
//   1. a workspace (hub) containing cwd, or
//   2. a code repo linked to a registered hub (attached mode), or
//   3. null — not a memory workspace; callers must stay silent.
export function resolveContext(cwd = process.cwd(), projectOverride) {
  const root = findWorkspaceRoot(cwd);
  if (root) {
    const config = loadConfig(root);
    let project = null;
    let codeRoot = null;
    for (const [name, entry] of Object.entries(config.projects || {})) {
      if (entry?.path && isInside(cwd, path.resolve(root, entry.path)) && realpath(path.resolve(root, entry.path)) !== realpath(root)) {
        project = name;
        codeRoot = path.resolve(root, entry.path);
      }
    }
    return withProject({ root, config, project, codeRoot, attached: false }, projectOverride);
  }
  for (const hub of readHubs()) {
    if (!fs.existsSync(configPath(hub))) continue;
    let config;
    try { config = loadConfig(hub); } catch { continue; }
    for (const [name, entry] of Object.entries(config.projects || {})) {
      if (!entry?.path) continue;
      const projectPath = path.resolve(hub, entry.path);
      if (isInside(cwd, projectPath)) {
        return withProject({ root: hub, config, project: name, codeRoot: projectPath, attached: true }, projectOverride);
      }
    }
  }
  return null;
}

function withProject(context, projectOverride) {
  if (!projectOverride) return context;
  if (!context.config.projects?.[projectOverride]) {
    const known = Object.keys(context.config.projects || {}).join(', ') || 'none';
    throw new UserError(`Unknown project "${projectOverride}". Linked projects: ${known}.`, `Drop --project, or link it first: ${scriptCommand('init.mjs')} --link <repo-path> --name ${projectOverride}`);
  }
  return { ...context, project: projectOverride };
}

export function requireContext(args = {}) {
  const cwd = args.target ? path.resolve(String(args.target)) : process.cwd();
  const project = values(args, 'project')[0];
  const context = resolveContext(cwd, project);
  if (!context) {
    throw new UserError(`No workspace memory found for ${cwd}.`, `Run from inside the workspace, or initialize it: ${scriptCommand('init.mjs')} --target <workspace-dir>`);
  }
  return context;
}

// Absolute memory directory for the context: hub memory or memory/projects/<name>.
export function memoryDir(context) {
  const base = path.join(context.root, context.config.memoryRoot);
  return context.project ? path.join(base, 'projects', context.project) : base;
}

export function allMemoryDirs(root, config) {
  const base = path.join(root, config.memoryRoot);
  return [base, ...Object.keys(config.projects || {}).map((name) => path.join(base, 'projects', name))];
}

export function runGit(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const output = options.raw ? String(result.stdout || '') : String(result.stdout || '').trim();
  const error = String(result.stderr || '').trim();
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(error || output || `git ${args[0]} failed with exit code ${result.status}`);
  }
  return { status: result.status ?? 1, stdout: output, stderr: error };
}

export function isGitRepository(root) {
  return runGit(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).status === 0;
}

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

// Reads text with Windows line endings normalized, so section parsing behaves the same everywhere.
export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

export function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  if (fs.existsSync(filePath) && readText(filePath) === normalized) return false;
  fs.writeFileSync(filePath, normalized, 'utf8');
  return true;
}

export function replaceManagedBlock(content, startMarker, endMarker, body) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new UserError(`Malformed managed block: ${startMarker}`, `Restore both "${startMarker}" and "${endMarker}" lines, or delete both.`);
  }
  const normalizedBody = body.trimEnd();
  if (start < 0) {
    const prefix = content.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}${normalizedBody}\n`;
  }
  return `${content.slice(0, start)}${normalizedBody}${content.slice(end + endMarker.length)}`;
}

export function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const result = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

export function setFrontmatterField(content, key, value) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return content;
  const lines = content.slice(4, end).split('\n');
  const line = `${key}: ${JSON.stringify(String(value))}`;
  const index = lines.findIndex((item) => item.startsWith(`${key}:`));
  if (index >= 0) lines[index] = line; else lines.push(line);
  return `---\n${lines.join('\n')}${content.slice(end)}`;
}

export function firstHeading(content, fallback) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

export function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'record';
}

// Current time. WORKSPACE_MEMORY_NOW (ISO date) lets tests simulate months of use.
export function now() {
  const override = process.env.WORKSPACE_MEMORY_NOW;
  const date = override ? new Date(override) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function utcDate(date = now()) {
  return date.toISOString().slice(0, 10);
}

export function utcTimestamp(date = now()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function listMarkdownFiles(directory, options = {}) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && options.recursive && !(options.skip || []).includes(fullPath)) files.push(...listMarkdownFiles(fullPath, options));
    if (entry.isFile() && entry.name.endsWith('.md') && (options.includeIndex || entry.name !== 'INDEX.md')) files.push(fullPath);
  }
  return files;
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === importMetaUrl;
}

export function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

export function findSecret(content) {
  return SECRET_PATTERNS.find((pattern) => pattern.test(content)) || null;
}

// ---- Markdown section editing (used by capture/checkpoint) ----

export const NONE_BULLET = '- None.';

export function normalizeText(value) {
  return String(value).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().replace(/\(\d{4}-\d{2}-\d{2}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isDuplicate(candidate, existing) {
  const a = normalizeText(candidate);
  return existing.some((item) => {
    const b = normalizeText(item);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 20 && longer.includes(shorter);
  });
}

// Returns bullet texts (without "- ") of a `## heading` section, and a writer to replace them.
export function readSection(content, heading) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]) && !lines[end].startsWith('<!-- workspace-memory:')) end += 1;
  const body = lines.slice(start + 1, end);
  const bullets = body.filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, '').trim())
    .filter((text) => text !== 'None.' && text !== 'None');
  const prose = body.filter((line) => line.trim() && !/^\s*-\s+/.test(line));
  return { lines, start, end, bullets, prose };
}

export function writeSection(content, heading, bullets) {
  let section = readSection(content, heading);
  if (!section) {
    content = `${content.trimEnd()}\n\n## ${heading}\n\n${NONE_BULLET}\n`;
    section = readSection(content, heading);
  }
  const { lines, start, end, prose } = section;
  const block = ['', ...prose, ...(prose.length ? [''] : []), ...(bullets.length ? bullets.map((item) => `- ${item}`) : [NONE_BULLET]), ''];
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

export function sectionHeadings(content) {
  return content.split('\n').filter((line) => /^##\s/.test(line)).map((line) => line.replace(/^##\s+/, '').trim());
}

const PLACEHOLDER = /^(?:\.{2,}|…|tbd|todo|n\/?a|none|null|undefined|-+|x+|<[^>]*>|\[[^\]]*\]|"?\.\.\."?|placeholder|text|value)$/i;

export function cleanField(name, value, options = {}) {
  const max = options.max ?? 500;
  // Single-value fields never contain "|"; a model copying the "a | b" pattern gets "a: b".
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\s*\\?\|\s*/g, ': ').trim();
  if (!text || PLACEHOLDER.test(text)) {
    throw new UserError(`--${name} is empty or a placeholder ("${text}").`, `Give a concrete sentence, e.g. --${name} "${options.example || 'Chose Postgres for JSONB support'}", or omit --${name}.`);
  }
  if (text.length > max) {
    throw new UserError(`--${name} is ${text.length} characters; the limit is ${max}.`, `Summarize it in one or two sentences. Do not paste transcripts or command output.`);
  }
  if (findSecret(text)) {
    throw new UserError(`--${name} looks like it contains a secret.`, 'Remove the credential; record only where it is stored (e.g. "API key is in 1Password: Vendor X").');
  }
  return text;
}

export function splitParts(name, value, count, example) {
  // Tolerate "\|" copied from Markdown tables.
  const parts = String(value).replaceAll('\\|', '|').split('|').map((part) => part.trim());
  if (parts.length < count || parts.slice(0, count).some((part) => !part)) {
    throw new UserError(`--${name} needs ${count} parts separated by "|" (got "${value}").`, `Example: --${name} "${example}"`);
  }
  if (parts.length > count) parts.splice(count - 1, parts.length, parts.slice(count - 1).join(' | '));
  return parts;
}
