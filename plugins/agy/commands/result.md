---
description: Show the stored output for a finished local Antigravity plugin job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Present the full output without summarizing or rewriting it. Preserve stderr and exit details for failed or cancelled jobs.
