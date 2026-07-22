---
name: agy-cli-runtime
description: Internal contract for forwarding one task to the Antigravity companion runtime
user-invocable: false
---

# Antigravity Runtime

Use this skill only inside the `agy:agy-rescue` subagent.

Primary helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "<raw arguments>"
```

Contract:

- Invoke `task` exactly once and return its stdout unchanged.
- Do no independent repository work or analysis.
- Default to safe `plan` plus sandbox mode.
- Preserve `--write` only when the user explicitly supplied it.
- Never infer write access.
- Never pass `--full-access` or `--confirm-full-access`; those require a direct slash command and confirmation.
- Preserve explicit background, continuation, model, agent, effort, timeout, extra-directory, and project controls.
- Do not call setup, status, result, cancel, or another agent.
- On failure, preserve the runtime error rather than fabricating an Antigravity answer.
