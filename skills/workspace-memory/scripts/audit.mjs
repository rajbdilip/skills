import fs from 'node:fs';
import path from 'node:path';
import {
  allMemoryDirs,
  fail,
  findSecret,
  isMain,
  listMarkdownFiles,
  parseArgs,
  readText,
  requireContext,
  scriptCommand,
  toPosix,
} from './lib.mjs';

const AREAS = ['decisions', 'topics', 'lessons', 'sessions', 'archive'];

function checkLinks(root, filePath, content, errors) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let decoded = raw.split('#')[0];
    try { decoded = decodeURIComponent(decoded); } catch {}
    if (!fs.existsSync(path.resolve(path.dirname(filePath), decoded))) {
      errors.push({
        message: `${toPosix(path.relative(root, filePath))} links to missing ${raw}`,
        fix: `Correct or remove that link, then run ${scriptCommand('index.mjs')}`,
      });
    }
  }
}

export function auditWorkspace(root, config) {
  const errors = [];
  const warnings = [];
  const memoryRoot = path.join(root, config.memoryRoot);
  const initFix = `${scriptCommand('init.mjs')} --target ${root}`;
  if (!fs.existsSync(memoryRoot)) return { ok: false, errors: [{ message: `Missing ${config.memoryRoot}/`, fix: initFix }], warnings };

  const dirs = allMemoryDirs(root, config);
  for (const directory of dirs) {
    const relative = toPosix(path.relative(root, directory));
    const required = ['INDEX.md', 'CURRENT.md', 'ACTIVE_THREADS.md', ...AREAS.map((area) => `${area}/INDEX.md`)];
    if (directory === memoryRoot) required.push('PROFILE.md');
    for (const file of required) {
      if (!fs.existsSync(path.join(directory, file))) errors.push({ message: `Missing ${relative}/${file}`, fix: `Re-run ${initFix} (it only adds missing files).` });
    }
    const index = path.join(directory, 'INDEX.md');
    if (fs.existsSync(index)) {
      const content = readText(index);
      for (const marker of ['recent-decisions', 'recent-sessions']) {
        if (!content.includes(`<!-- workspace-memory:${marker}:start -->`) || !content.includes(`<!-- workspace-memory:${marker}:end -->`)) {
          errors.push({ message: `${relative}/INDEX.md is missing its ${marker} markers`, fix: 'Restore the "<!-- workspace-memory:... -->" marker lines from the template in the skill\'s assets/templates.' });
        }
      }
    }
  }

  // Every markdown file under memory/, each scanned exactly once (INDEX files included).
  for (const filePath of listMarkdownFiles(memoryRoot, { recursive: true, includeIndex: true })) {
    const content = readText(filePath);
    const relative = toPosix(path.relative(root, filePath));
    const secret = findSecret(content);
    if (secret) errors.push({ message: `${relative} may contain a secret (${secret.source.slice(0, 40)}…)`, fix: 'Delete the credential from the file; record only where it is stored.' });
    checkLinks(root, filePath, content, errors);
  }

  const budgets = config.startup?.charBudgets || {};
  for (const [relative, budget] of Object.entries(budgets)) {
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) continue;
    const size = readText(filePath).length;
    if (size > Number(budget)) {
      warnings.push({ message: `${relative} is ${size} characters; startup budget is ${budget} (the rest is cut off at session start).`, fix: `Move detail into topics/ with "checkpoint --fact", remove stale bullets, or run ${scriptCommand('compact.mjs')}` });
    }
  }
  for (const project of Object.keys(config.projects || {})) {
    for (const file of ['CURRENT.md', 'ACTIVE_THREADS.md']) {
      const filePath = path.join(memoryRoot, 'projects', project, file);
      const budget = Number(budgets[`${config.memoryRoot}/${file}`] || 6000);
      if (fs.existsSync(filePath) && readText(filePath).length > budget) {
        warnings.push({ message: `${toPosix(path.relative(root, filePath))} exceeds its ${budget}-character startup budget.`, fix: 'Remove stale bullets or move detail into the project\'s topics/.' });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatAudit(result) {
  const lines = [result.ok ? 'audit: ok' : `audit: ${result.errors.length} error(s)`];
  for (const item of result.errors) lines.push(`error: ${item.message}`, `  fix: ${item.fix}`);
  for (const item of result.warnings) lines.push(`warning: ${item.message}`, `  fix: ${item.fix}`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const context = requireContext(args);
    const result = auditWorkspace(context.root, context.config);
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : formatAudit(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}
