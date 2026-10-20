# Antigravity `agy` plugin for Claude Code

This plugin lets Claude Code delegate work to the locally installed Antigravity CLI (`agy`, Gemini): independent investigations, codebase exploration, second opinions, and cross-model code reviews.

It is a model-invocable **skill** plus one thin wrapper script. Claude decides on its own when to hand a task to agy, calls the wrapper through its Bash tool, runs long or parallel jobs with Bash `run_in_background` (Claude is notified when they finish), and cancels them with TaskStop. There are no job records, hooks, or forwarding subagents to manage.

## Requirements

- Node.js 18.18 or newer
- `agy` 1.4.0 or newer on `PATH`
- Antigravity authentication configured for the selected account or environment

To authenticate, run `agy` in a terminal with an interactive TTY:

```bash
agy
```

If Claude Code's `! agy` reports that `/dev/tty` is unavailable, run `agy` in a separate WSL, Windows Terminal, or other interactive terminal window.

Antigravity also supports Gemini Enterprise sign-in, Workforce Identity Federation, and Application Default Credentials. Configure those through Antigravity or Google Cloud as appropriate, then confirm with `/agy:setup`.

## Installation

First, add the GitHub marketplace from inside Claude Code:

```text
/plugin marketplace add YellowVita/agy-claude-plugin
```

Then install the plugin:

```text
/plugin install agy@antigravity-agy
```

Apply the installed plugin:

```text
/reload-plugins
```

Verify the installation with:

```text
/agy:setup
```

## Local development

```bash
git clone https://github.com/YellowVita/agy-claude-plugin.git
cd agy-claude-plugin
claude --plugin-dir "$PWD/plugins/agy"
```

Validate the marketplace/plugin bundle with:

```bash
claude plugin validate . --strict
```

## How Claude uses it

The `antigravity` skill describes when delegation is worthwhile, so Claude can pick it up without being told. Typical triggers:

- a self-contained investigation or codebase exploration that can run while Claude keeps working
- a second opinion or a cross-model review of a change
- several independent questions that can run in parallel
- you asking for agy, Antigravity, or Gemini

Claude is also told when not to delegate: trivial lookups it can do itself, and tasks that depend on this conversation's context that cannot be passed along (agy cannot see the conversation, so every prompt must be self-contained).

Ask explicitly whenever you like:

```text
Ask agy to map how authentication flows through this repo and report the entry points.
Have agy review my uncommitted changes while you keep working on the tests.
Get a second opinion from Antigravity on this migration plan.
```

Claude then writes a standalone prompt, runs the wrapper (in the background for long jobs), checks the cited files and lines, and tells you which results came from Antigravity. If agy reports a conversation id, Claude can continue the same conversation for follow-ups.

### Modes

| Mode | Behavior | When Claude uses it |
| --- | --- | --- |
| `read` (default) | Requests read-only behavior: no edit mode, a read-only instruction added to the prompt, and the sandbox. Not enforced unless agy's permission setting is strict (see Permissions). | Always, unless you ask otherwise. |
| `write` | accept-edits: agy may edit files automatically. | Only when you explicitly ask agy to make changes. |
| `auto` | agy auto mode: autonomous, with a reviewer agent for sandbox escapes. Linux and macOS only. | Only when you explicitly ask for it. |

The agy sandbox is on by default. `--no-sandbox` is used only when a task needs network access or installs and you are fine with that. If agy is blocked by permissions, the wrapper prints a `denied actions` line and Claude reports it instead of silently escalating the mode.

### Permissions

agy's own permission settings decide what it may do, not the wrapper's mode. If `toolPermission` in `~/.gemini/antigravity-cli/settings.json` is `always-proceed`, agy auto-approves everything, so a read-mode run can still edit files. Read mode is enforced only when `toolPermission` is `request-review` or `strict`. To make read mode strict, set `toolPermission` to `request-review` in agy's settings (see agy's `/permissions` or `/config`). If `toolPermission` is not set, agy uses `request-review`, and the footer shows that. The footer shows `permission=<value>` after each run and `/agy:setup` (`--check`) prints `toolPermission` and `agentMode`, so you can see what is in effect. Claude is told to check this and to report unexpected `git status` changes after a read-mode run.

## Commands

```text
/agy:setup
/agy:review [--base <ref>] [focus]
```

- `/agy:setup` runs `agy-task.mjs --check`: it verifies the executable, the minimum version (agy 1.4.0 or newer; older versions fail the check), backend readiness, and prints agy's `toolPermission` and `agentMode`.
- `/agy:review` has Claude write the diff of your working tree (or of the branch against `--base <ref>`) to a file, have agy review it in read mode using the bundled JSON schema, then verify each finding before presenting it. Findings are never applied automatically.

## Wrapper CLI reference

The skill calls the wrapper below. You can also run it yourself.

```text
node plugins/agy/scripts/agy-task.mjs [options] [--] <prompt...>
node plugins/agy/scripts/agy-task.mjs [options] --prompt-file <path>      ("-" = stdin)
node plugins/agy/scripts/agy-task.mjs --check
```

