import process from "node:process";

import {
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

export function createTaskJob({ cwd, workspaceRoot, mode, background, continuation }) {
  const id = generateJobId();
  return {
    version: 1,
    id,
    kind: "task",
    status: background ? "queued" : "created",
    phase: background ? "queued" : "created",
    mode,
    background,
    continuation,
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

  let execution;
  try {
    execution = await runner();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    execution = {
      exitStatus: 1,
      signal: null,
      stdout: "",
      stderr: errorMessage,
      errorMessage
    };
  }

  writePrivateText(current.stdoutFile, execution.stdout ?? "");
  writePrivateText(current.stderrFile, execution.stderr ?? execution.errorMessage ?? "");

  const completed = execution.exitStatus === 0 && !execution.errorMessage;
  current = writeJob(job.workspaceRoot, {
    ...current,
    status: completed ? "completed" : "failed",
    phase: completed ? "done" : "failed",
    pid: null,
    completedAt: nowIso(),
    exitStatus: execution.exitStatus,
    signal: execution.signal ?? null,
    errorMessage: execution.errorMessage ?? null
  });
  appendLog(
    job.workspaceRoot,
    job.id,
    completed ? "Completed successfully." : `Failed with exit ${execution.exitStatus}${execution.signal ? ` (${execution.signal})` : ""}.`
  );
  pruneFinishedJobs(job.workspaceRoot);
  return { job: current, execution };
}
