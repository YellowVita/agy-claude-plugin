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
    FAKE_AGY_RESPONSE: "background exact output",
    FAKE_AGY_STDERR: "background diagnostic\n"
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
  assert.equal(result.stderr, "background diagnostic\n");

  const jobFile = findJobFile(pluginData, jobId);
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(JSON.stringify(job).includes("private background prompt"), false);
  assert.equal(fs.existsSync(path.join(path.dirname(jobFile), `${jobId}.request.json`)), false);
  assert.match(fs.readFileSync(job.stdoutFile, "utf8"), /"response":"background exact output"/);
  assert.equal(fs.readFileSync(job.stderrFile, "utf8"), result.stderr);
  assert.equal(job.conversationId, "fake-conversation-123");
  assert.equal(job.usage.cache_read_tokens, 40);
});

test("background preflight failures retain machine-readable structured results", async () => {
  for (const format of ["json", "stream-json"]) {
    const { workspace, env } = fixture();
    const launched = runCompanion(
      [
        "task",
        "--cwd",
        workspace,
        "--background",
        "--output-format",
        format,
        "--effort",
        "extreme",
        "--",
        "invalid"
      ],
      { env }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = extractJobId(launched.stdout);
    const waited = runCompanion(
      ["status", "--cwd", workspace, jobId, "--wait", "--timeout-ms", "5000"],
      { env, timeout: 10_000 }
    );
    assert.match(waited.stdout, /Status: failed/);

    const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
    if (format === "json") {
      assert.equal(JSON.parse(result.stdout).status, "FAILED");
    } else {
      const event = JSON.parse(result.stdout.trim());
      assert.equal(event.event, "result");
      assert.equal(event.result.status, "FAILED");
    }
    assert.equal(result.stderr.match(/Unsupported effort/g)?.length, 1);
  }
});

test("background missing-executable failures are recorded as machine-readable results", async () => {
  for (const format of ["json", "stream-json"]) {
    const { workspace, env } = fixture();
    const launched = runCompanion(
      ["task", "--cwd", workspace, "--background", "--output-format", format, "--", "missing"],
      { env: { ...env, AGY_PATH: path.join(workspace, "missing-agy") } }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = extractJobId(launched.stdout);
    const waited = runCompanion(
      ["status", "--cwd", workspace, jobId, "--wait", "--timeout-ms", "5000"],
      { env, timeout: 10_000 }
    );
    assert.match(waited.stdout, /Status: failed/);

    const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
    if (format === "json") {
      assert.equal(JSON.parse(result.stdout).status, "FAILED");
    } else {
      const event = JSON.parse(result.stdout.trim());
      assert.equal(event.event, "result");
      assert.equal(event.result.status, "FAILED");
    }
    assert.match(result.stderr, /AGY_PATH is not an executable file/);
  }
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
  assert.equal(result.stdout.match(/Cancelled by user/g)?.length, 1);
});

test("cancelled stream-json jobs retain a machine-readable terminal result", async (t) => {
  const { workspace, pluginData, env } = fixture({ FAKE_AGY_MODE: "hang" });
  const launched = runCompanion(
    ["task", "--cwd", workspace, "--background", "--output-format", "stream-json", "--", "hang forever"],
    { env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = extractJobId(launched.stdout);

  t.after(() => {
    runCompanion(["cancel", "--cwd", workspace, jobId], { env, timeout: 3_000 });
  });

  const jobFile = findJobFile(pluginData, jobId);
  const running = await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    return job.status === "running" && job.pid ? job : null;
  });
  fs.writeFileSync(running.stderrFile, "startup warning\n", "utf8");
  fs.writeFileSync(
    running.stdoutFile,
    `${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "race-conversation",
        status: "SUCCESS",
        response: "too late\n",
        duration_seconds: 1,
        num_turns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 2
        }
      }
    })}\n`,
    "utf8"
  );

  const cancelled = runCompanion(["cancel", "--cwd", workspace, jobId], { env });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const result = runCompanion(["result", "--cwd", workspace, jobId], { env });
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).event, "result");
  assert.equal(events.at(-1).result.status, "FAILED");
  assert.equal(events.filter((event) => event.event === "result").length, 1);
  assert.match(result.stderr, /Task Failed/);
  assert.match(result.stderr, /startup warning/);
  assert.equal(result.stderr.match(/Cancelled by user/g)?.length, 1);
});

