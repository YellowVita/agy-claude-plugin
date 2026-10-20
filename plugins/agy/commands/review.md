---
description: Have Antigravity (agy) review local git changes, then verify its findings
argument-hint: '[--base <ref>] [focus text]'
allowed-tools: Read, Write, Glob, Grep, Bash(git:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" *)
---

Run an Antigravity (agy) review in read mode of local changes, following the Reviews recipe of the `antigravity` skill.

Raw request: $ARGUMENTS

Steps:

1. Parse the request. `--base <ref>` selects a branch review (`git diff <ref>...HEAD`). Without it, review the working tree (`git diff HEAD` plus untracked files from `git status --short`); if the working tree is clean, review the current branch against its default branch. Any remaining text is the focus area.
2. If there is nothing to review, say so and stop.
3. Write the diff to a file in the scratchpad directory (do not have agy run git itself): `git diff HEAD > <scratch>/review.diff` plus the list and content of untracked files for a working-tree review, or `git diff <ref>...HEAD` for a branch review.
4. Write a self-contained prompt file in the scratchpad directory telling agy to read the diff file (absolute path) and inspect the repository files for context, with the focus text and an instruction to report only real defects with exact file and line. Run agy in read mode with the bundled schema; add `--add-dir <scratchpad dir>` if the scratchpad is outside the repo. For anything but a tiny diff, use Bash with `run_in_background: true` and continue when notified.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-task.mjs" --mode read \
  --add-dir <scratchpad dir> \
  --json-schema "${CLAUDE_PLUGIN_ROOT}/schemas/review-output.schema.json" \
  --prompt-file <prompt-file>
```

5. Check the footer's `permission=`; read mode is only enforced when it is `request-review` or `strict`, so if `git status` shows unexpected changes afterwards, tell the user. Verify every finding against the code (read the cited file and lines) before presenting it. Drop or flag findings you cannot confirm. Present the verdict, the confirmed findings ordered by severity with file and line, and say the review came from Antigravity.

This command is review-only. Never fix findings or apply patches unless the user asks afterwards.
