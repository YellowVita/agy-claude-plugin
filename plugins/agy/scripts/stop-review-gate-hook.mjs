#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readConfig,
  readTurnSnapshot,
  removeTurnArtifactsForSession
} from "./lib/state.mjs";
import { resolveDirectory, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(SCRIPT_DIR, "agy-companion.mjs");
const TIMEOUT_MS = 15 * 60 * 1000;

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function note(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function cleanupTurnArtifacts(sessionId) {
  try {
    removeTurnArtifactsForSession(sessionId);
  } catch (error) {
    note(
      `Antigravity review gate could not remove private turn artifacts: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function runGate(cwd, sessionId) {
  return spawnSync(
    process.execPath,
    [
      COMPANION,
      "adversarial-review",
      "--cwd",
      cwd,
      "--wait",
      "--stop-gate",
      "--review-json"
    ],
    {
      cwd,
      env: {
        ...process.env,
        AGY_STOP_GATE_SESSION_ID: sessionId
      },
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }
  );
}

function main() {
  const input = readInput();
  try {
    if (input.stop_hook_active) {
      return;
    }
    const cwd = resolveDirectory(input.cwd ?? process.cwd());
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    if (!readConfig(workspaceRoot).stopReviewGate) {
      return;
    }
    const baseline = readTurnSnapshot(workspaceRoot, input.session_id);
    if (!baseline) {
      note("Antigravity review gate has no baseline for this turn; allowing stop.");
      return;
    }

    const result = runGate(cwd, input.session_id);
    if (result.error || result.status !== 0) {
      note("Antigravity review gate could not run; allowing stop. Run /agy:setup for diagnostics.");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      note("Antigravity review gate returned unreadable output; allowing stop.");
      return;
    }
    const findings = Array.isArray(payload.review?.findings) ? payload.review.findings : [];
    const blocking = findings.filter(
      (finding) =>
        ["critical", "high"].includes(finding?.severity) &&
        Number(finding?.confidence ?? 0) >= 0.7
    );
    if (!blocking.length) {
      return;
    }
    const jobId = /^agy-[a-z0-9-]+$/i.test(payload.jobId ?? "") ? payload.jobId : null;
    const resultHint = jobId ? ` Review job ${jobId} with /agy:result ${jobId}.` : "";
    block(`Antigravity found ${blocking.length} high-confidence blocking issue(s).${resultHint}`);
  } finally {
    cleanupTurnArtifacts(input.session_id);
  }
}

try {
  main();
} catch (error) {
  note(`Antigravity review gate failed open: ${error instanceof Error ? error.message : String(error)}`);
}