test("status converts dead local worker records into failed stale jobs", async () => {
  const { workspace, pluginData, env } = fixture();
  const initial = runCompanion(
    ["task", "--cwd", workspace, "--background", "--output-format", "stream-json", "--", "brief"],
    { env: { ...env, FAKE_AGY_DELAY_MS: "25" } }
  );
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
  const rewritten = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const events = fs
    .readFileSync(rewritten.stdoutFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === "result").length, 1);
  assert.equal(events.at(-1).result.status, "FAILED");
});

test("background continuations claim one conversation without blocking other conversations", async (t) => {
  const { workspace, pluginData, env } = fixture({ FAKE_AGY_MODE: "hang" });
  const first = runCompanion(
    ["task", "--cwd", workspace, "--background", "--conversation", "shared-conversation", "--", "first"],
    { env }
  );
  assert.equal(first.status, 0, first.stderr);
  const firstJobId = extractJobId(first.stdout);

  t.after(() => {
    for (const jobId of [firstJobId]) {
      runCompanion(["cancel", "--cwd", workspace, jobId], { env, timeout: 3_000 });
    }
  });

  const firstJobFile = findJobFile(pluginData, firstJobId);
  await waitFor(() => {
    const job = JSON.parse(fs.readFileSync(firstJobFile, "utf8"));
    return job.status === "running" && job.pid;
  });

  const duplicate = runCompanion(
    ["task", "--cwd", workspace, "--background", "--conversation", "shared-conversation", "--", "second"],
    { env }
  );
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /shared-conversation.*already being continued by job/i);

  const independent = runCompanion(
    ["task", "--cwd", workspace, "--background", "--conversation", "other-conversation", "--", "other"],
    { env }
  );
  assert.equal(independent.status, 0, independent.stderr);
  const independentJobId = extractJobId(independent.stdout);
  t.after(() => {
    runCompanion(["cancel", "--cwd", workspace, independentJobId], { env, timeout: 3_000 });
  });

  const cancelled = runCompanion(["cancel", "--cwd", workspace, firstJobId], { env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const resumed = runCompanion(
    ["task", "--cwd", workspace, "--conversation", "shared-conversation", "--", "after cancel"],
    { env: { ...env, FAKE_AGY_MODE: "success" } }
  );
  assert.equal(resumed.status, 0, resumed.stderr);
});

test("conversation claims release after foreground completion, failure, and background preflight failure", async () => {
  const { workspace, env } = fixture();
  const conversation = "reusable-conversation";
  const args = ["task", "--cwd", workspace, "--conversation", conversation, "--", "continue"];

  let result = runCompanion(args, { env });
  assert.equal(result.status, 0, result.stderr);
  result = runCompanion(args, { env: { ...env, FAKE_AGY_MODE: "failure" } });
  assert.notEqual(result.status, 0);
  result = runCompanion(args, { env });
  assert.equal(result.status, 0, result.stderr);

  const preflight = runCompanion(
    [
      "task",
      "--cwd",
      workspace,
      "--background",
      "--conversation",
      conversation,
      "--effort",
      "extreme",
      "--",
      "invalid"
    ],
    { env }
  );
  assert.equal(preflight.status, 0, preflight.stderr);
  const jobId = extractJobId(preflight.stdout);
  const waited = runCompanion(
    ["status", "--cwd", workspace, jobId, "--wait", "--timeout-ms", "5000"],
    { env, timeout: 10_000 }
  );
  assert.match(waited.stdout, /Status: failed/);

  result = runCompanion(args, { env });
  assert.equal(result.status, 0, result.stderr);
});
