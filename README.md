# Antigravity `agy` plugin for Claude Code

This plugin delegates tasks from Claude Code to the locally installed Antigravity CLI (`agy`). It follows the command/agent/companion pattern used by the OpenAI Codex Claude Code plugin, but uses `agy -p` as a plain subprocess because `agy` does not expose a JSON app-server protocol.

## Requirements

- Node.js 18.18 or newer
- `agy` 1.1.8 or newer on `PATH`
- Antigravity authentication completed interactively when required

To authenticate, run `agy` in a terminal with an interactive TTY:

```bash
agy
```

If Claude Code's `! agy` reports that `/dev/tty` is unavailable, run `agy` in a separate WSL, Windows Terminal, or other interactive terminal window.

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

## Commands

```text
/agy:setup
/agy:run [structured output options] [options] -- <task>
/agy:rescue [options] -- <task>
/agy:continue [--job <job-id>|--conversation <id>] [options] -- <follow-up>
/agy:review [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background]
/agy:adversarial-review [review options] [focus text]
/agy:status [job-id] [--wait] [--json]
/agy:result [job-id]
/agy:cancel [job-id]
```

## Reviews

Run a read-only review of the working tree, or of the current branch when the working tree is clean:

```text
/agy:review
/agy:review --base origin/main --background
```

Challenge the implementation approach and provide an optional focus:

```text
/agy:adversarial-review --scope working-tree -- focus on rollback and stale-state behavior
```

Reviews always use plan+sandbox mode. They include staged, unstaged, and untracked changes, use the bundled JSON schema, and render stable findings with severity, file location, confidence, and recommendations. Branch refs are resolved to immutable commit object IDs before prompt construction. Review findings are never applied automatically.

Every review records a repository fingerprint before launching and verifies it again after completion. If the worktree, index, untracked files, or HEAD changes while a foreground or background review is running, the result is rejected as stale and must be rerun.

### Permission modes

Safe mode is the default:

```text
/agy:run -- inspect this repository and propose a migration plan
```

It maps to:

```text
agy --output-format json --mode plan --sandbox -p "<prompt>"
```

Explicit write mode:

```text
/agy:run --write -- implement the approved migration
```

It maps to:

```text
agy --output-format json --mode accept-edits --sandbox -p "<prompt>"
```

Confirmed full access:

```text
/agy:run --full-access -- perform the explicitly authorized system-level task
```

Claude Code asks for confirmation before the runtime can pass:

```text
agy --output-format json --mode accept-edits --dangerously-skip-permissions -p "<prompt>"
```

Full access is never inferred, is unavailable through `/agy:rescue`, and cannot run in the background in V1.

## Runtime options

The task runtime accepts:

- `--background`
- `--write` or `--full-access`
- `--output-format text|json|stream-json`
- `--json-schema <inline-schema-or-path>`
- `--model <model>`
- `--agent <agent>`
- `--effort low|medium|high`
- `--print-timeout <duration>`
- repeatable `--add-dir <path>`
- `--project <id>` or `--new-project`
- `--continue` or `--conversation <id>`
- `--cwd <path>` for the companion working directory

Use `--` before task text that begins with a dash.

## Structured output

The companion requests `json` output by default, stores its metadata, and returns only the response text to preserve the normal Claude Code experience. Passing an explicit format returns the raw CLI output:

```text
/agy:run --output-format json -- inspect this repository
/agy:run --output-format stream-json -- inspect this repository
```

`stream-json` is validated and forwarded incrementally as typed NDJSON `init` and `step_update` events. The terminal `result` is held until the agy process exits, ensuring consumers receive exactly one final success or failure result. Each emitted event is appended directly to the private job output file, and the complete stream remains available through `/agy:result`.

Explicit `json` and `stream-json` modes keep stdout machine-readable even when the task fails or is cancelled. Plugin diagnostics are written to stderr; malformed or incomplete structured output is replaced or completed with a valid `FAILED` result.

