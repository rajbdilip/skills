// Model-parity eval: runs realistic prompts through `claude -p` with different models in fresh
// temp workspaces (hooks wired via --settings), then checks what landed in memory/.
//   node tests/eval/run.mjs [--models haiku,sonnet,opus] [--scenarios decision,pref,...] [--keep]
// Costs tokens. Never touches your real ~/.claude/settings.json or ~/.workspace-memory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(SKILL, 'scripts', 'hook.mjs');
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => (arg.startsWith('--') ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true] : null)).filter(Boolean));
const MODELS = String(args.models || 'haiku,sonnet,opus').split(',');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-eval-'));

const read = (ws, relative) => { try { return fs.readFileSync(path.join(ws, relative), 'utf8'); } catch { return ''; } };
const listDir = (ws, relative) => { try { return fs.readdirSync(path.join(ws, relative)).filter((name) => name !== 'INDEX.md'); } catch { return []; } };
const memorySnapshot = (ws) => spawnSync('git', ['ls-files', '-s', '-o', '--exclude-standard', 'memory'], { cwd: ws, encoding: 'utf8' }).stdout
  + spawnSync('bash', ['-c', 'find memory -type f -exec shasum {} + | sort'], { cwd: ws, encoding: 'utf8' }).stdout;

const SCENARIOS = {
  decision: {
    turns: ['Update on the offsite: we are going with Porto instead of Lisbon, because the Lisbon venues are fully booked for our dates.'],
    check(ws) {
      const files = listDir(ws, 'memory/decisions');
      const text = files.map((name) => read(ws, `memory/decisions/${name}`)).join('\n');
      return [
        ['decision record created', files.length >= 1],
        ['decision mentions Porto', /porto/i.test(text)],
        ['decision keeps the reason', /book/i.test(text)],
      ];
    },
  },
  pref: {
    turns: ['From now on, whenever you summarize anything for me, use a numbered list with at most 3 items. Thanks!'],
    check(ws) {
      const profile = read(ws, 'memory/PROFILE.md');
      return [
        ['preference in PROFILE.md', /numbered/i.test(profile) && /3|three/i.test(profile)],
        ['not stored as a decision', listDir(ws, 'memory/decisions').length === 0],
      ];
    },
  },
  blocker: {
    turns: [
      'Heads up: we cannot book any flights until finance signs off on the travel budget.',
      'Good news, finance signed off on the travel budget this morning, so flights can be booked now.',
    ],
    checkAfter: [
      (ws) => [['blocker recorded in ACTIVE_THREADS', /finance|budget/i.test(read(ws, 'memory/ACTIVE_THREADS.md').split('\n## ').slice(1).join('\n').replace(/- None\./g, ''))]],
    ],
    check(ws) {
      const threads = read(ws, 'memory/ACTIVE_THREADS.md').split('\n## ').slice(1).join('\n');
      const current = read(ws, 'memory/CURRENT.md');
      return [
        ['blocker closed', !/finance/i.test(threads)],
        ['resolution recorded in CURRENT.md', /finance|budget/i.test(current)],
      ];
    },
  },
  noop: {
    turns: ['Quick unrelated question: what is 17 times 23? Just the number please.'],
    before: memorySnapshot,
    check(ws, before) {
      return [['memory unchanged for a trivial question', memorySnapshot(ws) === before]];
    },
  },
  mixed: {
    turns: ['Status: the venue in Porto confirmed 42 seats. Next I need to send the agenda draft to Maria by 2026-10-02. Also note for the future: venue quotes should always be requested with cancellation terms, we got burned on that before.'],
    check(ws) {
      const current = read(ws, 'memory/CURRENT.md');
      const lessons = listDir(ws, 'memory/lessons').map((name) => read(ws, `memory/lessons/${name}`)).join('\n');
      const topics = listDir(ws, 'memory/topics').map((name) => read(ws, `memory/topics/${name}`)).join('\n');
      return [
        ['status recorded', /42/.test(current + topics)],
        ['next action with date', /agenda/i.test(current) && /2026-10-02/.test(current)],
        ['lesson recorded', /cancellation/i.test(lessons + read(ws, 'memory/PROFILE.md'))],
      ];
    },
  },
  recall: {
    seed: [
      ['--fact', 'Catering | Caterer B (Sabores do Porto) does vegan menus and needs 3 weeks notice'],
      ['--fact', 'Catering | Caterer A is cheaper but has no vegan options'],
      ['--fact', 'Transport | Airport shuttle holds 20 people per trip'],
      ['--fact', 'Venues | Venue A holds 40 people and has a projector'],
      ['--fact', 'Activities | Boat tour on the Douro takes 2 hours'],
      ['--fact', 'Hotels | Hotel Ribeira gives 10 percent group discount above 30 rooms'],
      ['--lesson', 'Vendor quotes | Always ask for cancellation terms up front'],
    ],
    turns: ['Which caterer can do vegan food for us, and how much notice do they need? Answer from our notes.'],
    check(ws, before, responses) {
      const answer = responses.at(-1) || '';
      return [
        ['answer names caterer B', /caterer b|sabores/i.test(answer)],
        ['answer has 3 weeks notice', /3 weeks|three weeks/i.test(answer)],
      ];
    },
  },
  correction: {
    turns: ['Correction: the 40k EUR budget cap no longer applies, leadership lifted it this morning.'],
    check(ws) {
      const current = read(ws, 'memory/CURRENT.md');
      const constraints = current.split('## Constraints')[1]?.split('## ')[0] || '';
      return [
        ['old constraint removed', !/40k/i.test(constraints)],
        ['change recorded somewhere', /lift|removed|no (budget )?cap/i.test(current + listDir(ws, 'memory/decisions').map((name) => read(ws, `memory/decisions/${name}`)).join('') + listDir(ws, 'memory/topics').map((name) => read(ws, `memory/topics/${name}`)).join(''))],
      ];
    },
  },
  // Six separate sessions over ~11 simulated weeks (fresh context each time), then a recap quiz.
  journey: {
    freshSessions: true,
    blank: true,
    turns: [
      { date: '2026-10-01', prompt: 'Kicking off a new project: we are organising a customer summit in Berlin for about 120 people, target date 2027-03-18, budget 90k EUR. Whenever you summarise decisions for me, use a table.' },
      { date: '2026-10-08', prompt: 'Venue update: we picked Kosmos Hall over Tempodrom because Tempodrom has no AV included. We are also waiting on the CFO to approve the budget.' },
      { date: '2026-10-20', prompt: 'The CFO approved the budget but cut it to 80k EUR. Next I need to shortlist 3 caterers by 2026-11-01.' },
      { date: '2026-11-05', prompt: 'Correction: the summit moves to 2027-04-15 because of a trade fair clash. Caterer shortlist is done: Feinkost Berlin, GreenPlate and Mahlzeit.' },
      { date: '2026-12-10', prompt: 'Back after a break. If a memory review is due, do it now (use your judgment); otherwise just tell me where we stand in 3 bullets.' },
      { date: '2026-12-15', prompt: 'Quick recap for my boss: event date, budget, venue and why we chose it, the caterer shortlist, and any open items. Summarise the decisions the way I like.' },
    ],
    check(ws, before, responses) {
      const answer = responses.at(-1) || '';
      const threads = read(ws, 'memory/ACTIVE_THREADS.md').split('\n## ').slice(1).join('\n');
      return [
        ['recap: new date 2027-04-15', /2027-04-15|15 april 2027|april 15,? 2027/i.test(answer)],
        ['recap: budget 80k', /80\s?k|80,000|80 000/i.test(answer)],
        ['recap: venue and reason (AV)', /kosmos/i.test(answer) && /\bAV\b|audio/i.test(answer)],
        ['recap: all 3 caterers', /feinkost/i.test(answer) && /greenplate/i.test(answer) && /mahlzeit/i.test(answer)],
        ['recap: decisions as a table (preference)', /\|.*\|/.test(answer)],
        ['memory: CFO thread closed', !/cfo/i.test(threads)],
        ['memory: preference saved', /table/i.test(read(ws, 'memory/PROFILE.md'))],
      ];
    },
  },
  review: {
    seed: [
      ['--state', 'Venue shortlist not started yet'],
      ['--fact', 'Venues | Venue A in Porto holds forty people for the dinner'],
      ['--fact', 'Venue logistics | Venue A in Porto holds forty people for dinner'],
      ['--state', 'Porto venue A is booked and confirmed for 42 seats'],
    ],
    backdate: { 'memory/CURRENT.md': ['Venue shortlist not started yet', '2020-01-01'] },
    turns: ['Yes, let us do the memory review now. Use your judgment; the old shortlist status is obviously outdated.'],
    check(ws) {
      const current = read(ws, 'memory/CURRENT.md');
      return [
        ['review stamped', /^Last review: \d{4}-\d{2}-\d{2}/m.test(read(ws, 'memory/INDEX.md'))],
        ['stale status dropped', !/shortlist not started/i.test(current)],
        ['current status kept', /42 seats/.test(current)],
        ['decisions untouched', listDir(ws, 'memory/decisions').length === 0],
      ];
    },
  },
};

