// Lifecycle hook for Claude Code and Gemini CLI.
// Installed globally, it runs in every project, so it must stay silent (no output, exit 0)
// anywhere that is not a memory workspace or a linked code repo.
import fs from 'node:fs';
import path from 'node:path';
import { auditWorkspace } from './audit.mjs';
import { commitMemory } from './commit.mjs';
import { rebuildIndexes } from './index.mjs';
import { reviewDue } from './review.mjs';
import {
  hash,
  isGitRepository,
  memoryDir,
  parseArgs,
  readSection,
  readText,
  resolveContext,
  runGit,
  scriptCommand,
  stateHome,
  toPosix,
  writeText,
} from './lib.mjs';

async function readInput() {
  if (process.stdin.isTTY) return {};
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return data.trim() ? JSON.parse(data) : {}; } catch { return {}; }
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

// ---------- session start ----------

function clip(text, budget) {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n…[truncated at ${budget} characters; run ${scriptCommand('compact.mjs')} or move detail into topics/]`;
}

export function startupContext(context) {
  const { root, config } = context;
  const budgets = config.startup?.charBudgets || {};
  const capture = scriptCommand('capture.mjs');
  const projectFlag = context.project ? ` --project ${context.project}` : '';
  const files = [];
  if (context.project) {
    const base = path.join(config.memoryRoot, 'projects', context.project);
    files.push([`${config.memoryRoot}/PROFILE.md`, budgets[`${config.memoryRoot}/PROFILE.md`] || 3000]);
    files.push([`${base}/CURRENT.md`, budgets[`${config.memoryRoot}/CURRENT.md`] || 6000]);
    files.push([`${base}/ACTIVE_THREADS.md`, budgets[`${config.memoryRoot}/ACTIVE_THREADS.md`] || 4000]);
  } else {
    for (const file of config.startup.files) files.push([file, budgets[file] || 4000]);
  }

  const header = [
    context.project
      ? `Workspace memory is active for linked project "${context.project}". Memory lives in the hub ${toPosix(root)} (not in this repo).`
      : `Workspace memory is active. It lives in ${toPosix(path.join(root, config.memoryRoot))}/ (this is the memory to use, not any built-in agent memory folder). These files are the current orientation; open other memory files only when relevant.`,
  ];
  const sections = [];
  for (const [relative, budget] of files) {
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) continue;
    sections.push(`## ${toPosix(relative)}\n${clip(readText(filePath).trim(), Number(budget))}`);
  }
  if (context.project) {
    const hubCurrent = path.join(root, config.memoryRoot, 'CURRENT.md');
    if (fs.existsSync(hubCurrent)) {
      const objective = readSection(readText(hubCurrent), 'Objective')?.bullets[0];
      if (objective) sections.push(`Hub objective: ${objective}`);
    }
  }
  const notes = [];
  try {
    const due = reviewDue(root, config);
    if (due) notes.push(`Memory review due (last: ${due.last || 'never'}; ${due.count} finding(s)). At a natural pause, offer the user a short review: run \`${scriptCommand('review.mjs')}\` and work through it together.`);
  } catch {}
  if (!isGitRepository(root)) notes.push(`Note: memory at ${toPosix(root)} is not versioned yet. Suggest the user runs \`git init\` there.`);
  const footer = [
    'Memory rules:',
    `- When something durable happens (decision, preference, status change, new or resolved blocker, reusable fact or lesson), record it: \`${capture} checkpoint${projectFlag} --state "..." --next "..." --decision "title | choice | why" --open "..." --close "match | resolution" --fact "topic | fact" --lesson "title | lesson" --pref "..."\` (only the flags that apply).`,
    '- Do it in the SAME turn, before replying, whenever the user states a preference ("from now on", "always"), makes or changes a decision, reports a blocker or its resolution, gives a deadline, or updates status. Acknowledging in chat is not enough: chat is forgotten, memory is not.',
    `- To find older context, search instead of opening many files: \`${scriptCommand('search.mjs')} "words"\` (add \`--related <note path>\` for linked notes). Remove outdated bullets with \`checkpoint --drop "..."\`.`,
    '- Do not hand-edit memory for routine updates. Never save transcripts, command output, secrets, or facts obvious from the files.',
    '- Commits happen automatically at the end of each turn.',
  ];
  const total = Number(config.startup?.totalChars || 16000);
  return clip([...header, ...sections, ...notes, footer.join('\n')].join('\n\n'), total + 2000);
}

