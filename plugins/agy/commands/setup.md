---
description: Check whether the local Antigravity agy CLI is installed and ready to invoke
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup
```

Present the complete setup output to the user without adding installation commands.
If authentication has not been completed, preserve the guidance to run `! agy` interactively.
