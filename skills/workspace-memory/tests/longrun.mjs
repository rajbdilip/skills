// Long-horizon simulation: ~6 months of daily use with a fake clock, no model involved.
// Measures whether memory stays bounded, searchable, linked and tidy as it grows.
//   node tests/longrun.mjs [--days 180] [--seed 7] [--keep]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const DAYS = Number(arg('days', 180));
let seed = Number(arg('seed', 7));
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (items) => items[Math.floor(rand() * items.length)];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-longrun-'));
const WS = path.join(TMP, 'ws');
const baseEnv = { ...process.env, WORKSPACE_MEMORY_HOME: path.join(TMP, 'state'), GIT_AUTHOR_NAME: 'sim', GIT_AUTHOR_EMAIL: 'sim@example.com', GIT_COMMITTER_NAME: 'sim', GIT_COMMITTER_EMAIL: 'sim@example.com' };
const timings = {};
function run(script, args, day, input) {
  const env = { ...baseEnv, WORKSPACE_MEMORY_NOW: day, GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z` };
  const start = process.hrtime.bigint();
  const result = spawnSync('node', [path.join(SKILL, 'scripts', script), ...args], { cwd: WS, env, encoding: 'utf8', input });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  (timings[script] ||= []).push(ms);
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}
const iso = (offset) => new Date(Date.UTC(2026, 0, 5) + offset * 86_400_000).toISOString().slice(0, 10);
const read = (...parts) => fs.readFileSync(path.join(WS, ...parts), 'utf8');

// ---- storyline vocabulary ----
const TOPICS = ['Vendor contracts', 'Hiring plan', 'Office move', 'Budget', 'Security review', 'Customer onboarding', 'Pricing', 'Marketing launch', 'Data platform', 'Legal and compliance', 'Travel policy', 'Partner program'];
const VERBS = ['confirmed', 'reported', 'agreed', 'flagged', 'estimated', 'requested', 'approved', 'questioned'];
const PEOPLE = ['Maria', 'Ken', 'Priya', 'Tomas', 'Aisha', 'Lee', 'Olga', 'Sam'];
const THINGS = ['the rollout plan', 'the Q3 numbers', 'the vendor shortlist', 'the migration timeline', 'the pricing sheet', 'the headcount model', 'the risk register', 'the launch checklist'];

// Needles: unique facts planted on known days, queried at the end.
const NEEDLES = [
  { day: 3, topic: 'Vendor contracts', text: 'Acme Freight invoices net-60 and charges a 2 percent late fee', exact: 'Acme Freight late fee', paraphrase: 'penalty for paying the logistics supplier late' },
  { day: 20, topic: 'Office move', text: 'The new Lisbon office lease starts on 2026-07-01 with a 5 year term', exact: 'Lisbon office lease', paraphrase: 'when does the rental agreement for the Portugal workplace begin' },
  { day: 41, topic: 'Security review', text: 'Pen test by RedLattice found 2 high severity SSO issues', exact: 'RedLattice pen test', paraphrase: 'penetration testing vendor findings on single sign-on' },
  { day: 55, topic: 'Pricing', text: 'Enterprise tier list price set to 48 EUR per seat per month', exact: 'Enterprise tier price', paraphrase: 'how much do big customers pay per user' },
  { day: 77, topic: 'Hiring plan', text: 'Two data engineers approved for Q3 with a Warsaw hiring hub', exact: 'data engineers Warsaw', paraphrase: 'Polish recruiting location for the data team' },
  { day: 93, topic: 'Legal and compliance', text: 'DPA with Northwind Analytics signed; data stays in eu-central-1', exact: 'Northwind Analytics DPA', paraphrase: 'which AWS region holds customer data for the analytics vendor' },
  { day: 110, topic: 'Data platform', text: 'Snowflake chosen over BigQuery because finance already holds an enterprise contract', exact: 'Snowflake BigQuery', paraphrase: 'why did we pick that warehouse' },
  { day: 128, topic: 'Marketing launch', text: 'Launch webinar booked with Gartner analyst Dana Wells on 2026-06-10', exact: 'Dana Wells webinar', paraphrase: 'which industry analyst is presenting at our launch event' },
  { day: 150, topic: 'Travel policy', text: 'Economy class required for flights under 6 hours, premium economy above', exact: 'premium economy flights', paraphrase: 'what cabin can staff book for long trips' },
  { day: 170, topic: 'Partner program', text: 'Reseller margin fixed at 22 percent for gold partners', exact: 'gold partners reseller margin', paraphrase: 'discount level for top-tier channel sellers' },
];

const log = [];
const findingsOverTime = [];
let openThreads = [];
let nextActions = [];
let decisionCount = 0;
let failures = 0;
const check = (label, fn) => {
  try { fn(); log.push(`ok   ${label}`); } catch (error) { failures += 1; log.push(`FAIL ${label}\n     ${error.message.split('\n').join('\n     ')}`); }
};

// ---- setup ----
fs.mkdirSync(WS);
spawnSync('git', ['init', '-q', '--bare', path.join(TMP, 'remote.git')]);
run('init.mjs', ['--target', WS], iso(0));
spawnSync('git', ['remote', 'add', 'origin', path.join(TMP, 'remote.git')], { cwd: WS });
run('capture.mjs', ['checkpoint', '--objective', 'Run the 2026 expansion programme', '--constraint', 'Budget cap is 2M EUR for 2026', '--pref', 'Status updates as at most 5 bullets'], iso(0));

// ---- simulate days ----
for (let day = 1; day <= DAYS; day += 1) {
  const date = iso(day);
  if (new Date(`${date}T00:00:00Z`).getUTCDay() % 6 === 0 && !NEEDLES.some((item) => item.day === day)) continue; // weekends off
  const flags = [];
  const topic = pick(TOPICS);
  flags.push('--state', `${pick(PEOPLE)} ${pick(VERBS)} ${pick(THINGS)} for ${topic} (day ${day})`);
  if (rand() < 0.6) flags.push('--fact', `${topic} | ${pick(PEOPLE)} ${pick(VERBS)} that ${pick(THINGS)} affects ${pick(TOPICS)} (ref ${day}-${Math.floor(rand() * 1000)})`);
  if (rand() < 0.08) flags.push('--fact', `${topic} | ${pick(PEOPLE)} ${pick(VERBS)} that ${pick(THINGS)} affects ${topic} scope`); // near-duplicates
  for (const needle of NEEDLES.filter((item) => item.day === day)) flags.push('--fact', `${needle.topic} | ${needle.text}`);
  if (rand() < 0.4) { const action = `Follow up with ${pick(PEOPLE)} on ${pick(THINGS)} (day ${day})`; nextActions.push(action); flags.push('--next', action); }
  if (nextActions.length && rand() < 0.35) { const done = nextActions.shift(); flags.push('--done', done); }
  if (rand() < 0.2) { const thread = `Waiting on ${pick(PEOPLE)} to confirm ${pick(THINGS)} (opened day ${day})`; openThreads.push(thread); flags.push('--waiting', thread); }
  if (openThreads.length && rand() < 0.15) { const thread = openThreads.splice(Math.floor(rand() * openThreads.length), 1)[0]; flags.push('--close', `${thread.split(' (opened')[0]} | resolved on day ${day}`); }
  if (rand() < 0.12) { decisionCount += 1; flags.push('--decision', `${topic} choice ${decisionCount} | Option ${pick(['A', 'B', 'C'])} for ${topic} | ${pick(PEOPLE)} showed it is cheaper for ${pick(THINGS)}`); }
  if (day === 60) flags.push('--drop', 'Budget cap is 2M EUR for 2026', '--constraint', 'Budget cap raised to 2.4M EUR for 2026');
  if (day % 45 === 0) flags.push('--lesson', `${topic} | Share ${pick(THINGS)} with ${pick(PEOPLE)} a week before the review (day ${day})`);
  if (day % 7 === 0) flags.push('--session', `Week ${Math.ceil(day / 7)} review | Progress on ${topic} and ${pick(TOPICS)}`);
  const result = run('capture.mjs', ['checkpoint', ...flags], date);
  if (result.code !== 0) log.push(`note day ${day}: capture exit ${result.code}: ${result.err.split('\n')[0]}`);
  run('hook.mjs', ['turn-end'], date, JSON.stringify({ cwd: WS, session_id: `d${day}` }));

  if (day % 14 === 0) {
    const review = run('review.mjs', [], date);
    const count = Number(review.out.match(/Memory review: (\d+) new finding/)?.[1] || 0);
    findingsOverTime.push(`${date}: ${count} new`);
    // A diligent agent: drop stale status lines and the second copy of duplicates, then stamp the review.
    for (const match of review.out.matchAll(/--drop "([^"]+)"/g)) run('capture.mjs', ['checkpoint', '--drop', match[1]], date);
    run('review.mjs', ['--done', `Automated review day ${day}`], date);
  }
  if (day % 30 === 0) run('compact.mjs', ['--days', '60'], date);
}
const lastDay = iso(DAYS);
run('hook.mjs', ['turn-end'], lastDay, JSON.stringify({ cwd: WS, session_id: 'final' }));

// ---- measurements ----
const start = JSON.parse(run('hook.mjs', ['session-start'], lastDay, JSON.stringify({ cwd: WS, session_id: 'final-start' })).out || '{}');
const context = start.hookSpecificOutput?.additionalContext || '';
const files = spawnSync('bash', ['-c', 'find memory -name "*.md" | wc -l'], { cwd: WS, encoding: 'utf8' }).stdout.trim();
const repoSize = spawnSync('du', ['-sk', '.git'], { cwd: WS, encoding: 'utf8' }).stdout.split('\t')[0];
const commits = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: WS, encoding: 'utf8' }).stdout.trim();
const sizes = ['PROFILE.md', 'CURRENT.md', 'ACTIVE_THREADS.md', 'INDEX.md'].map((file) => `${file}=${read('memory', file).length}`);
const linkCount = spawnSync('bash', ['-c', 'grep -rhoE "\\]\\((\\.\\./)*[a-z-]+/[^)]+\\.md\\)" memory --include=*.md | wc -l'], { cwd: WS, encoding: 'utf8' }).stdout.trim();
const backlinked = spawnSync('bash', ['-c', 'grep -rl "## Referenced by" memory | wc -l'], { cwd: WS, encoding: 'utf8' }).stdout.trim();

const PLANTED = NEEDLES.filter((needle) => needle.day <= DAYS);
const recall = (kind) => PLANTED.map((needle) => {
  const out = run('search.mjs', [needle[kind]], lastDay).out;
  const top3 = out.split('\n').filter((line) => !line.startsWith(' ')).slice(0, 3).join('\n');
  const hitLines = out.split('\n').filter((line) => line.startsWith(' ')).slice(0, 9).join('\n');
  return top3.length && hitLines.includes(needle.text.slice(0, 25));
});
const exact = recall('exact');
const paraphrase = recall('paraphrase');

const pct = (list, p) => { const sorted = [...list].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]); };

check('audit passes after 6 months', () => assert.equal(run('audit.mjs', [], lastDay).code, 0));
check('startup context stays within budget', () => assert.ok(context.length <= 18000, `${context.length} chars`));
check('startup files not truncated', () => assert.doesNotMatch(context, /truncated at/));
check('CURRENT.md status list stays capped', () => assert.ok((read('memory', 'CURRENT.md').split('## Status')[1].split('## ')[0].match(/^- /gm) || []).length <= 8));
check('budget change carried through', () => { const current = read('memory', 'CURRENT.md'); assert.match(current, /2\.4M EUR/); assert.doesNotMatch(current.split('## Constraints')[1].split('## ')[0], /2M EUR for 2026\n/); });
check('exact-keyword search finds planted facts (>= 90% in top 3)', () => assert.ok(exact.filter(Boolean).length >= Math.ceil(PLANTED.length * 0.9), `${exact.filter(Boolean).length}/${PLANTED.length}`));
check('notes are linked (links and backlinks exist)', () => { assert.ok(Number(linkCount) > 20, `${linkCount} links`); assert.ok(Number(backlinked) > 5, `${backlinked} notes with backlinks`); });
if (DAYS > 90) check('old sessions archived', () => assert.ok(fs.readdirSync(path.join(WS, 'memory', 'archive', 'sessions')).length >= 1));
check('capture stays fast (p95 < 1500 ms)', () => assert.ok(pct(timings['capture.mjs'], 0.95) < 1500, `${pct(timings['capture.mjs'], 0.95)} ms`));
check('session start stays fast (< 1500 ms)', () => assert.ok(timings['hook.mjs'].at(-1) < 1500, `${Math.round(timings['hook.mjs'].at(-1))} ms`));
check('everything pushed', () => assert.equal(spawnSync('git', ['status', '-sb'], { cwd: WS, encoding: 'utf8' }).stdout.includes('ahead'), false));

process.stdout.write(`Simulated ${DAYS} days (${iso(0)} → ${lastDay}), seed ${arg('seed', 7)}\n\n`);
process.stdout.write(`${log.join('\n')}\n\n`);
process.stdout.write([
  'Measurements',
  `  memory notes: ${files}   commits: ${commits}   .git size: ${repoSize} KB`,
  `  startup context: ${context.length} chars   startup files: ${sizes.join('  ')}`,
  `  links: ${linkCount}   notes with backlinks: ${backlinked}   decisions: ${decisionCount}`,
  `  search recall@3  exact keywords: ${exact.filter(Boolean).length}/${PLANTED.length}   paraphrased: ${paraphrase.filter(Boolean).length}/${PLANTED.length}`,
  `  timings p50/p95 ms  capture ${pct(timings['capture.mjs'], 0.5)}/${pct(timings['capture.mjs'], 0.95)}  hook ${pct(timings['hook.mjs'], 0.5)}/${pct(timings['hook.mjs'], 0.95)}  search ${pct(timings['search.mjs'], 0.5)}/${pct(timings['search.mjs'], 0.95)}  review ${pct(timings['review.mjs'] || [0], 0.5)}`,
  `  review findings over time: ${findingsOverTime.join(' | ')}`,
  `  paraphrase misses: ${PLANTED.filter((_, i) => !paraphrase[i]).map((needle) => `"${needle.paraphrase}"`).join('; ') || 'none'}`,
].join('\n'));
process.stdout.write(`\n\nworkspace: ${argv.includes('--keep') || failures ? WS : '(removed)'}\n`);
if (!argv.includes('--keep') && !failures) fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
