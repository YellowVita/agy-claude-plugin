import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import { ROOT, makeTempDir } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "plugins", "agy", "scripts", "agy-task.mjs");

// A fake `agy` (CommonJS, extensionless) driven by FAKE_AGY_* environment variables.
const FAKE_AGY = String.raw`#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_AGY_RECORD) {
  fs.appendFileSync(env.FAKE_AGY_RECORD, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
}
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write((env.FAKE_AGY_VERSION ?? "1.4.2") + "\n");
  process.exit(0);
}
if (argv.join(" ") === "--output-format json models") {
  process.stderr.write("⠋ Fetching available models...\r");
  const models = [{ id: "model-a", label: "A" }, { id: "model-b", label: "B" }];
  process.stdout.write(env.FAKE_AGY_MODELS_STDOUT ??
    JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", command: { name: "models", data: { models } } }) + "\n");
  process.exit(Number(env.FAKE_AGY_MODELS_EXIT ?? 0));
}
if (argv[argv.length - 2] !== "-p") {
  process.stderr.write("error: -p must be the last flag\n");
  process.exit(2);
}
if (env.FAKE_AGY_GRANDCHILD) {
  // A long-lived grandchild that inherits agy's stdout/stderr pipes.
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: env.FAKE_AGY_GRANDCHILD === "detached"
  });
  grandchild.unref();
  fs.writeFileSync(env.FAKE_AGY_GRANDCHILD_PID, String(grandchild.pid));
}
if (env.FAKE_AGY_HANG) {
  process.on("SIGTERM", () => {
    fs.writeFileSync(env.FAKE_AGY_SIGNAL_FILE, "SIGTERM");
    if (env.FAKE_AGY_HANG !== "ignore-term") process.exit(143);
  });
  fs.writeFileSync(env.FAKE_AGY_READY_FILE, String(process.pid));
  setInterval(() => {}, 1000);
  return;
}
process.stderr.write(env.FAKE_AGY_STDERR ?? "");
if (env.FAKE_AGY_STDOUT !== undefined) {
  process.stdout.write(env.FAKE_AGY_STDOUT);
} else {
  const result = {
    conversation_id: "conv-123",
    status: "SUCCESS",
    response: "fake response\n",
    duration_seconds: 1.25,
    num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 }
  };
  if (argv.includes("--json-schema") && !env.FAKE_AGY_NO_STRUCTURED) result.structured_output = { answer: 42, items: ["x"] };
  if (env.FAKE_AGY_DENIED) result.denied_actions = JSON.parse(env.FAKE_AGY_DENIED);
  process.stdout.write(JSON.stringify(result) + "\n");
}
process.exitCode = Number(env.FAKE_AGY_EXIT ?? 0);
`;

function setup() {
  const dir = makeTempDir("agy-task-test-");
  const binDir = path.join(dir, "bin");
  const home = path.join(dir, "home");
  fs.mkdirSync(binDir);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(binDir, "agy"), FAKE_AGY, { mode: 0o755 });
  const record = path.join(dir, "record.jsonl");
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    FAKE_AGY_RECORD: record
  };
  delete env.AGY_BIN;
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: options.cwd ?? dir,
      env: { ...env, ...options.env },
      input: options.input,
      encoding: "utf8",
      timeout: 15_000
    });
  const calls = () =>
    fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const writeSettings = (text) => {
    const file = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  return { dir, env, run, calls, writeSettings };
}

const READ_GUARD =
  "Read-only task: do not create, modify, or delete files, and do not run commands that change state " +
  "(installs, git commit/checkout/reset, writes to network services). Only read and analyze, then answer.\n\n";

const SUCCESS_FOOTER =
  "---\n[agy] status=OK conversation=conv-123 turns=2 duration=1.3s mode=read sandbox=on permission=request-review\n" +
  "[agy] continue with: --conversation conv-123\n";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startWrapper(dir, env, args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, ...output })));
  return { child, exited };
}

