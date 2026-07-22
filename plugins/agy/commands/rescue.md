---
description: Delegate a bounded investigation, plan, or explicitly write-enabled task to Antigravity
argument-hint: '[--background] [--write] [--continue|--conversation <id>] [runtime options] [--] <task>'
allowed-tools: Bash(node:*), Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool with `subagent_type: "agy:agy-rescue"`, forwarding the raw user request as its prompt.
The subagent runs inline. Do not call `Skill(agy:rescue)` or a forked general-purpose agent because that can recurse or lose the explicit transport.

Raw user request:
$ARGUMENTS

Safety and routing rules:

- If the request contains `--full-access` or `--confirm-full-access`, do not invoke the subagent. Tell the user to use `/agy:run --full-access` so Claude Code can obtain direct confirmation.
- Safe plan+sandbox mode is the default.
- Preserve `--write` only when the user explicitly supplied it. Never infer write access from verbs such as “fix”, “implement”, or “change”.
- Preserve explicit `--background`, `--continue`, `--conversation`, model, agent, effort, timeout, directory, and project options.
- If the user did not supply a request, ask what Antigravity should investigate or plan.
- The final user-visible response must be the companion output verbatim.
- Do not inspect files, solve the task independently, poll status, retrieve results, or perform follow-up work on behalf of the subagent.
