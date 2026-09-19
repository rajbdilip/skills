<!-- workspace-memory:start -->
## Workspace memory

This workspace keeps long-term memory in `memory/` so the user never has to repeat themselves.

1. At session start, read `memory/PROFILE.md`, `memory/CURRENT.md`, `memory/ACTIVE_THREADS.md` and `memory/INDEX.md` (skip if already injected). For older context, search: `{{SEARCH}} "words"`.
2. In the same turn, before replying, record anything durable: a preference ("from now on", "always"), a decision or change of plan, a blocker or its resolution, a deadline, a status change, a reusable fact or lesson. Acknowledging in chat is not enough. Use one command and fill only the flags that apply:

   ```bash
   {{CAPTURE}} checkpoint --state "..." --next "..." --decision "title | choice | why" --open "..." --close "match | resolution" --fact "topic | fact" --lesson "title | lesson" --pref "..." --drop "outdated bullet"
   ```

3. Do not hand-edit memory files for routine updates, and do not save transcripts, command output, secrets, or facts obvious from the files.
4. Agents without lifecycle hooks: finish meaningful work with `{{COMMIT}}`.

Full rules: the `workspace-memory` skill (`{{SKILL}}`).
<!-- workspace-memory:end -->
