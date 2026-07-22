import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { formatCommandFailure, runCommand } from "./process.mjs";
import { resolveDirectory } from "./workspace.mjs";

const DEFAULT_PRINT_TIMEOUT = "5m0s";
const OUTER_TIMEOUT_GRACE_MS = 30_000;
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function executableNames(platform) {
  return platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"];
}

function resolveExecutableCandidate(candidate, platform) {
  const absolute = path.resolve(candidate);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      return null;
    }
    fs.accessSync(absolute, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    try {
      return fs.realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  } catch {
    return null;
  }
}

export function resolveAgyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.AGY_PATH) {
    if (!path.isAbsolute(env.AGY_PATH)) {
      throw new Error("AGY_PATH must be an absolute executable path.");
    }
    const resolved = resolveExecutableCandidate(env.AGY_PATH, platform);
    if (!resolved) {
      throw new Error(`AGY_PATH is not an executable file: ${env.AGY_PATH}`);
    }
    return resolved;
  }

  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of executableNames(platform)) {
      const resolved = resolveExecutableCandidate(path.join(directory, name), platform);
      if (resolved) {
        return resolved;
      }
    }
  }
  throw new Error("The agy executable was not found. Install Antigravity, add agy to PATH, or set AGY_PATH.");
}

export function parseDurationMs(value) {
  const source = String(value ?? "").trim();
  if (!source) {
    throw new Error("Print timeout cannot be empty.");
  }

  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = "";
  let match;
  while ((match = pattern.exec(source)) !== null) {
    consumed += match[0];
    total += Number(match[1]) * units[match[2]];
  }
  if (consumed !== source || !Number.isFinite(total) || total <= 0) {
    throw new Error(`Invalid duration "${source}". Use values such as 30s, 5m0s, or 1h.`);
  }
  return Math.ceil(total);
}

function normalizeExtraDirectories(cwd, values = []) {
  return values.map((value) => resolveDirectory(path.resolve(cwd, value)));
}

export function buildAgyArgs(request) {
  const printTimeout = request.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
  parseDurationMs(printTimeout);

  if (!new Set(["safe", "write", "full-access"]).has(request.mode)) {
    throw new Error(`Unknown Antigravity permission mode: ${request.mode}`);
  }
  if (request.mode === "full-access" && !request.fullAccessConfirmed) {
    throw new Error("Full access requires direct user confirmation.");
  }
  if (request.effort && !VALID_EFFORTS.has(request.effort)) {
    throw new Error(`Unsupported effort "${request.effort}". Use low, medium, or high.`);
  }
  if (request.continueLatest && request.conversation) {
    throw new Error("Choose either --continue or --conversation, not both.");
  }
  if (request.project && request.newProject) {
    throw new Error("Choose either --project or --new-project, not both.");
  }

  const args = ["--print-timeout", printTimeout];
  if (request.mode === "safe") {
    args.push("--mode", "plan", "--sandbox");
  } else if (request.mode === "write") {
    args.push("--mode", "accept-edits", "--sandbox");
  } else {
    args.push("--mode", "accept-edits", "--dangerously-skip-permissions");
  }

  if (request.continueLatest) {
    args.push("-c");
  } else if (request.conversation) {
    args.push("--conversation", request.conversation);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.agent) {
    args.push("--agent", request.agent);
  }
  if (request.effort) {
    args.push("--effort", request.effort);
  }
  for (const directory of normalizeExtraDirectories(request.cwd, request.addDirs)) {
    args.push("--add-dir", directory);
  }
  if (request.project) {
    args.push("--project", request.project);
  } else if (request.newProject) {
    args.push("--new-project");
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new Error("Antigravity requires a non-empty prompt.");
  }
  args.push("-p", request.prompt);
  return args;
}

export function probeAgy(options = {}) {
  try {
    const binary = resolveAgyBinary(options);
    const result = runCommand(binary, ["--version"], {
      env: options.env ?? process.env,
      timeout: 10_000
    });
    if (result.error || result.status !== 0) {
      return {
        available: false,
        binary,
        detail: formatCommandFailure(result)
      };
    }
    return {
      available: true,
      binary,
      version: result.stdout.trim() || result.stderr.trim() || "unknown"
    };
  } catch (error) {
    return {
      available: false,
      binary: null,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export function executeAgyTask(request, options = {}) {
  const env = options.env ?? process.env;
  const binary = resolveAgyBinary({ env });
  const args = buildAgyArgs(request);
  const printTimeoutMs = parseDurationMs(request.printTimeout ?? DEFAULT_PRINT_TIMEOUT);
  const result = runCommand(binary, args, {
    cwd: request.cwd,
    env,
    timeout: printTimeoutMs + OUTER_TIMEOUT_GRACE_MS,
    maxBuffer: 16 * 1024 * 1024
  });

  const errorMessage = result.error ? `agy failed to start or timed out: ${result.error.message}` : null;
  return {
    binary,
    exitStatus: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    errorMessage
  };
}
