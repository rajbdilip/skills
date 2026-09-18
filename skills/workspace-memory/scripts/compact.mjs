import fs from 'node:fs';
import path from 'node:path';
import { auditWorkspace, formatAudit } from './audit.mjs';
import { commitMemory, formatCommit } from './commit.mjs';
import { rebuildIndexes } from './index.mjs';
import { allMemoryDirs, fail, now, parseArgs, readSection, readText, requireContext, toPosix, UserError } from './lib.mjs';

function sessionDate(name) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasOpenThreads(content) {
  return (readSection(content, 'Open threads')?.bullets.length || 0) > 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = requireContext(args);
  const { root, config } = context;
  const days = Number(args.days || config.archive?.sessionAgeDays || 90);
  if (!Number.isFinite(days) || days < 1) throw new UserError('--days must be a positive number.', 'Example: --days 90');
  const cutoff = now().getTime() - days * 86_400_000;
  const moved = [];
  const kept = [];

  for (const directory of allMemoryDirs(root, config)) {
    const sessions = path.join(directory, 'sessions');
    if (!fs.existsSync(sessions)) continue;
    for (const entry of fs.readdirSync(sessions, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'INDEX.md') continue;
      const date = sessionDate(entry.name);
      if (!date || date.getTime() >= cutoff) continue;
      const source = path.join(sessions, entry.name);
      if (hasOpenThreads(readText(source))) {
        kept.push(toPosix(path.relative(root, source)));
        continue;
      }
      const destination = path.join(directory, 'archive', 'sessions', String(date.getUTCFullYear()), entry.name);
      if (fs.existsSync(destination)) throw new UserError(`Archive already has ${toPosix(path.relative(root, destination))}.`, 'Rename or delete one of the two files, then re-run compact.');
      if (!args['dry-run']) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(source, destination);
      }
      moved.push(toPosix(path.relative(root, destination)));
    }
  }

  const lines = [`${args['dry-run'] ? 'would archive' : 'archived'} ${moved.length} session note(s) older than ${days} days`];
  for (const file of kept) lines.push(`kept ${file}: it lists open threads (close them with "checkpoint --close", or clear its "Open threads" section)`);
  if (!args['dry-run']) {
    rebuildIndexes(root, config);
    const audit = auditWorkspace(root, config);
    lines.push(formatAudit(audit));
    if (!audit.ok) process.exitCode = 1;
    if (args.commit && moved.length) {
      const commit = commitMemory({ root, config, message: `archive ${moved.length} old session note(s)` });
      lines.push(formatCommit(commit));
      if (!commit.ok) process.exitCode = 1;
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch (error) {
  fail(error);
}
