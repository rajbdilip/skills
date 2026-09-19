import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'scripts/cli.mjs');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'rajbdilip-skills-test-'));
const project = join(temporaryRoot, 'project');
const fakeHome = join(temporaryRoot, 'home');

function run(args, cwd = project) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CODEX_HOME: join(fakeHome, '.codex') },
  });
}

try {
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);

  const listed = run(['list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map((skill) => skill.name), ['workspace-memory']);

  const missingAgent = run(['add', '-s', 'workspace-memory', '-y']);
  assert.notEqual(missingAgent.status, 0);
  assert.match(missingAgent.stderr, /No agents detected/);

  const added = run(['add', '--skill', 'workspace-memory', '--agent', 'claude-code', '--yes']);
  assert.equal(added.status, 0, added.stderr);
  const installed = join(project, '.claude/skills/workspace-memory/SKILL.md');
  assert.match(await readFile(installed, 'utf8'), /^---/);

  await writeFile(installed, 'outdated\n');
  const updated = run(['update', 'workspace-memory', '--agent', 'claude-code', '--yes']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(await readFile(installed, 'utf8'), /^---/);

  const globalInstall = run(['add', '-s', 'workspace-memory', '-a', 'codex', '-g', '-y']);
  assert.equal(globalInstall.status, 0, globalInstall.stderr);
  assert.match(await readFile(join(fakeHome, '.codex/skills/workspace-memory/SKILL.md'), 'utf8'), /^---/);

  // Descriptions are read without YAML quotes.
  const described = JSON.parse(run(['list', '--json']).stdout)[0].description;
  assert.doesNotMatch(described, /^["']/, 'description should be unquoted');

  // add prints the one-time setup step for skills that ship scripts/install.mjs.
  assert.match(added.stdout, /Next for workspace-memory[\s\S]*install\.mjs" --scope global/);

  // update replaces the folder: files deleted upstream do not linger.
  const stale = join(project, '.claude/skills/workspace-memory/stale-file.txt');
  await writeFile(stale, 'left over from an older version\n');
  const refreshed = run(['update', '-a', 'claude-code', '-y']);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(existsSync(stale), false, 'stale file should be gone after update');

  // Symlinked installs are managed elsewhere and are never written through.
  const external = join(temporaryRoot, 'external-copy');
  await mkdir(external, { recursive: true });
  await writeFile(join(external, 'SKILL.md'), 'external\n');
  const linked = join(project, '.agents/skills/workspace-memory');
  await mkdir(dirname(linked), { recursive: true });
  await symlink(external, linked, 'dir');
  const linkUpdate = run(['update', '-a', 'codex', '-y']);
  assert.equal(linkUpdate.status, 0, linkUpdate.stderr);
  assert.match(linkUpdate.stdout, /skipped .*symlink/);
  assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), 'external\n', 'symlink target must be untouched');

  // remove deletes copies, leaves symlinks unless --force, and removes only the link itself with --force.
  const removed = run(['remove', 'workspace-memory', '-a', 'claude-code', '-y']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /install\.mjs" --scope global --uninstall/);
  assert.equal(existsSync(join(project, '.claude/skills/workspace-memory')), false);
  const forced = run(['rm', 'workspace-memory', '-a', 'codex', '-y', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(existsSync(linked), false);
  assert.equal(existsSync(join(external, 'SKILL.md')), true, 'removing a symlink must not delete its target');
  const nothing = run(['remove', 'workspace-memory', '-a', 'claude-code', '-y']);
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /No matching project installs/);

  // --copy is accepted for skills CLI compatibility.
  const copyFlag = run(['add', '-s', 'workspace-memory', '-a', 'claude-code', '-y', '--copy', '--dry-run']);
  assert.equal(copyFlag.status, 0, copyFlag.stderr);

  console.log('CLI tests passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
