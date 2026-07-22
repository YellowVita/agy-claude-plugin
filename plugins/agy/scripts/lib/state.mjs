import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "agy-companion");
const MAX_FINISHED_JOBS = 50;

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

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const root = pluginData ? path.join(pluginData, "state") : FALLBACK_STATE_ROOT;
  return path.join(root, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = resolveJobsDir(cwd);
  privateMkdir(stateDir);
  privateMkdir(jobsDir);
  return jobsDir;
}

function jobPath(cwd, jobId, suffix) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}${suffix}`);
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

function atomicWrite(filePath, data) {
  privateMkdir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
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

export function writePrivateText(filePath, value) {
  atomicWrite(filePath, String(value ?? ""));
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
  const finished = jobs
    .filter((job) => !["queued", "running"].includes(job.status))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  for (const job of finished.slice(maxFinished)) {
    removeJobArtifacts(cwd, job.id);
  }
}
