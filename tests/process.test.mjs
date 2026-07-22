import test from "node:test";
import assert from "node:assert/strict";

import { isProcessRunning, terminateProcessTree } from "../plugins/agy/scripts/lib/process.mjs";

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
