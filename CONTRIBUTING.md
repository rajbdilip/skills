# Contributing

Contributions that add or improve focused, reusable Agent Skills are welcome.

## Add a skill

1. Create `skills/<skill-name>/SKILL.md`.
2. Use lowercase letters, digits, and hyphens for the directory and `name`; keep the name under 64 characters.
3. Add YAML frontmatter with a concise `name` and `description`. The description should explain what the skill does and when an agent should use it.
4. Keep the instructions focused. Add `scripts/`, `references/`, `assets/`, or `agents/openai.yaml` only when they support the skill's actual workflow. If the skill needs a one-time machine setup, provide it as `scripts/install.mjs`; the npm installer prints the command after `add`.
5. Quote frontmatter values that contain `: ` or ` #` (for example `description: "..."`). Unquoted, strict YAML parsers such as the `skills` CLI reject the file and the skill silently disappears. `npm test` checks this.
6. Add the skill to the catalog in `README.md`.
7. Run `npm test`.

Minimal example:

```markdown
---
name: example-skill
description: Performs a specific workflow. Use when the user asks for that concrete outcome.
---

# Example Skill

Describe the decisions, constraints, and verification that help an agent complete the workflow reliably.
```

## Pull requests

Keep each pull request scoped to one coherent change. Explain the user need, the behavior the skill adds or changes, and how you verified it. Do not include credentials, private data, generated dependency directories, or unrelated formatting changes.

## Releasing (maintainers)

1. Bump `version` in `package.json` (and `metadata.version` in any changed skill's `SKILL.md`).
2. Run `npm test`, then `npm pack --dry-run` and check the file list.
3. Commit, tag (`git tag -a vX.Y.Z`), and push the commit and tag.
4. Run `npm publish`. `prepack` runs the tests again, and `publishConfig.access` is already `public`.
5. Check the release: `npx rajbdilip-skills@latest --version` and `npx rajbdilip-skills@latest list`.
