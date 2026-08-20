// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "agy-companion");
const MAX_FINISHED_JOBS = 50;
const MAX_TURN_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function privateMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
}

export function resolveStateStorageRoot() {
  const pluginData = process.env[PLUGIN_DATA_ENV];
  return pluginData ? path.join(pluginData, "state") : FALLBACK_STATE_ROOT;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateStorageRoot(), `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), "config.json");
}

function turnSessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId ?? "")).digest("hex").slice(0, 24);
}

export function resolveTurnSnapshotFile(cwd, sessionId) {
  return path.join(resolveStateDir(cwd), `turn-${turnSessionKey(sessionId)}.json`);
}

function resolveTurnEvidenceDir(cwd, sessionId) {
  return path.join(resolveStateDir(cwd), "evidence", turnSessionKey(sessionId));
}

function removeTurnArtifactsAtStateDir(stateDir, sessionKey) {
  for (const target of [
    { path: path.join(stateDir, `turn-${sessionKey}.json`), directory: false },
    { path: path.join(stateDir, "evidence", sessionKey), directory: true }
  ]) {
    try {
      if (target.directory) {
        fs.rmSync(target.path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target.path);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function writeTurnEvidence(cwd, sessionId, contents) {
  if (!sessionId) {
    throw new Error("A Claude session ID is required to store turn evidence.");
  }
  const directory = resolveTurnEvidenceDir(cwd, sessionId);
  privateMkdir(directory);
  const filePath = path.join(directory, "turn.patch");
  atomicWrite(filePath, String(contents ?? ""));
  return filePath;
}

export function removeTurnArtifacts(cwd, sessionId) {
  if (!sessionId) {
    return;
  }
  removeTurnArtifactsAtStateDir(resolveStateDir(cwd), turnSessionKey(sessionId));
}

export function removeTurnArtifactsForSession(sessionId) {
  if (!sessionId) {
    return;
  }
  const storageRoot = resolveStateStorageRoot();
  let entries;
  try {
    entries = fs.readdirSync(storageRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const sessionKey = turnSessionKey(sessionId);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeTurnArtifactsAtStateDir(path.join(storageRoot, entry.name), sessionKey);
    }
  }
}

function pruneTurnArtifactsAtStateDir(stateDir, options = {}) {
  const evidenceRoot = path.join(stateDir, "evidence");
  const sessions = new Map();
  const record = (key, target, mtimeMs) => {
    const entry = sessions.get(key) ?? { key, targets: [], mtimeMs: 0 };
    entry.targets.push(target);
    entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs);
    sessions.set(key, entry);
  };

  try {
    for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
      const match = entry.isFile() ? /^turn-([0-9a-f]{24})\.json$/.exec(entry.name) : null;
      if (!match) {
        continue;
      }
      const target = path.join(stateDir, entry.name);
      try {
        record(match[1], target, fs.statSync(target).mtimeMs);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{24}$/.test(entry.name)) {
        continue;
      }
      const target = path.join(evidenceRoot, entry.name);
      try {
        record(entry.name, target, fs.statSync(target).mtimeMs);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const maxAgeMs = options.maxAgeMs ?? MAX_TURN_ARTIFACT_AGE_MS;
  const cutoff = Date.now() - maxAgeMs;
  for (const session of sessions.values()) {
    if (session.mtimeMs >= cutoff) {
      continue;
    }
    for (const target of session.targets) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

export function pruneTurnArtifacts(cwd, options = {}) {
  pruneTurnArtifactsAtStateDir(resolveStateDir(cwd), options);
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = path.join(stateDir, "jobs");
  privateMkdir(stateDir);
  privateMkdir(jobsDir);
  pruneTurnArtifactsAtStateDir(stateDir);
  return jobsDir;
}

export function probeStateWrite(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = path.join(stateDir, "jobs");
  privateMkdir(stateDir);
  privateMkdir(jobsDir);
  for (const directory of [stateDir, jobsDir]) {
    probeDirectoryWrite(directory);
  }
  return stateDir;
}

function probeDirectoryWrite(directory) {
  const probeFile = path.join(directory, `.write-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(probeFile, "wx", 0o600);
    fs.writeFileSync(descriptor, "ok\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probeFile);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original readiness error.
      }
    }
    try {
      fs.unlinkSync(probeFile);
    } catch {
      // Preserve the original readiness error.
    }
    throw new Error(`Plugin state is not writable: ${error.message}`);
  }
}

function jobPath(cwd, jobId, suffix) {
  return path.join(ensureStateDir(cwd), `${jobId}${suffix}`);
}

export function resolveJobFile(cwd, jobId) {
  return jobPath(cwd, jobId, ".json");
}

export function resolveRequestFile(cwd, jobId) {
  return jobPath(cwd, jobId, ".request.json");
}

export function resolveStdoutFile(cwd, jobId) {
  return jobPath(cwd, jobId, ".stdout");
}

export function resolveStderrFile(cwd, jobId) {
  return jobPath(cwd, jobId, ".stderr");
}

export function resolveLogFile(cwd, jobId) {
  return jobPath(cwd, jobId, ".log");
}

function replaceWithTemp(filePath, tempPath) {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Preserve the original rename error.
      }
      throw error;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") {
        throw unlinkError;
      }
    }
    fs.renameSync(tempPath, filePath);
  }
}

function atomicWrite(filePath, data) {
  privateMkdir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
  replaceWithTemp(filePath, tempPath);
}

export function writePrivateText(filePath, value) {
  atomicWrite(filePath, String(value ?? ""));
  return filePath;
}

