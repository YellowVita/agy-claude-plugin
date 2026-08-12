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
The setup probe requires agy 1.1.12 or newer with json, stream-json, JSON schema, and slash-command disabling support; older releases are unsupported.
It queries the machine-readable model catalog first and the agent catalog after model readiness succeeds, distinguishing backend readiness from CLI compatibility. If the readiness probe fails, preserve the authentication guidance to run `agy` in a terminal with an interactive TTY. Do not imply that Claude Code's `! agy` always provides a TTY; if it reports `/dev/tty` unavailable, direct the user to a separate terminal window. Enterprise and Workforce Identity Federation users should follow their configured Antigravity or Google Cloud sign-in flow; Application Default Credentials environments may already provide non-interactive credentials.
