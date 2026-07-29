---
description: Run a read-only Antigravity review against local git changes
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [runtime options]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a review through the companion runtime.

Raw request:
$ARGUMENTS

Core constraints:

- This command is review-only. Never fix findings or apply patches.
- Preserve the user's arguments exactly.
- The runtime always uses Antigravity plan+sandbox mode and the bundled review JSON schema.
- `--scope auto` reviews working-tree changes when present and otherwise reviews the current branch against its detected default branch.
- Use `--base <ref>` to select an explicit branch base.

Execution mode:

- If the raw request includes `--wait`, run in the foreground without asking.
- If it includes `--background`, launch with `run_in_background: true` without asking.
- Otherwise inspect `git status --short --untracked-files=all` and the relevant diff shortstat.
- Recommend waiting only for a clearly tiny review of one or two files. Recommend background otherwise.
- Ask exactly once with the recommended choice first:
  - `Wait for results`
  - `Run in background`

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "$ARGUMENTS"
```

Return companion stdout verbatim and do not modify code based on the result.

Background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --background "$ARGUMENTS"`,
  description: "Antigravity review",
  run_in_background: true
})
```

Do not poll in this turn. Tell the user to check `/agy:status`.
