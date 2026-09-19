import fs from 'node:fs';
import path from 'node:path';
import { auditWorkspace, formatAudit } from './audit.mjs';
import { commitMemory, formatCommit } from './commit.mjs';
import { autoLink, linkTargets } from './graph.mjs';
import { rebuildIndexes } from './index.mjs';
import {
  UserError,
  cleanField,
  fail,
  isDuplicate,
  memoryDir,
  normalizeText,
  now,
  parseArgs,
  parseFrontmatter,
  readSection,
  readText,
  requireContext,
  scriptCommand,
  sectionHeadings,
  setFrontmatterField,
  slugify,
  splitParts,
  toPosix,
  utcDate,
  utcTimestamp,
  values,
  writeSection,
  writeText,
} from './lib.mjs';

const CAPTURE = scriptCommand('capture.mjs');
const THREAD_SECTIONS = ['Open', 'Blocked', 'Waiting'];
const LIMITS = { Status: 8, 'Recently completed': 10 };

const USAGE = `Usage: ${CAPTURE} checkpoint [flags]   (fill only the flags that apply; each may repeat)
  --objective "..."                 replace the current objective
  --state "..."                     what is true now (newest first, dated)
  --next "..."                      add a next action
  --done "..."                      mark a next action done (moves it to Recently completed)
  --constraint "..."                add a constraint or requirement
  --decision "title | choice | why" record a decision (add --supersedes D-0003 to replace an old one)
  --open "..."  --blocked "..."  --waiting "..."   open a thread
  --close "match | resolution"      close the thread whose text matches
  --fact "topic | fact"             add a durable fact to a topic file
  --lesson "title | lesson"         add a reusable lesson
  --pref "..."                      add a user preference (workspace-wide)
  --drop "..."                      remove an outdated bullet (status, constraint, next action, preference, fact, lesson)
  --session "title | summary"       add a short session note
  --project <name>                  target a linked project's memory
  --commit                          commit now (only needed when hooks are not installed)`;

// ---------- file helpers ----------

function rel(context, filePath) {
  return toPosix(path.relative(context.root, filePath));
}

function edit(filePath, fn) {
  if (!fs.existsSync(filePath)) {
    throw new UserError(`Missing ${filePath}.`, `Re-run ${scriptCommand('init.mjs')} in the workspace to restore missing files.`);
  }
  const before = readText(filePath);
  const after = fn(before);
  if (after !== before) writeText(filePath, after);
  return after !== before;
}

function bulletsOf(content, heading) {
  return readSection(content, heading)?.bullets || [];
}

function stampUpdated(content) {
  return /^Last updated:.*$/m.test(content)
    ? content.replace(/^Last updated:.*$/m, `Last updated: ${utcDate()}`)
    : content;
}

function addBullet(content, heading, text, { prepend = false, limit, dated = false } = {}) {
  const existing = bulletsOf(content, heading);
  if (isDuplicate(text, existing)) return { content, added: false };
  const entry = dated ? `(${utcDate()}) ${text}` : text;
  let next = prepend ? [entry, ...existing] : [...existing, entry];
  if (limit && next.length > limit) next = prepend ? next.slice(0, limit) : next.slice(-limit);
  return { content: writeSection(content, heading, next), added: true };
}

function matchScore(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.95;
  const words = q.split(' ').filter((word) => word.length > 2);
  if (!words.length) return 0;
  const hay = new Set(c.split(' '));
  return (0.9 * words.filter((word) => hay.has(word)).length) / words.length;
}

function bestMatch(query, candidates) {
  const scored = candidates.map((candidate) => ({ ...candidate, score: matchScore(query, candidate.text) }))
    .filter((item) => item.score >= 0.55)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, scored };
  // Identical text in several places (e.g. a duplicate fact): removing either copy is the same outcome.
  const tied = scored.filter((item) => item.score === scored[0].score);
  if (tied.length > 1 && new Set(tied.map((item) => normalizeText(item.text))).size > 1) return { match: null, scored, ambiguous: true };
  return { match: scored[0], scored };
}

function uniquePath(directory, basename) {
  let candidate = path.join(directory, `${basename}.md`);
  for (let counter = 2; fs.existsSync(candidate); counter += 1) {
    candidate = path.join(directory, `${basename}-${String(counter).padStart(2, '0')}.md`);
  }
  return candidate;
}

function list(items) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None.';
}

