import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  listJobs,
  pruneFinishedJobs,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  writeJob
} from "../plugins/agy/scripts/lib/state.mjs";
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