// ---------- change detection for the nudge ----------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);

function listFiles(root, excludes, limit = 20000) {
  if (isGitRepository(root)) {
    const out = runGit(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { raw: true, allowFailure: true }).stdout;
    return out.split('\0').filter(Boolean).filter((file) => !excludes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))).slice(0, limit);
  }
  const files = [];
  const walk = (directory, prefix) => {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excludes.some((item) => relative === item || relative.startsWith(`${item}/`))) continue;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= limit) return;
    }
  };
  walk(root, '');
  return files;
}

function fingerprint(root, files) {
  const parts = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(path.resolve(root, file));
      parts.push(`${file}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {}
  }
  return hash(parts.sort().join('\n'));
}

function snapshot(context) {
  const { root, config } = context;
  const mem = memoryDir(context);
  const memFiles = listFiles(mem, []).map((file) => path.join(mem, file));
  memFiles.push(path.join(root, config.memoryRoot, 'PROFILE.md'));
  const memoryPrint = fingerprint(root, memFiles);
  let workPrint;
  if (context.codeRoot) {
    workPrint = fingerprint(context.codeRoot, listFiles(context.codeRoot, []));
  } else {
    const excludes = [config.memoryRoot, '.workspace-memory', ...Object.values(config.projects || {}).map((entry) => toPosix(path.relative(root, path.resolve(root, entry.path || '.'))))].filter((item) => item && !item.startsWith('..'));
    workPrint = fingerprint(root, listFiles(root, excludes));
  }
  return { memory: memoryPrint, work: workPrint };
}

// Phrases that usually mean the user just said something worth remembering.
// Phrases that usually mean the user just told us something worth remembering. Bare topic nouns
// ("budget", "status", "decision") are deliberately absent: recap questions use them too.
const DURABLE_SIGNAL = /\b(from now on|going forward|in (the )?future|always|never again|i prefer|i'd prefer|please remember|remember (that|this)|note (that|for)|keep in mind|keep track|don't let me forget|we('ve| have)? decided|we('re| are) going with|going with|instead of|switch(ed|ing)? to|moved? (to|from)|correction|actually,|blocked (on|by|until)|stuck (on|until)|waiting (on|for)|until .{0,40}(approve|sign|confirm)|can(no|')t .{0,60} until|approved|signed off|confirmed|cancel+ed|deadline|due (on|by)|by \d{4}-\d{2}-\d{2}|we learned|lesson learned|next (step|i need|we need))\b/i;
// Questions asking to recall or summarise are answered from memory, not new information.
const RECALL_ONLY = /^\s*(\(today is [^)]*\)\s*)?(what|where|when|who|why|how|which|can you (catch|remind|summari|recap|tell)|could you (summari|recap)|quick recap|recap|summari[sz]e|catch me up|remind me what)\b[^.!]*\??\s*$/i;

export function hasDurableSignal(text) {
  const value = String(text || '');
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length && sentences.every((sentence) => RECALL_ONLY.test(sentence) || !DURABLE_SIGNAL.test(sentence))) return false;
  return DURABLE_SIGNAL.test(value);
}

function statePath(context, sessionId) {
  return path.join(stateHome(), 'state', `${hash(`${context.root}|${context.project || ''}|${sessionId || 'default'}`)}.json`);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function saveState(file, state) {
  writeText(file, JSON.stringify(state));
}

function saveBaseline(context, input) {
  saveState(statePath(context, input.session_id), { ...snapshot(context), turns: 0, turnsSinceMemory: 0, sinceNudge: 99, lastWasNudge: false });
}

export function nudgeDecision(context, input) {
  const nudge = context.config.nudge || {};
  if (nudge.enabled === false) return null;
  const file = statePath(context, input.session_id);
  const previous = readState(file);
  const current = snapshot(context);
  if (!previous) {
    saveBaseline(context, input);
    return null;
  }
  const workChanged = current.work !== previous.work;
  const memoryChanged = current.memory !== previous.memory;
  const state = {
    ...current,
    turns: previous.turns + 1,
    turnsSinceMemory: memoryChanged ? 0 : previous.turnsSinceMemory + 1,
    sinceNudge: previous.sinceNudge + 1,
    lastWasNudge: false,
  };
  let reason = null;
  const signal = hasDurableSignal(previous.lastPrompt);
  state.lastPrompt = '';
  const allowed = !input.stop_hook_active && !previous.lastWasNudge && state.sinceNudge >= Number(nudge.minTurnsBetween ?? 3);
  if (!input.stop_hook_active && !previous.lastWasNudge && !memoryChanged && signal) {
    reason = 'The user\'s last message looks like it contains something to remember (a preference, decision, blocker, deadline or status), but workspace memory did not change.';
  } else if (allowed && !memoryChanged && workChanged) {
    reason = 'Files changed this turn but workspace memory did not.';
  } else if (allowed && !memoryChanged && state.turnsSinceMemory >= Number(nudge.turnsWithoutMemory ?? 6)) {
    reason = `${state.turnsSinceMemory} turns have passed without a memory update.`;
  }
  if (reason) {
    state.lastWasNudge = true;
    state.sinceNudge = 0;
    state.turnsSinceMemory = 0;
  }
  saveState(file, state);
  if (!reason) return null;
  const projectFlag = context.project ? ` --project ${context.project}` : '';
  return `${reason} If anything durable happened (a decision, a user preference, a status change, a blocker opened or resolved, a reusable fact or lesson), record it now with one command, using only the flags that apply:\n${scriptCommand('capture.mjs')} checkpoint${projectFlag} --state "..." --next "..." --done "..." --decision "title | choice | why" --open "..." --close "match | resolution" --fact "topic | fact" --lesson "title | lesson" --pref "..."\nIf nothing durable happened, reply only "no memory needed".`;
}

// ---------- persistence ----------

function persist(context, label) {
  const { root, config } = context;
  rebuildIndexes(root, config);
  const audit = auditWorkspace(root, config);
  if (!audit.ok) {
    return `Workspace memory was not committed: ${audit.errors.map((item) => `${item.message} (fix: ${item.fix})`).join('; ')}`;
  }
  const result = commitMemory({ root, config, message: label });
  if (result.ok || result.reason === 'not-a-git-repository') return null;
  return `Workspace memory: ${result.reason}${result.error ? ` — ${result.error}` : ''}${result.pushError ? ` — ${result.pushError}` : ''}${result.fix ? ` (fix: ${result.fix})` : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0] || 'turn-end';
  const agent = String(args.agent || 'claude');
  const input = await readInput();
  let context;
  try {
    context = resolveContext(input.cwd || process.cwd());
  } catch {
    return;
  }
  if (!context) return;

  if (mode === 'session-start') {
    // Take the nudge baseline now so the first turn is compared against the session start.
    try { saveBaseline(context, input); } catch {}
    emit({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'SessionStart', additionalContext: startupContext(context) } });
    return;
  }
  if (mode === 'prompt') {
    const file = statePath(context, input.session_id);
    const state = readState(file);
    if (state) saveState(file, { ...state, lastPrompt: String(input.prompt || '').slice(0, 4000) });
    return;
  }
  if (mode === 'nudge') {
    const reason = nudgeDecision(context, input);
    if (reason) emit({ decision: agent === 'gemini' ? 'deny' : 'block', reason });
    return;
  }
  const labels = { 'turn-end': 'turn checkpoint', 'pre-compact': 'checkpoint before compaction', 'session-end': 'session end checkpoint' };
  const message = persist(context, labels[mode] || 'checkpoint');
  if (message) emit({ systemMessage: message });
}

main().catch((error) => {
  emit({ systemMessage: `Workspace memory hook error: ${error.message}` });
});