describe("agy-task", { skip: process.platform === "win32" && "fake agy uses a POSIX shebang" }, () => {
  test("read mode passes only the safe defaults and puts -p last", () => {
    const { run, calls } = setup();
    const result = run(["hello", "world"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls()[0].argv, ["--output-format", "json", "--disable-slash-commands", "--sandbox", "-p", `${READ_GUARD}hello world`]);
  });

  test("write mode forwards every option before -p", () => {
    const { dir, run, calls } = setup();
    const schema = '{"type":"object"}';
    const result = run([
      "--mode", "write", "--no-sandbox", "--conversation", "abc", "--model", "m1", "--effort", "high",
      "--agent", "helper", "--add-dir", "a", "--add-dir=b", "--json-schema", schema, "--timeout", "5m",
      "--", "--fix", "it"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls()[0].argv, [
      "--output-format", "json", "--disable-slash-commands", "--mode", "accept-edits",
      "--conversation", "abc", "--model", "m1", "--effort", "high", "--agent", "helper",
      "--add-dir", path.join(dir, "a"), "--add-dir", path.join(dir, "b"),
      "--json-schema", schema, "--print-timeout", "5m", "-p", "--fix it"
    ]);
    assert.match(result.stdout, /mode=write sandbox=off permission=request-review/);
  });

  test("auto mode; relative paths resolve against --cwd", () => {
    const { dir, run, calls } = setup();
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "prompt.txt"), "from work dir");
    const result = run(["--mode", "auto", "--cwd", "work", "--add-dir", "sub", "--json-schema", "schema.json", "--prompt-file", "prompt.txt"]);
    assert.equal(result.status, 0, result.stderr);
    const [call] = calls();
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(work));
    assert.deepEqual(call.argv.slice(3, 5), ["--mode", "auto"]);
    assert.equal(call.argv[call.argv.indexOf("--add-dir") + 1], path.join(work, "sub"));
    assert.equal(call.argv[call.argv.indexOf("--json-schema") + 1], path.join(work, "schema.json"));
    assert.equal(call.argv.at(-1), "from work dir");
  });

  test("read mode prepends the read-only guard; write and auto do not", () => {
    const { run, calls } = setup();
    for (const mode of ["read", "write", "auto"]) assert.equal(run(["--mode", mode, "task"]).status, 0);
    assert.deepEqual(calls().map((call) => call.argv.at(-1)), [`${READ_GUARD}task`, "task", "task"]);
    const help = run(["--help"]).stdout;
    assert.match(help, /requested, not enforced: agy's own permission settings decide/);
  });

  test("options end at the first prompt word", () => {
    const { run, calls } = setup();
    assert.equal(run(["explain", "--mode", "write"]).status, 0);
    assert.equal(calls()[0].argv.at(-1), `${READ_GUARD}explain --mode write`);
    assert.ok(!calls()[0].argv.includes("accept-edits"));
  });

  test("renders a compact success result without stderr noise", () => {
    const { run } = setup();
    const result = run(["hi"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `fake response\n\n${SUCCESS_FOOTER}`);
    assert.equal(result.stderr, "");
  });

  test("footer shows toolPermission from agy settings (BOM tolerated, invalid -> unknown)", () => {
    const { run, writeSettings } = setup();
    writeSettings(`﻿${JSON.stringify({ toolPermission: "always-proceed" })}`);
    assert.match(run(["hi"]).stdout, /sandbox=on permission=always-proceed\n/);
    writeSettings("{ not json");
    const result = run(["hi"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /permission=unknown\n/);
  });

  test("falls back to the last JSON line when stdout has extra text", () => {
    const { run } = setup();
    const json = JSON.stringify({ conversation_id: "c9", status: "SUCCESS", response: "ok", num_turns: 1 });
    const result = run(["hi"], { env: { FAKE_AGY_STDOUT: `Some banner\n{ not json\n${json}\n` } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith("ok\n\n---\n[agy] status=OK conversation=c9"));
  });

  test("renders structured_output as pretty JSON", () => {
    const { run } = setup();
    const result = run(["--json-schema", '{"type":"object"}', "hi"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.startsWith(`${JSON.stringify({ answer: 42, items: ["x"] }, null, 2)}\n\n---\n`));
  });

  test("missing structured_output is an error but keeps the prose", () => {
    const { run } = setup();
    const result = run(["--json-schema", '{"type":"object"}', "hi"], { env: { FAKE_AGY_NO_STRUCTURED: "1" } });
    assert.equal(result.status, 3);
    assert.ok(result.stdout.startsWith("fake response\n\n---\n[agy] status=ERROR"));
    assert.match(result.stdout, /^\[agy\] error: structured output missing/m);
  });

  test("lists denied actions", () => {
    const { run } = setup();
    const denied = JSON.stringify(["write_file src/a.js", { name: "run_command", command: "npm test" }]);
    const result = run(["hi"], { env: { FAKE_AGY_DENIED: denied } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\[agy\] denied actions: write_file src\/a\.js, run_command npm test$/m);
  });

  test("renders agy 1.4 denied_actions entries", () => {
    const { run } = setup();
    // Shape observed from agy 1.4.2 when headless mode auto-denies a command.
    const denied = JSON.stringify([{ action: "command", display_name: "RunCommand" }]);
    const result = run(["hi"], { env: { FAKE_AGY_DENIED: denied } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\[agy\] denied actions: command \(RunCommand\)$/m);
  });

  test("--timeout expiry is reported as PARTIAL with exit 4", () => {
    const { run } = setup();
    const result = run(["--timeout", "1s", "hi"], {
      // Wording observed from agy 1.4.2; it still exits 0 with status SUCCESS.
      env: { FAKE_AGY_STDERR: "[agy] print timeout after 1s with turn in progress; returning partial output\n" }
    });
    assert.equal(result.status, 4);
    assert.match(result.stdout, /status=PARTIAL/);
    assert.match(result.stdout, /^\[agy\] timed out: response is partial$/m);
    assert.match(result.stderr, /print timeout/);
  });

  test("timeout-like stderr without --timeout is not PARTIAL", () => {
    const { run } = setup();
    const result = run(["hi"], { env: { FAKE_AGY_STDERR: "warning: context deadline exceeded while syncing\n" } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /status=OK/);
    assert.doesNotMatch(result.stdout, /timed out/);
  });

  test("a timeout never masks an error status", () => {
    const { run } = setup();
    const stdout = JSON.stringify({ conversation_id: "c", status: "ERROR", response: "half", error: "model failed" });
    const result = run(["--timeout", "1s", "hi"], { env: { FAKE_AGY_STDOUT: stdout, FAKE_AGY_STDERR: "warning: request timed out\n" } });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /status=ERROR/);
    assert.match(result.stdout, /^\[agy\] error: model failed \(status=ERROR\)$/m);
    assert.doesNotMatch(result.stdout, /timed out: response is partial/);
  });

  test("runtime errors exit 3 and parse AGY_ERROR", () => {
    const { run } = setup();
    const stdout = JSON.stringify({
      conversation_id: "conv-err", status: "ERROR", response: "", error: "Individual quota reached",
      duration_seconds: 0, num_turns: 1, usage: {}
    });
    const agyError = JSON.stringify({ short_error: "quota", status: "RESOURCE_EXHAUSTED", error_code: 429, retryable: true });
    const result = run(["hi"], {
      env: { FAKE_AGY_STDOUT: stdout, FAKE_AGY_EXIT: "3", FAKE_AGY_STDERR: `error: Individual quota reached\nAGY_ERROR: ${agyError}\n` }
    });
    assert.equal(result.status, 3);
    assert.ok(result.stdout.startsWith("---\n[agy] status=ERROR conversation=conv-err turns=1 duration=0s"));
    assert.match(result.stdout, /^\[agy\] error: Individual quota reached \(status=RESOURCE_EXHAUSTED, retryable=true\)$/m);
    assert.match(result.stdout, /continue with: --conversation conv-err/);
    assert.match(result.stderr, /AGY_ERROR/);
  });

  test("any status other than SUCCESS is an error, even with exit 0", () => {
    const { run } = setup();
    const cases = [
      [{ conversation_id: "c", status: "ERROR", response: "", error: "boom" }, /\[agy\] error: boom \(status=ERROR\)/],
      [{ conversation_id: "c", status: "CANCELLED", response: "x" }, /\[agy\] error: agy reported status CANCELLED \(status=CANCELLED\)/],
      [{ conversation_id: "c", response: "x" }, /\[agy\] error: agy reported status \(missing\) \(status=missing\)/]
    ];
    for (const [payload, pattern] of cases) {
      const result = run(["hi"], { env: { FAKE_AGY_STDOUT: JSON.stringify(payload) } });
      assert.equal(result.status, 3, JSON.stringify(payload));
      assert.match(result.stdout, pattern);
    }
    const lower = run(["hi"], { env: { FAKE_AGY_STDOUT: JSON.stringify({ status: "success", response: "x" }) } });
    assert.equal(lower.status, 0);
  });

  test("unexpected agy exit codes map to 3", () => {
    const { run } = setup();
    assert.equal(run(["hi"], { env: { FAKE_AGY_EXIT: "5" } }).status, 3);
    const nonJson = run(["hi"], { env: { FAKE_AGY_STDOUT: "boom\n", FAKE_AGY_EXIT: "7" } });
    assert.equal(nonJson.status, 3);
    assert.match(nonJson.stderr, /exited with code 7/);
  });

  test("non-JSON stdout is shown with stderr", () => {
    const { run } = setup();
    const result = run(["hi"], { env: { FAKE_AGY_STDOUT: "plain text\n", FAKE_AGY_STDERR: "something odd\n" } });
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "plain text\n");
    assert.match(result.stderr, /without valid JSON[\s\S]*something odd/);
  });

  test("agy usage errors pass through with their stderr", () => {
    const { run } = setup();
    const result = run(["--agent", "nope", "hi"], {
      env: { FAKE_AGY_STDOUT: "", FAKE_AGY_STDERR: "error: agent not found: nope\n", FAKE_AGY_EXIT: "1" }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent not found: nope/);
    assert.equal(run(["hi"], { env: { FAKE_AGY_STDOUT: "", FAKE_AGY_EXIT: "2" } }).status, 2);
  });

  test("--raw prints agy JSON verbatim", () => {
    const { run } = setup();
    const result = run(["--raw", "hi"]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).conversation_id, "conv-123");
  });

  test("usage errors exit 2 with usage text", () => {
    const { run, calls } = setup();
    for (const args of [[], ["--mode", "write"], ["--bogus", "hi"], ["--mode", "plan", "hi"], ["   "], ["--cwd", "missing", "hi"]]) {
      const result = run(args);
      assert.equal(result.status, 2, `args: ${args.join(" ")}`);
      assert.match(result.stderr, /Usage:/);
    }
    assert.deepEqual(calls(), []);
  });

  test("prompts with NUL bytes or over the size limit are rejected before spawning", () => {
    const { dir, run, calls } = setup();
    fs.writeFileSync(path.join(dir, "nul.txt"), "a\0b");
    const nul = run(["--prompt-file", "nul.txt"]);
    assert.equal(nul.status, 2);
    assert.match(nul.stderr, /NUL byte/);
    // The guard counts toward the limit: this prompt only fits without it.
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(100 * 1024 - 10));
    assert.equal(run(["--mode", "write", "--prompt-file", "big.txt"]).status, 0);
    const big = run(["--prompt-file", "big.txt"]);
    assert.equal(big.status, 2);
    assert.match(big.stderr, /put the material in a file and tell agy to read it/);
    assert.equal(calls().length, 1);
  });

  test("--help lists every exit code", () => {
    const { run } = setup();
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    for (const code of ["0", "1", "2", "3", "4", "126", "127", "129/130/143"]) {
      assert.match(result.stdout, new RegExp(`^  ${code}\\s`, "m"));
    }
    assert.match(result.stdout, /--check exits 0 when ready and 1 otherwise/);
  });

  test("missing agy exits 127 with an actionable message", () => {
    const { dir, run } = setup();
    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    const result = run(["hi"], { env: { PATH: empty } });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /not found[\s\S]*PATH/);
    const viaEnv = run(["hi"], { env: { AGY_BIN: path.join(empty, "agy") } });
    assert.equal(viaEnv.status, 127);
  });

  test("a non-executable agy exits 126 without a stack trace", () => {
    const { dir, run } = setup();
    const file = path.join(dir, "not-executable");
    fs.writeFileSync(file, "", { mode: 0o644 });
    const result = run(["hi"], { env: { AGY_BIN: file } });
    assert.equal(result.status, 126);
    assert.match(result.stderr, /could not start/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  test("--prompt-file reads a file or stdin", () => {
    const { dir, run, calls } = setup();
    fs.writeFileSync(path.join(dir, "prompt.txt"), "line one\nline two\n");
    assert.equal(run(["--prompt-file", "prompt.txt"]).status, 0);
    assert.equal(run(["--prompt-file", "-"], { input: "from stdin" }).status, 0);
    assert.deepEqual(calls().map((call) => call.argv.at(-1)), [`${READ_GUARD}line one\nline two\n`, `${READ_GUARD}from stdin`]);
    assert.equal(run(["--prompt-file", "prompt.txt", "extra"]).status, 2);
    assert.equal(run(["--prompt-file", "missing.txt"]).status, 2);
  });

  test("--check reports version, settings and models", () => {
    const { run, calls, writeSettings } = setup();
    writeSettings(`﻿${JSON.stringify({ toolPermission: "request-review", agentMode: "fast" })}`);
    const result = run(["--check"]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /version: 1\.4\.2/);
    assert.match(result.stdout, /toolPermission: request-review\nagentMode: fast/);
    assert.match(result.stdout, /models: 2 available \(model-a, model-b\)/);
    assert.deepEqual(calls().map((call) => call.argv), [["--version"], ["--output-format", "json", "models"]]);
  });

  test("--check tolerates missing or invalid settings", () => {
    const { run, writeSettings } = setup();
    assert.match(run(["--check"]).stdout, /toolPermission: request-review\nagentMode: default/);
    writeSettings("[1, 2");
    const result = run(["--check"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /unreadable[\s\S]*toolPermission: unknown/);
  });

  test("--check rejects agy older than 1.4.0", () => {
    const { run } = setup();
    const result = run(["--check"], { env: { FAKE_AGY_VERSION: "1.3.9" } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ready: no\ndetail: agy 1\.4\.0 or newer is required \(found 1\.3\.9\)/);
  });

  test("--check fails with a sign-in hint", () => {
    const { run } = setup();
    const result = run(["--check"], {
      env: {
        FAKE_AGY_MODELS_STDOUT: JSON.stringify({ status: "ERROR", error: "not signed in" }),
        FAKE_AGY_MODELS_EXIT: "1"
      }
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ready: no\ndetail: not signed in/);
    assert.match(result.stdout, /interactive terminal to sign in/);
    const { dir, run: run2 } = setup();
    fs.mkdirSync(path.join(dir, "empty"));
    const missing = run2(["--check"], { env: { PATH: path.join(dir, "empty") } });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /not found/);
  });

  test("SIGTERM stops agy's whole process group", async () => {
    const { dir, env } = setup();
    const files = { ready: path.join(dir, "ready"), signal: path.join(dir, "signal"), grandchild: path.join(dir, "gc") };
    const { child, exited } = startWrapper(dir, {
      ...env, FAKE_AGY_HANG: "1", FAKE_AGY_READY_FILE: files.ready, FAKE_AGY_SIGNAL_FILE: files.signal,
      FAKE_AGY_GRANDCHILD: "group", FAKE_AGY_GRANDCHILD_PID: files.grandchild
    }, ["hi"]);
    await waitFor(() => fs.existsSync(files.ready), "fake agy did not start");
    const grandchild = Number(fs.readFileSync(files.grandchild, "utf8"));
    child.kill("SIGTERM");
    const { code, stderr } = await exited;
    assert.equal(code, 143);
    assert.equal(fs.readFileSync(files.signal, "utf8"), "SIGTERM");
    assert.match(stderr, /interrupted by SIGTERM/);
    await waitFor(() => !isAlive(grandchild), "grandchild survived");
  });

  test("escalates to SIGKILL when agy ignores SIGTERM", async () => {
    const { dir, env } = setup();
    const files = { ready: path.join(dir, "ready"), signal: path.join(dir, "signal") };
    const { child, exited } = startWrapper(dir, {
      ...env, FAKE_AGY_HANG: "ignore-term", FAKE_AGY_READY_FILE: files.ready, FAKE_AGY_SIGNAL_FILE: files.signal
    }, ["hi"]);
    await waitFor(() => fs.existsSync(files.ready), "fake agy did not start");
    const agyPid = Number(fs.readFileSync(files.ready, "utf8"));
    child.kill("SIGINT");
    const { code } = await exited;
    assert.equal(code, 130);
    assert.ok(!isAlive(agyPid));
  });

  test("does not hang when a detached grandchild keeps the pipes open", async () => {
    const { dir, env } = setup();
    const pidFile = path.join(dir, "gc");
    const started = Date.now();
    const { exited } = startWrapper(dir, { ...env, FAKE_AGY_GRANDCHILD: "detached", FAKE_AGY_GRANDCHILD_PID: pidFile }, ["hi"]);
    const { code, stdout } = await exited;
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    try {
      assert.equal(code, 0);
      assert.equal(stdout, `fake response\n\n${SUCCESS_FOOTER}`);
      assert.ok(Date.now() - started < 8_000);
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  test("normal exit does not leave agy's process group running", async () => {
    const { dir, env } = setup();
    const pidFile = path.join(dir, "gc");
    const { exited } = startWrapper(dir, { ...env, FAKE_AGY_GRANDCHILD: "group", FAKE_AGY_GRANDCHILD_PID: pidFile }, ["hi"]);
    const { code } = await exited;
    assert.equal(code, 0);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => !isAlive(grandchild), "grandchild survived the wrapper");
  });
});
