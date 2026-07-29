#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import process from "node:process";

import { captureRepositorySnapshot } from "./lib/git-review.mjs";
import {
  readConfig,
  removeTurnArtifactsForSession,
  writeTurnSnapshot
} from "./lib/state.mjs";
import { resolveDirectory, resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function main() {
  const input = readInput();
  if (!input.session_id) {
    return;
  }
  removeTurnArtifactsForSession(input.session_id);
  const cwd = resolveDirectory(input.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!readConfig(workspaceRoot).stopReviewGate) {
    return;
  }
  writeTurnSnapshot(
    workspaceRoot,
    input.session_id,
    captureRepositorySnapshot(cwd, { includeDirtyContent: true })
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Antigravity could not capture the turn review baseline: ${error instanceof Error ? error.message : String(error)}\n`
  );
}
