---
description: Challenge implementation choices with a read-only Antigravity adversarial review
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [runtime options] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial review through the companion runtime.

Raw request:
$ARGUMENTS

Core constraints:

- This command is review-only. Never fix findings or apply patches.
- Preserve the user's flags and focus text exactly.
- The runtime always uses Antigravity plan+sandbox mode and the bundled review JSON schema.
- Challenge design choices, hidden assumptions, failure modes, rollback behavior, and operational tradeoffs.

Execution mode:

- If the raw request includes `--wait`, run in the foreground without asking.
- If it includes `--background`, launch with `run_in_background: true` without asking.
- Otherwise estimate the target with git status and diff shortstat.
- Recommend waiting only for a clearly tiny review of one or two files. Recommend background otherwise.
- Ask exactly once with the recommended choice first:
  - `Wait for results`
  - `Run in background`

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "$ARGUMENTS"
```

Return companion stdout verbatim and do not modify code based on the result.

Background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --background "$ARGUMENTS"`,
  description: "Antigravity adversarial review",
  run_in_background: true
})
```

Do not poll in this turn. Tell the user to check `/agy:status`.
