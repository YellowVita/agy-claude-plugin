#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { executeAgyTask, parseDurationMs, probeAgy } from "./lib/agy.mjs";
import { parseCommandArgs } from "./lib/args.mjs";
import {
  assertConversationClaim,
  claimConversation,
  releaseConversation
} from "./lib/conversation-claims.mjs";
import {
  assertRepositorySnapshot,
  buildReviewPrompt,
  resolveReviewTarget,
  resolveTurnReviewTarget
} from "./lib/git-review.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readCurrentJob,
  resolveLatestConversationJob,
  resolveCancelableJob,
  resolveResultJob,
  waitForJob
} from "./lib/job-control.mjs";
import { terminateProcessTree, waitForProcessTreeExit } from "./lib/process.mjs";
import {
  renderCancel,
  renderExecution,
  renderFailure,
  renderQueued,
  renderSetup,
  renderSingleStatus,
  renderStatus,
  renderStoredResult
} from "./lib/render.mjs";
import {
  appendLog,
  ensureStateDir,
  pruneFinishedJobs,
  probeStateWrite,
  readConfig,
  readJob,
  readPrivateText,
  readRequest,
  readTurnSnapshot,
  removeRequest,
  replacePrivateNdjsonTerminal,
  setConfigValue,
  writeJob,
  writePrivateText,
  writeRequest,
  writeTurnEvidence
} from "./lib/state.mjs";
import { createStructuredFailureOutput } from "./lib/structured-output.mjs";
import { createTaskJob, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { resolveDirectory, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
const CONVERSATION_CLAIM_GRACE_MS = 60_000;

function printUsage() {
  process.stdout.write(`agy-companion

Usage:
  agy-companion setup
  agy-companion task [--output-format text|json|stream-json] [--json-schema <schema>] [options] [--] <prompt>
  agy-companion review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
  agy-companion adversarial-review [review options] [focus text]
  agy-companion status [job-id] [--wait] [--all]
  agy-companion result [job-id]
  agy-companion cancel [job-id]
`);
}

function output(value) {
  process.stdout.write(String(value ?? ""));
}

function outputJson(value) {
  output(`${JSON.stringify(value, null, 2)}\n`);
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
    valueOptions: [
      "cwd",
      "model",
      "agent",
      "effort",
      "print-timeout",
      "output-format",
      "json-schema",
      "add-dir",
      "project",
      "conversation",
      "job"
    ],
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
  if (options.job && (options.continue || options.conversation)) {
    throw new Error("Choose exactly one of --job, --continue, or --conversation.");
  }
  if (options.job && !options["continue-command"]) {
    throw new Error("--job is available only through /agy:continue.");
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
  const outputFormat = options["output-format"] ?? "json";
  let conversation = options.conversation ?? null;
  if (options.job) {
    const sourceJob = buildSingleJobSnapshot(cwd, options.job).job;
    if (["queued", "running"].includes(sourceJob.status)) {
      throw new Error(
        `Job ${sourceJob.id} is still ${sourceJob.status}; wait for it to finish before continuing its conversation.`
      );
    }
    if (!sourceJob.conversationId) {
      throw new Error(`Job ${sourceJob.id} does not contain an Antigravity conversation ID.`);
    }
    conversation = sourceJob.conversationId;
  }
  const wantsContinuation = Boolean(options.continue || options["continue-command"]);
  if (wantsContinuation && !conversation) {
    const latest = resolveLatestConversationJob(cwd);
    if (!latest) {
      throw new Error(
        "No resumable non-gate Antigravity conversation is recorded for this workspace. Pass --conversation <id>."
      );
    }
    conversation = latest.job.conversationId;
  }
  return {
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    prompt: pipedPrompt,
    mode,
    fullAccessConfirmed: Boolean(options["confirm-full-access"]),
    background: Boolean(options.background),
    continueLatest: false,
    conversation,
    model: options.model ?? null,
    agent: options.agent ?? null,
    effort: options.effort ?? null,
    printTimeout: options["print-timeout"] ?? "5m0s",
    outputFormat,
    outputFormatExplicit: options["output-format"] !== undefined,
    jsonSchema: options["json-schema"] ?? null,
    addDirs: options["add-dir"] ?? [],
    project: options.project ?? null,
    newProject: Boolean(options["new-project"])
  };
}

function parseReviewRequest(argv, kind) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd", "base", "scope", "model", "agent", "effort", "print-timeout"],
    booleanOptions: ["background", "wait", "stop-gate", "review-json"],
    allowInterspersedOptions: true,
    splitSingleRawArgument: true
  });
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait, not both.");
  }
  if (kind === "review" && positionals.length) {
    throw new Error("Use /agy:adversarial-review when custom review focus text is required.");
  }
  const stopGate = Boolean(options["stop-gate"]);
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let target;
  if (stopGate) {
    const sessionId = process.env.AGY_STOP_GATE_SESSION_ID;
    const baseline = readTurnSnapshot(workspaceRoot, sessionId);
    if (!baseline) {
      throw new Error("The stop review gate is missing a valid turn baseline.");
    }
    target = resolveTurnReviewTarget(cwd, baseline);
    if (target.syntheticPatch) {
      target.evidenceFile = writeTurnEvidence(workspaceRoot, sessionId, target.syntheticPatch);
    }
  } else {
    target = resolveReviewTarget(cwd, {
      base: options.base,
      scope: options.scope
    });
  }
  return {
    cwd,
    workspaceRoot,
    prompt: buildReviewPrompt(target, {
      kind,
      focus: stopGate ? "" : positionals.join(" "),
      stopGate
    }),
    mode: "safe",
    fullAccessConfirmed: false,
    background: Boolean(options.background),
    continueLatest: false,
    conversation: null,
    model: options.model ?? null,
    agent: options.agent ?? null,
    effort: options.effort ?? null,
    printTimeout: options["print-timeout"] ?? "5m0s",
    outputFormat: "json",
    outputFormatExplicit: false,
    jsonSchema: REVIEW_SCHEMA,
    addDirs: target.evidenceFile ? [path.dirname(target.evidenceFile)] : [],
    project: null,
    newProject: false,
    kind: "review",
    reviewKind: kind,
    reviewTarget: target.label,
    reviewSnapshot: target.snapshot,
    stopGate,
    reviewJson: Boolean(options["review-json"])
  };
}

