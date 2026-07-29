import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractJobId,
  findJobFile,
  installFakeAgy,
  makeTempDir,
  runCompanion
} from "./helpers.mjs";

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

function readOnlyJob(pluginData) {
  const stateRoot = path.join(pluginData, "state");
  const workspaceDir = fs.readdirSync(stateRoot).map((name) => path.join(stateRoot, name))[0];
  const jobFiles = fs
    .readdirSync(path.join(workspaceDir, "jobs"))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".request.json"));
  assert.equal(jobFiles.length, 1);
  return JSON.parse(fs.readFileSync(path.join(workspaceDir, "jobs", jobFiles[0]), "utf8"));
}

test("setup reports the resolved fake agy executable and version", () => {
  const { env, fakeAgy } = fixture();
  const result = runCompanion(["setup"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Antigravity Setup/);
  assert.match(result.stdout, new RegExp(fakeAgy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /agy 1\.1\.8-fake/);
  assert.match(result.stdout, /interactive TTY/);
  assert.match(result.stdout, /\/dev\/tty/);
  assert.match(result.stdout, /separate terminal window/);
});

test("setup rejects agy builds that do not expose required structured features", () => {
  const { env } = fixture();
  const result = runCompanion(["setup"], {
    env: { ...env, FAKE_AGY_HELP: "Usage: agy -p <prompt>\n" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lacks required features/);
  assert.match(result.stdout, /JSON schema validation/);
});

test("setup JSON reports writable state and toggles the experimental review gate", () => {
  const { workspace, env } = fixture();
  let result = runCompanion(["setup", "--cwd", workspace, "--json", "--enable-review-gate"], { env });
  assert.equal(result.status, 0, result.stderr);
  let report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.stateWritable, true);
  assert.equal(report.reviewGateEnabled, true);
  assert.equal(report.capabilities["stream-json output"], true);

  result = runCompanion(["setup", "--cwd", workspace, "--json", "--disable-review-gate"], { env });
  assert.equal(result.status, 0, result.stderr);
  report = JSON.parse(result.stdout);
  assert.equal(report.reviewGateEnabled, false);
});

test("setup lazily prunes expired turn baselines and evidence", () => {
  const { workspace, pluginData, env } = fixture();
  const initial = runCompanion(["setup", "--cwd", workspace], { env });
  assert.equal(initial.status, 0, initial.stderr);
  const stateRoot = path.join(pluginData, "state");
  const workspaceState = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const key = "a".repeat(24);
  const snapshotFile = path.join(workspaceState, `turn-${key}.json`);
  const evidenceDirectory = path.join(workspaceState, "evidence", key);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(snapshotFile, '{"sensitive":"baseline"}\n');
  fs.writeFileSync(path.join(evidenceDirectory, "turn.patch"), "sensitive patch\n");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(snapshotFile, old, old);
  fs.utimesSync(evidenceDirectory, old, old);

  const result = runCompanion(["setup", "--cwd", workspace], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(snapshotFile), false);
  assert.equal(fs.existsSync(evidenceDirectory), false);
});

test("safe mode safely forwards the exact prompt with shell disabled semantics", () => {
  const { workspace, record, env } = fixture();
  const prompt = "line one\nquotes: ' \" ; $(touch nope) | &\nline three";
  const result = runCompanion(["task", "--cwd", workspace], {
    env: { ...env, FAKE_AGY_RESPONSE: "exact output" },
    input: prompt,
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "exact output");
  const captured = readRecord(record);
  assert.equal(captured.stdin, "");
  assert.equal(captured.prompt, prompt);
  assert.equal(captured.cwd, workspace);
  assert.deepEqual(captured.argv, [
    "--print-timeout",
    "5m0s",
    "--output-format",
    "json",
    "--mode",
    "plan",
    "--sandbox",
    "-p",
    prompt
  ]);
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
    "--output-format",
    "json",
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
  assert.deepEqual(readRecord(writeFixture.record).argv.slice(4, 7), ["--mode", "accept-edits", "--sandbox"]);

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
  assert.deepEqual(readRecord(fullFixture.record).argv.slice(4, 7), [
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
    "--output-format",
    "json",
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
  let result = runCompanion(["task", "--cwd", latest.workspace, "--", "initial"], {
    env: latest.env
  });
  assert.equal(result.status, 0, result.stderr);
  result = runCompanion(["task", "--cwd", latest.workspace, "--continue", "--", "follow up"], {
    env: latest.env
  });
  assert.equal(result.status, 0, result.stderr);
  const latestArgv = readRecord(latest.record).argv;
  assert.deepEqual(
    latestArgv.slice(latestArgv.indexOf("--conversation"), latestArgv.indexOf("--conversation") + 2),
    ["--conversation", "fake-conversation-123"]
  );
  assert.equal(latestArgv.includes("-c"), false);

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

test("continue resolves a stored structured-output job to its conversation ID", () => {
  const { workspace, pluginData, record, env } = fixture();
  const initial = runCompanion(["task", "--cwd", workspace, "--", "initial"], { env });
  assert.equal(initial.status, 0, initial.stderr);
  const sourceJob = readOnlyJob(pluginData);

  const continued = runCompanion(
    ["task", "--cwd", workspace, "--continue-command", "--job", sourceJob.id, "--", "follow up"],
    { env }
  );
  assert.equal(continued.status, 0, continued.stderr);
  const argv = readRecord(record).argv;
  assert.deepEqual(argv.slice(argv.indexOf("--conversation"), argv.indexOf("--conversation") + 2), [
    "--conversation",
    "fake-conversation-123"
  ]);
  assert.equal(argv.includes("-c"), false);
});

test("continue rejects an explicitly selected job that is still active", () => {
  const { workspace, pluginData, env } = fixture();
  const initial = runCompanion(["task", "--cwd", workspace, "--", "initial"], { env });
  assert.equal(initial.status, 0, initial.stderr);
  const sourceJob = readOnlyJob(pluginData);
  const jobFile = findJobFile(pluginData, sourceJob.id);
  fs.writeFileSync(
    jobFile,
    `${JSON.stringify({ ...sourceJob, status: "running", phase: "running", pid: process.pid }, null, 2)}\n`
  );

  const continued = runCompanion(
    ["task", "--cwd", workspace, "--continue-command", "--job", sourceJob.id, "--", "follow up"],
    { env }
  );
  assert.equal(continued.status, 1);
  assert.match(continued.stderr, /still running.*wait for it to finish/i);
});

test("explicit json output returns the raw envelope and records structured metadata", () => {
  const { workspace, pluginData, env } = fixture();
  const result = runCompanion(["task", "--cwd", workspace, "--output-format", "json", "--", "inspect"], { env });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.response, "fake response\n");
  assert.equal(envelope.usage.cache_read_tokens, 40);

  const job = readOnlyJob(pluginData);
  assert.equal(job.outputFormat, "json");
  assert.equal(job.outputFormatExplicit, true);
  assert.equal(job.conversationId, "fake-conversation-123");
  assert.equal(job.usage.total_tokens, 120);

  const status = runCompanion(["status", "--cwd", workspace, job.id], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Conversation: fake-conversation-123/);
  assert.match(status.stdout, /120 total, 40 cache-read/);

  const jsonStatus = runCompanion(["status", "--cwd", workspace, job.id, "--json"], { env });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  assert.equal(JSON.parse(jsonStatus.stdout).job.conversationId, "fake-conversation-123");
});

test("json schema supports inline JSON and renders structured_output by default", () => {
  const { workspace, record, env } = fixture();
  const schema = '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}';
  const result = runCompanion(["task", "--cwd", workspace, "--json-schema", schema, "--", "answer"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { answer: "fake structured" });

  const argv = readRecord(record).argv;
  assert.equal(argv[argv.indexOf("--json-schema") + 1], schema);
  assert.deepEqual(argv.slice(0, 6), [
    "--print-timeout",
    "5m0s",
    "--output-format",
    "json",
    "--json-schema",
    schema
  ]);
});

test("json schema file paths are validated and forwarded as absolute paths", () => {
  const { workspace, record, env } = fixture();
  const schemaPath = path.join(workspace, "schema.json");
  fs.writeFileSync(schemaPath, '{"type":"object"}\n', "utf8");
  const result = runCompanion(
    ["task", "--cwd", workspace, "--json-schema", "./schema.json", "--", "answer"],
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  const argv = readRecord(record).argv;
  assert.equal(argv[argv.indexOf("--json-schema") + 1], schemaPath);
});

test("stream-json is forwarded incrementally and records terminal metadata without sensitive payloads", () => {
  const { workspace, pluginData, env } = fixture();
  const result = runCompanion(["task", "--cwd", workspace, "--output-format", "stream-json", "--", "inspect"], {
    env: { ...env, FAKE_AGY_STREAM_TOOL: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    ["init", "step_update", "result"]
  );

  const job = readOnlyJob(pluginData);
  assert.equal(job.outputFormat, "stream-json");
  assert.equal(job.toolCallCount, 1);
  assert.equal(job.subagentCount, 1);
  assert.equal(job.conversationId, "fake-conversation-123");
  assert.equal(job.recentSteps[0].toolName, "view_file");
  assert.equal(job.subagents[0].conversationId, "child-1");
  assert.equal(job.subagents[0].logUri, "file:///fake");
  assert.equal(JSON.stringify(job).includes('"parameters"'), false);
  assert.equal(JSON.stringify(job).includes('"output":"ok"'), false);
});

test("explicit json failures keep stdout machine-readable and send diagnostics to stderr", () => {
  const { workspace, pluginData, env } = fixture();
  const failureEnvelope = {
    conversation_id: "failed-conversation",
    status: "FAILED",
    response: "",
    duration_seconds: 0.5,
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      thinking_tokens: 1,
      cache_read_tokens: 0,
      total_tokens: 12
    }
  };
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "json", "--", "fail"],
    {
      env: {
        ...env,
        FAKE_AGY_MODE: "failure",
        FAKE_AGY_STDOUT: `${JSON.stringify(failureEnvelope)}\n`,
        FAKE_AGY_STDERR: "specific failure\n",
        FAKE_AGY_EXIT: "9"
      }
    }
  );
  assert.equal(result.status, 9);
  assert.equal(JSON.parse(result.stdout).status, "FAILED");
  assert.doesNotMatch(result.stdout, /Antigravity Task Failed/);
  assert.match(result.stderr, /Antigravity Task Failed/);

  const job = readOnlyJob(pluginData);
  const stored = runCompanion(["result", "--cwd", workspace, job.id], { env });
  assert.equal(JSON.parse(stored.stdout).status, "FAILED");
  assert.doesNotMatch(stored.stdout, /Antigravity Task Failed/);
  assert.match(stored.stderr, /Antigravity Task Failed/);
});

test("invalid explicit json failures are replaced by a valid plugin error envelope", () => {
  const { workspace, env } = fixture();
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "json", "--", "fail"],
    {
      env: {
        ...env,
        FAKE_AGY_MODE: "failure",
        FAKE_AGY_STDOUT: "not-json\n",
        FAKE_AGY_STDERR: "specific failure\n",
        FAKE_AGY_EXIT: "9"
      }
    }
  );
  assert.equal(result.status, 9);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "FAILED");
  assert.equal(envelope.error.source, "agy-companion");
  assert.equal(envelope.error.raw_output, "not-json\n");
});

test("structured results missing required fields become valid plugin error envelopes", () => {
  const { workspace, env } = fixture();
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "json", "--", "invalid contract"],
    { env: { ...env, FAKE_AGY_STDOUT: '{"conversation_id":"incomplete"}\n' } }
  );
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "FAILED");
  assert.match(envelope.error.message, /terminal status/);
});

test("stream-json failures emit only valid NDJSON and append a terminal failure result", () => {
  const { workspace, pluginData, env } = fixture();
  const init = {
    event: "init",
    conversation_id: "stream-failure-conversation",
    init: { cwd: workspace, tools: [], permission_mode: "request-review" }
  };
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "stream-json", "--", "fail"],
    {
      env: {
        ...env,
        FAKE_AGY_MODE: "failure",
        FAKE_AGY_STDOUT: `${JSON.stringify(init)}\n`,
        FAKE_AGY_STDERR: "stream failure\n",
        FAKE_AGY_EXIT: "9"
      }
    }
  );
  assert.equal(result.status, 9);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    ["init", "result"]
  );
  assert.equal(events.at(-1).result.status, "FAILED");
  assert.doesNotMatch(result.stdout, /Antigravity Task Failed/);
  assert.match(result.stderr, /Antigravity Task Failed/);

  const job = readOnlyJob(pluginData);
  assert.equal(fs.readFileSync(job.stdoutFile, "utf8"), result.stdout);
  const stored = runCompanion(["result", "--cwd", workspace, job.id], { env });
  for (const line of stored.stdout.trim().split(/\r?\n/)) {
    JSON.parse(line);
  }
});

