# Agent Skills

A public collection of reusable skills for AI coding agents. Each skill follows the open `SKILL.md` format.

## Install with skills.sh (recommended)

Use the [`skills`](https://skills.sh/) CLI to browse or install directly from this repository:

```bash
# List this repository's skills
npx skills add rajbdilip/skills --list

# Choose skills and agents interactively
npx skills add rajbdilip/skills

# Install a specific skill for a specific agent
npx skills add rajbdilip/skills --skill workspace-memory --agent codex
```

Add `--global` (`-g`) for a user-level install, `--yes` (`-y`) to skip prompts, or `--all` to install every skill for every supported agent. See the [`skills` CLI documentation](https://github.com/vercel-labs/skills#readme) for its complete agent list and options.

## Install from npm (no GitHub access required)

For machines that can reach the npm registry but not GitHub. The package bundles the complete skills, so nothing else is downloaded. (`npx skills add rajbdilip/skills` and `npx rajbdilip/skills` both fetch from GitHub; the npm package name is `rajbdilip-skills`.)

```bash
# Choose skills and agents interactively
npx rajbdilip-skills@latest add

# Non-interactive global install for Codex
npx rajbdilip-skills@latest add --skill workspace-memory --agent codex --global --yes

# Refresh existing project installs from the latest npm package
npx rajbdilip-skills@latest update

# Refresh existing global installs
npx rajbdilip-skills@latest update --global

# Remove a skill
npx rajbdilip-skills@latest remove workspace-memory --agent claude-code --global

# List the skills in the package
npx rajbdilip-skills@latest list
```

The npm installer follows the common `skills` CLI options for this repository:

| Option | Meaning |
| --- | --- |
| `-s, --skill <names>` | Select skills; accepts space- or comma-separated names, or `'*'` |
| `-a, --agent <names>` | Select `claude-code`, `codex`, or `gemini-cli`; accepts `'*'` |
| `-g, --global` | Use user-level agent directories |
| `-p, --project` | Use the current project (the default for `add`) |
| `-y, --yes` | Skip confirmation; detected agents are used when `--agent` is omitted |
| `--all` | Select all bundled skills and supported agents, then skip confirmation |
| `-l, --list` | List bundled skills without installing |
| `--dry-run` | Preview destinations without writing files |
| `--copy` | Accepted for compatibility; npm installs always copy |
| `--force` | Also replace or remove installs that are symlinks |

Commands: `add` (aliases `a`, `install`, `i`), `update [skills...]`, `remove [skills...]` (alias `rm`), `list` (alias `ls`).

- `add` is safe to rerun: it replaces the installed folder with the packaged version, so files removed upstream don't linger.
- `update` only refreshes skills that are already installed; it never creates new installs.
- Installs that are symlinks (for example, made by the `skills` CLI) are skipped unless you pass `--force`, so an update never writes into a copy managed elsewhere.
- npm installs always copy, because the npx cache is temporary and can't be a symlink target.
- Some skills need a one-time setup after installing; `add` prints the command when they do.

## Available skills

| Skill | Purpose |
| --- | --- |
| [`workspace-memory`](skills/workspace-memory/README.md) | Long-term, Git-backed memory for a workspace, shared by Claude Code, Gemini CLI and Codex, so you never have to repeat yourself across sessions or models. |

## Repository layout

```text
skills/
  <skill-name>/
    SKILL.md              # Required
    agents/openai.yaml    # Optional UI metadata
    scripts/              # Optional executable helpers (scripts/install.mjs = one-time setup)
    references/           # Optional on-demand documentation
    assets/               # Optional output resources
    tests/                # Optional; kept in Git, left out of the npm package
scripts/
  cli.mjs                 # npm install/update CLI
  test-cli.mjs            # npm CLI smoke tests
  validate-skills.mjs
```

Every skill is self-contained. The only required file is `skills/<skill-name>/SKILL.md`, with `name` and `description` in its YAML frontmatter.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), then run the local checks before opening a pull request:

```bash
npm test
```

## License

[MIT](LICENSE)
