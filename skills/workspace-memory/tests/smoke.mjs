// End-to-end smoke test. Runs in throwaway temp dirs with a fake HOME/state dir and a local bare remote.
//   node tests/smoke.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-smoke-'));
const HOME = path.join(TMP, 'home');
const ENV = {
  ...process.env,
  WORKSPACE_MEMORY_HOME: path.join(HOME, '.workspace-memory'),
  WORKSPACE_MEMORY_INSTALL_HOME: HOME,
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com',
};
let failures = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || TMP, env: ENV, encoding: 'utf8', input: options.input });
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}
const node = (script, args, options) => run('node', [path.join(SKILL, 'scripts', script), ...args], options);
const git = (cwd, ...args) => run('git', args, { cwd }).out.trim();
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const hook = (mode, cwd, payload = {}, extra = []) => node('hook.mjs', [mode, ...extra], { cwd, input: JSON.stringify({ cwd, session_id: 's1', ...payload }) });

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}

const WS = path.join(TMP, 'ws');
const REMOTE = path.join(TMP, 'remote.git');
const REPO = path.join(TMP, 'app');
const OTHER = path.join(TMP, 'unrelated');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(OTHER);
run('git', ['init', '-q', '--bare', REMOTE]);

test('1. init creates only config, memory/ and managed blocks; pushes bootstrap', () => {
  fs.mkdirSync(WS);
  git(WS, 'init', '-q');
  git(WS, 'remote', 'add', 'origin', REMOTE);
  fs.writeFileSync(path.join(WS, 'AGENTS.md'), '# My rules\n\nKeep this.\n');
  git(WS, 'add', 'AGENTS.md');
  git(WS, 'commit', '-q', '-m', 'user file');
  const dry = node('init.mjs', ['--target', WS, '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /would change 13 file/);
  assert.ok(!fs.existsSync(path.join(WS, 'memory')), 'dry run wrote files');
  const result = node('init.mjs', ['--target', WS]);
  assert.equal(result.code, 0, result.err + result.out);
  assert.ok(!fs.existsSync(path.join(WS, '.gitignore')), '.gitignore should not be created');
  assert.ok(!fs.existsSync(path.join(WS, '.workspace-memory', 'scripts')), 'no vendored scripts');
  const agents = read(WS, 'AGENTS.md');
  assert.match(agents, /# My rules[\s\S]*Keep this\.[\s\S]*workspace-memory:start/);
  assert.match(agents, /capture\.mjs checkpoint/);
  assert.equal(git(WS, 'status', '--porcelain'), '');
  assert.match(git(REMOTE, 'log', '--oneline', '-1', 'main') || git(REMOTE, 'log', '--oneline', '-1'), /initialize workspace memory/);
  const again = node('init.mjs', ['--target', WS]);
  assert.match(again.out, /changed 0 file/);
});

test('2. checkpoint writes every field to the right file; validation guards weak input', () => {
  const r = node('capture.mjs', ['checkpoint',
    '--objective', 'Plan the Q4 offsite',
    '--state', 'Venue shortlist has 3 options',
    '--next', 'Get quotes from the three venues',
    '--next', 'Draft the agenda',
    '--constraint', 'Budget cap is 40k EUR',
    '--decision', 'Offsite city | Lisbon | Cheapest flights for most of the team',
    '--open', 'Need budget approval from finance',
    '--blocked', 'Waiting on HR headcount numbers',
    '--fact', 'Venues | Venue A holds 40 people',
    '--lesson', 'Vendor quotes | Ask for cancellation terms up front',
    '--pref', 'Summaries as at most 5 bullets',
    '--session', 'Kickoff | Agreed location and first steps'], { cwd: WS });
  assert.equal(r.code, 0, r.err + r.out);
  const current = read(WS, 'memory', 'CURRENT.md');
  assert.match(current, /## Objective\n\n- Plan the Q4 offsite/);
  assert.match(current, /Last updated: \d{4}-\d{2}-\d{2}/);
  assert.match(current, /## Constraints\n\n- Budget cap is 40k EUR/);
  assert.match(read(WS, 'memory', 'ACTIVE_THREADS.md'), /## Blocked\n\n- \(\d{4}-\d{2}-\d{2}\) Waiting on HR headcount numbers/);
  assert.match(read(WS, 'memory', 'PROFILE.md'), /- Summaries as at most 5 bullets/);
  assert.match(read(WS, 'memory', 'topics', 'venues.md'), /Venue A holds 40 people/);
  assert.match(read(WS, 'memory', 'lessons', 'vendor-quotes.md'), /cancellation terms/);
  assert.match(read(WS, 'memory', 'decisions', 'INDEX.md'), /D-0001: Offsite city/);
  assert.match(read(WS, 'memory', 'INDEX.md'), /recent-decisions:start -->\n- \[D-0001: Offsite city\]/);
  assert.match(read(WS, 'memory', 'INDEX.md'), /recent-sessions:start -->\n- \[Kickoff\]/);

  const done = node('capture.mjs', ['checkpoint', '--done', 'got quotes from the three venues', '--close', 'budget approval | Finance approved 38k on the call'], { cwd: WS });
  assert.equal(done.code, 0, done.err);
  const after = read(WS, 'memory', 'CURRENT.md');
  assert.doesNotMatch(after.split('## Recently completed')[0], /Get quotes/);
  assert.match(after, /Resolved: Need budget approval from finance — Finance approved 38k/);
  assert.doesNotMatch(read(WS, 'memory', 'ACTIVE_THREADS.md'), /budget approval/);

  const dup = node('capture.mjs', ['checkpoint', '--pref', 'summaries as at most 5 bullets!'], { cwd: WS });
  assert.match(dup.out, /duplicate skipped/);
  const placeholder = node('capture.mjs', ['checkpoint', '--state', '...'], { cwd: WS });
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.err, /placeholder[\s\S]*fix:/);
  const badDecision = node('capture.mjs', ['checkpoint', '--decision', 'Only a title'], { cwd: WS });
  assert.match(badDecision.err, /3 parts[\s\S]*fix: Example/);
  const noThread = node('capture.mjs', ['checkpoint', '--close', 'nonexistent thing | done'], { cwd: WS });
  assert.match(noThread.err, /Open threads: .*HR headcount/);
  const long = node('capture.mjs', ['checkpoint', '--state', 'word '.repeat(120)], { cwd: WS });
  assert.match(long.err, /limit is 500/);
  const secret = node('capture.mjs', ['checkpoint', '--fact', 'AWS | key AKIAABCDEFGHIJKLMNOP'], { cwd: WS });
  assert.match(secret.err, /secret/);
  const invalidAll = node('capture.mjs', ['checkpoint', '--next', 'Valid next step here', '--state', 'TBD'], { cwd: WS });
  assert.equal(invalidAll.code, 1);
  assert.doesNotMatch(read(WS, 'memory', 'CURRENT.md'), /Valid next step here/, 'nothing is written when any field is invalid');
});

test('3. decision --supersedes links both records', () => {
  const r = node('capture.mjs', ['checkpoint', '--decision', 'Offsite city v2 | Porto | Lisbon venues were fully booked', '--supersedes', 'D-0001'], { cwd: WS });
  assert.equal(r.code, 0, r.err);
  const old = fs.readdirSync(path.join(WS, 'memory', 'decisions')).find((name) => name.startsWith('D-0001'));
  const oldText = read(WS, 'memory', 'decisions', old);
  assert.match(oldText, /status: "superseded"/);
  assert.match(oldText, /## Superseded by\n\n- \[D-0002/);
  const repeat = node('capture.mjs', ['checkpoint', '--decision', 'Offsite city v2 | Faro | again'], { cwd: WS });
  assert.match(repeat.err, /already exists[\s\S]*--supersedes/);
});

test('4. session-start context: bounded, includes PROFILE and the checkpoint reminder', () => {
  const r = hook('session-start', WS);
  assert.equal(r.code, 0, r.err);
  const context = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(context, /memory\/PROFILE\.md[\s\S]*Summaries as at most 5 bullets/);
  assert.match(context, /capture\.mjs checkpoint/);
  assert.ok(context.length < 20000);
  fs.appendFileSync(path.join(WS, 'memory', 'CURRENT.md'), `\n${'- filler line for budget test\n'.repeat(400)}`);
  const clipped = JSON.parse(hook('session-start', WS).out).hookSpecificOutput.additionalContext;
  assert.match(clipped, /truncated at 6000 characters/);
  const audit = node('audit.mjs', [], { cwd: WS });
  assert.match(audit.out, /warning: memory\/CURRENT\.md is \d+ characters[\s\S]*fix:/);
  git(WS, 'checkout', '--', 'memory/CURRENT.md');
  run('git', ['checkout', '--', 'memory/CURRENT.md'], { cwd: WS });
});

test('5. every hook mode is silent outside a workspace', () => {
  for (const mode of ['session-start', 'nudge', 'turn-end', 'pre-compact', 'session-end']) {
    const r = hook(mode, OTHER);
    assert.equal(r.code, 0, `${mode}: ${r.err}`);
    assert.equal(r.out, '', `${mode} printed output`);
  }
});

test('6. nudge: fires on work without memory, never twice in a row, not after memory change', () => {
  git(WS, 'add', '-A');
  git(WS, 'commit', '-q', '-m', 'sync');
  hook('session-start', WS, { session_id: 'n1' });
  fs.writeFileSync(path.join(WS, 'plan.md'), '# Plan\n');
  const first = hook('nudge', WS, { session_id: 'n1' });
  const decision = JSON.parse(first.out);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /capture\.mjs checkpoint[\s\S]*no memory needed/);
  fs.writeFileSync(path.join(WS, 'plan.md'), '# Plan v2\n');
  assert.equal(hook('nudge', WS, { session_id: 'n1', stop_hook_active: true }).out, '');
  fs.writeFileSync(path.join(WS, 'plan.md'), '# Plan v3\n');
  assert.equal(hook('nudge', WS, { session_id: 'n1' }).out, '', 'second nudge in a row');
  hook('session-start', WS, { session_id: 'n2' });
  fs.writeFileSync(path.join(WS, 'plan.md'), '# Plan v4\n');
  node('capture.mjs', ['checkpoint', '--state', 'Plan drafted in plan.md'], { cwd: WS });
  assert.equal(hook('nudge', WS, { session_id: 'n2' }).out, '', 'nudged although memory changed');
  hook('session-start', WS, { session_id: 'n3' });
  fs.writeFileSync(path.join(WS, 'plan.md'), '# Plan v5\n');
  const gemini = JSON.parse(hook('nudge', WS, { session_id: 'n3' }, ['--agent', 'gemini']).out);
  assert.equal(gemini.decision, 'deny');
  // Chat-only turn: a preference stated in the prompt, no file edits, no memory change.
  hook('session-start', WS, { session_id: 'n4' });
  hook('prompt', WS, { session_id: 'n4', prompt: 'From now on, summarize in 3 bullets.' });
  assert.match(JSON.parse(hook('nudge', WS, { session_id: 'n4' }).out).reason, /something to remember/);
  hook('session-start', WS, { session_id: 'n5' });
  hook('prompt', WS, { session_id: 'n5', prompt: 'What is 17 times 23?' });
  assert.equal(hook('nudge', WS, { session_id: 'n5' }).out, '', 'trivial question should not nudge');
  for (const [id, prompt] of [['n6', 'Quick recap for my boss: event date, budget, venue and the open items. Summarise the decisions as a table.'], ['n7', 'What did we decide about the budget and where does the status stand?']]) {
    hook('session-start', WS, { session_id: id });
    hook('prompt', WS, { session_id: id, prompt });
    assert.equal(hook('nudge', WS, { session_id: id }).out, '', `recap question should not nudge: ${prompt}`);
  }
  hook('session-start', WS, { session_id: 'n8' });
  hook('prompt', WS, { session_id: 'n8', prompt: 'Correction: the summit moves to 2027-04-15 because of a trade fair clash.' });
  assert.match(hook('nudge', WS, { session_id: 'n8' }).out, /something to remember/, 'a correction should nudge');
});

test('7. turn-end commits the whole workspace and pushes; secrets block the commit', () => {
  fs.writeFileSync(path.join(WS, 'notes.md'), 'Meeting notes\n');
  const r = hook('turn-end', WS);
  assert.equal(r.out, '', r.out);
  assert.equal(git(WS, 'status', '--porcelain'), '');
  assert.match(git(WS, 'log', '--oneline', '-1'), /memory: turn checkpoint/);
  assert.equal(git(WS, 'rev-parse', 'HEAD'), git(REMOTE, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(WS, 'creds.txt'), 'aws AKIAABCDEFGHIJKLMNOP\n');
  const blocked = JSON.parse(hook('turn-end', WS).out);
  assert.match(blocked.systemMessage, /possible-secret[\s\S]*creds\.txt[\s\S]*fix:/);
  assert.match(git(WS, 'status', '--porcelain'), /creds\.txt/);
  fs.rmSync(path.join(WS, 'creds.txt'));
});

test('8. linked repo: memory injected from hub, commits land in hub, repo untouched', () => {
  fs.mkdirSync(REPO);
  git(REPO, 'init', '-q');
  fs.writeFileSync(path.join(REPO, 'index.js'), 'console.log(1)\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-q', '-m', 'app');
  const link = node('init.mjs', ['--target', WS, '--link', REPO, '--name', 'app']);
  assert.equal(link.code, 0, link.err + link.out);
  assert.equal(git(REPO, 'status', '--porcelain'), '', 'link modified the code repo');
  const start = JSON.parse(hook('session-start', REPO, { session_id: 'p1' }).out).hookSpecificOutput.additionalContext;
  assert.match(start, /linked project "app"/);
  assert.match(start, /memory\/projects\/app\/CURRENT\.md/);
  assert.match(start, /--project app/);
  const cap = node('capture.mjs', ['checkpoint', '--state', 'Login page refactor started', '--decision', 'Auth library | Use Lucia | Simpler sessions than NextAuth'], { cwd: REPO });
  assert.equal(cap.code, 0, cap.err);
  assert.match(read(WS, 'memory', 'projects', 'app', 'CURRENT.md'), /Login page refactor started/);
  assert.ok(fs.readdirSync(path.join(WS, 'memory', 'projects', 'app', 'decisions')).some((name) => name.startsWith('D-0001')));
  hook('session-start', REPO, { session_id: 'p2' });
  fs.writeFileSync(path.join(REPO, 'index.js'), 'console.log(2)\n');
  assert.equal(JSON.parse(hook('nudge', REPO, { session_id: 'p2' }).out).decision, 'block', 'code change should nudge when memory did not change');
  const before = git(REPO, 'rev-parse', 'HEAD');
  hook('turn-end', REPO);
  assert.equal(git(REPO, 'rev-parse', 'HEAD'), before, 'hook committed in the code repo');
  assert.match(git(REPO, 'status', '--porcelain'), /index\.js/);
  assert.equal(git(WS, 'status', '--porcelain'), '');
  assert.match(read(WS, 'memory', 'INDEX.md'), /\[app\]\(projects\/app\/INDEX\.md\)/);
  const pointer = node('init.mjs', ['--target', WS, '--link', REPO, '--name', 'app', '--pointer']);
  assert.match(read(REPO, 'AGENTS.md'), /--project app/, pointer.out);
});

test('9. compact archives old sessions but keeps ones with open threads', () => {
  const sessions = path.join(WS, 'memory', 'sessions');
  fs.writeFileSync(path.join(sessions, '2020-01-01-0000-old.md'), '---\ntype: session\ndate: "2020-01-01"\n---\n\n# Old\n\n## Open threads\n\n- None.\n');
  fs.writeFileSync(path.join(sessions, '2020-01-02-0000-open.md'), '---\ntype: session\ndate: "2020-01-02"\n---\n\n# Open\n\n## Open threads\n\n- Still waiting on vendor\n');
  const r = node('compact.mjs', ['--days', '30'], { cwd: WS });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /archived 1 session/);
  assert.match(r.out, /kept memory\/sessions\/2020-01-02-0000-open\.md/);
  assert.ok(fs.existsSync(path.join(WS, 'memory', 'archive', 'sessions', '2020', '2020-01-01-0000-old.md')));
  assert.match(read(WS, 'memory', 'archive', 'INDEX.md'), /sessions\/2020\/2020-01-01-0000-old\.md/);
  assert.equal(node('audit.mjs', [], { cwd: WS }).code, 0);
});

test('10. global install merges hooks idempotently without clobbering settings', () => {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const r = node('install.mjs', ['--scope', 'global']);
  assert.equal(r.code, 0, r.err);
  const settings = JSON.parse(read(HOME, '.claude', 'settings.json'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.Stop.length, 3);
  assert.ok(settings.hooks.Stop.some((group) => group.hooks[0].async === true));
  assert.ok(fs.lstatSync(path.join(HOME, '.agents', 'skills', 'workspace-memory')).isSymbolicLink());
  assert.ok(JSON.parse(read(HOME, '.gemini', 'settings.json')).hooks.AfterAgent[0].hooks.length === 2);
  const snapshot = read(HOME, '.claude', 'settings.json');
  const again = node('install.mjs', ['--scope', 'global']);
  assert.match(again.out, /already up to date|next:/);
  assert.equal(read(HOME, '.claude', 'settings.json'), snapshot, 'second install changed settings');
  node('install.mjs', ['--scope', 'global', '--uninstall']);
  const cleaned = JSON.parse(read(HOME, '.claude', 'settings.json'));
  assert.equal(cleaned.hooks.Stop.length, 1);
  assert.ok(!fs.existsSync(path.join(HOME, '.agents', 'skills', 'workspace-memory')));
});

test('11. project install copies the same skill and wires project hooks', () => {
  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(proj);
  const r = node('install.mjs', ['--scope', 'project', '--target', proj, '--agents', 'claude']);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(proj, '.agents', 'skills', 'workspace-memory', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'skills', 'workspace-memory', 'scripts', 'hook.mjs')));
  const hooks = JSON.parse(read(proj, '.claude', 'settings.json')).hooks;
  assert.match(hooks.SessionStart[0].hooks[0].args[0], /^\$\{CLAUDE_PROJECT_DIR\}\/\.agents\/skills\/workspace-memory/);
});

test('12. v1 workspace upgrades cleanly', () => {
  const v1 = path.join(TMP, 'v1');
  fs.mkdirSync(path.join(v1, '.workspace-memory', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(v1, '.workspace-memory', 'scripts', 'hook.mjs'), '// old');
  fs.writeFileSync(path.join(v1, '.workspace-memory', 'config.json'), JSON.stringify({ version: 1, memoryRoot: 'memory', startupFiles: ['memory/INDEX.md'], lineBudgets: { 'memory/INDEX.md': 120 }, commit: { enabled: true, push: 'never' } }));
  const r = node('init.mjs', ['--target', v1, '--upgrade', '--no-git-init']);
  assert.equal(r.code, 0, r.err + r.out);
  const config = JSON.parse(read(v1, '.workspace-memory', 'config.json'));
  assert.equal(config.version, 2);
  assert.equal(config.commit.scope, 'memory', 'v1 workspaces keep memory-only commits');
  assert.equal(config.commit.push, 'never');
  assert.ok(!fs.existsSync(path.join(v1, '.workspace-memory', 'scripts')));
  assert.equal(hook('turn-end', v1).out, '', 'no-git workspace should be quiet');
  assert.match(JSON.parse(hook('session-start', v1).out).hookSpecificOutput.additionalContext, /not versioned/);
});

test('13. README quick-start commands exist with the documented flags', () => {
  const readme = read(SKILL, 'README.md');
  const commands = [...readme.matchAll(/node ~\/\.claude\/skills\/workspace-memory\/scripts\/([a-z]+\.mjs)([^\n`]*)/g)];
  assert.ok(commands.length >= 5, 'README should show commands');
  for (const [, script, rest] of commands) {
    assert.ok(fs.existsSync(path.join(SKILL, 'scripts', script)), `README references missing ${script}`);
    const source = read(SKILL, 'scripts', script);
    for (const flag of rest.match(/--[a-z-]+/g) || []) {
      assert.ok(source.includes(`'${flag.slice(2)}'`) || source.includes(`"${flag.slice(2)}"`) || source.includes(`args.${flag.slice(2)}`) || source.includes(`args['${flag.slice(2)}']`) || source.includes(`--${flag.slice(2)}`), `${script} does not handle ${flag}`);
    }
  }
});

test('14. auto-links mentions and generates backlinks', () => {
  const r = node('capture.mjs', ['checkpoint', '--fact', 'Catering | Caterer B does vegan menus and needs 3 weeks notice', '--fact', 'Venue logistics | Venue A kitchen works with Catering suppliers only on weekdays', '--state', 'Porto decision D-0002 confirmed with the team'], { cwd: WS });
  assert.equal(r.code, 0, r.err + r.out);
  const venue = read(WS, 'memory', 'topics', 'venue-logistics.md');
  assert.match(venue, /\[Catering\]\(catering\.md\)/, 'topic mention should become a link');
  assert.match(read(WS, 'memory', 'CURRENT.md'), /\[D-0002\]\(decisions\/D-0002-[^)]+\.md\)/, 'decision ID should link');
  const catering = read(WS, 'memory', 'topics', 'catering.md');
  assert.match(catering, /## Referenced by\n\n- \[Venue logistics\]\(venue-logistics\.md\)/);
  const decision = fs.readdirSync(path.join(WS, 'memory', 'decisions')).find((name) => name.startsWith('D-0002'));
  assert.match(read(WS, 'memory', 'decisions', decision), /Referenced by[\s\S]*\(\.\.\/CURRENT\.md\)/);
  const again = node('capture.mjs', ['checkpoint', '--fact', 'Catering | Caterer B does vegan menus and needs 3 weeks notice'], { cwd: WS });
  assert.match(again.out, /duplicate skipped/);
  const more = node('capture.mjs', ['checkpoint', '--fact', 'Catering | Menu tasting is free for groups over 30'], { cwd: WS });
  assert.equal(more.code, 0, more.err);
  const updated = read(WS, 'memory', 'topics', 'catering.md');
  assert.ok(updated.indexOf('Menu tasting') < updated.indexOf('## Referenced by'), 'new fact must stay above the backlinks block');
  assert.equal(node('audit.mjs', [], { cwd: WS }).code, 0);
});

test('15. search ranks the right note; --related follows links', () => {
  const r = node('search.mjs', ['which caterer does vegan food'], { cwd: WS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split('\n')[0], /memory\/topics\/catering\.md/);
  assert.match(r.out, /3 weeks notice/);
  const id = node('search.mjs', ['D-0002'], { cwd: WS });
  assert.match(id.out, /decisions\/D-0002/);
  const rel = node('search.mjs', ['--related', 'memory/topics/catering.md'], { cwd: WS });
  assert.match(rel.out, /venue-logistics\.md[\s\S]*1 hop/);
  const none = node('search.mjs', ['zzzqqq'], { cwd: WS });
  assert.match(none.out, /no matches/);
  const empty = node('search.mjs', ['the of'], { cwd: WS });
  assert.match(empty.err, /no searchable words[\s\S]*fix:/);
});

test('16. --drop removes outdated bullets and refuses ambiguity', () => {
  node('capture.mjs', ['checkpoint', '--constraint', 'Budget cap is 40k EUR'], { cwd: WS });
  const hint = node('capture.mjs', ['checkpoint', '--state', 'Correction: the 40k EUR budget cap no longer applies'], { cwd: WS });
  assert.match(hint.out, /check: "Budget cap is 40k EUR"[\s\S]*--drop "Budget cap is 40k EUR"/);
  const r = node('capture.mjs', ['checkpoint', '--drop', 'Budget cap is 40k', '--state', 'Budget cap lifted by leadership'], { cwd: WS });
  assert.equal(r.code, 0, r.err + r.out);
  assert.doesNotMatch(read(WS, 'memory', 'CURRENT.md').split('## Constraints')[1].split('## ')[0], /Budget cap is 40k/);
  assert.match(read(WS, 'memory', 'CURRENT.md'), /No longer applies: Budget cap is 40k EUR/);
  const missing = node('capture.mjs', ['checkpoint', '--drop', 'nothing like this exists anywhere'], { cwd: WS });
  assert.match(missing.err, /No bullet matches[\s\S]*Closest[\s\S]*fix:/);
  const partial = node('capture.mjs', ['checkpoint', '--next', 'Confirm the DJ booking', '--drop', 'nothing like this exists anywhere'], { cwd: WS });
  assert.match(partial.err, /Nothing was changed/);
  assert.doesNotMatch(read(WS, 'memory', 'CURRENT.md'), /Confirm the DJ/, 'a failed checkpoint must not leave partial writes');
  node('capture.mjs', ['checkpoint', '--fact', 'Hotels | Hotel Ribeira gives a group discount', '--fact', 'Rooms | Hotel Ribeira gives a group discount'], { cwd: WS });
  const twin = node('capture.mjs', ['checkpoint', '--drop', 'Hotel Ribeira gives a group discount'], { cwd: WS });
  assert.equal(twin.code, 0, `identical duplicates should be droppable: ${twin.err}`);
  const fact = node('capture.mjs', ['checkpoint', '--drop', 'Menu tasting is free'], { cwd: WS });
  assert.equal(fact.code, 0, fact.err);
  assert.doesNotMatch(read(WS, 'memory', 'topics', 'catering.md'), /Menu tasting/);
});

test('17. review finds stale and duplicate items; session start says when due; --done stamps', () => {
  const current = path.join(WS, 'memory', 'CURRENT.md');
  fs.writeFileSync(current, read(current).replace('## Status\n\n', '## Status\n\n- (2020-01-01) Venue shortlist is still open\n'));
  const threads = path.join(WS, 'memory', 'ACTIVE_THREADS.md');
  fs.writeFileSync(threads, read(threads).replace('## Waiting\n\n- None.', '## Waiting\n\n- (2020-02-01) Waiting on visa letters'));
  node('capture.mjs', ['checkpoint', '--fact', 'Venues | Venue A holds forty people for the offsite dinner'], { cwd: WS });
  node('capture.mjs', ['checkpoint', '--fact', 'Venue logistics | Venue A holds forty people for dinner at the offsite'], { cwd: WS });
  const r = node('review.mjs', [], { cwd: WS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[stale status\][\s\S]*--drop "Venue shortlist is still open"/);
  assert.match(r.out, /\[old thread\][\s\S]*visa letters/);
  assert.match(r.out, /\[possible duplicate\]/);
  assert.match(r.out, /Memory review: \d+ new finding/);
  assert.match(r.out, /review\.mjs --done/);
  const start = JSON.parse(hook('session-start', WS, { session_id: 'r1' }).out).hookSpecificOutput.additionalContext;
  assert.match(start, /Memory review due \(last: never; \d+ finding/);
  const done = node('review.mjs', ['--done', 'Dropped stale status, merged venue facts'], { cwd: WS });
  assert.match(done.out, /Last review: \d{4}-\d{2}-\d{2} — Dropped stale/);
  assert.match(read(WS, 'memory', 'INDEX.md'), /^Last review: /m);
  const after = JSON.parse(hook('session-start', WS, { session_id: 'r2' }).out).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(after, /Memory review due/);
});

test('18. Windows line endings are handled', () => {
  const current = path.join(WS, 'memory', 'CURRENT.md');
  fs.writeFileSync(current, read(current).replace(/\n/g, '\r\n'));
  const r = node('capture.mjs', ['checkpoint', '--next', 'Book the photographer'], { cwd: WS });
  assert.equal(r.code, 0, r.err);
  const text = read(WS, 'memory', 'CURRENT.md');
  assert.match(text, /## Next actions\n\n(- .+\n)*- Book the photographer\n/);
  assert.doesNotMatch(text, /\r/);
});

fs.rmSync(TMP, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} test(s) failed\n` : '\nall tests passed\n');
process.exitCode = failures ? 1 : 0;
