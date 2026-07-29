// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { spawn, spawnSync } from "node:child_process";
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

export function runCommandStreaming(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let child;
    let timer = null;
    let forceKillTimer = null;
    let finalizeTimer = null;
    let terminationError = null;
    let knownDescendants = [];
    const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;

    const listDescendants = (rootPid) => {
      if (process.platform === "win32") {
        return [];
      }
      const snapshot = runCommand("ps", ["-eo", "pid=,ppid="], { timeout: 2_000 });
      if (snapshot.error || snapshot.status !== 0) {
        return [];
      }
      const children = new Map();
      for (const line of snapshot.stdout.split(/\r?\n/)) {
        const [pidText, parentText] = line.trim().split(/\s+/, 2);
        const pid = Number(pidText);
        const parent = Number(parentText);
        if (!Number.isInteger(pid) || !Number.isInteger(parent)) {
          continue;
        }
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const descendants = [];
      const pending = [...(children.get(rootPid) ?? [])];
      while (pending.length) {
        const pid = pending.shift();
        descendants.push(pid);
        pending.push(...(children.get(pid) ?? []));
      }
      return descendants;
    };

    const signalTree = (signal) => {
      if (process.platform === "win32") {
        if (signal === "SIGKILL") {
          runCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000 });
        } else {
          child.kill(signal);
        }
        return;
      }
      const descendants = [...new Set([...knownDescendants, ...listDescendants(child.pid)])];
      knownDescendants = descendants;
      for (const pid of [...descendants].reverse()) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") {
            // Best effort; the finalizer still guarantees completion.
          }
        }
      }
      try {
        process.kill(child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") {
          child.kill(signal);
        }
      }
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const activeTimer of [timer, forceKillTimer, finalizeTimer]) {
        if (activeTimer) {
          clearTimeout(activeTimer);
        }
      }
      resolve({
        command,
        args,
        status: result.status,
        signal: result.signal ?? null,
        stdout,
        stderr,
        error: result.error ?? null
      });
    };

    const requestTermination = (error) => {
      if (terminationError || settled) {
        return;
      }
      terminationError = error;
      try {
        signalTree(options.killSignal ?? "SIGTERM");
      } catch {
        // The finalizer below still guarantees that the promise settles.
      }
      forceKillTimer = setTimeout(() => {
        try {
          signalTree("SIGKILL");
        } catch {
          // The process may already be gone.
        }
      }, options.forceKillGraceMs ?? 500);
      finalizeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ status: null, signal: "SIGKILL", error: terminationError });
      }, options.finalizeGraceMs ?? 1_500);
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      resolve({ command, args, status: null, signal: null, stdout, stderr, error });
      return;
    }

    timer =
      Number.isFinite(options.timeout) && options.timeout > 0
        ? setTimeout(() => {
            requestTermination(new Error(`Command timed out after ${options.timeout}ms`));
          }, options.timeout)
        : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.captureStdout !== false) {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > maxBuffer) {
          requestTermination(new Error(`Command stdout exceeded ${maxBuffer} bytes.`));
          return;
        }
        stdout += chunk;
      }
      try {
        options.onStdout?.(chunk);
      } catch (error) {
        requestTermination(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (options.captureStderr !== false) {
        stderrBytes += Buffer.byteLength(chunk, "utf8");
        if (stderrBytes > maxBuffer) {
          requestTermination(new Error(`Command stderr exceeded ${maxBuffer} bytes.`));
          return;
        }
        stderr += chunk;
      }
      try {
        options.onStderr?.(chunk);
      } catch (error) {
        requestTermination(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (status, signal) => {
      finish({ status, signal, error: terminationError });
    });
  });
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
