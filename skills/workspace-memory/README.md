# workspace-memory

Long-term memory for AI-assisted workspaces. Everything is plain Markdown in Git, and it works across Claude Code, Gemini CLI and Codex.

Work in a folder for months, switch agents or models, and never re-explain your goals, preferences, decisions or open questions.

## When to use it

**Good fit**
- **Planning and non-coding workspaces**: a product plan, research, a book, an event, a job search, operations. The folder *is* the project, and every change is versioned automatically.
- **A hub for code repos**: one planning workspace that remembers context for several code repos in other directories. The code repos stay untouched: no memory files and no memory commits in their history.
- Mixed-model use: Opus one day, Haiku or Gemini Flash the next, with the same memory and the same behaviour.

**Not worth it**
- One-off or throwaway sessions.
- A single code repo where Claude Code's built-in auto-memory is enough and you only use Claude.

## How it works

```text
session start ──► hook injects PROFILE + CURRENT + ACTIVE_THREADS + INDEX (size-capped)
      │
   you work ──► agent records durable things with ONE command (capture.mjs checkpoint ...)
      │
  turn ends ──► reminder if work changed but memory didn't ──► auto-commit (push is opt-in)
```

- **The agent decides *what* to remember. Scripts do *all* the writing.** The scripts route each item to the right file, date it, remove duplicates, reject placeholders and secrets, rebuild indexes and audit. This is why smaller models produce the same quality as big ones.
- **Startup context is small and bounded** (about 16k characters by default). Everything else is found on demand with the built-in search (ranked keyword search, plain Node, nothing to install).
- **Notes link to each other automatically.** Mention a topic, lesson or decision ID and it becomes a standard Markdown link, rendered by GitHub/GitLab/Bitbucket, Obsidian and VS Code. Each note gets a generated "Referenced by" list.
- **Memory is kept tidy in two ways.** Progressively on every write (dedupe, caps, supersede, close) and by a periodic review the agent offers every 14 days when there is something to fix.
- **Git is the safety net.** Nothing is ever force-pushed or rewritten; every past state is recoverable.

## Install (once per machine)

**Global (recommended):**
```bash
node ~/.claude/skills/workspace-memory/scripts/install.mjs --scope global
```
This:
- links the skill into `~/.agents/skills/` (read by Gemini CLI and Codex);
- adds hooks to `~/.claude/settings.json` and `~/.gemini/settings.json`.

Hooks do nothing in folders that are not workspaces. Choose agents with `--agents claude,gemini,codex`, and preview with `--dry-run`.

**Project only.** Use this when you can't install globally, or you want the workspace to carry its own copy:
```bash
node ~/.claude/skills/workspace-memory/scripts/install.mjs --scope project --target ~/work/offsite
```
It copies the same skill folder into `<project>/.agents/skills/` and wires project-level hooks. Don't combine it with a global install.

**Uninstall:** add `--uninstall` to the same command. Only this skill's hooks and links are removed.

## Quick start

**1. Create a workspace.** Use a new or existing folder. It becomes a Git repo if it isn't one already.
```bash
node ~/.claude/skills/workspace-memory/scripts/init.mjs --target ~/work/offsite
```
Memory is committed locally after every turn. Pushing is off by default. To back it up, add a remote you're allowed to use (`git remote add origin <url>`) and turn pushing on: `init.mjs --target ~/work/offsite --push auto`.

**2. Start a session there** (`claude`, `gemini` or `codex`). Tell it what you're doing and what you like:

> "We're planning the Q4 offsite for 40 people, budget 40k EUR. I prefer short bullet summaries."

The agent records it:
```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --objective "Plan the Q4 offsite for 40 people" --constraint "Budget cap is 40k EUR" --pref "Short bullet summaries"
```
Next week, in a new session with any model, the agent already knows all of this.

**3. Optionally, link code repos** so the hub remembers them too:
```bash
node ~/.claude/skills/workspace-memory/scripts/init.mjs --target ~/work/offsite --link ~/code/offsite-app --name app
```
Sessions started inside `~/code/offsite-app` now load `memory/projects/app/` from the hub, and memory commits go to the hub. Add `--pointer` to put a short `AGENTS.md` note in the code repo for Codex, which has no hooks; commit that note yourself if you want it.

