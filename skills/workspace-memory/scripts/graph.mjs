// Note-to-note links: standard relative Markdown links (render in GitHub/GitLab/Bitbucket, Obsidian, VS Code).
// The scripts add links automatically; models never have to write link syntax.
import fs from 'node:fs';
import path from 'node:path';
import { firstHeading, listMarkdownFiles, memoryDir, parseFrontmatter, readText, toPosix } from './lib.mjs';

export const BACKLINK_START = '<!-- workspace-memory:backlinks:start -->';
export const BACKLINK_END = '<!-- workspace-memory:backlinks:end -->';
const LINKABLE_AREAS = ['decisions', 'topics', 'lessons'];

export function stripBacklinks(content) {
  const start = content.indexOf(BACKLINK_START);
  const end = content.indexOf(BACKLINK_END);
  if (start < 0 || end < start) return content;
  return `${content.slice(0, start).trimEnd()}\n${content.slice(end + BACKLINK_END.length).replace(/^\n+/, '')}`;
}

export function setBacklinks(content, items) {
  const base = stripBacklinks(content).trimEnd();
  if (!items.length) return `${base}\n`;
  return `${base}\n\n${BACKLINK_START}\n## Referenced by\n\n${items.map((item) => `- ${item}`).join('\n')}\n${BACKLINK_END}\n`;
}

// Resolved memory-file targets of the Markdown links in a file (backlink blocks excluded).
export function outgoingLinks(file, content, memoryRoot) {
  const targets = new Set();
  for (const match of stripBacklinks(content).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch {}
    const target = path.resolve(path.dirname(file), decoded);
    if (target !== file && target.startsWith(memoryRoot) && target.endsWith('.md') && fs.existsSync(target)) targets.add(target);
  }
  return targets;
}

// Graph over all memory notes. INDEX files are navigation, not knowledge, so they are not link sources.
export function buildGraph(root, config) {
  const memoryRoot = path.join(root, config.memoryRoot);
  const files = listMarkdownFiles(memoryRoot, { recursive: true, includeIndex: true });
  const out = new Map();
  const incoming = new Map();
  for (const file of files) {
    if (path.basename(file) === 'INDEX.md') continue;
    const targets = outgoingLinks(file, readText(file), memoryRoot);
    out.set(file, targets);
    for (const target of targets) {
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target).add(file);
    }
  }
  return { memoryRoot, files, out, incoming };
}

export function noteTitle(file) {
  const content = readText(file);
  const meta = parseFrontmatter(content);
  const title = firstHeading(content, path.basename(file, '.md'));
  return meta.id && !title.startsWith(meta.id) ? `${meta.id}: ${title}` : title;
}

export function relLink(fromFile, toFile) {
  return toPosix(path.relative(path.dirname(fromFile), toFile));
}

// Decisions, topics and lessons that new text may link to: the context's own memory dir first,
// then the hub (so project notes can reference workspace-wide topics).
export function linkTargets(context) {
  const dirs = [memoryDir(context)];
  const hub = path.join(context.root, context.config.memoryRoot);
  if (!dirs.includes(hub)) dirs.push(hub);
  const targets = [];
  const seenIds = new Set();
  for (const directory of dirs) {
    for (const area of LINKABLE_AREAS) {
      for (const file of listMarkdownFiles(path.join(directory, area))) {
        const content = readText(file);
        const meta = parseFrontmatter(content);
        const title = firstHeading(content, path.basename(file, '.md'));
        const id = meta.id && !seenIds.has(meta.id) ? meta.id : '';
        if (id) seenIds.add(id);
        targets.push({ file, title, id, status: meta.status || '' });
      }
    }
  }
  return targets;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insideLink(text, index) {
  const before = text.slice(0, index);
  return before.lastIndexOf('[') > before.lastIndexOf(']') || before.lastIndexOf('](') > before.lastIndexOf(')');
}

// Links the first mention of each known decision ID or note title in `text` (max 3 links).
export function autoLink(text, fromFile, targets) {
  let result = text;
  let added = 0;
  const ordered = [...targets].sort((a, b) => b.title.length - a.title.length);
  for (const target of ordered) {
    if (added >= 3) break;
    if (path.resolve(target.file) === path.resolve(fromFile)) continue;
    const patterns = [];
    if (target.id) patterns.push(new RegExp(`\\b${escapeRegExp(target.id)}\\b`));
    const words = target.title.trim().split(/\s+/);
    if (target.status !== 'superseded' && (target.title.length >= 6 || words.length >= 2)) {
      patterns.push(new RegExp(`(?<![\\w\\[])${escapeRegExp(target.title.trim())}(?![\\w\\]])`, 'i'));
    }
    for (const pattern of patterns) {
      const match = pattern.exec(result);
      if (!match || insideLink(result, match.index)) continue;
      const link = `[${match[0]}](${relLink(fromFile, target.file)})`;
      result = `${result.slice(0, match.index)}${link}${result.slice(match.index + match[0].length)}`;
      added += 1;
      break;
    }
  }
  return result;
}
