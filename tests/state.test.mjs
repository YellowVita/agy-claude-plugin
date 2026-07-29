import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

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
import { resolveLatestConversationJob } from "../plugins/agy/scripts/lib/job-control.mjs";
import { makeTempDir } from "./helpers.mjs";

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
