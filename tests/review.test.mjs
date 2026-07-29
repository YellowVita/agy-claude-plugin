import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  extractJobId,
  installFakeAgy,
  makeTempDir,
  runCompanion,
  waitFor,
  findJobFile
} from "./helpers.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function fixture() {
  const workspace = makeTempDir("agy-review-workspace-");
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "tests@example.com"]);
  git(workspace, ["config", "user.name", "Agy Tests"]);
  fs.writeFileSync(path.join(workspace, "app.js"), "export const value = 1;\n");
  git(workspace, ["add", "app.js"]);
  git(workspace, ["commit", "-m", "initial"]);
  fs.writeFileSync(path.join(workspace, "app.js"), "export const value = 2;\n");

  const pluginData = makeTempDir("agy-review-data-");
  const record = path.join(makeTempDir("agy-review-record-"), "record.json");
  const review = {
    verdict: "needs-attention",
    summary: "One correctness problem needs attention.",
    findings: [
      {
        severity: "high",
        title: "Value breaks callers",
        body: "The changed value violates the documented caller contract.",
        file: "app.js",
        line_start: 1,
        line_end: 1,
        confidence: 0.92,
        recommendation: "Preserve the public contract."
      }
    ],
    next_steps: ["Restore compatibility and rerun tests."]
  };
  const env = {
    AGY_PATH: installFakeAgy(),
    CLAUDE_PLUGIN_DATA: pluginData,
    FAKE_AGY_RECORD: record,
    FAKE_AGY_STRUCTURED_OUTPUT: JSON.stringify(review)
  };
  return { workspace, pluginData, record, review, env };
}

test("review uses plan+sandbox, the bundled schema, and a stable Markdown renderer", () => {
  const { workspace, pluginData, record, env } = fixture();
  const result = runCompanion(["review", "--cwd", workspace, "--scope", "working-tree", "--wait"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Antigravity Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[HIGH\] Value breaks callers/);
  assert.match(result.stdout, /app\.js:1/);

  const invocation = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(invocation.argv.slice(4, 7), ["--json-schema", invocation.argv[5], "--mode"]);
  assert.match(invocation.argv[5], /schemas[/\\]review-output\.schema\.json$/);
  assert.deepEqual(invocation.argv.slice(6, 9), ["--mode", "plan", "--sandbox"]);
  assert.match(invocation.prompt, /Do not edit files/);

  const jobId = extractJobId(
    runCompanion(["status", "--cwd", workspace], { env }).stdout.replace(
      /\| (agy-[a-z0-9-]+) \|/,
      "Job: $1"
    )
  );
  const job = JSON.parse(fs.readFileSync(findJobFile(pluginData, jobId), "utf8"));
  assert.equal(job.kind, "review");
  assert.equal(job.reviewKind, "review");
});

test("adversarial review preserves focus text and challenges the design", () => {
  const { workspace, record, env } = fixture();
  const result = runCompanion(
    ["adversarial-review", "--cwd", workspace, "--scope", "working-tree", "--wait", "--", "focus on rollback"],
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Antigravity Adversarial Review/);
  const invocation = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.match(invocation.prompt, /focus on rollback/);
  assert.match(invocation.prompt, /Challenge the chosen design/);
});

test("background reviews integrate with status and result", async () => {
  const { workspace, pluginData, env } = fixture();
  const launched = runCompanion(
    ["review", "--cwd", workspace, "--scope", "working-tree", "--background"],
    { env: { ...env, FAKE_AGY_DELAY_MS: "75" } }
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /Review Queued/);
  const jobId = extractJobId(launched.stdout);
  const jobFile = findJobFile(pluginData, jobId);
  await waitFor(() => JSON.parse(fs.readFileSync(jobFile, "utf8")).status === "completed");

  const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Antigravity Review/);
  assert.match(result.stdout, /Value breaks callers/);
});

test("background reviews fail as stale when the repository changes after launch", async () => {
  const { workspace, pluginData, env } = fixture();
  const launched = runCompanion(
    ["review", "--cwd", workspace, "--scope", "working-tree", "--background"],
    { env: { ...env, FAKE_AGY_DELAY_MS: "250" } }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = extractJobId(launched.stdout);
  fs.writeFileSync(path.join(workspace, "app.js"), "export const value = 99;\n");

  const jobFile = findJobFile(pluginData, jobId);
  const failed = await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    return job.status === "failed" ? job : null;
  });
  assert.match(failed.errorMessage, /result is stale/);
  const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
  assert.match(result.stdout, /result is stale/);
  assert.doesNotMatch(result.stdout, /Value breaks callers/);
});
