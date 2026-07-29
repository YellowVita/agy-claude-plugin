---
description: Continue the latest recorded non-gate Antigravity conversation, a job, or a known conversation ID
argument-hint: '[--job <job-id>|--conversation <id>] [--background] [--write|--full-access] [structured output options] [runtime options] [--] <follow-up task>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward the raw request to the companion `task` runtime and add the internal `--continue-command` routing flag.
If the user supplied `--conversation <id>`, the runtime uses that ID instead of the latest recorded non-gate conversation.
If the user supplied `--job <job-id>`, the runtime resolves the stored structured-output conversation ID for that job.
Without either flag, the runtime selects the latest non-gate conversation recorded by this plugin and never uses agy's global `-c` pointer.

Raw request:
$ARGUMENTS

Apply the same full-access policy as `/agy:run`:

- `--full-access --background` is forbidden; full access runs in the foreground only.
- Ask exactly once before full access, with:
  - `Cancel full-access run (Recommended)`
  - `Run with full access`
- Explain that confirmation enables `--dangerously-skip-permissions` in the current workspace.
- Add `--confirm-full-access` only after confirmation.

Runtime forms:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --continue-command "$ARGUMENTS"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --continue-command --confirm-full-access "$ARGUMENTS"
```

Return companion stdout verbatim. Preserve runtime errors without inventing a result.