Use a JSON schema inline or, preferably, from a file:

```text
/agy:run --json-schema ./schemas/review.json -- review this repository
```

When a schema is supplied without an explicit output format, the command returns `structured_output`. Job records retain the conversation ID, terminal status, duration, turn count, token usage including cache reads, recent step summaries, canonical tool names, and child conversation/log references. Tool parameters and output remain only in the private raw output file rather than job metadata.

Continue the latest recorded non-gate conversation, or a specific recorded job, without copying its Antigravity conversation ID:

```text
/agy:continue -- investigate the latest user task
/agy:continue --job <job-id> -- investigate the first finding
```

The companion does not use agy's global `-c` latest pointer because internal reviews or unrelated terminal sessions could otherwise change its meaning. A recorded job must finish before it can be selected with `--job`, preventing concurrent continuation of an active trajectory. Pass `--conversation <id>` when continuing a conversation that was not recorded by this plugin.

Request machine-readable job metadata:

```text
/agy:status <job-id> --json
```

## Setup and experimental review gate

`/agy:setup` verifies the installed executable, minimum version, json and stream-json formats, JSON schema validation, and the local state directory. Builds without the required structured features are rejected instead of using a compatibility path.

An optional stop-time review gate can challenge the previous Claude turn before the session stops:

```text
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
```

The gate is disabled by default and fails open when agy is unavailable or the review cannot run. After it is enabled, the next `UserPromptSubmit` hook records a private git baseline for that Claude turn. The Stop hook compares HEAD, index, working tree, and untracked files against that baseline, so committed changes are included. It generates a private baseline-to-current patch and uses that patch as the exclusive hunk evidence, preventing unchanged pre-existing dirty hunks from being attributed to the current turn. Oversized or unsupported paths that cannot be isolated safely are excluded rather than risking a false block.

Only high-confidence `high` or `critical` findings block stopping. The block message contains a trusted job ID rather than model-generated finding text; inspect details explicitly with `/agy:result <job-id>`. Internal gate jobs are hidden from default status/result selection but are visible with `/agy:status --all`. The gate can add latency and token usage and should be enabled intentionally.

## Important limitations

- Status and cancellation are local plugin process records, not Antigravity server APIs.
- A review result is intentionally discarded if the repository fingerprint changes before it finishes.
- Headless permission prompts may be soft-denied. Configure required Antigravity permissions interactively rather than using full access by default.
- The runtime uses an argv array with `shell: false`, so prompt metacharacters are not evaluated by a shell, but the `-p` prompt may be visible to local process-inspection tools while `agy` is running.
- A completed prompt is not retained in job metadata. Background prompts exist briefly in a mode-`0600` request file until the worker starts.
- A single JSON document or NDJSON event is limited to 32 MiB. `stream-json` does not retain the complete stream in memory.

## State

Per-workspace job records and per-session turn baselines are stored below `$CLAUDE_PLUGIN_DATA/state` when Claude Code provides it. Otherwise the runtime uses an OS temporary directory. Job metadata, structured stdout, stderr, and lifecycle logs are private files; the most recent 50 user jobs and 20 internal gate jobs are retained. Turn baselines and synthetic evidence are deleted after Stop processing. Artifacts left by an interrupted session are deleted after 24 hours on the next plugin state access; fresh sessions are not pruned by count.

## Acknowledgements

This plugin's command, thin-agent, companion-runtime, and local job-tracking architecture is adapted in part from the [OpenAI Codex Plugin for Claude Code](https://github.com/openai/codex-plugin-cc), licensed under the Apache License 2.0. See [NOTICE](NOTICE) for attribution details.

This is an independent community project. It is not affiliated with or endorsed by OpenAI, Google, or the Antigravity project.

## Development

Tests use a fake `agy` executable and never invoke the real CLI:

```bash
npm test
npm run check-version
npm run bump-version -- 0.4.0
```
