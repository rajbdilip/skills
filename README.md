# Agent Skills

A public collection of reusable skills for AI coding agents. Each skill follows the open `SKILL.md` format and can be installed with the [`skills`](https://github.com/vercel-labs/skills) CLI.

## Install

List the skills available in this repository:

```bash
npx skills add rajbdilip/skills --list
```

Install interactively:

```bash
npx skills add rajbdilip/skills
```

Install one skill directly:

```bash
npx skills add rajbdilip/skills --skill skill-authoring
```

Use `-a <agent>` to target a supported agent or `-g` for a global install. See the [skills CLI documentation](https://github.com/vercel-labs/skills#readme) for all options.

## Available skills

| Skill | Purpose |
| --- | --- |
| [`skill-authoring`](skills/skill-authoring/SKILL.md) | Create, refine, and validate reusable Agent Skills. |

## Repository layout

```text
skills/
  <skill-name>/
    SKILL.md              # Required
    agents/openai.yaml    # Optional UI metadata
    scripts/              # Optional executable helpers
    references/           # Optional on-demand documentation
    assets/               # Optional output resources
scripts/
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
