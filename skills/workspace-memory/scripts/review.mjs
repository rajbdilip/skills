// Periodic memory review. The script finds problems deterministically; the agent (or user) decides
// keep / drop / merge for each finding, using the exact commands printed next to it.
//   review.mjs                 list findings
//   review.mjs --done "..."    record that a review happened (stamps memory/INDEX.md)
import fs from 'node:fs';
import path from 'node:path';
import { auditWorkspace } from './audit.mjs';
import {
  allMemoryDirs,
  cleanField,
  fail,
  isMain,
  listMarkdownFiles,
  normalizeText,
  now,
  parseArgs,
  parseFrontmatter,
  readSection,
  readText,
  requireContext,
  scriptCommand,
  toPosix,
  utcDate,
  values,
  writeText,
} from './lib.mjs';

const REVIEW_LINE = /^Last review: .*$/m;
const DAY = 86_400_000;

export function lastReview(root, config) {
  const index = path.join(root, config.memoryRoot, 'INDEX.md');
  if (!fs.existsSync(index)) return null;
  const match = readText(index).match(/^Last review: (\d{4}-\d{2}-\d{2})/m);
  return match ? match[1] : null;
}

function ageDays(date) {
  return Math.floor((now().getTime() - new Date(`${date}T00:00:00Z`).getTime()) / DAY);
}

function datedBullets(content, heading) {
  return (readSection(content, heading)?.bullets || [])
    .map((text) => ({ text, date: text.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] }))
    .filter((item) => item.date);
}

// Meaningful words only: numbers are ignored so "holds 40" vs "holds 42" still pairs up (a likely conflict).
function words(text) {
  return new Set(normalizeText(text).split(' ').filter((word) => word.length > 3 && !/\d/.test(word)));
}

// Jaccard overlap: shared words / all words. Template-like sentences about different subjects stay below the bar.
function similarity(a, b) {
  const left = words(a);
  const right = words(b);
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function bulletDate(text) {
  return text.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] || null;
}

function short(text) {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, '');
  return plain.length > 90 ? `${plain.slice(0, 90)}…` : plain;
}

// Findings the user already saw at the last review (and chose to keep) are "acknowledged": they are listed
// but do not make a new review due, until they reach 3x the stale age.
export function findIssues(root, config) {
  const capture = scriptCommand('capture.mjs');
  const staleDays = Number(config.review?.staleDays || 30);
  const last = lastReview(root, config);
  const lastAge = last ? ageDays(last) : null;
  const seenAtLastReview = (date) => Boolean(last && date && ageDays(date) - lastAge >= staleDays && ageDays(date) < staleDays * 3);
  const issues = [];
  const rel = (file) => toPosix(path.relative(root, file));
  const push = (kind, file, detail, action, acknowledged = false) => issues.push({ kind, file: rel(file), detail, action, acknowledged });

  for (const warning of auditWorkspace(root, config).warnings) issues.push({ kind: 'over budget', file: '', detail: warning.message, action: warning.fix });

  for (const directory of allMemoryDirs(root, config)) {
    const project = path.basename(path.dirname(directory)) === 'projects' ? ` --project ${path.basename(directory)}` : '';
    const current = path.join(directory, 'CURRENT.md');
    if (fs.existsSync(current)) {
      const content = readText(current);
      for (const item of datedBullets(content, 'Status')) {
        if (ageDays(item.date) >= staleDays) push('stale status', current, `"${short(item.text)}" is ${ageDays(item.date)} days old`, `Still true? Keep it, or: ${capture} checkpoint${project} --drop "${short(item.text).slice(0, 40)}" (add --state "..." if it changed)`, seenAtLastReview(item.date));
      }
      const next = readSection(content, 'Next actions')?.bullets || [];
      if (next.length > 8) push('long list', current, `${next.length} next actions`, `Mark finished ones: ${capture} checkpoint${project} --done "..."; remove obsolete ones: --drop "..."`);
    }
    const threads = path.join(directory, 'ACTIVE_THREADS.md');
    if (fs.existsSync(threads)) {
      const content = readText(threads);
      for (const heading of ['Open', 'Blocked', 'Waiting']) {
        for (const item of datedBullets(content, heading)) {
          if (ageDays(item.date) >= staleDays) push('old thread', threads, `${heading}: "${short(item.text)}" open for ${ageDays(item.date)} days`, `Resolved? ${capture} checkpoint${project} --close "${short(item.text).slice(0, 40)} | <resolution>". Otherwise leave it.`, seenAtLastReview(item.date));
        }
      }
    }
    for (const area of ['topics', 'lessons']) {
      const heading = area === 'topics' ? 'Facts' : 'Lessons';
      const notes = listMarkdownFiles(path.join(directory, area)).map((file) => ({ file, bullets: readSection(readText(file), heading)?.bullets || [] }));
      for (const note of notes) {
        if (note.bullets.length > 20) push('large note', note.file, `${note.bullets.length} bullets`, `Summarize: ${capture} checkpoint${project} --${area === 'topics' ? 'fact' : 'lesson'} "<title> | <summary>" (2-5 consolidated bullets), then --drop the ones they replace.`);
      }
      const all = notes.flatMap((note) => note.bullets.map((text) => ({ file: note.file, text })));
      for (let i = 0; i < all.length && i < 1500; i += 1) {
        for (let j = i + 1; j < all.length && j < 1500; j += 1) {
          if (similarity(all[i].text, all[j].text) >= 0.75) {
            const dates = [bulletDate(all[i].text), bulletDate(all[j].text)];
            const both = Boolean(last && dates.every((date) => date && date <= last));
            push('possible duplicate', all[i].file, `"${short(all[i].text)}" vs "${short(all[j].text)}" (${rel(all[j].file)})`, `Same fact? ${capture} checkpoint${project} --drop "${short(all[j].text).slice(0, 40)}". Contradicting? Keep the correct one and --drop the other.`, both);
          }
        }
      }
    }
    const decisions = path.join(directory, 'decisions');
    for (const file of listMarkdownFiles(decisions)) {
      const meta = parseFrontmatter(readText(file));
      if (meta.status === 'proposed' && meta.date && ageDays(meta.date) >= 14) push('undecided', file, `proposed ${ageDays(meta.date)} days ago`, `Decide it: ${capture} checkpoint${project} --decision "title | choice | why" --supersedes ${meta.id}`);
    }
    const sessions = listMarkdownFiles(path.join(directory, 'sessions')).filter((file) => {
      const date = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
      return date && ageDays(date) >= Number(config.archive?.sessionAgeDays || 90);
    });
    if (sessions.length) push('archive', path.join(directory, 'sessions'), `${sessions.length} session note(s) older than ${config.archive?.sessionAgeDays || 90} days`, `${scriptCommand('compact.mjs')}`);
  }

  const profile = path.join(root, config.memoryRoot, 'PROFILE.md');
  if (fs.existsSync(profile)) {
    const bullets = (readSection(readText(profile), 'Preferences')?.bullets || []);
    for (let i = 0; i < bullets.length; i += 1) {
      for (let j = i + 1; j < bullets.length; j += 1) {
        if (similarity(bullets[i], bullets[j]) >= 0.6) push('preference overlap', profile, `"${short(bullets[i])}" vs "${short(bullets[j])}"`, `Keep the newer wording: ${capture} checkpoint --drop "${short(bullets[i]).slice(0, 40)}"`);
      }
    }
  }
  return issues;
}

