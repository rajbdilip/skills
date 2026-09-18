# Layout and configuration

## Skill (one copy, used by every agent)

```text
workspace-memory/
├── SKILL.md              agent instructions (short and literal)
├── README.md             human guide
├── references/           rationale, hooks, layout (this file)
├── agents/openai.yaml    optional Codex UI metadata (display name, default prompt)
├── scripts/              all runtime code; workspaces never get a copy
│   ├── install.mjs  init.mjs  capture.mjs  commit.mjs
│   ├── search.mjs  review.mjs  graph.mjs (links)
│   ├── hook.mjs  index.mjs  audit.mjs  compact.mjs  lib.mjs
├── assets/templates/     memory/ and project/ starter files
├── assets/fragments/     managed blocks for AGENTS.md, CLAUDE.md, GEMINI.md, code-repo pointer
└── tests/                smoke.mjs (script tests), longrun.mjs (6-month simulation), eval/ (model tests); not shipped to npm
```

## Workspace

```text
workspace/
├── AGENTS.md  CLAUDE.md  GEMINI.md          only the marked workspace-memory block is managed
├── .workspace-memory/config.json
└── memory/
    ├── PROFILE.md  CURRENT.md  ACTIVE_THREADS.md  INDEX.md
    ├── decisions/  topics/  lessons/  sessions/  archive/   (each with INDEX.md)
    └── projects/<name>/                      one per linked code repo, same layout minus PROFILE.md
```

Machine-local, never committed:
- `~/.workspace-memory/hubs.json`: the registry that lets hooks find the hub from inside a linked repo;
- `~/.workspace-memory/state/`: nudge baselines;
- `~/.workspace-memory/locks/`: commit locks.

Override the location with `WORKSPACE_MEMORY_HOME`.

## `.workspace-memory/config.json`

| Key | Default | Meaning |
| --- | --- | --- |
| `memoryRoot` | `"memory"` | Memory folder, relative to the workspace |
| `startup.files` | PROFILE, CURRENT, ACTIVE_THREADS, INDEX | Injected at session start |
| `startup.charBudgets` | 3000 / 6000 / 4000 / 3000 | Per-file character cap at session start; audit warns above it |
| `startup.totalChars` | 16000 | Overall cap for injected context |
| `index.recentDecisions`, `index.recentSessions` | 5 | Items listed in `INDEX.md` |
| `archive.sessionAgeDays` | 90 | Default age for `compact.mjs` |
| `commit.enabled` | `true` | Turn automatic commits off entirely |
| `commit.scope` | `"workspace"` | `workspace` = everything in the folder; `memory` = only `memory/` |
| `commit.push` | `"never"` | `never` (commit locally only) or `auto` (push after each commit) |
| `commit.remote` | `"origin"` | Preferred remote when there is no upstream |
| `commit.maxFileMB` | 10 | Larger files are left uncommitted, with a warning |
| `nudge.enabled` | `true` | End-of-turn reminder |
| `nudge.minTurnsBetween` | 3 | Minimum turns between reminders |
| `nudge.turnsWithoutMemory` | 6 | Remind after this many turns with no memory change |
| `review.everyDays` | 14 | A review is suggested at most this often (only when there are findings) |
| `review.staleDays` | 30 | Dated status lines and threads older than this are flagged |
| `projects` | `{}` | Linked code repos: `{ "name": { "path": "/abs/path" } }` (use `init.mjs --link`) |

Configs from pre-release builds (`"version": 1`) are still read. `init.mjs --upgrade` rewrites them in the current format and removes files those builds copied into the workspace.
