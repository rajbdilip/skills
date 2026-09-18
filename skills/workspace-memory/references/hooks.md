# Hooks and Git behaviour

`install.mjs` adds these hooks. Global scope writes them to `~/.claude/settings.json` and `~/.gemini/settings.json`; project scope writes them to the project's `.claude/` and `.gemini/`.

| Event (Claude / Gemini) | Mode | What it does |
| --- | --- | --- |
| `SessionStart` / `SessionStart` | `session-start` | Injects PROFILE, CURRENT, ACTIVE_THREADS and INDEX within character budgets, plus the checkpoint and search commands and a "review due" note when applicable; records a change baseline |
| `UserPromptSubmit` / `BeforeAgent` | `prompt` | Remembers the user's message so the end-of-turn check can spot preferences, decisions, blockers and deadlines stated in chat |
| `Stop` / `AfterAgent` | `nudge` | Asks the agent once to record memory if work changed but memory did not (or after N quiet turns) |
| `Stop` (async) / `AfterAgent` | `turn-end` | Rebuilds indexes, audits, commits (and pushes if `push` is `auto`) |
| `PreCompact` / `PreCompress` | `pre-compact` | Same as turn-end, before context is compressed |
| `SessionEnd` / `SessionEnd` | `session-end` | Final commit |

Global hooks run in every project. The hook exits silently unless the current directory is:
- inside a workspace (it has `.workspace-memory/config.json`), or
- inside a code repo linked to a registered hub.

The nudge fires when (a) the user's message contains a durable signal ("from now on", "decided", "blocked until", "approved", a deadline…) and memory did not change, (b) files changed but memory did not, or (c) several turns passed with no memory change.

Nudge output is `{"decision":"block"}` for Claude and `{"decision":"deny"}` for Gemini, each with the reason text. It is skipped while `stop_hook_active` is set and never fires twice in a row. Tune or disable it with `nudge` in the config.

## Commit scope

| Mode | What is committed | Where |
| --- | --- | --- |
| Workspace, `commit.scope: "workspace"` (default) | Every change in the folder (respects `.gitignore`), minus linked repos nested inside it | Workspace repo |
| Workspace, `commit.scope: "memory"` | Only `memory/` | Workspace repo |
| Workspace inside a larger Git repo | Only `memory/` (forced) | That repo |
| Linked code repo | Nothing in the code repo | The hub's repo |

Before committing, the script:
- scans every changed text file for secrets and refuses the whole commit if one looks present;
- skips files larger than `commit.maxFileMB`;
- refuses during merge, rebase, cherry-pick or detached HEAD.

A lock prevents two commits at once.

## Push

Pushing is off by default (`commit.push: "never"`). With `commit.push: "auto"`, each commit is pushed:
1. to the upstream if one exists;
2. otherwise to `commit.remote` (default `origin`), or to the only remote;
3. establishing upstream with a normal `git push -u`.

It never force-pushes, never retries in a loop and never rewrites history. A failed push leaves the local commit and reports a `fix:`.

`commit.push: "never"` (the default) keeps everything local. No remote configured means nothing is pushed, and that is not an error.
