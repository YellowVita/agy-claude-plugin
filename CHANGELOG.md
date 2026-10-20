# Changelog

## 0.5.1

Verified against real agy 1.4.2 runs (success, follow-up, timeout, denied actions, schema review).

- Show agy 1.4's `denied_actions` entries as `command (RunCommand)` instead of just `command`.
- Show an unset `toolPermission` as `request-review`, agy's default, instead of `default`. agy removes default values from `settings.json`.
- Use agy's real timeout wording in the tests. On `--print-timeout` expiry agy exits 0 with status `SUCCESS` and prints `[agy] print timeout after …; returning partial output` to stderr, which the wrapper reports as PARTIAL.
- Tell Claude that a run stopped by a denied permission can return an empty response.

## 0.5.0

Breaking restructure: the plugin is now a model-invocable skill plus one thin wrapper script instead of human slash commands, a forwarding subagent, and hooks.

- Replaced the last files adapted from the OpenAI Codex plugin with original ones: a new review result schema (`schemas/review-result.schema.json`: `outcome`, `overview`, `issues`, `unchecked`) and a rewritten `scripts/bump-version.mjs`. NOTICE no longer carries third-party attribution.
- Added the `antigravity` skill so Claude decides on its own when to delegate investigations, exploration, second opinions, and cross-model reviews to agy, and how to write self-contained prompts, verify results, and report them as coming from Antigravity.
- Added the `agy-task.mjs` wrapper (`--mode read|write|auto`, `--no-sandbox`, `--conversation`, `--json-schema`, `--timeout`, `--prompt-file`, `--check`, and more) with a status footer and distinct exit codes (0 ok, 4 partial, 3 agy error, 126 cannot start, 127 not installed, 129/130/143 signal).
- Long and parallel work now uses Claude's background Bash (`run_in_background`) with completion notifications and TaskStop for cancellation, replacing the plugin's own job tracking.
- Removed `/agy:run`, `/agy:rescue`, `/agy:continue`, `/agy:status`, `/agy:result`, `/agy:cancel`, and `/agy:adversarial-review`, the `agy-rescue` subagent, the `agy-cli-runtime` skill, the Stop and UserPromptSubmit hooks (including the stop-time review gate), `--full-access`, and persisted job state. See "Migrating from 0.4" in the README.
- `/agy:setup` now runs the wrapper's `--check`; `/agy:review [--base <ref>] [focus]` has Claude run a schema-validated agy review in read mode and verify the findings before presenting them.
- Fixed plan mode being silently ineffective in 0.4: `--mode plan` is ignored when `--disable-slash-commands` is passed. Read mode now relies on agy's default permission mode plus a prompt guard (see below).
- Fixed truncated output being returned as success: with agy 1.1.28 and newer, hitting `--print-timeout` exits 0 with partial output, and the 0.4 default timeout was 5 minutes. The timeout is now unlimited by default, and a timeout is reported as `PARTIAL` (exit 4) with a notice.
- agy runtime errors (exit 3, `AGY_ERROR`, such as quota or model failures) and `denied_actions` (permission-blocked actions) are now surfaced in the footer instead of being hidden.
- Raised the minimum Antigravity CLI version to 1.4.0. `--check` now enforces it (exit 1 when agy is missing or older) and prints agy's `toolPermission` and `agentMode`.
- Read mode requests read-only behavior (no edit mode, a read-only guard instruction prepended to the prompt, sandbox on) but is enforced only when agy's permission setting is `request-review` or `strict`; with `always-proceed` agy can still edit. The footer now reports `permission=<toolPermission|default|unknown>`, and the skill tells Claude to check it and to report unexpected `git status` changes after a read run.
- Stricter result handling: any non-SUCCESS status (such as cancelled) exits 3, and requesting `--json-schema` without getting structured output is an error.
- Cancelling the wrapper (for example via TaskStop) terminates agy's whole process tree; signal exits are 129/130/143.
- Prompts are validated before launch: over 100 KB (about 30 KB on Windows) or containing NUL bytes is a usage error (exit 2). Reviews now write the diff to a file for agy to read instead of having agy run `git diff`.

## 0.4.0

- Raised the minimum Antigravity CLI version to 1.1.12 so headless mode, model, and effort controls use their corrected upstream behavior.
- Preserved delegated task text by disabling Antigravity slash-command expansion for companion runs.
- Added machine-readable model and agent catalog readiness checks to setup, with backend diagnostics and authentication guidance.
- Prevented concurrent continuations of the same Antigravity conversation with cross-workspace, deadline-backed claims and stale-owner recovery.
- Preserved successful Antigravity stderr diagnostics without contaminating JSON or stream-JSON stdout.

## 0.3.0

- Added read-only review and adversarial-review commands with git scope selection and schema-validated findings.
- Added safe structured progress summaries, child conversation metadata, and JSON status output.
- Added agy feature probing, an optional experimental stop-time review gate, version synchronization, and CI.
- Hardened review refs with immutable commit OIDs, repository-root stale detection, ephemeral turn evidence, fixed hook feedback, internal gate-job isolation, active-continuation rejection, and exactly one terminal stream result.

## 0.2.0

- Added json and stream-json task output, custom JSON schemas, conversation continuation, token usage, and tool/subagent counts.

## 0.1.0

- Added safe, write, and confirmed full-access task delegation with background job management.