export function reviewDue(root, config) {
  const last = lastReview(root, config);
  const every = Number(config.review?.everyDays || 14);
  if (last && ageDays(last) < every) return null;
  const issues = findIssues(root, config).filter((issue) => !issue.acknowledged);
  if (!issues.length) return null;
  return { last, count: issues.length };
}

function markDone(root, config, summary) {
  const index = path.join(root, config.memoryRoot, 'INDEX.md');
  const line = `Last review: ${utcDate()} — ${summary}`;
  let content = readText(index);
  content = REVIEW_LINE.test(content) ? content.replace(REVIEW_LINE, line) : content.replace(/^(# .+\n)/, `$1\n${line}\n`);
  writeText(index, content);
  return line;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const context = requireContext(args);
    const { root, config } = context;
    if (args.done) {
      const summary = values(args, 'done')[0] ? cleanField('done', values(args, 'done')[0]) : 'no changes needed';
      process.stdout.write(`${markDone(root, config, summary)}\n`);
    } else {
      const all = findIssues(root, config);
      const issues = all.filter((issue) => !issue.acknowledged);
      const kept = all.filter((issue) => issue.acknowledged);
      const last = lastReview(root, config);
      const lines = [`Memory review: ${issues.length} new finding(s). Last review: ${last || 'never'}.`];
      if (!issues.length) lines.push('Nothing new to fix.');
      issues.forEach((issue, index) => {
        lines.push(`${index + 1}. [${issue.kind}] ${issue.file ? `${issue.file}: ` : ''}${issue.detail}`, `   → ${issue.action}`);
      });
      if (kept.length) {
        lines.push('', `Kept at an earlier review (${kept.length}; no action needed unless something changed):`);
        for (const issue of kept.slice(0, 10)) lines.push(`  - [${issue.kind}] ${issue.detail}`);
        if (kept.length > 10) lines.push(`  - …and ${kept.length - 10} more`);
      }
      lines.push('', 'For each finding decide keep / drop / merge. Ask the user when unsure; never drop a decision or an unresolved thread on your own.');
      lines.push(`When finished: ${scriptCommand('review.mjs')} --done "<one line: what changed>"`);
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } catch (error) {
    fail(error);
  }
}