function setupWorkspace(dir, stateDir, scenario = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, WORKSPACE_MEMORY_HOME: stateDir };
  spawnSync('node', [path.join(SKILL, 'scripts', 'init.mjs'), '--target', dir], { env, encoding: 'utf8' });
  if (!scenario.blank) spawnSync('node', [path.join(SKILL, 'scripts', 'capture.mjs'), 'checkpoint', '--objective', 'Plan the Q4 team offsite for about 40 people', '--constraint', 'Budget cap is 40k EUR', '--next', 'Collect venue quotes', '--commit'], { cwd: dir, env, encoding: 'utf8' });
  for (const flags of scenario.seed || []) {
    spawnSync('node', [path.join(SKILL, 'scripts', 'capture.mjs'), 'checkpoint', ...flags], { cwd: dir, env, encoding: 'utf8' });
  }
  for (const [file, [text, date]] of Object.entries(scenario.backdate || {})) {
    const full = path.join(dir, file);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(new RegExp(`\\(\\d{4}-\\d{2}-\\d{2}\\) ${text}`), `(${date}) ${text}`));
  }
  if (scenario.seed) spawnSync('node', [path.join(SKILL, 'scripts', 'commit.mjs'), '--message', 'seed'], { cwd: dir, env, encoding: 'utf8' });
  const handler = (mode, extra = {}) => ({ type: 'command', command: 'node', args: [HOOK, mode], timeout: 60, ...extra });
  const settings = args['no-hooks'] ? {} : {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [handler('session-start')] }],
      UserPromptSubmit: [{ hooks: [handler('prompt')] }],
      Stop: [{ hooks: [handler('nudge')] }, { hooks: [handler('turn-end')] }],
    },
  };
  fs.writeFileSync(path.join(dir, '..', 'settings.json'), JSON.stringify(settings));
  return env;
}

