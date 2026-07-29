// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import process from "node:process";

import {
  createStructuredFailureOutput,
  parseStructuredOutput
} from "./structured-output.mjs";
import {
  appendPrivateText,
  appendLog,
  generateJobId,
  pruneFinishedJobs,
  resolveLogFile,
  resolveStderrFile,
  resolveStdoutFile,
  writeJob,
  writePrivateText
} from "./state.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function createTaskJob({
  cwd,
  workspaceRoot,
  mode,
  background,
  continuation,
  outputFormat,
  outputFormatExplicit,
  jsonSchemaRequested,
  kind = "task",
  reviewKind = null,
  reviewTarget = null,
  stopGate = false
}) {
  const id = generateJobId();
  return {
    version: 3,
    id,
    kind,
    reviewKind,
    reviewTarget,
    stopGate,
    status: background ? "queued" : "created",
    phase: background ? "queued" : "created",
    mode,
    background,
    continuation,
    outputFormat,
    outputFormatExplicit,
    jsonSchemaRequested,
    cwd,
    workspaceRoot,
    pid: null,
    createdAt: nowIso(),
    stdoutFile: resolveStdoutFile(workspaceRoot, id),
    stderrFile: resolveStderrFile(workspaceRoot, id),
    logFile: resolveLogFile(workspaceRoot, id)
  };
}

export async function runTrackedJob(job, runner) {
  let current = writeJob(job.workspaceRoot, {
    ...job,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso(),
    errorMessage: null
  });
  appendLog(job.workspaceRoot, job.id, `Started ${job.mode} ${job.background ? "background" : "foreground"} task.`);
  writePrivateText(current.stdoutFile, "");
  writePrivateText(current.stderrFile, "");

  let execution;
  try {
    execution = await runner({
      onStdout: (chunk) => appendPrivateText(current.stdoutFile, chunk),
      onStderr: (chunk) => appendPrivateText(current.stderrFile, chunk),
      onProgress: (progress) => {
        current = writeJob(job.workspaceRoot, {
          ...current,
          phase: progress.phase ?? current.phase,
          conversationId: progress.conversationId ?? current.conversationId ?? null,
          toolCallCount: progress.toolCallCount ?? current.toolCallCount ?? 0,
          subagentCount: progress.subagentCount ?? current.subagentCount ?? 0,
          recentSteps: progress.recentSteps ?? current.recentSteps ?? [],
          subagents: progress.subagents ?? current.subagents ?? []
        });
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const structuredFailure =
      job.outputFormatExplicit && ["json", "stream-json"].includes(job.outputFormat)
        ? createStructuredFailureOutput(job.outputFormat, { message: errorMessage })
        : "";
    execution = {
      exitStatus: 1,
      signal: null,
      stdout: structuredFailure,
      stderr: errorMessage,
      errorMessage,
      structured: structuredFailure ? parseStructuredOutput(job.outputFormat, structuredFailure) : null
    };
  }

  if (!execution.stdoutPersisted) {
    writePrivateText(current.stdoutFile, execution.stdout ?? "");
  }
  if (!execution.stderrPersisted) {
    writePrivateText(current.stderrFile, execution.stderr ?? execution.errorMessage ?? "");
  }

  const completed = execution.exitStatus === 0 && !execution.errorMessage;
  const structured = execution.structured;
  current = writeJob(job.workspaceRoot, {
    ...current,
    status: completed ? "completed" : "failed",
    phase: completed ? "done" : "failed",
    pid: null,
    completedAt: nowIso(),
    exitStatus: execution.exitStatus,
    signal: execution.signal ?? null,
    errorMessage: execution.errorMessage ?? null,
    conversationId: structured?.conversationId ?? null,
    remoteStatus: structured?.remoteStatus ?? null,
    durationSeconds: structured?.durationSeconds ?? null,
    numTurns: structured?.numTurns ?? null,
    usage: structured?.usage ?? null,
    toolCallCount: structured?.toolCallCount ?? 0,
    subagentCount: structured?.subagentCount ?? 0,
    recentSteps: structured?.recentSteps ?? current.recentSteps ?? [],
    subagents: structured?.subagents ?? current.subagents ?? []
  });
  appendLog(
    job.workspaceRoot,
    job.id,
    completed ? "Completed successfully." : `Failed with exit ${execution.exitStatus}${execution.signal ? ` (${execution.signal})` : ""}.`
  );
  pruneFinishedJobs(job.workspaceRoot);
  return { job: current, execution };
}
