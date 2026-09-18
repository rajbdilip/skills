#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(root, "skills");
const errors = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walk(path);
    return entry.name === "SKILL.md" ? [path] : [];
  });
}

function parseFrontmatter(content, file) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push(`${file}: missing YAML frontmatter`);
    return {};
  }

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}

function validateLinks(content, skillFile) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const decoded = decodeURIComponent(target);
    if (!existsSync(resolve(dirname(skillFile), decoded))) {
      errors.push(`${relative(root, skillFile)}: broken relative link ${target}`);
    }
  }
}

if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
  errors.push("skills/: directory is missing");
} else {
  const skillFiles = walk(skillsRoot).sort();
  const names = new Map();

  if (skillFiles.length === 0) errors.push("skills/: no SKILL.md files found");

  for (const absoluteFile of skillFiles) {
    const file = relative(root, absoluteFile);
    const content = readFileSync(absoluteFile, "utf8");
    const fields = parseFrontmatter(content, file);
    const folder = basename(dirname(absoluteFile));

    if (!fields.name) errors.push(`${file}: frontmatter is missing name`);
    if (!fields.description) errors.push(`${file}: frontmatter is missing description`);
    if (fields.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name)) {
      errors.push(`${file}: name must use lowercase letters, digits, and single hyphens`);
    }
    if (fields.name && fields.name.length > 64) errors.push(`${file}: name exceeds 64 characters`);
    if (fields.name && fields.name !== folder) {
      errors.push(`${file}: name must match its parent directory (${folder})`);
    }
    if (fields.description && fields.description.length > 1024) {
      errors.push(`${file}: description exceeds 1024 characters`);
    }
    if (/\b(?:TODO|TBD|FIXME)\b/i.test(content)) errors.push(`${file}: contains an unfinished placeholder`);
    if (fields.name && names.has(fields.name)) {
      errors.push(`${file}: duplicate skill name also used by ${names.get(fields.name)}`);
    } else if (fields.name) {
      names.set(fields.name, file);
    }

    validateLinks(content, absoluteFile);
  }

  if (errors.length === 0) {
    console.log(`Validated ${skillFiles.length} skill${skillFiles.length === 1 ? "" : "s"}.`);
  }
}

if (errors.length > 0) {
  console.error("Skill validation failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
