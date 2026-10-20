---
description: Check whether the Antigravity agy CLI is installed, recent enough, and authenticated
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --check)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --check
```

Report the output to the user as is. The plugin needs agy 1.4.0 or newer on `PATH`; `--check` fails (exit 1) if agy is missing or older. It also prints agy's `toolPermission` and `agentMode`; mention that read mode is only enforced when `toolPermission` is `request-review` or `strict`.

If agy is missing or too old, point the user to the Antigravity installation instructions. If it is installed but not authenticated, tell the user to run `agy` in a terminal with an interactive TTY and sign in. Do not imply that Claude Code's `! agy` always provides a TTY; if it reports `/dev/tty` unavailable, direct the user to a separate terminal window. Enterprise and Workforce Identity Federation users should follow their configured Antigravity or Google Cloud sign-in flow; Application Default Credentials environments may already provide non-interactive credentials.
