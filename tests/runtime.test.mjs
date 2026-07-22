import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { extractJobId, installFakeAgy, makeTempDir, runCompanion } from "./helpers.mjs";

function fixture() {
  const workspace = makeTempDir("agy-workspace-");
  const pluginData = makeTempDir("agy-data-");
  const fakeAgy = installFakeAgy();
  const record = path.join(makeTempDir("agy-record-"), "record.json");
  const env = {
    AGY_PATH: fakeAgy,
    CLAUDE_PLUGIN_DATA: pluginData,
    FAKE_AGY_RECORD: record
  };
  return { workspace, pluginData, fakeAgy, record, env };
}

function readRecord(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("setup reports the resolved fake agy executable and version", () => {
  const { env, fakeAgy } = fixture();
  const result = runCompanion(["setup"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Antigravity Setup/);
  assert.match(result.stdout, new RegExp(fakeAgy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /agy 1\.1\.5-fake/);
  assert.match(result.stdout, /interactive TTY/);
  assert.match(result.stdout, /\/dev\/tty/);
  assert.match(result.stdout, /separate terminal window/);
});

test("safe mode safely forwards the exact prompt with shell disabled semantics", () => {
  const { workspace, record, env } = fixture();
  const prompt = "line one\nquotes: ' \" ; $(touch nope) | &\nline three";
  const result = runCompanion(["task", "--cwd", workspace], {
    env: { ...env, FAKE_AGY_STDOUT: "exact output" },
    input: prompt,
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "exact output");
  const captured = readRecord(record);
  assert.equal(captured.stdin, "");
  assert.equal(captured.prompt, prompt);
  assert.equal(captured.cwd, workspace);
  assert.deepEqual(captured.argv, ["--print-timeout", "5m0s", "--mode", "plan", "--sandbox", "-p", prompt]);
  assert.equal(fs.existsSync(path.join(workspace, "nope")), false);
});

test("single raw slash-command arguments preserve the prompt after --", () => {
  const { workspace, record, env } = fixture();
  const prompt = "preserve  two spaces\nand -- literal task text";
  const result = runCompanion(["task", `--cwd "${workspace}" --write -- ${prompt}`], { env });
  assert.equal(result.status, 0, result.stderr);
  const captured = readRecord(record);
  assert.equal(captured.stdin, "");
  assert.equal(captured.prompt, prompt);
  assert.deepEqual(captured.argv, [
    "--print-timeout",
    "5m0s",
    "--mode",
    "accept-edits",
    "--sandbox",
    "-p",
    prompt
  ]);
});

test("write and confirmed full-access modes map to distinct agy flags", () => {
  const writeFixture = fixture();
  let result = runCompanion(["task", "--cwd", writeFixture.workspace, "--write", "--", "edit task"], {
    env: writeFixture.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRecord(writeFixture.record).argv.slice(2, 5), ["--mode", "accept-edits", "--sandbox"]);

  const deniedFixture = fixture();
  result = runCompanion(["task", "--cwd", deniedFixture.workspace, "--full-access", "--", "dangerous task"], {
    env: deniedFixture.env
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direct user confirmation/i);
  assert.equal(fs.existsSync(deniedFixture.record), false);

  const fullFixture = fixture();
  result = runCompanion(
    ["task", "--cwd", fullFixture.workspace, "--full-access", "--confirm-full-access", "--", "dangerous task"],
    { env: fullFixture.env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRecord(fullFixture.record).argv.slice(2, 5), [
    "--mode",
    "accept-edits",
    "--dangerously-skip-permissions"
  ]);

  const backgroundFixture = fixture();
  result = runCompanion(
    [
      "task",
      "--cwd",
      backgroundFixture.workspace,
      "--background",
      "--full-access",
      "--confirm-full-access",
      "--",
      "dangerous task"
    ],
    { env: backgroundFixture.env }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /foreground/);
});

test("runtime forwards validated model, agent, effort, directory, and project controls", () => {
  const { workspace, record, env } = fixture();
  const extraA = makeTempDir("agy-extra-a-");
  const extraB = makeTempDir("agy-extra-b-");
  const result = runCompanion(
    [
      "task",
      "--cwd",
      workspace,
      "--model",
      "model-x",
      "--agent",
      "agent-y",
      "--effort",
      "high",
      "--print-timeout",
      "1m30s",
      "--add-dir",
      extraA,
      "--add-dir",
      extraB,
      "--project",
      "project-z",
      "--",
      "inspect"
    ],
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRecord(record).argv, [
    "--print-timeout",
    "1m30s",
    "--mode",
    "plan",
    "--sandbox",
    "--model",
    "model-x",
    "--agent",
    "agent-y",
    "--effort",
    "high",
    "--add-dir",
    extraA,
    "--add-dir",
    extraB,
    "--project",
    "project-z",
    "-p",
    "inspect"
  ]);
});

test("continue routing supports latest and known conversation IDs", () => {
  const latest = fixture();
  let result = runCompanion(["task", "--cwd", latest.workspace, "--continue", "--", "follow up"], {
    env: latest.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readRecord(latest.record).argv.includes("-c"));

  const known = fixture();
  result = runCompanion(
    ["task", "--cwd", known.workspace, "--continue-command", "--conversation", "conversation-123", "--", "follow up"],
    { env: known.env }
  );
  assert.equal(result.status, 0, result.stderr);
  const argv = readRecord(known.record).argv;
  assert.deepEqual(argv.slice(argv.indexOf("--conversation"), argv.indexOf("--conversation") + 2), [
    "--conversation",
    "conversation-123"
  ]);
  assert.equal(argv.includes("-c"), false);
});

test("failure preserves stderr, partial stdout, exit status, and stored result", () => {
  const { workspace, env } = fixture();
  const result = runCompanion(["task", "--cwd", workspace, "--", "fail"], {
    env: {
      ...env,
      FAKE_AGY_MODE: "failure",
      FAKE_AGY_STDOUT: "partial exact\n",
      FAKE_AGY_STDERR: "specific failure\n",
      FAKE_AGY_EXIT: "9"
    }
  });
  assert.equal(result.status, 9);
  assert.match(result.stdout, /Antigravity Task Failed/);
  assert.match(result.stdout, /specific failure/);
  assert.match(result.stdout, /partial exact/);
  const jobId = extractJobId(result.stdout);

  const stored = runCompanion(["result", "--cwd", workspace, jobId], { env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /Exit: 9/);
  assert.match(stored.stdout, /specific failure/);
  assert.match(stored.stdout, /partial exact/);
});

test("invalid options and missing agy fail without launching a task", () => {
  const invalid = fixture();
  let result = runCompanion(["task", "--cwd", invalid.workspace, "--effort", "extreme", "--", "task"], {
    env: invalid.env
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Antigravity Task Failed/);
  assert.match(result.stdout, /Unsupported effort/);

  const missing = fixture();
  result = runCompanion(["task", "--cwd", missing.workspace, "--", "task"], {
    env: { ...missing.env, AGY_PATH: path.join(missing.workspace, "missing-agy") }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AGY_PATH is not an executable file/);
});