// Adds links to known decisions/topics/lessons mentioned in text written into `file`.
function linked(context, file, text) {
  context.targets ||= linkTargets(context);
  return autoLink(text, file, context.targets);
}

// Bullets that --drop may remove: CURRENT (not Objective), PROFILE, topics, lessons.
// Threads close with --close and decisions are superseded, so both keep their history.
function droppable(context) {
  const directory = memoryDir(context);
  const candidates = [];
  const add = (file, headings) => {
    if (!fs.existsSync(file)) return;
    const content = readText(file);
    for (const heading of headings || sectionHeadings(content)) {
      bulletsOf(content, heading).forEach((text, index) => candidates.push({ file, heading, text, index }));
    }
  };
  add(path.join(directory, 'CURRENT.md'), ['Status', 'Constraints', 'Next actions', 'Recently completed']);
  add(path.join(context.root, context.config.memoryRoot, 'PROFILE.md'));
  for (const area of ['topics', 'lessons']) {
    for (const file of fs.existsSync(path.join(directory, area)) ? fs.readdirSync(path.join(directory, area)) : []) {
      if (file.endsWith('.md') && file !== 'INDEX.md') add(path.join(directory, area, file), area === 'topics' ? ['Facts'] : ['Lessons']);
    }
  }
  return candidates;
}

// ---------- operations (each returns a short report line) ----------