function claude(model, prompt, cwd, env, sessionId) {
  const cliArgs = ['-p', prompt, '--model', model, '--output-format', 'json',
    '--settings', path.join(cwd, '..', 'settings.json'),
    '--allowedTools', 'Bash(node:*)', 'Read',
  ];
  if (sessionId) cliArgs.push('--resume', sessionId);
  return new Promise((resolve) => {
    const child = spawn('claude', cliArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); } catch { resolve({ is_error: true, result: `${out}\n${err}`.slice(0, 500) }); }
    });
  });
}

// The substantive reply of a turn: the longest assistant message in that session's transcript.
// response.result is only the LAST message, which can be a short reply to the end-of-turn reminder.
function answerText(response) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${response.session_id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const texts = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
    const lastUser = lines.map((entry, index) => (entry.type === 'user' && typeof entry.message?.content === 'string' && !entry.message.content.startsWith('Stop hook') ? index : -1)).filter((index) => index >= 0).pop() ?? 0;
    for (const entry of lines.slice(lastUser)) {
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) if (block.type === 'text') texts.push(block.text);
    }
    if (texts.length) return texts.sort((a, b) => b.length - a.length)[0];
  }
  return String(response.result || '');
}

async function runCase(model, name) {
  const scenario = SCENARIOS[name];
  const base = path.join(ROOT, `${model}-${name}`);
  const ws = path.join(base, 'ws');
  const env = setupWorkspace(ws, path.join(base, 'state'), scenario);
  const before = scenario.before ? scenario.before(ws) : null;
  const results = [];
  let sessionId;
  const responses = [];
  for (const [index, turn] of scenario.turns.entries()) {
    const prompt = typeof turn === 'string' ? turn : `(Today is ${turn.date}.) ${turn.prompt}`;
    const turnEnv = typeof turn === 'string' ? env : { ...env, WORKSPACE_MEMORY_NOW: turn.date };
    if (scenario.freshSessions) sessionId = undefined;
    const response = await claude(model, prompt, ws, turnEnv, sessionId);
    responses.push(answerText(response));
    if (response.is_error) results.push([`turn ${index + 1} ran`, false, response.result]);
    sessionId = response.session_id || sessionId;
    for (const [label, ok] of scenario.checkAfter?.[index]?.(ws) || []) results.push([label, ok]);
  }
  results.push(...scenario.check(ws, before, responses));
  const audit = spawnSync('node', [path.join(SKILL, 'scripts', 'audit.mjs')], { cwd: ws, env, encoding: 'utf8' });
  results.push(['audit passes', audit.status === 0]);
  return { model, name, ws, results };
}

