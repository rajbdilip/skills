---
name: workspace-memory
description: Use this skill as the project's long-term record, shared by Claude Code, Gemini CLI and Codex across sessions. You don't remember past sessions yourself, so use it whenever a message depends on or changes what was discussed before, even if the word "memory" never comes up: (1) recall: "what did we decide/agree", "why did we drop X", "catch me up", "where did we leave off", any mention of yesterday, last week or earlier meetings; (2) updates worth keeping: decisions, corrections ("actually it moved to…"), blockers or waiting-on items, deadlines, status changes, preferences, "keep track of / don't let me forget"; (3) upkeep: a "Memory review due" prompt, or a request to review, tidy or prune what's remembered; (4) setup: making several sessions or AI tools share context for a project or planning workspace, or linking code repos to it. Don't use it for RAM or memory-leak problems, Jira tickets, one-off meeting summaries, importing another assistant's memories, or Claude's built-in /memory.
metadata:
  version: 0.0.1
compatibility: Requires Node.js 18+ and Git on PATH. No npm packages, network services or other tools; works on macOS, Linux and Windows.
---

# Workspace Memory

Memory lives in `memory/` inside a workspace and is committed to Git. Scripts in this skill do all file editing, because they validate input, file each item in the right place, remove duplicates and keep links and indexes consistent; hand edits drift. Your job is to decide **what** is worth remembering and pass it to one command.

Commands below assume the skill is at `~/.claude/skills/workspace-memory`. If the session context shows a different path for `capture.mjs`, use that path instead.

## 1. Setup (only when asked, or when no `.workspace-memory/config.json` exists)

| Situation | Run |
| --- | --- |
| Hooks not installed on this machine yet | `node ~/.claude/skills/workspace-memory/scripts/install.mjs --scope global` |
| New planning or non-coding workspace | `node ~/.claude/skills/workspace-memory/scripts/init.mjs --target <dir>` |
| Link a code repo to a planning hub | `node ~/.claude/skills/workspace-memory/scripts/init.mjs --target <hub> --link <repo> --name <short-name>` |
| Workspace made with the old v1 skill | `node ~/.claude/skills/workspace-memory/scripts/init.mjs --target <dir> --upgrade` |

Add `--dry-run` to preview any of these.

## 2. At session start

If the session context already contains "Workspace memory is active", the files are loaded. Do not read them again.
Otherwise read `memory/PROFILE.md`, `memory/CURRENT.md`, `memory/ACTIVE_THREADS.md` and `memory/INDEX.md`.
Open other memory files only when the task needs them. To find older context, search. Do not open files one by one:
```bash
node ~/.claude/skills/workspace-memory/scripts/search.mjs "caterer vegan notice"          # best-matching lines, grouped by note
node ~/.claude/skills/workspace-memory/scripts/search.mjs --related memory/topics/venues.md   # notes linked to or from a note
```
Follow `PROFILE.md` preferences without being reminded. The whole point of this skill is that the user never repeats themselves.

When the user asks about the past ("what did we decide about the caterer?", "where are we with the budget?"), search memory first and answer from it, citing the note.

## 3. When something durable happens, record it with one command, in the same turn, before replying

Acknowledging in chat is not enough. The conversation is gone next session; only memory carries over, and later turns or context compaction make details easy to lose. Triggers: "from now on", "always/never", "we decided", "going with", "instead of", "blocked/waiting until", "approved", deadlines, status updates, "remember".

```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint [flags]
```

Use only the flags that apply. Each flag may repeat.

| When this happens | Flag |
| --- | --- |
| The overall goal is set or changes | `--objective "..."` |
| Something is now true (progress, status) | `--state "..."` |
| A next step is agreed | `--next "..."` |
| A next step is finished | `--done "..."` |
| A limit or requirement appears (budget, deadline, rule) | `--constraint "..."` |
| A choice is made between options | `--decision "title \| choice \| why"` |
| A choice replaces an earlier decision | add `--supersedes D-0003` |
| A question, blocker or dependency appears | `--open "..."`, `--blocked "..."` or `--waiting "..."` |
| A question, blocker or dependency is resolved | `--close "words from the thread \| how it was resolved"` |
| A lasting fact about the domain is learned | `--fact "topic \| fact"` |
| Something went wrong or right and should repeat | `--lesson "title \| lesson"` |
| The user states a preference or way of working | `--pref "..."` |
| Something recorded earlier is no longer true | `--drop "words from the old bullet"` (add the new fact with `--state` / `--fact` / `--pref`) |
| A long session produced several outcomes | `--session "title \| one-line summary"` |
| You are working in a linked code repo | add `--project <name>` (added automatically when run inside the repo) |