const ops = {
  objective(context, text) {
    const file = path.join(memoryDir(context), 'CURRENT.md');
    edit(file, (content) => stampUpdated(writeSection(content, 'Objective', [text])));
    return `${rel(context, file)}: objective set`;
  },

  current(context, heading, text, options = {}) {
    const file = path.join(memoryDir(context), 'CURRENT.md');
    let added = false;
    edit(file, (content) => {
      const result = addBullet(content, heading, linked(context, file, text), options);
      added = result.added;
      return added ? stampUpdated(result.content) : content;
    });
    return `${rel(context, file)}: ${heading} ${added ? '+1' : '(duplicate skipped)'}`;
  },

  done(context, text) {
    const file = path.join(memoryDir(context), 'CURRENT.md');
    let removed = null;
    edit(file, (content) => {
      const next = bulletsOf(content, 'Next actions');
      const { match } = bestMatch(text, next.map((item, index) => ({ text: item, index })));
      if (match) {
        removed = match.text;
        content = writeSection(content, 'Next actions', next.filter((_, index) => index !== match.index));
      }
      return stampUpdated(addBullet(content, 'Recently completed', text, { prepend: true, limit: LIMITS['Recently completed'], dated: true }).content);
    });
    return `${rel(context, file)}: done recorded${removed ? ` (removed next action "${removed}")` : ''}`;
  },

  openThread(context, section, text) {
    const file = path.join(memoryDir(context), 'ACTIVE_THREADS.md');
    let added = false;
    edit(file, (content) => {
      const all = THREAD_SECTIONS.flatMap((heading) => bulletsOf(content, heading));
      if (isDuplicate(text, all)) return content;
      added = true;
      return addBullet(content, section, linked(context, file, text), { dated: true }).content;
    });
    return `${rel(context, file)}: ${section} ${added ? '+1' : '(already open, skipped)'}`;
  },

  closeThread(context, query, resolution) {
    const file = path.join(memoryDir(context), 'ACTIVE_THREADS.md');
    const content = readText(file);
    const candidates = THREAD_SECTIONS.flatMap((section) => bulletsOf(content, section).map((text, index) => ({ section, text, index })));
    const { match, scored, ambiguous } = bestMatch(query, candidates);
    if (!match) {
      const open = candidates.map((item) => `"${item.text}"`).join('; ') || 'none';
      const next = bestMatch(query, bulletsOf(readText(path.join(memoryDir(context), 'CURRENT.md')), 'Next actions').map((text) => ({ text }))).match;
      if (next) throw new UserError(`"${query}" is a next action, not an open thread.`, `Mark it finished with --done "${next.text}" instead of --close.`);
      throw new UserError(
        ambiguous ? `"${query}" matches several threads: ${scored.map((item) => `"${item.text}"`).join('; ')}` : `No open thread matches "${query}". Open threads: ${open}`,
        `Use more of the exact thread text: --close "<words from the thread> | <resolution>"${candidates.length ? '' : ', or record the outcome with --state instead'}`,
      );
    }
    const remaining = bulletsOf(content, match.section).filter((_, index) => index !== match.index);
    writeText(file, writeSection(content, match.section, remaining));
    const thread = match.text.replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, '');
    ops.current(context, 'Recently completed', `Resolved: ${thread} — ${resolution}`, { prepend: true, limit: LIMITS['Recently completed'], dated: true });
    return `${rel(context, file)}: closed "${thread}" (${match.section})`;
  },

  note(context, area, title, text, sectionHeading) {
    const directory = path.join(memoryDir(context), area);
    const file = path.join(directory, `${slugify(title)}.md`);
    if (!fs.existsSync(file)) {
      context.targets = null;
      writeText(file, `---\ntype: ${area === 'topics' ? 'topic' : 'lesson'}\nupdated: "${utcDate()}"\n---\n\n# ${title}\n\n## ${sectionHeading}\n\n- None.\n`);
    }
    let added = false;
    edit(file, (content) => {
      const result = addBullet(content, sectionHeading, `${linked(context, file, text)} (${utcDate()})`);
      added = result.added;
      return added ? setFrontmatterField(result.content, 'updated', utcDate()) : content;
    });
    return `${rel(context, file)}: ${added ? '+1' : '(duplicate skipped)'}`;
  },

  drop(context, query) {
    const candidates = droppable(context);
    const { match, scored, ambiguous } = bestMatch(query, candidates);
    if (!match) {
      const near = candidates.map((item) => ({ ...item, score: matchScore(query, item.text) })).sort((a, b) => b.score - a.score).slice(0, 5);
      throw new UserError(
        ambiguous ? `"${query}" matches several bullets: ${scored.slice(0, 5).map((item) => `"${item.text}" (${rel(context, item.file)})`).join('; ')}` : `No bullet matches "${query}". Closest: ${near.map((item) => `"${item.text}"`).join('; ') || 'none'}`,
        'Use more of the exact bullet text: --drop "<words from the bullet>". Threads use --close; decisions use --supersedes.',
      );
    }
    edit(match.file, (content) => {
      const bullets = bulletsOf(content, match.heading).filter((_, index) => index !== match.index);
      const next = writeSection(content, match.heading, bullets);
      return /^Last updated:/m.test(next) ? stampUpdated(next) : next;
    });
    // Removing a rule the user relied on is itself news: keep a trace in the startup view.
    if (['Constraints', 'Preferences', 'Working style'].includes(match.heading)) {
      const plain = match.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      ops.current(context, 'Recently completed', `No longer applies: ${plain}`, { prepend: true, limit: LIMITS['Recently completed'], dated: true });
    }
    return `${rel(context, match.file)}: dropped "${match.text}" (${match.heading})`;
  },

  pref(context, text, section = 'Preferences') {
    const file = path.join(context.root, context.config.memoryRoot, 'PROFILE.md');
    let added = false;
    edit(file, (content) => {
      const result = addBullet(content, section, text);
      added = result.added;
      return result.content;
    });
    return `${rel(context, file)}: ${section} ${added ? '+1' : '(duplicate skipped)'}`;
  },

  decision(context, { title, choice: rawChoice, why: rawWhy, alternatives = [], consequences = [], supersedes = [], status = 'accepted' }) {
    const directory = path.join(memoryDir(context), 'decisions');
    fs.mkdirSync(directory, { recursive: true });
    let choice = rawChoice;
    let why = rawWhy;
    for (const name of fs.readdirSync(directory)) {
      if (!/^D-\d{4}-/.test(name)) continue;
      const existing = parseFrontmatter(readText(path.join(directory, name)));
      if (existing.status !== 'superseded' && normalizeText(readText(path.join(directory, name)).match(/^#\s+(.+)$/m)?.[1] || '') === normalizeText(title)) {
        throw new UserError(`A decision titled "${title}" already exists (${name}).`, `If it changed, record a new one that replaces it: --decision "<new title> | <choice> | <why>" --supersedes ${name.slice(0, 6)}`);
      }
    }
    choice = linked(context, path.join(directory, 'D-new.md'), choice);
    why = linked(context, path.join(directory, 'D-new.md'), why);
    const max = fs.readdirSync(directory).reduce((value, name) => Math.max(value, Number(name.match(/^D-(\d{4})-/)?.[1] || 0)), 0);
    const id = `D-${String(max + 1).padStart(4, '0')}`;
    const file = uniquePath(directory, `${id}-${slugify(title)}`);
    const supersededLinks = [];
    for (const oldId of supersedes) {
      const oldName = fs.readdirSync(directory).find((name) => name.startsWith(`${oldId.toUpperCase()}-`));
      if (!oldName) throw new UserError(`--supersedes ${oldId}: no such decision.`, `List decisions with: ls ${rel(context, directory)}`);
      const oldFile = path.join(directory, oldName);
      let oldContent = setFrontmatterField(readText(oldFile), 'status', 'superseded');
      oldContent = writeSection(oldContent, 'Superseded by', [`[${id}: ${title}](${path.basename(file)}) (${utcDate()})`]);
      writeText(oldFile, oldContent);
      supersededLinks.push(`[${oldId.toUpperCase()}](${oldName})`);
    }
    writeText(file, `---
type: decision
id: "${id}"
date: "${utcDate()}"
status: "${status}"
---

# ${title}

## Decision

${choice}

## Why

${why}

## Consequences

${list(consequences)}

## Alternatives considered

${list(alternatives)}

## Supersedes

${list(supersededLinks)}
`);
    context.targets = null;
    return `${rel(context, file)}: ${id} recorded${supersededLinks.length ? ` (supersedes ${supersedes.join(', ')})` : ''}`;
  },

  session(context, { title, summary, outcomes = [], open = [], files = [] }) {
    const stamp = now();
    const directory = path.join(memoryDir(context), 'sessions');
    const file = uniquePath(directory, `${utcDate(stamp)}-${utcTimestamp(stamp).slice(9, 13)}-${slugify(title)}`);
    writeText(file, `---
type: session
date: "${utcDate(stamp)}"
---

# ${title}

## Summary

${summary}

## Outcomes

${list(outcomes)}

## Open threads

${list(open)}

## Files changed

${list(files)}
`);
    return `${rel(context, file)}: session recorded`;
  },
};

// ---------- command parsing: validate everything first, then apply ----------

function field(args, key, options) {
  return values(args, key).map((value) => cleanField(key, value, options));
}

function planCheckpoint(args) {
  const plan = [];
  for (const text of field(args, 'objective')) plan.push((c) => ops.objective(c, text));
  for (const text of field(args, 'state')) plan.push((c) => ops.current(c, 'Status', text, { prepend: true, limit: LIMITS.Status, dated: true }));
  for (const text of field(args, 'next')) plan.push((c) => ops.current(c, 'Next actions', text));
  for (const text of field(args, 'constraint')) plan.push((c) => ops.current(c, 'Constraints', text));
  for (const text of field(args, 'done')) plan.push((c) => ops.done(c, text));
  const supersedes = values(args, 'supersedes');
  const decisions = values(args, 'decision');
  if (supersedes.length && decisions.length !== 1) throw new UserError('--supersedes needs exactly one --decision.', 'Record the replacing decision in its own checkpoint call.');
  for (const raw of decisions) {
    const [title, choice, why] = splitParts('decision', raw, 3, 'Use Postgres | Postgres 16 on RDS | JSONB support and team familiarity');
    const item = { title: cleanField('decision title', title, { max: 120 }), choice: cleanField('decision choice', choice), why: cleanField('decision why', why), supersedes };
    plan.push((c) => ops.decision(c, item));
  }
  for (const [flag, section] of [['open', 'Open'], ['blocked', 'Blocked'], ['waiting', 'Waiting']]) {
    for (const text of field(args, flag)) plan.push((c) => ops.openThread(c, section, text));
  }
  for (const raw of values(args, 'close')) {
    const [match, resolution] = splitParts('close', raw, 2, 'legal approval | Approved by legal on the call');
    const item = [cleanField('close match', match), cleanField('close resolution', resolution)];
    plan.push((c) => ops.closeThread(c, ...item));
  }
  for (const raw of values(args, 'fact')) {
    const [topic, text] = splitParts('fact', raw, 2, 'Vendor contracts | Payment terms are net-60');
    const item = [cleanField('fact topic', topic, { max: 80 }), cleanField('fact', text)];
    plan.push((c) => ops.note(c, 'topics', item[0], item[1], 'Facts'));
  }
  for (const raw of values(args, 'lesson')) {
    const [title, text] = splitParts('lesson', raw, 2, 'Budget reviews | Send numbers a day early; finance needs a day to validate');
    const item = [cleanField('lesson title', title, { max: 80 }), cleanField('lesson', text)];
    plan.push((c) => ops.note(c, 'lessons', item[0], item[1], 'Lessons'));
  }
  for (const text of field(args, 'drop')) plan.push((c) => ops.drop(c, text));
  for (const text of field(args, 'pref', { example: 'Prefers bullet summaries of at most 5 points' })) plan.push((c) => ops.pref(c, text));
  for (const raw of values(args, 'session')) {
    const [title, summary] = splitParts('session', raw, 2, 'Q3 plan review | Agreed scope and owners for Q3');
    const item = { title: cleanField('session title', title, { max: 120 }), summary: cleanField('session summary', summary, { max: 1000 }) };
    plan.push((c) => ops.session(c, item));
  }
  return plan;
}

function planSubcommand(type, args) {
  const one = (key, options) => {
    const value = values(args, key)[0];
    if (!value) throw new UserError(`--${key} is required for "${type}".`, USAGE_BY_TYPE[type]);
    return cleanField(key, value, options);
  };
  switch (type) {
    case 'decision': {
      const item = {
        title: one('title', { max: 120 }),
        choice: one('decision'),
        why: values(args, 'why')[0] || values(args, 'context')[0] ? cleanField('why', values(args, 'why')[0] || values(args, 'context')[0]) : (() => { throw new UserError('--why is required for "decision".', USAGE_BY_TYPE.decision); })(),
        consequences: field(args, 'consequence'),
        alternatives: field(args, 'alternative'),
        supersedes: values(args, 'supersedes'),
        status: values(args, 'status')[0] || 'accepted',
      };
      return [(c) => ops.decision(c, item)];
    }
    case 'session': {
      const item = {
        title: one('title', { max: 120 }),
        summary: cleanField('summary', values(args, 'summary')[0] || values(args, 'objective')[0], { max: 1000 }),
        outcomes: field(args, 'outcome'),
        open: field(args, 'open'),
        files: field(args, 'file'),
      };
      return [(c) => ops.session(c, item)];
    }
    case 'topic': {
      const title = one('title', { max: 80 });
      return field(args, 'fact').map((text) => (c) => ops.note(c, 'topics', title, text, 'Facts'));
    }
    case 'lesson': {
      const title = one('title', { max: 80 });
      return field(args, 'lesson').map((text) => (c) => ops.note(c, 'lessons', title, text, 'Lessons'));
    }
    case 'pref': {
      const section = values(args, 'section')[0] || 'Preferences';
      return field(args, 'text').map((text) => (c) => ops.pref(c, text, section));
    }
    case 'thread': {
      const action = args._[1];
      if (action === 'open') {
        const section = values(args, 'section')[0] || 'Open';
        if (!THREAD_SECTIONS.includes(section)) throw new UserError(`--section must be one of ${THREAD_SECTIONS.join(', ')}.`, USAGE_BY_TYPE.thread);
        return field(args, 'text').map((text) => (c) => ops.openThread(c, section, text));
      }
      if (action === 'close') {
        const item = [one('match'), one('resolution')];
        return [(c) => ops.closeThread(c, ...item)];
      }
      throw new UserError('thread needs "open" or "close".', USAGE_BY_TYPE.thread);
    }
    case 'current': {
      const section = values(args, 'section')[0];
      if (!section) throw new UserError('--section is required.', USAGE_BY_TYPE.current);
      const plan = [];
      if (values(args, 'set').length) {
        const items = field(args, 'set');
        plan.push((c) => {
          const file = path.join(memoryDir(c), 'CURRENT.md');
          edit(file, (content) => stampUpdated(writeSection(content, section, items)));
          return `${rel(c, file)}: ${section} replaced`;
        });
      }
      for (const text of field(args, 'add')) plan.push((c) => ops.current(c, section, text));
      for (const text of field(args, 'remove')) {
        plan.push((c) => {
          const file = path.join(memoryDir(c), 'CURRENT.md');
          const content = readText(file);
          const bullets = bulletsOf(content, section);
          const { match } = bestMatch(text, bullets.map((item, index) => ({ text: item, index })));
          if (!match) throw new UserError(`No bullet in "${section}" matches "${text}".`, `Current bullets: ${bullets.map((item) => `"${item}"`).join('; ') || 'none'}`);
          writeText(file, stampUpdated(writeSection(content, section, bullets.filter((_, index) => index !== match.index))));
          return `${rel(c, file)}: ${section} -1`;
        });
      }
      return plan;
    }
    default:
      throw new UserError(`Unknown command "${type}".`, USAGE);
  }
}

const USAGE_BY_TYPE = {
  decision: `${CAPTURE} decision --title "..." --decision "..." --why "..." [--consequence ...] [--alternative ...] [--supersedes D-0001]`,
  session: `${CAPTURE} session --title "..." --summary "..." [--outcome ...] [--open ...] [--file ...]`,
  thread: `${CAPTURE} thread open --text "..." [--section Open|Blocked|Waiting]   |   ${CAPTURE} thread close --match "..." --resolution "..."`,
  current: `${CAPTURE} current --section "Next actions" [--add "..."] [--remove "..."] [--set "..."]`,
};

// Text that announces a change usually makes an older bullet wrong. Point at likely candidates
// so the agent can --drop them (deterministic hint; nothing is removed automatically).
const CHANGE_WORDS = /\b(no longer|not anymore|lifted|removed|cancel+ed|canceled|dropped|replaced|instead of|changed|moved to|switched|correction|actually|now\b|increased|reduced|extended|postponed|delayed)/i;

function contradictionHints(context, args) {
  const added = ['state', 'fact', 'pref', 'constraint', 'objective'].flatMap((key) => values(args, key).map((value) => value.split('|').pop()));
  const hints = [];
  const candidates = droppable(context);
  const significant = (text) => new Set(normalizeText(text).split(' ').filter((word) => word.length > 2 && !/^\d{4}$/.test(word)));
  for (const text of added.filter((item) => CHANGE_WORDS.test(item))) {
    const mine = significant(text);
    for (const candidate of candidates) {
      if (isDuplicate(text, [candidate.text])) continue;
      const theirs = significant(candidate.text);
      const shared = [...theirs].filter((word) => mine.has(word)).length;
      if (theirs.size && shared / theirs.size >= 0.5 && shared >= 2) {
        hints.push(`check: "${candidate.text}" (${rel(context, candidate.file)} → ${candidate.heading}) may now be outdated. If so: ${CAPTURE} checkpoint${context.project ? ` --project ${context.project}` : ''} --drop "${candidate.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '').slice(0, 80)}"`);
      }
    }
  }
  return [...new Set(hints)].slice(0, 5);
}

// All-or-nothing: if any step fails, memory files are restored exactly as they were.
function transaction(context, fn) {
  const memoryRoot = path.join(context.root, context.config.memoryRoot);
  const snapshot = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) snapshot.set(full, fs.readFileSync(full));
    }
  };
  walk(memoryRoot);
  try {
    return fn();
  } catch (error) {
    const restore = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) restore(full);
        else if (!snapshot.has(full)) fs.rmSync(full);
      }
    };
    restore(memoryRoot);
    for (const [file, content] of snapshot) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) fs.writeFileSync(file, content);
    }
    if (error instanceof UserError) error.message += ' Nothing was changed; fix this flag and re-run the whole command.';
    throw error;
  }
}