const selected = String(args.scenarios || Object.keys(SCENARIOS).join(',')).split(',');
const jobs = MODELS.flatMap((model) => selected.map((name) => [model, name]));
const outcomes = [];
const concurrency = 5;
for (let index = 0; index < jobs.length; index += concurrency) {
  outcomes.push(...await Promise.all(jobs.slice(index, index + concurrency).map(([model, name]) => runCase(model, name))));
}

const lines = [];
for (const name of selected) {
  lines.push(`\n${name}`);
  const checks = outcomes.find((item) => item.name === name).results.map(([label]) => label);
  for (const label of checks) {
    const row = MODELS.map((model) => {
      const result = outcomes.find((item) => item.name === name && item.model === model).results.find(([candidate]) => candidate === label);
      return `${model}:${result ? (result[1] ? 'PASS' : 'FAIL') : '-'}`;
    });
    lines.push(`  ${label.padEnd(40)} ${row.join('  ')}`);
  }
}
const failed = outcomes.flatMap((item) => item.results.filter(([, ok]) => !ok).map(([label, , detail]) => `${item.model}/${item.name}: ${label}${detail ? ` — ${detail}` : ''}  (${item.ws})`));
process.stdout.write(`mode: ${args['no-hooks'] ? 'NO hooks (AGENTS.md instructions only, like Codex)' : 'hooks enabled'}\n`);
process.stdout.write(`${lines.join('\n')}\n\n${failed.length ? `FAILURES:\n${failed.join('\n')}` : 'all checks passed'}\n`);
process.stdout.write(`workspaces: ${ROOT}${args.keep ? '' : ' (pass --keep to inspect; kept anyway when failures exist)'}\n`);
if (!failed.length && !args.keep) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // Claude Code stores each eval session's transcript under ~/.claude/projects/<mangled cwd>; drop ours.
  const projects = path.join(os.homedir(), '.claude', 'projects');
  for (const name of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    if (name.includes(path.basename(ROOT))) fs.rmSync(path.join(projects, name), { recursive: true, force: true });
  }
}
process.exitCode = failed.length ? 1 : 0;
