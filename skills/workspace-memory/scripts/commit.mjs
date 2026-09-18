import fs from 'node:fs';
import path from 'node:path';
import {
  fail,
  findSecret,
  hash,
  isGitRepository,
  isMain,
  parseArgs,
  requireContext,
  runGit,
  stateHome,
  toPosix,
  values,
} from './lib.mjs';

function operationInProgress(root) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'].some((name) => {
    const result = runGit(root, ['rev-parse', '--git-path', name], { allowFailure: true });
    if (result.status !== 0 || !result.stdout) return false;
    return fs.existsSync(path.isAbsolute(result.stdout) ? result.stdout : path.join(root, result.stdout));
  });
}

function acquireLock(root) {
  const lockPath = path.join(stateHome(), 'locks', `${hash(path.resolve(root))}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const descriptor = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`);
    return () => {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let age = 0;
    try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return acquireLock(root); }
    if (age > 120_000) {
      try { fs.unlinkSync(lockPath); } catch {}
      return acquireLock(root);
    }
    return null;
  }
}

function selectRemote(root, preferred) {
  const upstream = runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  if (upstream.status === 0 && upstream.stdout.includes('/')) return { hasUpstream: true, remote: upstream.stdout.split('/')[0] };
  const remotes = runGit(root, ['remote'], { allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean);
  if (preferred && remotes.includes(preferred)) return { hasUpstream: false, remote: preferred };
  if (remotes.length === 1) return { hasUpstream: false, remote: remotes[0] };
  return { hasUpstream: false, remote: '' };
}

function pushCommit(root, config, branch) {
  if (config.commit?.push === 'never') return { pushed: false, pushReason: 'disabled' };
  const selection = selectRemote(root, config.commit?.remote);
  if (!selection.remote) return { pushed: false, pushReason: 'no-remote' };
  const args = selection.hasUpstream ? ['push'] : ['push', '-u', selection.remote, branch];
  const pushed = runGit(root, args, { allowFailure: true });
  if (pushed.status !== 0) return { pushed: false, pushReason: 'push-failed', pushError: pushed.stderr || pushed.stdout };
  return { pushed: true, remote: selection.remote };
}

// Parses `git status --porcelain=v1 -z` into changed paths (new side of renames).
function changedPaths(root, pathspecs) {
  const out = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs], { raw: true }).stdout;
  const entries = out.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    files.push({ code: entry.slice(0, 2), file: entry.slice(3) });
    if (entry[0] === 'R' || entry[0] === 'C') index += 1;
  }
  return files;
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

function screenFiles(root, files, maxBytes) {
  const tooLarge = [];
  const secrets = [];
  for (const { code, file } of files) {
    if (code.includes('D')) continue;
    const full = path.join(root, file);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > maxBytes) { tooLarge.push(file); continue; }
    if (stat.size > 2 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(full);
    if (isText(buffer) && findSecret(buffer.toString('utf8'))) secrets.push(file);
  }
  return { tooLarge, secrets };
}

// Linked code repos that sit inside the hub directory must never be swept into hub commits.
function nestedProjectExcludes(root, config) {
  const excludes = [];
  for (const entry of Object.values(config.projects || {})) {
    if (!entry?.path) continue;
    const relative = path.relative(root, path.resolve(root, entry.path));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) excludes.push(`:(exclude)${toPosix(relative)}`);
  }
  return excludes;
}

