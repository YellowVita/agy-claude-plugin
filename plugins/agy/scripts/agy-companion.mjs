#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { executeAgyTask, probeAgy, resolveAgyBinary } from "./lib/agy.mjs";
import { parseCommandArgs } from "./lib/args.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readCurrentJob,
  resolveCancelableJob,
  resolveResultJob,
  waitForJob
} from "./lib/job-control.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  renderCancel,
  renderExecution,
  renderQueued,
  renderSetup,
  renderSingleStatus,
  renderStatus,
  renderStoredResult
} from "./lib/render.mjs";
import {
  appendLog,
  pruneFinishedJobs,
  readJob,
  readPrivateText,
  readRequest,
  removeRequest,
  writeJob,
  writePrivateText,
  writeRequest
} from "./lib/state.mjs";
import { createTaskJob, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { resolveDirectory, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function printUsage() {
  process.stdout.write(`agy-companion

Usage:
  agy-companion setup
  agy-companion task [options] [--] <prompt>
  agy-companion status [job-id] [--wait] [--all]
  agy-companion result [job-id]
  agy-companion cancel [job-id]
`);
}

function output(value) {
  process.stdout.write(String(value ?? ""));
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}

function requireSinglePositional(positionals, label) {
  if (positionals.length > 1) {
    throw new Error(`Too many ${label} arguments.`);
  }
  return positionals[0] ?? "";
}

function parseTaskRequest(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd", "model", "agent", "effort", "print-timeout", "add-dir", "project", "conversation"],
    booleanOptions: [
      "background",
      "wait",
      "write",
      "full-access",
      "confirm-full-access",
      "continue",
      "continue-command",
      "new-project"
    ],
    repeatableOptions: ["add-dir"]
  });

  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait, not both.");
  }
  if (options.write && options["full-access"]) {
    throw new Error("Choose either --write or --full-access, not both.");
  }
  if (options["full-access"] && !options["confirm-full-access"]) {
    throw new Error("Full access requires direct user confirmation before --confirm-full-access may be supplied.");
  }
  if (options["confirm-full-access"] && !options["full-access"]) {
    throw new Error("--confirm-full-access is valid only together with --full-access.");
  }
  if (options["full-access"] && options.background) {
    throw new Error("Full-access Antigravity tasks must run in the foreground.");
  }
  if (options.continue && options.conversation) {
    throw new Error("Choose either --continue or --conversation, not both.");
  }
  if (options.project && options["new-project"]) {
    throw new Error("Choose either --project or --new-project, not both.");
  }

  const prompt = positionals.length === 1 ? positionals[0] : positionals.join(" ");
  const pipedPrompt = prompt || readStdinIfPiped();
  if (!pipedPrompt.trim()) {
    throw new Error("Provide an Antigravity task prompt. Use -- before prompt text that begins with a dash.");
  }

  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const mode = options["full-access"] ? "full-access" : options.write ? "write" : "safe";
  return {
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    prompt: pipedPrompt,
    mode,
    fullAccessConfirmed: Boolean(options["confirm-full-access"]),
    background: Boolean(options.background),
    continueLatest: Boolean(options.continue || (options["continue-command"] && !options.conversation)),
    conversation: options.conversation ?? null,
    model: options.model ?? null,
    agent: options.agent ?? null,
    effort: options.effort ?? null,
    printTimeout: options["print-timeout"] ?? "5m0s",
    addDirs: options["add-dir"] ?? [],
    project: options.project ?? null,
    newProject: Boolean(options["new-project"])
  };
}

function continuationLabel(request) {
  if (request.conversation) {
    return `conversation:${request.conversation}`;
  }
  return request.continueLatest ? "latest" : "new";
}

function spawnDetachedWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function handleSetup(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd"]
  });
  if (positionals.length) {
    throw new Error("setup does not accept positional arguments.");
  }
  if (options.cwd) {
    resolveDirectory(options.cwd);
  }
  const result = probeAgy();
  output(renderSetup(result));
  if (!result.available) {
    process.exitCode = 1;
  }
}

