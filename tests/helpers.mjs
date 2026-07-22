import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy");
export const COMPANION = path.join(PLUGIN_ROOT, "scripts", "agy-companion.mjs");
export const FAKE_AGY_FIXTURE = path.join(ROOT, "tests", "fake-agy-fixture.mjs");

export function makeTempDir(prefix = "agy-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function installFakeAgy(directory = makeTempDir("fake-agy-bin-")) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, process.platform === "win32" ? "agy.exe" : "agy");
  fs.copyFileSync(FAKE_AGY_FIXTURE, target);
  fs.chmodSync(target, 0o755);
  return target;
}

export function runCompanion(args, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 15_000,
    windowsHide: true
  });
}

export function extractJobId(output) {
  const match = String(output).match(/Job:\s+(agy-[a-z0-9-]+)/i);
  if (!match) {
    throw new Error(`No job ID found in output:\n${output}`);
  }
  return match[1];
}

export function findJobFile(pluginData, jobId) {
  const stateRoot = path.join(pluginData, "state");
  for (const workspaceName of fs.readdirSync(stateRoot)) {
    const candidate = path.join(stateRoot, workspaceName, "jobs", `${jobId}.json`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find ${jobId} below ${stateRoot}.`);
}

export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.message ?? "Timed out waiting for condition.");
}
