import test from "node:test";
import assert from "node:assert/strict";

import {
  isProcessRunning,
  runCommandStreaming,
  terminateProcessTree
} from "../plugins/agy/scripts/lib/process.mjs";

test("runCommandStreaming forwards chunks while retaining the complete output", async () => {
  const chunks = [];
  const result = await runCommandStreaming(
    process.execPath,
    ["-e", "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 10)"],
    { timeout: 1_000, onStdout: (chunk) => chunks.push(chunk) }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "first\nsecond\n");
  assert.equal(chunks.join(""), result.stdout);
});

test("runCommandStreaming force-kills a process that ignores SIGTERM and always settles", async () => {
  const startedAt = Date.now();
  const result = await runCommandStreaming(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeout: 25, forceKillGraceMs: 25, finalizeGraceMs: 150 }
  );
  assert.match(result.error?.message ?? "", /timed out/);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runCommandStreaming timeout terminates descendants as well as the direct child", async () => {
  const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' });`,
    "process.stdout.write(String(child.pid) + '\\n');",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);"
  ].join(" ");
  const result = await runCommandStreaming(process.execPath, ["-e", parentSource], {
    timeout: 100,
    forceKillGraceMs: 50,
    finalizeGraceMs: 300
  });
  const grandchildPid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  try {
    const deadline = Date.now() + 1_000;
    while (isProcessRunning(grandchildPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(isProcessRunning(grandchildPid), false);
  } finally {
    if (isProcessRunning(grandchildPid)) {
      process.kill(grandchildPid, "SIGKILL");
    }
  }
});

test("runCommandStreaming can forward large streams without retaining stdout", async () => {
  let receivedBytes = 0;
  const result = await runCommandStreaming(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    {
      timeout: 1_000,
      captureStdout: false,
      maxBuffer: 1_024,
      onStdout: (chunk) => {
        receivedBytes += Buffer.byteLength(chunk, "utf8");
      }
    }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(receivedBytes, 2 * 1024 * 1024);
});

test("terminateProcessTree uses taskkill for a Windows process tree", () => {
  let captured;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });
  assert.deepEqual(captured, { command: "taskkill", args: ["/PID", "1234", "/T", "/F"] });
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.delivered, true);
});

test("terminateProcessTree targets a POSIX process group first", () => {
  const calls = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push({ pid, signal });
    }
  });
  assert.deepEqual(calls, [{ pid: -4321, signal: "SIGTERM" }]);
  assert.equal(outcome.method, "process-group");
});

test("isProcessRunning distinguishes live, missing, and permission-protected processes", () => {
  assert.equal(isProcessRunning(100, () => {}), true);
  assert.equal(
    isProcessRunning(100, () => {
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    }),
    false
  );
  assert.equal(
    isProcessRunning(100, () => {
      const error = new Error("protected");
      error.code = "EPERM";
      throw error;
    }),
    true
  );
});
