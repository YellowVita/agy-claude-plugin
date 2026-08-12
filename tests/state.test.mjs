import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertConversationClaim,
  claimConversation,
  releaseConversation
} from "../plugins/agy/scripts/lib/conversation-claims.mjs";
import {
  listJobs,
  pruneFinishedJobs,
  pruneTurnArtifacts,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  resolveTurnSnapshotFile,
  writeTurnEvidence,
  writeTurnSnapshot,
  writeJob
} from "../plugins/agy/scripts/lib/state.mjs";
import {
  buildSingleJobSnapshot,
  resolveLatestConversationJob
} from "../plugins/agy/scripts/lib/job-control.mjs";
import {
  isProcessRunning,
  isProcessTreeRunning,
  terminateProcessTree,
  waitForProcessTreeExit
} from "../plugins/agy/scripts/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

function claimOptions(leaseMs = 10_000) {
  return { expiresAt: new Date(Date.now() + leaseMs).toISOString() };
}

function withPluginData(pluginData, callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("state is private and separated by canonical workspace hash", () => {
  const pluginData = makeTempDir("agy-state-data-");
  const workspaceA = makeTempDir("agy-state-a-");
  const workspaceB = makeTempDir("agy-state-b-");

  withPluginData(pluginData, () => {
    const stateA = resolveStateDir(workspaceA);
    const stateB = resolveStateDir(workspaceB);
    assert.notEqual(stateA, stateB);
    assert.ok(stateA.startsWith(path.join(pluginData, "state")));

    writeJob(workspaceA, { id: "agy-private", status: "completed", mode: "safe", background: false });
    const jobFile = resolveJobFile(workspaceA, "agy-private");
    assert.equal(fs.statSync(resolveStateDir(workspaceA)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(resolveJobsDir(workspaceA)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(jobFile).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(jobFile)).some((name) => name.endsWith(".tmp")), false);
  });
});

test("pruning retains active jobs and only the 50 newest finished records", () => {
  const pluginData = makeTempDir("agy-prune-data-");
  const workspace = makeTempDir("agy-prune-workspace-");

  withPluginData(pluginData, () => {
    for (let index = 0; index < 51; index += 1) {
      writeJob(workspace, {
        id: `agy-finished-${index}`,
        status: "completed",
        mode: "safe",
        background: false,
        completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    writeJob(workspace, {
      id: "agy-active",
      status: "running",
      mode: "write",
      background: true,
      pid: process.pid
    });

    pruneFinishedJobs(workspace);
    const jobs = listJobs(workspace);
    assert.equal(jobs.filter((job) => job.status === "completed").length, 50);
    assert.ok(jobs.some((job) => job.id === "agy-active" && job.status === "running"));
  });
});

test("internal gate jobs have a separate retention budget from user jobs", () => {
  const pluginData = makeTempDir("agy-prune-gate-data-");
  const workspace = makeTempDir("agy-prune-gate-workspace-");

  withPluginData(pluginData, () => {
    for (let index = 0; index < 51; index += 1) {
      writeJob(workspace, {
        id: `agy-user-${index}`,
        status: "completed",
        stopGate: false,
        completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    for (let index = 0; index < 21; index += 1) {
      writeJob(workspace, {
        id: `agy-gate-${index}`,
        status: "completed",
        stopGate: true,
        completedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString()
      });
    }

    pruneFinishedJobs(workspace);
    const jobs = listJobs(workspace);
    assert.equal(jobs.filter((job) => !job.stopGate).length, 50);
    assert.equal(jobs.filter((job) => job.stopGate).length, 20);
  });
});

test("latest continuation excludes active conversations", () => {
  const pluginData = makeTempDir("agy-latest-data-");
  const workspace = makeTempDir("agy-latest-workspace-");

  withPluginData(pluginData, () => {
    writeJob(workspace, {
      id: "agy-completed",
      status: "completed",
      stopGate: false,
      conversationId: "completed-conversation",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    writeJob(workspace, {
      id: "agy-running",
      status: "running",
      stopGate: false,
      conversationId: "running-conversation",
      pid: process.pid,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const latest = resolveLatestConversationJob(workspace);
    assert.equal(latest.job.id, "agy-completed");
    assert.equal(latest.job.conversationId, "completed-conversation");
  });
});

test("turn artifact retention removes expired private baselines and evidence", () => {
  const pluginData = makeTempDir("agy-turn-prune-data-");
  const workspace = makeTempDir("agy-turn-prune-workspace-");

  withPluginData(pluginData, () => {
    const sessionId = "expired-session";
    writeTurnSnapshot(workspace, sessionId, { version: 2, sensitive: "baseline" });
    const evidenceFile = writeTurnEvidence(workspace, sessionId, "sensitive patch");
    const snapshotFile = resolveTurnSnapshotFile(workspace, sessionId);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(snapshotFile, old, old);
    fs.utimesSync(path.dirname(evidenceFile), old, old);

    pruneTurnArtifacts(workspace, { maxAgeMs: 1 });
    assert.equal(fs.existsSync(snapshotFile), false);
    assert.equal(fs.existsSync(path.dirname(evidenceFile)), false);
  });
});

test("fresh turn baselines are not pruned by session count", () => {
  const pluginData = makeTempDir("agy-turn-count-data-");
  const workspace = makeTempDir("agy-turn-count-workspace-");

  withPluginData(pluginData, () => {
    for (let index = 0; index < 21; index += 1) {
      writeTurnSnapshot(workspace, `active-session-${index}`, {
        version: 2,
        session: index
      });
    }
    const snapshots = fs
      .readdirSync(resolveStateDir(workspace))
      .filter((name) => /^turn-[0-9a-f]{24}\.json$/.test(name));
    assert.equal(snapshots.length, 21);
  });
});

test("conversation claims are exclusive per conversation and independently releasable", () => {
  const pluginData = makeTempDir("agy-claims-data-");
  const workspace = makeTempDir("agy-claims-workspace-");
  const otherWorkspace = makeTempDir("agy-claims-other-workspace-");

  withPluginData(pluginData, () => {
    claimConversation(workspace, "conversation-a", "job-a", claimOptions());
    assert.throws(
      () => claimConversation(workspace, "conversation-a", "job-b", claimOptions()),
      /already being continued by job job-a/i
    );
    assert.throws(
      () => claimConversation(otherWorkspace, "conversation-a", "job-other-workspace", claimOptions()),
      /already being continued by job job-a/i
    );
    assert.doesNotThrow(() => claimConversation(workspace, "conversation-b", "job-b", claimOptions()));

    releaseConversation(workspace, "conversation-a", "not-the-owner");
    assert.throws(
      () => claimConversation(workspace, "conversation-a", "job-c", claimOptions()),
      /already being continued/i
    );
    releaseConversation(workspace, "conversation-a", "job-a");
    assert.doesNotThrow(() => claimConversation(workspace, "conversation-a", "job-c", claimOptions()));

    releaseConversation(workspace, "conversation-a", "job-c");
    releaseConversation(workspace, "conversation-b", "job-b");
  });
});

test("concurrent processes elect exactly one conversation claim owner", async () => {
  const pluginData = makeTempDir("agy-concurrent-claims-data-");
  const workspace = makeTempDir("agy-concurrent-claims-workspace-");
  const claimModule = new URL("../plugins/agy/scripts/lib/conversation-claims.mjs", import.meta.url).href;
  const contenders = Array.from({ length: 8 }, (_, index) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { claimConversation } from ${JSON.stringify(claimModule)};
           try {
             claimConversation(${JSON.stringify(workspace)}, "contended-conversation", "job-${index}", {
               expiresAt: new Date(Date.now() + 10_000).toISOString()
             });
             setTimeout(() => process.exit(0), 200);
           } catch (error) {
             process.stderr.write(String(error.message));
             process.exit(2);
           }`
        ],
        {
          cwd: path.resolve("."),
          env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
          stdio: ["ignore", "ignore", "pipe"]
        }
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stderr }));
    })
  );

  const results = await Promise.all(contenders);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  for (const loser of results.filter((result) => result.status !== 0)) {
    assert.equal(loser.status, 2);
    assert.match(loser.stderr, /already being continued by job/i);
  }
});

test("dead handoff owners keep conversations claimed until their execution lease expires", async () => {
  const pluginData = makeTempDir("agy-dead-claim-data-");
  const workspace = makeTempDir("agy-dead-claim-workspace-");
  const claimModule = new URL("../plugins/agy/scripts/lib/conversation-claims.mjs", import.meta.url).href;
  const stateModule = new URL("../plugins/agy/scripts/lib/state.mjs", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { claimConversation } from ${JSON.stringify(claimModule)};
       import { writeJob } from ${JSON.stringify(stateModule)};
       writeJob(${JSON.stringify(workspace)}, { id: "dead-job", status: "queued", background: true, pid: null });
       claimConversation(${JSON.stringify(workspace)}, "stale-conversation", "dead-job", {
         expiresAt: new Date(Date.now() + 500).toISOString()
       });`
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      encoding: "utf8"
    }
  );
  assert.equal(child.status, 0, child.stderr);

  withPluginData(pluginData, () => {
    assert.equal(buildSingleJobSnapshot(workspace, "dead-job").job.status, "failed");
    assert.throws(
      () => claimConversation(workspace, "stale-conversation", "replacement-job", claimOptions()),
      /already being continued by job dead-job/i
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 550));
  withPluginData(pluginData, () => {
    assert.doesNotThrow(() =>
      claimConversation(workspace, "stale-conversation", "replacement-job", claimOptions())
    );
    releaseConversation(workspace, "stale-conversation", "replacement-job");
  });
});

test("expired workers cannot start or release a replacement conversation claim", async () => {
  const pluginData = makeTempDir("agy-expired-claim-data-");
  const workspace = makeTempDir("agy-expired-claim-workspace-");
  const conversationId = "expired-worker-conversation";
  const firstExpiry = new Date(Date.now() + 200).toISOString();

  withPluginData(pluginData, () => {
    claimConversation(workspace, conversationId, "first-job", { expiresAt: firstExpiry });
    assert.doesNotThrow(() =>
      assertConversationClaim(workspace, conversationId, "first-job", { expiresAt: firstExpiry })
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const replacementExpiry = new Date(Date.now() + 10_000).toISOString();
  withPluginData(pluginData, () => {
    assert.throws(
      () => assertConversationClaim(workspace, conversationId, "first-job", { expiresAt: firstExpiry }),
      /delayed worker will not start/i
    );
    claimConversation(workspace, conversationId, "replacement-job", { expiresAt: replacementExpiry });
    releaseConversation(workspace, conversationId, "first-job");
    assert.doesNotThrow(() =>
      assertConversationClaim(workspace, conversationId, "replacement-job", { expiresAt: replacementExpiry })
    );
    releaseConversation(workspace, conversationId, "replacement-job");
  });
});

test("expired pending claim metadata is pruned without touching live pending claims", async () => {
  const pluginData = makeTempDir("agy-pending-claim-data-");
  const workspace = makeTempDir("agy-pending-claim-workspace-");
  const claimsDir = path.join(pluginData, "state", "conversation-claims");
  const key = createHash("sha256").update("pending-conversation").digest("hex");
  const expiredToken = "a".repeat(32);
  const liveToken = "b".repeat(32);
  const expiredDir = path.join(claimsDir, `${key}.pending-${Date.now() - 1}-${expiredToken}`);
  const liveDir = path.join(claimsDir, `${key}.pending-${Date.now() + 10_000}-${liveToken}`);
  fs.mkdirSync(expiredDir, { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(expiredDir, `owner-${expiredToken}.json`), '{"conversationId":"sensitive"}\n');
  fs.writeFileSync(path.join(liveDir, `owner-${liveToken}.json`), '{"conversationId":"live"}\n');

  withPluginData(pluginData, () => {
    claimConversation(workspace, "trigger-cleanup", "cleanup-job", claimOptions());
    releaseConversation(workspace, "trigger-cleanup", "cleanup-job");
  });
  assert.equal(fs.existsSync(expiredDir), false);
  assert.equal(fs.existsSync(liveDir), true);
});

test("an orphaned background descendant keeps its job and conversation claimed", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are required for this test.");
    return;
  }

  const pluginData = makeTempDir("agy-orphan-claim-data-");
  const workspace = makeTempDir("agy-orphan-claim-workspace-");
  const conversationId = "orphaned-background-conversation";
  const leader = spawn(
    process.execPath,
    [
      "-e",
      "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref();"
    ],
    { detached: true, stdio: "ignore" }
  );
  const leaderExited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the process-group leader to exit.")), 2_000);
    leader.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    leader.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  leader.unref();

  t.after(async () => {
    terminateProcessTree(leader.pid, { signal: "SIGKILL" });
    await waitForProcessTreeExit(leader.pid, { timeoutMs: 2_000 });
  });

  await leaderExited;
  const deadline = Date.now() + 2_000;
  while (!isProcessTreeRunning(leader.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(isProcessRunning(leader.pid), false);
  assert.equal(isProcessTreeRunning(leader.pid), true);

  withPluginData(pluginData, () => {
    writeJob(workspace, {
      id: "orphaned-background-job",
      status: "running",
      background: true,
      pid: leader.pid,
      resumeConversationId: conversationId
    });
    claimConversation(workspace, conversationId, "orphaned-background-job", claimOptions());

    assert.equal(buildSingleJobSnapshot(workspace, "orphaned-background-job").job.status, "running");
    assert.throws(
      () => claimConversation(workspace, conversationId, "overlapping-job", claimOptions()),
      /already being continued by job orphaned-background-job/i
    );
  });
});
