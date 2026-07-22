import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractJobId,
  findJobFile,
  installFakeAgy,
  makeTempDir,
  runCompanion,
  waitFor
} from "./helpers.mjs";

function fixture(extraEnv = {}) {
  const workspace = makeTempDir("agy-background-workspace-");
  const pluginData = makeTempDir("agy-background-data-");
  const fakeAgy = installFakeAgy();
  return {
    workspace,
    pluginData,
    env: {
      AGY_PATH: fakeAgy,
      CLAUDE_PLUGIN_DATA: pluginData,
      ...extraEnv
    }
  };
}

test("background jobs complete, wait, return exact output, and erase prompt requests", async () => {
  const { workspace, pluginData, env } = fixture({
    FAKE_AGY_DELAY_MS: "150",
    FAKE_AGY_STDOUT: "background exact output"
  });
  const launched = runCompanion(["task", "--cwd", workspace, "--background", "--", "private background prompt"], {
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = extractJobId(launched.stdout);

  const waited = runCompanion(
    ["status", `--cwd "${workspace}" ${jobId} --wait --timeout-ms 5000 --poll-interval-ms 25`],
    { env, timeout: 10_000 }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /Status: completed/);

  const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "background exact output");

  const jobFile = findJobFile(pluginData, jobId);
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(JSON.stringify(job).includes("private background prompt"), false);
  assert.equal(fs.existsSync(path.join(path.dirname(jobFile), `${jobId}.request.json`)), false);
  assert.equal(fs.readFileSync(job.stdoutFile, "utf8"), "background exact output");
});

test("cancel terminates a background worker process group and records cancellation", async (t) => {
  const { workspace, pluginData, env } = fixture({ FAKE_AGY_MODE: "hang" });
  const launched = runCompanion(["task", "--cwd", workspace, "--background", "--", "hang forever"], { env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = extractJobId(launched.stdout);

  t.after(() => {
    runCompanion(["cancel", "--cwd", workspace, jobId], { env, timeout: 3_000 });
  });

  const jobFile = findJobFile(pluginData, jobId);
  await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    return job.status === "running" && job.pid ? job : null;
  });

  const cancelled = runCompanion(["cancel", "--cwd", workspace, jobId], { env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Job Cancelled/);
  assert.match(cancelled.stdout, /process-group|taskkill|kill/);

  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(job.status, "cancelled");
  assert.equal(job.pid, null);
  const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Task Cancelled/);
  assert.match(result.stdout, /Cancelled by user/);
});

test("status converts dead local worker records into failed stale jobs", async () => {
  const { workspace, pluginData, env } = fixture();
  const initial = runCompanion(["task", "--cwd", workspace, "--background", "--", "brief"], {
    env: { ...env, FAKE_AGY_DELAY_MS: "25" }
  });
  assert.equal(initial.status, 0, initial.stderr);
  const jobId = extractJobId(initial.stdout);
  const jobFile = findJobFile(pluginData, jobId);
  const completed = await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    return job.status === "completed" ? job : null;
  });
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ ...completed, status: "running", phase: "running", pid: 2_147_483_647 }, null, 2)}\n`,
    "utf8"
  );

  const status = runCompanion(["status", "--cwd", workspace, jobId], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Status: failed/);
  assert.match(status.stdout, /worker exited without recording/i);
});