async function executeRequest(request, options = {}) {
  if (request.kind === "review") {
    assertRepositorySnapshot(request.cwd, request.reviewSnapshot);
  }
  const execution = await executeAgyTask(request, options);
  if (request.kind !== "review") {
    return execution;
  }
  try {
    assertRepositorySnapshot(request.cwd, request.reviewSnapshot);
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...execution,
      exitStatus: 1,
      stdout: "",
      stderr: `${execution.stderr ?? ""}${execution.stderr ? "\n" : ""}${message}\n`,
      errorMessage: message,
      structured: null,
      stdoutPersisted: false,
      stderrPersisted: false
    };
  }
}

function continuationLabel(request) {
  if (request.conversation) {
    return `conversation:${request.conversation}`;
  }
  return request.continueLatest ? "latest" : "new";
}

function usesRawStructuredOutput(job) {
  return Boolean(job.outputFormatExplicit && ["json", "stream-json"].includes(job.outputFormat));
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
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  if (positionals.length) {
    throw new Error("setup does not accept positional arguments.");
  }
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actions = [];
  let stateDirectory = null;
  let stateWritable = false;
  let stateDetail = null;
  let reviewGateEnabled = false;
  try {
    stateDirectory = path.dirname(ensureStateDir(workspaceRoot));
    probeStateWrite(workspaceRoot);
    if (options["enable-review-gate"]) {
      setConfigValue(workspaceRoot, "stopReviewGate", true);
      actions.push("Enabled the experimental stop-time review gate.");
    } else if (options["disable-review-gate"]) {
      setConfigValue(workspaceRoot, "stopReviewGate", false);
      actions.push("Disabled the experimental stop-time review gate.");
    }
    reviewGateEnabled = Boolean(readConfig(workspaceRoot).stopReviewGate);
    stateWritable = true;
  } catch (error) {
    stateDetail = error instanceof Error ? error.message : String(error);
  }
  const result = {
    ...probeAgy(),
    workspaceRoot,
    stateDirectory,
    stateWritable,
    stateDetail,
    reviewGateEnabled,
    actions
  };
  if (options.json) {
    outputJson(result);
  } else {
    output(renderSetup(result));
  }
  if (!result.available || !result.ready || !result.stateWritable) {
    process.exitCode = 1;
  }
}

