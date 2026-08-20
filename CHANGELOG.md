# Changelog

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
