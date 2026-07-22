---
description: Run an Antigravity task with safe defaults, explicit edits, or confirmed full access
argument-hint: '[--background] [--write|--full-access] [--model <model>] [--agent <agent>] [--effort low|medium|high] [--print-timeout <duration>] [--add-dir <path> ...] [--project <id>|--new-project] [--] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run the raw request through the companion runtime. Preserve all user-supplied flags and task text.

Raw request:
$ARGUMENTS

Full-access policy:

- If the raw request does not contain `--full-access`, do not ask a permission question. Invoke `task` once with the raw request as one quoted argument.
- If the raw request contains `--full-access` together with `--background`, do not invoke Antigravity. Explain that V1 permits full access only in the foreground.
- If the raw request contains `--full-access`, use `AskUserQuestion` exactly once before invoking the runtime.
- Explain that this mode passes `--dangerously-skip-permissions`, can execute commands and change files beyond the normal sandbox policy, and runs in the current workspace.
- Use these choices:
  - `Cancel full-access run (Recommended)`
  - `Run with full access`
- If the user cancels, do not invoke the runtime.
- If the user confirms, add the internal `--confirm-full-access` flag to the runtime call. Never add that flag otherwise.

Runtime forms:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "$ARGUMENTS"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --confirm-full-access "$ARGUMENTS"
```

Return companion stdout verbatim. On failure, preserve the actionable stderr and do not invent an Antigravity result.