export function commitMemory({ root, config, message, push = true, paths = [], bootstrap = false }) {
  if (config.commit?.enabled === false) return { ok: true, committed: false, reason: 'disabled' };
  if (!isGitRepository(root)) return { ok: true, committed: false, reason: 'not-a-git-repository' };
  const top = runGit(root, ['rev-parse', '--show-toplevel']).stdout;
  if (fs.realpathSync(top) !== fs.realpathSync(root)) {
    // Workspace is a subfolder of a bigger repo: only ever commit the memory folder.
    config = { ...config, commit: { ...config.commit, scope: 'memory' } };
  }
  const release = acquireLock(root);
  if (!release) return { ok: true, committed: false, reason: 'commit-already-running' };
  try {
    const unresolved = runGit(root, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout;
    if (unresolved || operationInProgress(root)) {
      return { ok: false, committed: false, reason: 'git-operation-in-progress', fix: 'Finish or abort the merge/rebase in the workspace, then the next turn will commit.' };
    }
    const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }).stdout;
    if (!branch) return { ok: false, committed: false, reason: 'detached-head', fix: 'Check out a branch in the workspace (git switch main).' };

    const scope = paths.length ? 'paths' : (config.commit?.scope === 'memory' ? 'memory' : 'workspace');
    const known = (item) => fs.existsSync(path.join(root, item)) || runGit(root, ['ls-files', '--error-unmatch', '--', item], { allowFailure: true }).status === 0;
    const pathspecs = scope === 'paths' ? paths.filter(known) : scope === 'memory' ? [config.memoryRoot] : ['.', ...nestedProjectExcludes(root, config)];
    if (!pathspecs.length) return { ok: true, committed: false, reason: 'no-changes' };
    const changed = changedPaths(root, pathspecs);
    if (!changed.length) return { ok: true, committed: false, reason: 'no-changes' };

    const maxBytes = Number(config.commit?.maxFileMB || 10) * 1024 * 1024;
    const { tooLarge, secrets } = screenFiles(root, changed, maxBytes);
    if (secrets.length) {
      return {
        ok: false,
        committed: false,
        reason: 'possible-secret',
        error: `possible secret in: ${secrets.join(', ')}`,
        fix: 'Remove the credential from those files (or add them to .gitignore); nothing was committed.',
      };
    }
    const excludes = tooLarge.map((file) => `:(exclude)${file}`);
    runGit(root, ['add', '-A', '--', ...pathspecs, ...excludes]);
    const staged = runGit(root, ['diff', '--cached', '--name-only', '--', ...pathspecs]).stdout;
    if (!staged) return { ok: true, committed: false, reason: 'no-changes', skipped: tooLarge };

    const prefix = String(config.commit?.messagePrefix || 'memory').trim() || 'memory';
    let text = String(message || 'checkpoint').trim();
    if (!text.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) text = `${prefix}: ${text}`;
    const commitArgs = scope === 'workspace' && !bootstrap
      ? ['commit', '-q', '-m', text]
      : ['commit', '-q', '--only', '-m', text, '--', ...pathspecs];
    const commit = runGit(root, commitArgs, { allowFailure: true });
    if (commit.status !== 0) return { ok: false, committed: false, reason: 'commit-failed', error: commit.stderr || commit.stdout };
    const result = { ok: true, committed: true, hash: runGit(root, ['rev-parse', '--short', 'HEAD']).stdout, message: text, files: staged.split('\n').length };
    if (tooLarge.length) result.skipped = tooLarge;
    const pushResult = push ? pushCommit(root, config, branch) : { pushed: false, pushReason: 'suppressed' };
    return { ...result, ...pushResult, ok: !pushResult.pushError, fix: pushResult.pushError ? 'Local commit is safe. Run `git pull --rebase && git push` in the workspace when convenient.' : undefined };
  } finally {
    release();
  }
}

export function formatCommit(result) {
  if (result.committed) {
    const pushed = result.pushed ? `, pushed to ${result.remote}` : result.pushReason === 'push-failed' ? ', PUSH FAILED' : '';
    const lines = [`committed ${result.hash} "${result.message}" (${result.files} file(s)${pushed})`];
    if (result.skipped?.length) lines.push(`warning: skipped files over size limit: ${result.skipped.join(', ')}`);
    if (result.pushError) lines.push(`error: ${result.pushError}`, `fix: ${result.fix}`);
    return lines.join('\n');
  }
  const lines = [`not committed: ${result.reason}`];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.fix) lines.push(`fix: ${result.fix}`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const context = requireContext(args);
    const result = commitMemory({
      root: context.root,
      config: context.config,
      message: values(args, 'message')[0],
      push: !args['no-push'],
    });
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : formatCommit(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}
