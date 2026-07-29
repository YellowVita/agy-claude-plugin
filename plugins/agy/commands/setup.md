---
description: Check whether the local Antigravity agy CLI is installed and ready to invoke
argument-hint: '[--json] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup "$ARGUMENTS"
```

Present the complete setup output to the user without adding installation commands.
The setup probe requires json, stream-json, and JSON schema support; older agy releases are unsupported.
If authentication has not been completed, preserve the guidance to run `agy` in a terminal with an interactive TTY. Do not imply that Claude Code's `! agy` always provides a TTY; if it reports `/dev/tty` unavailable, direct the user to a separate terminal window.