| Option | Description |
| --- | --- |
| `--mode read\|write\|auto` | Permission mode (default `read`). |
| `--no-sandbox` | Disable the agy sandbox (on by default). |
| `--conversation <id>` | Continue an earlier agy conversation. |
| `--model <m>` | Model to use. |
| `--effort low\|medium\|high\|xhigh\|max` | Reasoning effort (agy validates; availability depends on the model). |
| `--agent <name>` | agy agent to use. |
| `--add-dir <path>` | Extra directory agy may access (repeatable). Relative paths resolve against `--cwd` if given, else the current directory. |
| `--json-schema <path-or-inline>` | Structured output; the schema root must be `type: object`. A relative file path resolves like `--add-dir`. |
| `--timeout <duration>` | For example `10m`. Default is unlimited. |
| `--cwd <dir>` | Working directory (resolved against the current directory). Recommend absolute paths everywhere. |
| `--raw` | agy's JSON output verbatim. |
| `--prompt-file <path>` | Read the prompt from a file (`-` for stdin); useful for long or quote-heavy prompts. A relative path resolves like `--add-dir`. |
| `--check` | Verify agy is installed, recent enough, and ready. |
| `-h`, `--help` | Show help. |

Output is the response text (or pretty-printed JSON with `--json-schema`) followed by a footer:

```text
---
[agy] status=<OK|PARTIAL|ERROR> conversation=<id> turns=<n> duration=<s>s mode=<read|write|auto> sandbox=<on|off> permission=<toolPermission|unknown>
[agy] denied actions: ...                (if any)
[agy] timed out: response is partial     (if the timeout was reached)
[agy] error: <message> (status=..., retryable=...)   (on error)
[agy] continue with: --conversation <id>
```

Prompts are passed to agy as a command-line argument: the wrapper rejects prompts over 100 KB (about 30 KB on Windows) and NUL bytes (exit 2). For large material, write it to a file and tell agy to read it (with `--add-dir` if it is outside the workspace).

Cancelling the wrapper (for example with TaskStop) terminates agy's whole process tree.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 4 | Partial output (only when `--timeout` was given and expired) |
| 3 | agy runtime error (quota, model failure, any non-SUCCESS status such as cancelled, or `--json-schema` requested but no structured output returned) |
| 2 | Usage error (wrapper, or passed through from agy) |
| 1 | agy rejected its arguments |
| 126 | agy could not be started (on Windows `.cmd`/`.bat` shims are unsupported; point `AGY_BIN` at `agy.exe`) |
| 127 | agy not found |
| 129/130/143 | Wrapper was stopped by a signal (for example TaskStop) |

`--check` exits 0 when ready and 1 otherwise, including when agy is missing or older than 1.4.0.

## Migrating from 0.4

0.5.0 replaces the human slash-command workflow with a skill that Claude invokes itself.

| Removed | Replacement |
| --- | --- |
| `/agy:run`, `/agy:rescue` | Ask Claude to delegate to agy; it uses the `antigravity` skill. |
| `--background`, background jobs, `/agy:status`, `/agy:result` | Claude runs the wrapper with Bash `run_in_background` and is notified on completion. |
| `/agy:cancel` | TaskStop on the background Bash task. |
| `/agy:continue`, `--job`, `--continue` | `--conversation <id>` (the id is printed in the output footer). |
| `/agy:adversarial-review` | `/agy:review [--base <ref>] [focus]`, with the focus text steering the review. |
| `--full-access` / `--dangerously-skip-permissions` | Removed. Use `--mode auto` or `--mode write`, or configure Antigravity permissions interactively. |
| Stop-time review gate (`--enable-review-gate`) and the UserPromptSubmit/Stop hooks | Removed. Ask for a review with `/agy:review`. |
| `agy-rescue` subagent, `agy-cli-runtime` skill | Replaced by the single `antigravity` skill. |
| `--output-format`, `--print-timeout`, `--project`, `--new-project` | `--raw` for agy's JSON, `--timeout` (unlimited by default); projects are no longer managed. |

Job records under `$CLAUDE_PLUGIN_DATA/state` are no longer written or read.

## Limitations

- agy runs headlessly: permission prompts cannot be answered. What is denied depends on agy's permission setting; read mode is not enforced under `always-proceed` (see Permissions).
- The wrapper starts `agy` with an argv array and `shell: false`, so prompt metacharacters are not evaluated by a shell, but the prompt is passed to agy as a command-line argument and may be visible to local process-inspection tools while `agy` runs, including when read via `--prompt-file`. Do not put secrets in prompts.
- agy output is model output: Claude is instructed to verify it before presenting it, but you should review anything consequential yourself.

## Acknowledgements

This project began as an adaptation of the [OpenAI Codex Plugin for Claude Code](https://github.com/openai/codex-plugin-cc). Since 0.5.0 it contains no code or files from that project.

This is an independent community project. It is not affiliated with or endorsed by OpenAI, Google, or the Antigravity project.

## Development

Tests use a fake `agy` executable and never invoke the real CLI:

```bash
npm test
npm run check-version
npm run bump-version -- 0.5.0
```
