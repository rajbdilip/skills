# Memory protocol: rationale

This is optional background for `SKILL.md`. Agents do not need it for routine work.

## Why memory is structured this way

| Memory | Holds | Why separate |
| --- | --- | --- |
| `PROFILE.md` | Preferences, working style, recurring context | Loaded every session so the user never repeats themselves |
| `CURRENT.md` | Objective, status, constraints, next actions, recently completed | The page a newcomer reads first; kept short |
| `ACTIVE_THREADS.md` | Open, blocked and waiting items | Unresolved work must stay visible until closed |
| `decisions/` | One file per consequential choice | Choices need their reasons; superseded ones stay for history |
| `topics/` | Durable facts grouped by subject | Facts outlive the session that found them |
| `lessons/` | Reusable failure or success patterns | Stops the same mistake happening twice |
| `sessions/` | Short provenance notes | Explains *when* and *why*, searchable, never bulk-loaded |
| `archive/` | Old session notes | Keeps `sessions/` small; Git keeps everything else |

## Progressive loading

| Tier | Content | When |
| --- | --- | --- |
| 0 | `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` block | Always, via the client |
| 1 | PROFILE, CURRENT, ACTIVE_THREADS, INDEX (character-budgeted) | Session start (hook-injected) |
| 2 | Area indexes (`decisions/INDEX.md`, ...) | When the task touches that area |
| 3 | Individual records | Only when relevant |
| 4 | Sessions and archive | Search for provenance only |

## Evidence states

- **Fact**: verified and current (`--state`, `--fact`).
- **Decision**: deliberately chosen, with its reason (`--decision`).
- **Hypothesis**: write "Unconfirmed: ..." and say how to verify it.
- **Open thread**: unresolved (`--open`, `--blocked`, `--waiting`).
- **Superseded**: kept for history, no longer authoritative (`--supersedes`).

When sources conflict, the newest explicit decision wins over older notes. Canonical files outrank session notes. Live files and code outrank stale prose; record the mismatch if it matters.

## Why a script does the writing

Smaller models (Haiku, Gemini Flash) follow "fill in these fields" far more reliably than "edit these Markdown files correctly". The script:
- routes each field to the right file;
- dates entries;
- de-duplicates;
- rejects placeholders, secrets and walls of text;
- keeps `Status` (8) and `Recently completed` (10) bounded;
- rebuilds indexes and audits after every write.

Memory quality then depends on *what* the model chooses to record, which the table in `SKILL.md` makes explicit.

## Links and search

Notes use standard relative Markdown links, so they render in any Git host and in Obsidian or VS Code. The scripts insert links when text mentions an existing topic, lesson or decision ID, and `index.mjs` generates each note's "Referenced by" block. `search.mjs` ranks lines with BM25 keyword scoring (no dependencies, nothing leaves the machine), and `--related` walks links two hops out.

Semantic (embedding) search is deliberately not built in. Keyword ranking plus the model's own reading of the indexes covers months of notes. A local embedding model is the planned opt-in if evals show retrieval misses.

## Why a periodic review exists

Progressive rules (dedupe, caps, supersede, close) keep memory tidy on every write but cannot judge meaning. Over weeks, status lines go stale, facts contradict each other and topics bloat. `review.mjs` finds these deterministically; the agent and user make the judgment calls. It runs only when due and when there are findings, and never reorganizes without asking.

## Why the end-of-turn reminder exists

Agents forget to save. The reminder ("nudge") fires when:
- files changed in a turn but memory did not, or
- several turns passed with no memory update (useful for planning conversations where decisions happen in chat).

It never fires twice in a row, and it includes the exact command to run.