export function appendPrivateText(filePath, value) {
  privateMkdir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 });
  }
  fs.appendFileSync(filePath, String(value ?? ""), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export function replacePrivateNdjsonTerminal(filePath, terminalLine, options = {}) {
  privateMkdir(path.dirname(filePath));
  const maxLineBytes = options.maxLineBytes ?? 32 * 1024 * 1024;
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const outputFd = fs.openSync(tempPath, "w", 0o600);
  let inputFd = null;
  let buffer = "";
  const decoder = new StringDecoder("utf8");

  const writeNonTerminal = (line) => {
    if (!line.trim()) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      throw new Error(`Stored stream-json event exceeded ${maxLineBytes} bytes.`);
    }
    try {
      const event = JSON.parse(line);
      if (event?.event !== "result") {
        fs.writeSync(outputFd, `${line}\n`, null, "utf8");
      }
    } catch {
      // Drop malformed stored lines so the rewritten file remains valid NDJSON.
    }
  };

  try {
    try {
      inputFd = fs.openSync(filePath, "r");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (inputFd !== null) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const bytesRead = fs.readSync(inputFd, chunk, 0, chunk.length, null);
        if (!bytesRead) {
          break;
        }
        buffer += decoder.write(chunk.subarray(0, bytesRead));
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) {
            break;
          }
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          writeNonTerminal(line);
        }
        if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
          throw new Error(`Stored stream-json event exceeded ${maxLineBytes} bytes.`);
        }
      }
      buffer += decoder.end();
      if (buffer) {
        writeNonTerminal(buffer.replace(/\r$/, ""));
      }
    }
    const normalizedTerminal = String(terminalLine ?? "").trim();
    JSON.parse(normalizedTerminal);
    fs.writeSync(outputFd, `${normalizedTerminal}\n`, null, "utf8");
    fs.closeSync(outputFd);
    if (inputFd !== null) {
      fs.closeSync(inputFd);
      inputFd = null;
    }
    replaceWithTemp(filePath, tempPath);
  } catch (error) {
    try {
      fs.closeSync(outputFd);
    } catch {
      // Already closed.
    }
    if (inputFd !== null) {
      try {
        fs.closeSync(inputFd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
  return filePath;
}

export function readPrivateText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function readConfig(cwd) {
  const stateDir = resolveStateDir(cwd);
  pruneTurnArtifactsAtStateDir(stateDir);
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Could not read plugin config: ${error.message}`);
  }
}

export function writeConfig(cwd, value) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  atomicWrite(resolveConfigFile(cwd), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function setConfigValue(cwd, key, value) {
  return writeConfig(cwd, { ...readConfig(cwd), [key]: value });
}

export function writeTurnSnapshot(cwd, sessionId, snapshot) {
  if (!sessionId) {
    throw new Error("A Claude session ID is required to store a turn snapshot.");
  }
  const stateDir = resolveStateDir(cwd);
  const filePath = path.join(stateDir, `turn-${turnSessionKey(sessionId)}.json`);
  atomicWrite(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  pruneTurnArtifactsAtStateDir(stateDir);
  return filePath;
}

export function readTurnSnapshot(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolveTurnSnapshotFile(cwd, sessionId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read the stored turn snapshot: ${error.message}`);
  }
}

export function appendLog(cwd, jobId, message) {
  const normalized = String(message ?? "").trim();
  if (!normalized) {
    return;
  }
  const filePath = resolveLogFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", { encoding: "utf8", mode: 0o600 });
  }
  fs.appendFileSync(filePath, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function generateJobId() {
  return `agy-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function writeJob(cwd, job) {
  const existing = readJob(cwd, job.id);
  const timestamp = nowIso();
  const next = {
    version: 1,
    createdAt: existing?.createdAt ?? job.createdAt ?? timestamp,
    ...existing,
    ...job,
    updatedAt: timestamp
  };
  atomicWrite(resolveJobFile(cwd, job.id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function updateJob(cwd, jobId, patch) {
  const existing = readJob(cwd, jobId);
  if (!existing) {
    throw new Error(`No stored Antigravity job found for ${jobId}.`);
  }
  return writeJob(cwd, { ...existing, ...patch, id: jobId });
}

export function readJob(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read job ${jobId}: ${error.message}`);
  }
}

export function listJobs(cwd) {
  const jobsDir = ensureStateDir(cwd);
  const jobs = [];
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json") || name.endsWith(".request.json")) {
      continue;
    }
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")));
    } catch {
      // Ignore incomplete or unrelated files; atomic writes prevent normal partial records.
    }
  }
  return jobs;
}

export function writeRequest(cwd, jobId, request) {
  const filePath = resolveRequestFile(cwd, jobId);
  atomicWrite(filePath, `${JSON.stringify(request, null, 2)}\n`);
  return filePath;
}

export function readRequest(cwd, jobId) {
  const filePath = resolveRequestFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function removeRequest(cwd, jobId) {
  removeFile(resolveRequestFile(cwd, jobId));
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export function removeJobArtifacts(cwd, jobId) {
  for (const filePath of [
    resolveJobFile(cwd, jobId),
    resolveRequestFile(cwd, jobId),
    resolveStdoutFile(cwd, jobId),
    resolveStderrFile(cwd, jobId),
    resolveLogFile(cwd, jobId)
  ]) {
    removeFile(filePath);
  }
}

export function pruneFinishedJobs(cwd, maxFinished = MAX_FINISHED_JOBS) {
  const jobs = listJobs(cwd);
  const finished = jobs.filter((job) => !["queued", "running"].includes(job.status));
  const userJobs = finished
    .filter((job) => !job.stopGate)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const internalJobs = finished
    .filter((job) => job.stopGate)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  for (const job of [...userJobs.slice(maxFinished), ...internalJobs.slice(20)]) {
    removeJobArtifacts(cwd, job.id);
  }
}
