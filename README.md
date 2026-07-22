# Antigravity `agy` plugin for Claude Code

This plugin delegates tasks from Claude Code to the locally installed Antigravity CLI (`agy`). It follows the command/agent/companion pattern used by the OpenAI Codex Claude Code plugin, but uses `agy -p` as a plain subprocess because `agy` does not expose a JSON app-server protocol.

## Requirements

- Node.js 18.18 or newer
- `agy` 1.1.5 or a compatible release on `PATH`
- Antigravity authentication completed interactively when required

To authenticate, run this directly in Claude Code:

```text
! agy
```

## Installation

Add the GitHub marketplace and install the plugin from inside Claude Code:

```text
/plugin marketplace add YellowVita/agy-claude-plugin
/plugin install agy@antigravity-agy
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

## Commands

```text
/agy:setup
/agy:run [options] -- <task>
/agy:rescue [options] -- <task>
/agy:continue [--conversation <id>] [options] -- <follow-up>
/agy:status [job-id] [--wait]
/agy:result [job-id]
/agy:cancel [job-id]
```

### Permission modes

Safe mode is the default:

```text
/agy:run -- inspect this repository and propose a migration plan
```

It maps to:

```text
agy --mode plan --sandbox -p "<prompt>"
```

Explicit write mode:

```text
/agy:run --write -- implement the approved migration
```

It maps to:

```text
agy --mode accept-edits --sandbox -p "<prompt>"
```

Confirmed full access:

```text
/agy:run --full-access -- perform the explicitly authorized system-level task
```

Claude Code asks for confirmation before the runtime can pass:

```text
agy --mode accept-edits --dangerously-skip-permissions -p "<prompt>"
```

Full access is never inferred, is unavailable through `/agy:rescue`, and cannot run in the background in V1.

## Runtime options

The task runtime accepts:

- `--background`
- `--write` or `--full-access`
- `--model <model>`
- `--agent <agent>`
- `--effort low|medium|high`
- `--print-timeout <duration>`
- repeatable `--add-dir <path>`
- `--project <id>` or `--new-project`
- `--continue` or `--conversation <id>`
- `--cwd <path>` for the companion working directory

Use `--` before task text that begins with a dash.

## Important limitations

- `agy` output is unstructured text, not a transport-level JSON response.
- Status and cancellation are local plugin process records, not Antigravity server APIs.
- Headless permission prompts may be soft-denied. Configure required Antigravity permissions interactively rather than using full access by default.
- The CLI cannot list conversation IDs through a shell subcommand. `/agy:continue` can use the latest conversation (`-c`) or an ID you already know.
- `agy` 1.1.5 requires the prompt as the value of `-p`; it does not accept a prompt from stdin. The runtime uses an argv array with `shell: false`, so prompt metacharacters are not evaluated by a shell, but the prompt may be visible to local process-inspection tools while `agy` is running.
- A completed prompt is not retained in job metadata. Background prompts exist briefly in a mode-`0600` request file until the worker starts.

## State

Per-workspace job records are stored below `$CLAUDE_PLUGIN_DATA/state` when Claude Code provides it. Otherwise the runtime uses an OS temporary directory. Job metadata, stdout, stderr, and lifecycle logs are private files; the most recent 50 finished jobs are retained.

## Development

Tests use a fake `agy` executable and never invoke the real CLI:

```bash
npm test
```
