---
description: Show active and recent local Antigravity plugin jobs for this workspace
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

Present the complete command output. These are plugin-local process records, not Antigravity server-side job status.
Default listings hide internal stop-gate review jobs; `--all` includes them.