Rules for values:
- One clear sentence each, under 500 characters. Write facts, not chat.
- Use the user's own terms and numbers. Put exact dates as `YYYY-MM-DD`, inside the item they belong to (`--next "Send agenda to Maria by 2026-10-02"`).
- When something changes or is corrected, `--drop` the old bullet in the same command. If the output shows `check:` lines, act on them.
- If something is uncertain, say so in the text ("Unconfirmed: ...").
- The script rejects placeholders, secrets and walls of text, and skips duplicates. If it prints `error:` and `fix:`, do what `fix:` says and run it again.

## 4. What not to save

Startup memory has a small size budget, so every line should earn its place. Leave out:

- Chat transcripts, tool or command output, stack traces
- Secrets, tokens, passwords (say where they are stored instead)
- Facts anyone can see by opening the files or code
- Small talk, one-off questions, things true only for this turn
- Personal data unrelated to the work

When nothing durable happened, record nothing. When the end-of-turn reminder asks and nothing qualifies, reply `no memory needed`.

## 5. Examples

User: "Let's go with Lisbon for the offsite, flights are cheapest there. Next I need venue quotes."
```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --decision "Offsite city | Lisbon | Cheapest flights for most of the team" --next "Get venue quotes in Lisbon"
```

User: "Please always give me summaries as short bullet lists, max 5."
```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --pref "Summaries as short bullet lists, at most 5 bullets"
```

User: "We're stuck until finance approves the budget." Later: "Finance approved 38k."
```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --blocked "Budget approval from finance"
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --close "budget approval | Finance approved 38k EUR" --state "Budget approved: 38k EUR"
```

User: "Correction: the 40k budget cap was lifted."
```bash
node ~/.claude/skills/workspace-memory/scripts/capture.mjs checkpoint --drop "Budget cap is 40k" --state "Budget cap lifted by leadership"
```

User: "What's 17 × 23?" → answer it. Nothing durable, so record nothing.

## 6. Committing

Hooks (Claude Code, Gemini CLI) commit at the end of every turn. You do not need to commit. Git is the safety net: every past state of memory can be recovered.
Without hooks (for example Codex), finish meaningful work with:
```bash
node ~/.claude/skills/workspace-memory/scripts/commit.mjs --message "what changed"
```
Do not run your own `git add` / `git commit` / `git push` for memory. The commit script screens for secrets and never force-pushes. Never commit memory inside a linked code repo: the hub holds it, which keeps code history and pull requests clean.

## 7. Links between notes

The script links notes automatically. Mention an existing topic or lesson title, or a decision ID like `D-0003`, in any value and it becomes a link. Every linked note gets a generated "Referenced by" list. Do not write link syntax yourself.

## 8. Periodic review (when the session context says "Memory review due", or when asked)

1. Tell the user a review is due and offer to do it now (2–5 minutes).
2. Run `node ~/.claude/skills/workspace-memory/scripts/review.mjs`. It lists findings, each with the exact command to fix it.
3. For each finding, decide keep, drop or merge. Merge = add one consolidated bullet, then `--drop` the ones it replaces. Ask the user when unsure. Never drop decisions or unresolved threads on your own.
4. Finish with `node ~/.claude/skills/workspace-memory/scripts/review.mjs --done "one line: what changed"`.

## 9. Maintenance (only when asked, or when an audit warning says so)

| Task | Run |
| --- | --- |
| Check memory health | `node ~/.claude/skills/workspace-memory/scripts/audit.mjs` |
| Rebuild indexes after hand edits | `node ~/.claude/skills/workspace-memory/scripts/index.mjs` |
| Archive old session notes | `node ~/.claude/skills/workspace-memory/scripts/compact.mjs --days 90` |
| A startup file is over budget | Move detail into topics with `--fact`, remove stale bullets, then run audit |

Hand edits are fine for larger restructuring. Keep the `## Section` headings and the `<!-- workspace-memory:... -->` markers, then run `node ~/.claude/skills/workspace-memory/scripts/index.mjs` and `node ~/.claude/skills/workspace-memory/scripts/audit.mjs`.

Why the rules are what they are: [references/protocol.md](references/protocol.md). Hooks and Git behaviour: [references/hooks.md](references/hooks.md). Layout and config: [references/structure.md](references/structure.md).
