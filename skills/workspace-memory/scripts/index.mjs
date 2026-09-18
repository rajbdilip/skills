import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, noteTitle, relLink, setBacklinks } from './graph.mjs';
import {
  allMemoryDirs,
  fail,
  firstHeading,
  isMain,
  listMarkdownFiles,
  parseArgs,
  parseFrontmatter,
  readText,
  replaceManagedBlock,
  requireContext,
  toPosix,
  writeText,
} from './lib.mjs';

const AREAS = ['decisions', 'topics', 'lessons', 'sessions', 'archive'];

function readRecord(filePath, baseDirectory) {
  const content = readText(filePath);
  const metadata = parseFrontmatter(content);
  const fallback = path.basename(filePath, '.md');
  const dated = fallback.match(/^\d{4}-\d{2}-\d{2}/);
  return {
    link: toPosix(path.relative(baseDirectory, filePath)),
    title: firstHeading(content, fallback),
    date: metadata.date || metadata.updated || (dated ? dated[0] : ''),
    id: metadata.id || '',
    status: metadata.status && metadata.status !== 'complete' ? metadata.status : '',
  };
}

function sortNewest(records) {
  return records.sort((left, right) => `${right.date}|${right.link}`.localeCompare(`${left.date}|${left.link}`));
}

function item(record, prefix = '') {
  const identity = record.id ? `${record.id}: ` : '';
  const state = record.status ? ` — ${record.status}` : '';
  const date = record.date ? ` (${record.date})` : '';
  return `- [${identity}${record.title}](${prefix}${record.link})${date}${state}`;
}

function block(marker, lines, empty = '- None yet.') {
  return `<!-- workspace-memory:${marker}:start -->\n${lines.length ? lines.join('\n') : empty}\n<!-- workspace-memory:${marker}:end -->`;
}

function setBlock(filePath, marker, lines, empty) {
  if (!fs.existsSync(filePath)) return;
  const current = readText(filePath);
  const start = `<!-- workspace-memory:${marker}:start -->`;
  if (!current.includes(start) && marker !== 'index') return;
  writeText(filePath, replaceManagedBlock(current, start, `<!-- workspace-memory:${marker}:end -->`, block(marker, lines, empty)));
}

function rebuildDirectory(directory, config) {
  const counts = {};
  const records = {};
  for (const area of AREAS) {
    const areaPath = path.join(directory, area);
    if (!fs.existsSync(areaPath)) continue;
    const list = sortNewest(listMarkdownFiles(areaPath, { recursive: area === 'archive' }).map((file) => readRecord(file, areaPath)));
    records[area] = list;
    counts[area] = list.length;
    const lines = list.slice(0, 200).map((record) => item(record));
    if (list.length > 200) lines.push(`- ${list.length - 200} older records omitted; search this directory with \`rg\`.`);
    setBlock(path.join(areaPath, 'INDEX.md'), 'index', lines);
  }
  const indexPath = path.join(directory, 'INDEX.md');
  setBlock(indexPath, 'recent-decisions', (records.decisions || []).slice(0, Number(config.index?.recentDecisions || 5)).map((record) => item(record, 'decisions/')));
  setBlock(indexPath, 'recent-sessions', (records.sessions || []).slice(0, Number(config.index?.recentSessions || 5)).map((record) => item(record, 'sessions/')));
  return counts;
}

// Adds a generated "Referenced by" block to every decision, topic and lesson that other notes link to.
function rebuildBacklinks(root, config) {
  const graph = buildGraph(root, config);
  for (const file of graph.files) {
    const area = path.basename(path.dirname(file));
    if (!['decisions', 'topics', 'lessons'].includes(area) || path.basename(file) === 'INDEX.md') continue;
    const sources = [...(graph.incoming.get(file) || [])].sort();
    const items = sources.map((source) => `[${noteTitle(source)}](${relLink(file, source)})`);
    const content = readText(file);
    const next = setBacklinks(content, items);
    if (next !== content) writeText(file, next);
  }
}

export function rebuildIndexes(root, config) {
  const result = {};
  const dirs = allMemoryDirs(root, config);
  for (const directory of dirs) {
    if (!fs.existsSync(directory)) continue;
    result[toPosix(path.relative(root, directory))] = rebuildDirectory(directory, config);
  }
  rebuildBacklinks(root, config);
  const projects = Object.entries(config.projects || {}).map(([name, entry]) => `- [${name}](projects/${name}/INDEX.md) — \`${entry.path}\``);
  setBlock(path.join(root, config.memoryRoot, 'INDEX.md'), 'projects', projects, '- None.');
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const context = requireContext(parseArgs(process.argv.slice(2)));
    const result = rebuildIndexes(context.root, context.config);
    for (const [directory, counts] of Object.entries(result)) {
      process.stdout.write(`${directory}: ${Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(', ')}\n`);
    }
  } catch (error) {
    fail(error);
  }
}