## Day to day

| You want to... | Do |
| --- | --- |
| See what the agent knows | Open `memory/CURRENT.md`, `memory/PROFILE.md`, `memory/ACTIVE_THREADS.md` |
| Correct or add something | Tell the agent ("remember that...") or edit the file directly; keep the `## Section` headings |
| Record something yourself | `capture.mjs checkpoint --state "..."` (flags below) |
| Find something from weeks ago | `node ~/.claude/skills/workspace-memory/scripts/search.mjs "caterer vegan"` |
| See what a note connects to | `node ~/.claude/skills/workspace-memory/scripts/search.mjs --related memory/topics/venues.md` |
| Review and tidy memory | `node ~/.claude/skills/workspace-memory/scripts/review.mjs`, then `node ~/.claude/skills/workspace-memory/scripts/review.mjs --done "what changed"` |
| Check memory health | `node ~/.claude/skills/workspace-memory/scripts/audit.mjs` |
| Archive old session notes | `node ~/.claude/skills/workspace-memory/scripts/compact.mjs --days 90` |
| Commit by hand (no hooks) | `node ~/.claude/skills/workspace-memory/scripts/commit.mjs --message "..."` |

`checkpoint` flags. Each can repeat; use only what applies.

| Flag | Goes to |
| --- | --- |
| `--objective "..."` | CURRENT → Objective (replaces) |
| `--state "..."` | CURRENT → Status (dated, newest first, last 8 kept) |
| `--next "..."` / `--done "..."` | CURRENT → Next actions / Recently completed |
| `--constraint "..."` | CURRENT → Constraints |
| `--decision "title \| choice \| why"` (+ `--supersedes D-0001`) | `decisions/D-000N-*.md` |
| `--open` / `--blocked` / `--waiting "..."` | ACTIVE_THREADS |
| `--close "match \| resolution"` | Removes the thread, logs the outcome in CURRENT |
| `--fact "topic \| fact"` | `topics/<topic>.md` |
| `--lesson "title \| lesson"` | `lessons/<title>.md` |
| `--pref "..."` | PROFILE → Preferences (workspace-wide) |
| `--drop "..."` | Removes an outdated bullet (status, constraint, next action, preference, fact, lesson) |
| `--session "title \| summary"` | `sessions/<date>-*.md` |
| `--project <name>` | Target a linked repo's memory (automatic inside that repo) |

**Periodic review.** Once a review is due (default every 14 days, and only when the script finds something: stale status lines, threads open for 30+ days, near-duplicate or contradicting facts, oversized notes, old sessions), the session starts with a note and the agent offers a short review. The script lists each finding with the exact command to fix it. The agent or you decide keep, drop or merge, and nothing is reorganized without asking. Tune it with `review.everyDays` / `review.staleDays`.

**The end-of-turn reminder.** If a turn changed files but not memory, or six turns pass without a memory update, the agent gets one reminder with the exact command. It records something or replies "no memory needed". Tune it with `nudge` in the config, or turn it off with `"enabled": false`.

## Git behaviour

| Where you work | What gets committed | Pushed? |
| --- | --- | --- |
| Planning workspace (default `commit.scope: "workspace"`) | Every change in the folder, respecting `.gitignore` | Only with `push: "auto"` and a remote |
| Workspace with `commit.scope: "memory"` | Only `memory/` | Only with `push: "auto"` and a remote |
| Linked code repo | **Nothing in the code repo**; memory commits land in the hub | Follows the hub's setting |

Safety rules:
- Commits are refused if a changed file looks like it holds a secret (API keys, private keys, tokens). You get a `fix:` hint.
- Files over 10 MB are skipped.
- Nothing is committed during a merge or rebase.
- Pushes are never forced.

Pushing is off by default (`"push": "never"`). To turn it on, set `"push": "auto"` or run `init.mjs --target <dir> --push auto`.

## Corporate use

