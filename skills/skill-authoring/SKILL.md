---
name: skill-authoring
description: Create or improve reusable Agent Skills in a skills repository. Use when adding a new skill package, refining its discovery metadata and instructions, or preparing a skill for public distribution.
---

# Skill Authoring

Build a focused skill that an agent can discover from its metadata and follow without hidden context.

## Workflow

1. Define the concrete job the skill should help with and the requests that should activate it.
2. Inspect nearby skills and repository guidance before choosing a structure or terminology.
3. Create `skills/<skill-name>/SKILL.md`. Use a lowercase, hyphenated name under 64 characters and make the directory name match it.
4. Write YAML frontmatter with `name` and `description`. Make the description say both what the skill does and when it applies; keep procedural detail in the body.
5. Write only the instructions that materially improve an agent's decisions. Preserve user intent and distinguish requirements from optional guidance.
6. Add `scripts/`, `references/`, `assets/`, or `agents/openai.yaml` only when the skill genuinely needs them. Link conditional references from `SKILL.md` so agents know when to load them.
7. Run `npm test` from the repository root and exercise any added scripts with representative inputs.
8. Add the skill to the catalog in the root `README.md`.

## Quality checks

- The skill is useful without repository-specific knowledge that is not included or linked.
- The description is specific enough to avoid activating for unrelated work.
- Instructions do not restate generic agent capabilities or impose unnecessary steps.
- Examples contain no secrets, personal data, or environment-specific absolute paths.
- Relative links resolve and no scaffold placeholders remain.
- The skill has the smallest resource footprint that supports its actual workflow.