test("stream-json replaces a premature success terminal when the process exits non-zero", () => {
  const { workspace, env } = fixture();
  const conversationId = "premature-success";
  const init = {
    event: "init",
    conversation_id: conversationId,
    init: { cwd: workspace, tools: [], permission_mode: "request-review" }
  };
  const success = {
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: "not actually successful",
      duration_seconds: 0.1,
      num_turns: 1,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 2
      }
    }
  };
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "stream-json", "--", "fail after result"],
    {
      env: {
        ...env,
        FAKE_AGY_MODE: "failure",
        FAKE_AGY_STDOUT: `${JSON.stringify(init)}\n${JSON.stringify(success)}\n`,
        FAKE_AGY_EXIT: "9"
      }
    }
  );

  assert.equal(result.status, 9);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["init", "result"]);
  assert.equal(events.filter((event) => event.event === "result").length, 1);
  assert.equal(events.at(-1).result.status, "FAILED");
});

test("invalid stream-json lines are withheld and replaced by a valid failure result", () => {
  const { workspace, env } = fixture();
  const init = JSON.stringify({
    event: "init",
    conversation_id: "invalid-stream",
    init: { cwd: workspace, tools: [], permission_mode: "request-review" }
  });
  const result = runCompanion(
    ["task", "--cwd", workspace, "--output-format", "stream-json", "--", "invalid"],
    { env: { ...env, FAKE_AGY_STDOUT: `${init}\nnot-json\n` } }
  );
  assert.equal(result.status, 1);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "init");
  assert.equal(events[1].event, "result");
  assert.equal(events[1].result.status, "FAILED");
  assert.match(events[1].result.error.message, /invalid stream-json event/);
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

  for (const format of ["json", "stream-json"]) {
    const structuredInvalid = fixture();
    result = runCompanion(
      [
        "task",
        "--cwd",
        structuredInvalid.workspace,
        "--output-format",
        format,
        "--effort",
        "extreme",
        "--",
        "task"
      ],
      { env: structuredInvalid.env }
    );
    assert.equal(result.status, 1);
    if (format === "json") {
      assert.equal(JSON.parse(result.stdout).status, "FAILED");
    } else {
      const event = JSON.parse(result.stdout.trim());
      assert.equal(event.event, "result");
      assert.equal(event.result.status, "FAILED");
    }
    assert.match(result.stderr, /Unsupported effort/);
  }

  const badFormat = fixture();
  result = runCompanion(
    ["task", "--cwd", badFormat.workspace, "--output-format", "yaml", "--", "task"],
    { env: badFormat.env }
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unsupported output format/);

  const textSchema = fixture();
  result = runCompanion(
    [
      "task",
      "--cwd",
      textSchema.workspace,
      "--output-format",
      "text",
      "--json-schema",
      '{"type":"object"}',
      "--",
      "task"
    ],
    { env: textSchema.env }
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /requires --output-format json or stream-json/);

  const missing = fixture();
  result = runCompanion(["task", "--cwd", missing.workspace, "--", "task"], {
    env: { ...missing.env, AGY_PATH: path.join(missing.workspace, "missing-agy") }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AGY_PATH is not an executable file/);
});

test("setup rejects agy versions older than 1.1.8", () => {
  const { env } = fixture();
  const result = runCompanion(["setup"], { env: { ...env, FAKE_AGY_VERSION: "agy 1.1.7\n" } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /agy 1\.1\.8 or newer is required/);
});