- **No data leaves the machine** except your own `git push` to the remote you configure. Search is local and there are no external services or APIs.
- **Nothing to install beyond Node and Git.** No npm packages, no `ripgrep`, no database.
- **Your commit hooks still run.** Memory commits are normal `git commit`s, so company pre-commit hooks and secret scanners (gitleaks, detect-secrets, …) apply. The built-in secret check is only a simple pattern match; treat your company's scanner as the real safety net.
- **Choose where memory is pushed.** Memory holds business content, so only push to a repo with suitable access controls, and leave pushing off until that's agreed. Protected branches reject the automatic pushes; give the workspace its own branch or repo.
- **Instruction files are shared.** The `AGENTS.md` block uses `~/.claude/skills/...` paths so it works for every teammate on macOS/Linux. Windows users see absolute paths.
- **Windows** is supported by design but has not been tested yet:
  - the install uses directory junctions, so no admin rights are needed;
  - Windows line endings are handled;
  - Node must be on the `PATH` for hooks.

## Configuration

Settings live in `.workspace-memory/config.json`. The main keys:
- `startup.charBudgets`: how much of each file is loaded at start;
- `commit.scope` and `commit.push`;
- `nudge`;
- `projects`: linked repos.

The full reference is in [references/structure.md](references/structure.md).

## Files

```text
your-workspace/
├── AGENTS.md / CLAUDE.md / GEMINI.md   small managed block; your own content is preserved
├── .workspace-memory/config.json
└── memory/
    ├── PROFILE.md          your preferences and working style (loaded every session)
    ├── CURRENT.md          objective, status, constraints, next actions
    ├── ACTIVE_THREADS.md   open, blocked and waiting items
    ├── INDEX.md            map, linked projects, recent decisions and sessions
    ├── decisions/ topics/ lessons/ sessions/ archive/
    └── projects/<name>/    memory for each linked code repo
```

Nothing else is added: no scripts, no `.gitignore` changes. Machine-local state (hub registry, reminder state, locks) lives in `~/.workspace-memory/`.

## Upgrading from the v1 draft

```bash
node ~/.claude/skills/workspace-memory/scripts/init.mjs --target <workspace> --upgrade
node ~/.claude/skills/workspace-memory/scripts/install.mjs --scope global
```
This converts the config (v1 workspaces keep memory-only commits), removes vendored scripts and copied skills, and replaces the old hooks.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No memory context at session start | Hooks not installed: run `install.mjs --scope global`. Or you're outside a workspace or linked repo. Hooks are deliberately silent there. |
| "possible-secret" and nothing committed | A changed file matches a secret pattern. Remove the credential or add the file to `.gitignore`. |
| "push-failed" | The local commit is safe. In the workspace, run `git pull --rebase && git push`. |
| "git-operation-in-progress" / "detached-head" | Finish the merge or rebase, or `git switch main`. The next turn commits. |
| Reminder too frequent or too rare | Adjust `nudge.minTurnsBetween` / `nudge.turnsWithoutMemory`. |
| Startup file "truncated" | It exceeds its budget. Ask the agent to consolidate it (move detail into topics), or raise the budget. |
| Hooks do nothing on Windows | Check `node --version` works in the same terminal; Claude Code runs hooks with that `PATH`. |
| Linked repo not recognised | Run `init.mjs --link` from the hub again; it re-registers the hub on this machine. |

## Development

`WORKSPACE_MEMORY_NOW=YYYY-MM-DD` overrides the scripts' clock (used by the long-run simulation).

```bash
node ~/.claude/skills/workspace-memory/tests/smoke.mjs          # script tests, temp dirs only
node ~/.claude/skills/workspace-memory/tests/eval/run.mjs       # model-parity eval (calls claude -p; costs tokens; cleans up after itself)
node ~/.claude/skills/workspace-memory/tests/longrun.mjs --days 180   # simulates 6 months of daily use with a fake clock (no model, ~1 min)
node ~/.claude/skills/workspace-memory/tests/eval/run.mjs --scenarios journey [--no-hooks]   # 6 fresh sessions over ~11 weeks, then a recap quiz
```

Agent-facing instructions are in [SKILL.md](SKILL.md). The design rationale is in [references/protocol.md](references/protocol.md). `agents/openai.yaml` is optional Codex UI metadata (display name, default prompt); nothing depends on it.
