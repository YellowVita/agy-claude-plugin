---
name: antigravity
description: Delegate a self-contained task to Antigravity (agy, Gemini) from the shell: an independent investigation, codebase exploration, second opinion, or cross-model code review. Use it to run work in parallel while you continue, or when the user asks for agy, Antigravity, or Gemini. Do not use it for trivial lookups you can do yourself, or for tasks that depend on this conversation's context you cannot put into a standalone prompt.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" *)
---

# Delegating to Antigravity (agy)

`agy` is Google's Antigravity CLI. This skill runs it headlessly through one wrapper script. Treat agy as a capable colleague who has not seen this conversation: hand it a self-contained job and verify what comes back.

## Calling the wrapper

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" [options] -- "<prompt>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" [options] --prompt-file <path>   # "-" reads stdin
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --check                          # installed and authenticated?
```

Run it from the project directory (or pass `--cwd <dir>`). Output is agy's answer followed by a `[agy]` footer with the status, conversation id, and any problems.

### Writing the prompt

agy has NO access to this conversation, your files-read history, or your plans. Every prompt must stand alone and include:

- the goal and why it matters
- the relevant paths, symbols, or commands (agy can read the repository, so point at it instead of pasting large files)
- constraints (what not to touch, conventions, scope limits)
- the output you want (for example "list findings as `file:line - problem - fix`, most severe first, under 400 words")

For anything longer than a few lines, write the prompt to a file in the scratchpad directory and pass `--prompt-file <path>`; this avoids shell-quoting problems. The prompt still travels to agy as a command-line argument: the wrapper rejects prompts over 100 KB (about 30 KB on Windows) and NUL bytes (exit 2). For large material (diffs, logs, specs), write it to a file and tell agy to read that file by absolute path, adding `--add-dir <its directory>` if it is outside the workspace.

### Options

| Option | Use |
| --- | --- |
| `--mode read` (default) | Asks for read-only behaviour: no edit mode, a read-only guard added to your prompt, and the sandbox. Use for investigation, review, and second opinions. NOT guaranteed, see "Read mode is a request" below. |
| `--mode write` | agy may edit files (accept-edits). |
| `--mode auto` | agy works autonomously with a reviewer agent for sandbox escapes. Linux/macOS only. |
| `--no-sandbox` | Disable agy's sandbox. The sandbox is on by default. |
| `--conversation <id>` | Continue an earlier agy conversation. |
| `--model <m>`, `--effort low\|medium\|high\|xhigh\|max`, `--agent <name>` | Pick model, reasoning effort (agy validates; availability depends on the model), or agent. Omit unless the user asked. |
| `--add-dir <path>` | Give agy access to an extra directory (repeatable). |
| `--json-schema <path-or-inline>` | Structured output; the schema root must be `type: object`. |
| `--timeout <duration>` | For example `9m`. Default is unlimited. |
| `--cwd <dir>` | Working directory for agy. |
| `--raw` | agy's JSON output verbatim. |

Relative `--add-dir`, `--json-schema`, and `--prompt-file` paths resolve against `--cwd` when given, otherwise the current directory. Prefer absolute paths.

### Safety rules

- Use `--mode write` or `--mode auto` ONLY when the user explicitly asked for agy to make changes. Never escalate on your own.
- Use `--no-sandbox` only when the task truly needs network access or installs, and the user is fine with that.
- If the footer shows `denied actions`, agy was blocked by permissions. Report what it tried to do. Do not silently rerun with a broader mode; ask the user first.

### Read mode is a request, not a guarantee

agy's own permission setting (`toolPermission` in `~/.gemini/antigravity-cli/settings.json`, plus any persisted agent mode) decides what is actually allowed. Read mode only avoids edit mode, prepends a "do not create, modify, or delete files" instruction, and keeps the sandbox on. It is enforced only when agy's permission is `request-review` or `strict`; with `always-proceed`, agy can still edit files.

- Check the footer's `permission=` value (`--check` also prints `toolPermission` and `agentMode`).
- Before a read task on a repo with uncommitted work, be aware of this; if `permission=always-proceed`, consider telling the user first.
- After a read-mode run, check `git status`. If there are unexpected changes, tell the user and do not revert them yourself.

## Foreground vs background

The wrapper prints nothing until agy finishes, and Bash kills foreground commands after 2 minutes by default.

- Default to `run_in_background: true` for anything non-trivial. You are notified when it finishes; read the output then. Give each job a distinct `description`. Do not poll or sleep.
- For a short foreground run, pass Bash `timeout: 600000` and wrapper `--timeout 9m`, so the wrapper returns `PARTIAL` instead of being killed with no output.
- Cancel a background job with TaskStop; the wrapper then terminates agy's whole process tree.

## Reading the result

The footer looks like:

```
---
[agy] status=OK conversation=<id> turns=3 duration=42s mode=read sandbox=on permission=request-review
[agy] continue with: --conversation <id>
```

Exit codes:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | OK | Use the answer. |
| 4 | Partial: `--timeout` was given and expired | The answer is incomplete. Say so; retry with a larger `--timeout`, a narrower prompt, or `--conversation <id>` to continue. |
| 3 | agy runtime error: quota, model failure, any non-SUCCESS status (e.g. cancelled), or `--json-schema` requested but no structured output | Report the error line. Retryable errors may be retried once; quota errors should not. |
| 2 | Usage error (wrapper, or passed through from agy) | Fix the command line. |
| 1 | agy rejected its arguments | Read the message and fix the options. |
| 126 | agy could not be started | On Windows `.cmd`/`.bat` shims are unsupported; point `AGY_BIN` at `agy.exe`. |
| 127 | agy not found | Run `--check`; suggest the user install and sign in to agy (run `agy` once in an interactive terminal). |
| 129/130/143 | Wrapper was stopped by a signal (e.g. TaskStop) | Nothing to retry unless the user wants it. |

`--check` exits 0 when ready and 1 otherwise, including agy missing or older than 1.4.0.

For follow-up questions about the same work, pass `--conversation <id>` from the footer so agy keeps its context.

## Verify before presenting

agy's output is a claim, not a fact. Before you relay it:

- spot-check the files, line numbers, and symbols it cites (read them);
- run or inspect anything it says is broken or fixed when that is cheap;
- drop or flag findings you cannot confirm.

When you present results, tell the user they came from Antigravity (agy), and distinguish what you verified from what you did not.

## Reviews

For a cross-model code review, have agy read a diff file and return structured findings. Do not ask agy to run `git diff` itself.

1. Write the diff to a file in the scratchpad directory: `git diff HEAD > <scratch>/review.diff` for the working tree (append the list and content of untracked files from `git status --short`), or `git diff <base>...HEAD` for a branch.
2. Write a prompt file telling agy to read that diff file (absolute path) and inspect the repository files for context. State what the change is meant to do, any focus area, and to report only real defects (bugs, security, data loss, broken contracts) with exact file and line.
3. Run in read mode with the bundled schema. If the scratchpad is outside the repo, add `--add-dir <scratchpad dir>`. Run it in the background.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --mode read \
  --add-dir <scratchpad dir> \
  --json-schema "${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json" \
  --prompt-file <prompt-file>
```

The output is JSON with `verdict` (`approve` or `needs-attention`), `summary`, `findings` (severity, title, body, file, line range, confidence, recommendation), and `next_steps`. Verify each finding against the code before presenting it, and do not apply fixes unless the user asks.