function commitMessage(reports) {
  const first = reports[0]?.split(': ').slice(1).join(': ') || 'update';
  return reports.length > 1 ? `checkpoint (${reports.length} updates)` : `checkpoint: ${first}`.slice(0, 72);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const type = args._[0];
  if (!type || args.help) {
    process.stdout.write(`${USAGE}\n`);
    if (!type) process.exitCode = 1;
    return;
  }
  const context = requireContext(args);
  const plan = type === 'checkpoint' ? planCheckpoint(args) : planSubcommand(type, args);
  if (!plan.length) throw new UserError('Nothing to record: no flags were given.', USAGE);

  const reports = transaction(context, () => plan.map((step) => step(context)));
  rebuildIndexes(context.root, context.config);
  const audit = auditWorkspace(context.root, context.config);
  const lines = [...reports, ...(type === 'checkpoint' && !values(args, 'drop').length ? contradictionHints(context, args) : [])];
  if (!audit.ok || audit.warnings.length) lines.push(formatAudit(audit));
  if (args.commit) {
    const commit = commitMemory({ root: context.root, config: context.config, message: commitMessage(reports) });
    lines.push(formatCommit(commit));
    if (!commit.ok) process.exitCode = 1;
  }
  if (!audit.ok) process.exitCode = 1;
  process.stdout.write(`${args.json ? JSON.stringify({ reports, audit }, null, 2) : lines.join('\n')}\n`);
}

main().catch(fail);
