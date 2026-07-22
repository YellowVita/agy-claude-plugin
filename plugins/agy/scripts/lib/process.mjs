// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout,
    killSignal: options.killSignal ?? "SIGTERM",
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function isProcessRunning(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }
    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(output)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }
    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }
    if (result.error) {
      throw result.error;
    }
    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.error) {
    parts.push(result.error.message);
  } else if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status ?? "unknown"}`);
  }
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
