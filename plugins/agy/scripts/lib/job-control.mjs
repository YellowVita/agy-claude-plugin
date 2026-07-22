// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { isProcessRunning } from "./process.mjs";
import { listJobs, readJob, removeRequest, updateJob } from "./state.mjs";
import { nowIso } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function refreshStaleJobs(workspaceRoot) {
  const refreshed = [];
  for (const job of listJobs(workspaceRoot)) {
    if (!ACTIVE_STATUSES.has(job.status)) {
      refreshed.push(job);
      continue;
    }
    if (isProcessRunning(job.pid)) {
      refreshed.push(job);
      continue;
    }

    removeRequest(workspaceRoot, job.id);
    refreshed.push(
      updateJob(workspaceRoot, job.id, {
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt: nowIso(),
        exitStatus: 1,
        errorMessage: "The local worker exited without recording a final result."
      })
    );
  }
  return refreshed;
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }
  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefixes = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixes.length === 1) {
    return prefixes[0];
  }
  if (prefixes.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job ID.`);
  }
  return null;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(refreshStaleJobs(workspaceRoot));
  return {
    workspaceRoot,
    jobs: options.all ? jobs : jobs.slice(0, options.maxJobs ?? 8)
  };
}

export function buildSingleJobSnapshot(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(refreshStaleJobs(workspaceRoot));
  const job = matchJobReference(jobs, reference);
  if (!job) {
    throw new Error(`No Antigravity job found for "${reference}". Run /agy:status to list local jobs.`);
  }
  return { workspaceRoot, job };
}

export async function waitForJob(cwd, reference, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 300_000);
  const pollIntervalMs = Number(options.pollIntervalMs ?? 100);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    if (!ACTIVE_STATUSES.has(snapshot.job.status)) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${snapshot.job.id}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(refreshStaleJobs(workspaceRoot));
  if (reference) {
    const selected = matchJobReference(jobs, reference);
    if (!selected) {
      throw new Error(`No Antigravity job found for "${reference}". Run /agy:status to list local jobs.`);
    }
    if (ACTIVE_STATUSES.has(selected.status)) {
      throw new Error(`Job ${selected.id} is still ${selected.status}. Run /agy:status ${selected.id} --wait first.`);
    }
    return { workspaceRoot, job: selected };
  }

  const selected = jobs.find((job) => FINISHED_STATUSES.has(job.status));
  if (!selected) {
    throw new Error("No finished Antigravity jobs are recorded for this workspace.");
  }
  return { workspaceRoot, job: selected };
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(refreshStaleJobs(workspaceRoot));
  const activeBackground = jobs.filter((job) => ACTIVE_STATUSES.has(job.status) && job.background);
  if (reference) {
    const selected = matchJobReference(activeBackground, reference);
    if (!selected) {
      throw new Error(`No active background Antigravity job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }
  if (activeBackground.length === 1) {
    return { workspaceRoot, job: activeBackground[0] };
  }
  if (activeBackground.length > 1) {
    throw new Error("Multiple Antigravity jobs are active. Pass a job ID to /agy:cancel.");
  }
  throw new Error("No active background Antigravity jobs are available to cancel.");
}

export function readCurrentJob(workspaceRoot, jobId) {
  return readJob(workspaceRoot, jobId);
}
