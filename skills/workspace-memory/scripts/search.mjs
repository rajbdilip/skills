// Ranked keyword search (BM25) over memory notes, plus link-based "related notes".
// Plain Node, no dependencies, same results on every OS.
//   search.mjs "venue catering vegan"          best matching lines, grouped by note
//   search.mjs --related topics/venues.md      notes linked to/from a note (2 hops)
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, noteTitle, stripBacklinks } from './graph.mjs';
import {
  UserError,
  fail,
  firstHeading,
  isMain,
  listMarkdownFiles,
  memoryDir,
  parseArgs,
  readText,
  requireContext,
  toPosix,
  values,
} from './lib.mjs';

const STOPWORDS = new Set('a an and are as at be but by do does for from had has have how i in is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about into not no yes can could should would did done any all also just than too very more most some such only own same other'.split(' '));

function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  return String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bD-(\d{4})\b/gi, 'd$1')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .map(stem);
}

const WEIGHT = { archive: 0.5, sessions: 0.8 };

// Each non-empty content line is a searchable unit, carrying its note title and section heading as context.
// Everything under memory/ is searched; inside a linked repo, that project's notes rank higher.
function collectUnits(context) {
  const memoryRoot = path.join(context.root, context.config.memoryRoot);
  const projectDir = context.project ? `${memoryDir(context)}${path.sep}` : null;
  const files = listMarkdownFiles(memoryRoot, { recursive: true });
  const units = [];
  for (const file of files) {
    const raw = stripBacklinks(readText(file));
    const frontmatter = raw.match(/^---\n[\s\S]*?\n---\n/)?.[0] || '';
    const offset = frontmatter ? frontmatter.split('\n').length - 1 : 0;
    const content = raw.slice(frontmatter.length);
    const title = firstHeading(content, path.basename(file, '.md'));
    const area = toPosix(path.relative(memoryRoot, file)).split('/').find((part) => WEIGHT[part]) || '';
    let heading = '';
    content.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) { heading = trimmed.replace(/^#+\s*/, ''); return; }
      if (!trimmed || trimmed === '- None.' || trimmed === '- None yet.' || trimmed.startsWith('<!--')) return;
      const text = trimmed.replace(/^-\s+/, '');
      const boost = projectDir && file.startsWith(projectDir) ? 1.3 : 1;
      units.push({ file, title, heading, line: index + 1 + offset, text, weight: (WEIGHT[area] || 1) * boost, tokens: [...tokenize(text), ...tokenize(`${title} ${heading}`)] });
    });
  }
  return units;
}

export function search(context, query, options = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) throw new UserError('The query has no searchable words.', 'Use nouns from the topic, e.g. search.mjs "caterer vegan notice"');
  const units = collectUnits(context);
  const df = new Map();
  for (const unit of units) for (const term of new Set(unit.tokens)) df.set(term, (df.get(term) || 0) + 1);
  const avg = units.reduce((sum, unit) => sum + unit.tokens.length, 0) / (units.length || 1);
  const k1 = 1.2;
  const b = 0.75;
  const phrase = query.trim().toLowerCase();
  const scored = [];
  for (const unit of units) {
    let score = 0;
    const counts = new Map();
    for (const token of unit.tokens) counts.set(token, (counts.get(token) || 0) + 1);
    let matched = 0;
    for (const term of terms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      matched += 1;
      const idf = Math.log(1 + (units.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * unit.tokens.length) / avg)));
    }
    if (!score) continue;
    score *= 0.5 + (0.5 * matched) / terms.length;
    if (phrase.length > 3 && unit.text.toLowerCase().includes(phrase)) score *= 1.5;
    scored.push({ ...unit, score: score * unit.weight });
  }
  const byFile = new Map();
  for (const unit of scored.sort((x, y) => y.score - x.score)) {
    if (!byFile.has(unit.file)) byFile.set(unit.file, { file: unit.file, title: unit.title, score: 0, hits: [] });
    const entry = byFile.get(unit.file);
    entry.score += entry.hits.length ? unit.score * 0.3 : unit.score;
    if (entry.hits.length < 3) entry.hits.push(unit);
  }
  return [...byFile.values()].sort((x, y) => y.score - x.score).slice(0, options.limit || 8);
}

function resolveNote(context, reference, graph) {
  const candidates = [path.resolve(context.root, reference), path.resolve(graph.memoryRoot, reference), path.resolve(memoryDir(context), reference)];
  const direct = candidates.find((file) => fs.existsSync(file) && file.endsWith('.md'));
  if (direct) return direct;
  const lower = reference.toLowerCase();
  const byTitle = graph.files.filter((file) => path.basename(file) !== 'INDEX.md' && noteTitle(file).toLowerCase().includes(lower));
  if (byTitle.length === 1) return byTitle[0];
  throw new UserError(
    byTitle.length ? `"${reference}" matches several notes: ${byTitle.slice(0, 5).map((file) => toPosix(path.relative(context.root, file))).join(', ')}` : `No note found for "${reference}".`,
    'Pass the note path as shown by search.mjs, e.g. --related memory/topics/venues.md',
  );
}

export function related(context, reference, depth = 2) {
  const graph = buildGraph(context.root, context.config);
  const start = resolveNote(context, reference, graph);
  const seen = new Map([[start, { hops: 0, via: 'start' }]]);
  let frontier = [start];
  for (let hop = 1; hop <= depth; hop += 1) {
    const next = [];
    for (const file of frontier) {
      for (const [target, via] of [...[...(graph.out.get(file) || [])].map((item) => [item, 'links to']), ...[...(graph.incoming.get(file) || [])].map((item) => [item, 'linked from'])]) {
        if (seen.has(target) || path.basename(target) === 'INDEX.md') continue;
        seen.set(target, { hops: hop, via: `${via} ${noteTitle(file)}` });
        next.push(target);
      }
    }
    frontier = next;
  }
  return { start, notes: [...seen.entries()].filter(([file]) => file !== start).map(([file, info]) => ({ file, ...info })) };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const context = requireContext(args);
    const rel = (file) => toPosix(path.relative(context.root, file));
    const lines = [];
    if (values(args, 'related').length) {
      const result = related(context, values(args, 'related')[0], Number(values(args, 'depth')[0] || 2));
      lines.push(`related to ${rel(result.start)} (${noteTitle(result.start)}):`);
      for (const note of result.notes) lines.push(`  ${rel(note.file)} — ${noteTitle(note.file)} [${note.hops} hop${note.hops > 1 ? 's' : ''}: ${note.via}]`);
      if (!result.notes.length) lines.push('  no linked notes yet');
    } else {
      const query = args._.join(' ') || values(args, 'query')[0] || '';
      const results = search(context, query, { limit: Number(values(args, 'limit')[0] || 8) });
      if (!results.length) lines.push(`no matches for "${query}". Try other words (synonyms, names, dates), or list files: ls ${context.config.memoryRoot}/topics`);
      for (const result of results) {
        lines.push(`${rel(result.file)} — ${result.title}`);
        for (const hit of result.hits) lines.push(`  ${hit.line}: ${hit.text.length > 200 ? `${hit.text.slice(0, 200)}…` : hit.text}`);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (error) {
    fail(error);
  }
}