async function handleTask(argv) {
  const request = parseTaskRequest(argv);
  const job = createTaskJob({
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    mode: request.mode,
    background: request.background,
    continuation: continuationLabel(request)
  });

  if (request.background) {
    resolveAgyBinary();
    writeJob(request.workspaceRoot, job);
    writeRequest(request.workspaceRoot, job.id, request);
    appendLog(request.workspaceRoot, job.id, "Queued for background execution.");

    let child;
    try {
      child = spawnDetachedWorker(request.cwd, job.id);
    } catch (error) {
      removeRequest(request.workspaceRoot, job.id);
      writeJob(request.workspaceRoot, {
        ...job,
        status: "failed",
        phase: "failed",
        completedAt: nowIso(),
        exitStatus: 1,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    const current = readJob(request.workspaceRoot, job.id);
    if (current && ["queued", "running"].includes(current.status)) {
      writeJob(request.workspaceRoot, { ...current, pid: child.pid ?? current.pid });
    }
    pruneFinishedJobs(request.workspaceRoot);
    output(renderQueued({ ...job, pid: child.pid ?? null }));
    return;
  }

  const outcome = await runTrackedJob(job, () => executeAgyTask(request));
  output(renderExecution(outcome.job, outcome.execution));
  if (outcome.job.status !== "completed") {
    process.exitCode = outcome.execution.exitStatus || 1;
  }
}

async function handleTaskWorker(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (positionals.length) {
    throw new Error("task-worker does not accept positional arguments.");
  }
  if (!options["job-id"]) {
    throw new Error("task-worker requires --job-id.");
  }

  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readCurrentJob(workspaceRoot, options["job-id"]);
  if (!job) {
    throw new Error(`No stored Antigravity job found for ${options["job-id"]}.`);
  }
  const request = readRequest(workspaceRoot, job.id);
  removeRequest(workspaceRoot, job.id);
  if (job.status === "cancelled") {
    return;
  }
  if (!request) {
    throw new Error(`Background job ${job.id} is missing its request payload.`);
  }

  await runTrackedJob({ ...job, cwd, workspaceRoot, background: true }, () => executeAgyTask(request));
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["wait", "all"],
    allowInterspersedOptions: true,
    splitSingleRawArgument: true
  });
  const reference = requireSinglePositional(positionals, "job reference");
  const cwd = resolveDirectory(options.cwd ?? process.cwd());

  if (options.wait) {
    if (!reference) {
      throw new Error("status --wait requires a job ID.");
    }
    const snapshot = await waitForJob(cwd, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    });
    output(renderSingleStatus(snapshot));
    return;
  }
  if (reference) {
    output(renderSingleStatus(buildSingleJobSnapshot(cwd, reference)));
    return;
  }
  output(renderStatus(buildStatusSnapshot(cwd, { all: Boolean(options.all) })));
}

function handleResult(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd"]
  });
  const reference = requireSinglePositional(positionals, "job reference");
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const { job } = resolveResultJob(cwd, reference);
  output(renderStoredResult(job, readPrivateText(job.stdoutFile), readPrivateText(job.stderrFile)));
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd"]
  });
  const reference = requireSinglePositional(positionals, "job reference");
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const outcome = terminateProcessTree(job.pid);
  removeRequest(workspaceRoot, job.id);

  const stderr = readPrivateText(job.stderrFile);
  writePrivateText(job.stderrFile, `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}Cancelled by user.\n`);
  const cancelled = writeJob(workspaceRoot, {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: nowIso(),
    exitStatus: null,
    errorMessage: "Cancelled by user."
  });
  appendLog(workspaceRoot, job.id, "Cancelled by user.");
  output(renderCancel(cancelled, outcome));
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