async function executeTrackedRequest(request) {
  let job;
  let conversationClaim;
  try {
    ensureStateDir(request.workspaceRoot);
    probeStateWrite(request.workspaceRoot);
    job = createTaskJob({
      cwd: request.cwd,
      workspaceRoot: request.workspaceRoot,
      mode: request.mode,
      background: request.background,
      continuation: continuationLabel(request),
      resumeConversationId: request.conversation,
      outputFormat: request.outputFormat,
      outputFormatExplicit: request.outputFormatExplicit,
      jsonSchemaRequested: Boolean(request.jsonSchema),
      kind: request.kind ?? "task",
      reviewKind: request.reviewKind ?? null,
      reviewTarget: request.reviewTarget ?? null,
      reviewSnapshotFingerprint: request.reviewSnapshot?.fingerprint ?? null,
      stopGate: Boolean(request.stopGate)
    });
    const conversationClaimExpiresAt = request.conversation
      ? new Date(Date.now() + parseDurationMs(request.printTimeout) + CONVERSATION_CLAIM_GRACE_MS).toISOString()
      : null;
    request.conversationClaimExpiresAt = conversationClaimExpiresAt;
    job.conversationClaimExpiresAt = conversationClaimExpiresAt;
    conversationClaim = claimConversation(request.workspaceRoot, request.conversation, job.id, {
      expiresAt: conversationClaimExpiresAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.outputFormatExplicit && ["json", "stream-json"].includes(request.outputFormat)) {
      output(createStructuredFailureOutput(request.outputFormat, { message }));
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (request.background) {
    let handedOff = false;
    try {
      writeJob(request.workspaceRoot, job);
      writeRequest(request.workspaceRoot, job.id, request);
      appendLog(request.workspaceRoot, job.id, "Queued for background execution.");

      let child;
      try {
        child = spawnDetachedWorker(request.cwd, job.id);
        handedOff = true;
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
    } finally {
      if (conversationClaim && !handedOff) {
        releaseConversation(request.workspaceRoot, request.conversation, job.id);
      }
    }
  }

  const streamToConsole = request.outputFormat === "stream-json";
  let outcome;
  try {
    outcome = await runTrackedJob(job, async (io) => {
      let stderrForwarded = false;
      const execution = await executeRequest(request, {
        onStdout: streamToConsole
          ? (chunk) => {
              io.onStdout(chunk);
              output(chunk);
            }
          : undefined,
        onStderr: (chunk) => {
          stderrForwarded = true;
          io.onStderr(chunk);
          process.stderr.write(chunk);
        },
        onProgress: io.onProgress
      });
      return {
        ...execution,
        stdoutStreamed: streamToConsole,
        stderrForwarded
      };
    });
  } finally {
    if (conversationClaim) {
      releaseConversation(request.workspaceRoot, request.conversation, job.id);
    }
  }
  if (outcome.job.status !== "completed" && usesRawStructuredOutput(outcome.job)) {
    if (!outcome.execution.stdoutStreamed) {
      output(outcome.execution.stdout);
    }
    process.stderr.write(
      renderFailure(outcome.job, "", outcome.execution.stderrForwarded ? "" : outcome.execution.stderr)
    );
  } else if (request.reviewJson && outcome.job.status === "completed") {
    outputJson({
      jobId: outcome.job.id,
      conversationId: outcome.job.conversationId ?? null,
      review: outcome.execution.structured?.structuredOutput ?? null
    });
  } else {
    output(
      renderExecution(outcome.job, {
        ...outcome.execution,
        stderr: outcome.execution.stderrForwarded ? "" : outcome.execution.stderr
      })
    );
  }
  if (outcome.job.status !== "completed") {
    process.exitCode = outcome.execution.exitStatus || 1;
  }
}

async function handleTask(argv) {
  await executeTrackedRequest(parseTaskRequest(argv));
}

async function handleReview(argv, kind) {
  await executeTrackedRequest(parseReviewRequest(argv, kind));
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
  try {
    const request = readRequest(workspaceRoot, job.id);
    removeRequest(workspaceRoot, job.id);
    if (job.status === "cancelled") {
      return;
    }
    if (!request) {
      throw new Error(`Background job ${job.id} is missing its request payload.`);
    }
    await runTrackedJob({ ...job, cwd, workspaceRoot, background: true }, (io) => {
      assertConversationClaim(workspaceRoot, job.resumeConversationId, job.id, {
        expiresAt: request.conversationClaimExpiresAt
      });
      return executeRequest(request, {
        onStdout: request.outputFormat === "stream-json" ? io.onStdout : undefined,
        onStderr: request.outputFormat === "stream-json" ? io.onStderr : undefined,
        onProgress: io.onProgress
      });
    });
  } finally {
    releaseConversation(workspaceRoot, job.resumeConversationId, job.id);
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["wait", "all", "json"],
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
    if (options.json) {
      outputJson(snapshot);
    } else {
      output(renderSingleStatus(snapshot));
    }
    return;
  }
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    if (options.json) {
      outputJson(snapshot);
    } else {
      output(renderSingleStatus(snapshot));
    }
    return;
  }
  const snapshot = buildStatusSnapshot(cwd, { all: Boolean(options.all) });
  if (options.json) {
    outputJson(snapshot);
  } else {
    output(renderStatus(snapshot));
  }
}

function handleResult(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd"]
  });
  const reference = requireSinglePositional(positionals, "job reference");
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const { job } = resolveResultJob(cwd, reference);
  const stdout = readPrivateText(job.stdoutFile);
  const stderr = readPrivateText(job.stderrFile);
  if (job.status !== "completed" && usesRawStructuredOutput(job)) {
    output(stdout);
    process.stderr.write(renderFailure(job, "", stderr));
    return;
  }
  if (job.status === "completed" && stderr) {
    process.stderr.write(stderr);
  }
  output(renderStoredResult(job, stdout, stderr));
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandArgs(argv, {
    valueOptions: ["cwd"]
  });
  const reference = requireSinglePositional(positionals, "job reference");
  const cwd = resolveDirectory(options.cwd ?? process.cwd());
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const terminatingPid = job.pid;
  const outcome = terminateProcessTree(terminatingPid);

  const stopped = await waitForProcessTreeExit(terminatingPid, { timeoutMs: 2_000 });
  if (!stopped) {
    appendLog(
      workspaceRoot,
      job.id,
      "Cancellation failed because the process tree did not stop; the job and conversation claim remain active."
    );
    throw new Error(
      `Could not stop process tree ${terminatingPid} for job ${job.id}. The job and conversation claim remain active.`
    );
  }

  removeRequest(workspaceRoot, job.id);

  const stderr = readPrivateText(job.stderrFile);
  if (usesRawStructuredOutput(job)) {
    const failureOutput = createStructuredFailureOutput(job.outputFormat, {
      message: "Cancelled by user."
    });
    if (job.outputFormat === "stream-json") {
      replacePrivateNdjsonTerminal(job.stdoutFile, failureOutput);
    } else {
      writePrivateText(job.stdoutFile, failureOutput);
    }
  }
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
  releaseConversation(workspaceRoot, job.resumeConversationId, job.id);
  appendLog(workspaceRoot, job.id, "Cancelled by user; process tree stopped.");
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
    case "review":
      await handleReview(argv, "review");
      break;
    case "adversarial-review":
      await handleReview(argv, "adversarial");
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
      await handleCancel(argv);
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
