---
description: Check whether the Antigravity agy CLI is installed, recent enough, and authenticated
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --check)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --check
```

Report the output to the user as is. The plugin needs agy 1.4.0 or newer on `PATH` (1.5.17 or newer recommended); `--check` fails (exit 1) if agy is missing or older. It also prints agy's `toolPermission` and the effective `agentMode`. Mention that read mode follows agy's default Agent Mode, which is Auto on agy 1.5.7+ and approves edits inside the workspace, and since 1.5.16 also approves edits to files outside the workspace that are in a version-controlled repository, plus new files and appends anywhere, so read mode only blocks edits when `toolPermission` is `strict` (or `request-review` with Agent Mode set to Default).

If agy is missing or too old, point the user to the Antigravity installation instructions. If it is installed but not authenticated, tell the user to run `agy` in a terminal with an interactive TTY and sign in. Do not imply that Claude Code's `! agy` always provides a TTY; if it reports `/dev/tty` unavailable, direct the user to a separate terminal window. Enterprise and Workforce Identity Federation users should follow their configured Antigravity or Google Cloud sign-in flow; Application Default Credentials environments may already provide non-interactive credentials.
