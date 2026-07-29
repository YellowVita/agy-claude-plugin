#!/usr/bin/env node

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(process.env.FAKE_AGY_VERSION ?? "agy 1.1.8-fake\n");
  process.exit(0);
}
if (argv.length === 1 && argv[0] === "--help") {
  process.stdout.write(
    process.env.FAKE_AGY_HELP ??
      "Usage: agy -p <prompt> --output-format <text|json|stream-json> --json-schema <schema>\n"
  );
  process.exit(0);
}

const stdin = fs.readFileSync(0, "utf8");
const promptIndex = argv.indexOf("-p");
if (promptIndex === -1 || argv[promptIndex + 1] === undefined) {
  process.stderr.write("fake agy expected -p <prompt>\n");
  process.exit(64);
}
const prompt = argv[promptIndex + 1];
if (process.env.FAKE_AGY_RECORD) {
  fs.writeFileSync(
    process.env.FAKE_AGY_RECORD,
    `${JSON.stringify({ argv, cwd: process.cwd(), stdin, prompt }, null, 2)}\n`,
    "utf8"
  );
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const mode = process.env.FAKE_AGY_MODE ?? "success";
if (mode === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

if (mode === "failure") {
  process.stdout.write(process.env.FAKE_AGY_STDOUT ?? "partial output\n");
  process.stderr.write(process.env.FAKE_AGY_STDERR ?? "fake agy failure\n");
  process.exit(Number(process.env.FAKE_AGY_EXIT ?? 7));
}

process.stderr.write(process.env.FAKE_AGY_STDERR ?? "");
if (process.env.FAKE_AGY_STDOUT !== undefined) {
  process.stdout.write(process.env.FAKE_AGY_STDOUT);
  process.exit(0);
}

const outputFormatIndex = argv.indexOf("--output-format");
const outputFormat = outputFormatIndex === -1 ? "text" : argv[outputFormatIndex + 1];
const response = process.env.FAKE_AGY_RESPONSE ?? "fake response\n";
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  thinking_tokens: 5,
  cache_read_tokens: 40,
  total_tokens: 120
};
const result = {
  conversation_id: process.env.FAKE_AGY_CONVERSATION_ID ?? "fake-conversation-123",
  status: "SUCCESS",
  response,
  duration_seconds: 1.25,
  num_turns: 1,
  usage
};

if (outputFormat === "json") {
  const schemaIndex = argv.indexOf("--json-schema");
  if (schemaIndex !== -1) {
    result.structured_output = JSON.parse(process.env.FAKE_AGY_STRUCTURED_OUTPUT ?? '{"answer":"fake structured"}');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (outputFormat === "stream-json") {
  process.stdout.write(
    `${JSON.stringify({
      event: "init",
      conversation_id: result.conversation_id,
      init: { cwd: process.cwd(), tools: [], permission_mode: "request-review" }
    })}\n`
  );
  if (process.env.FAKE_AGY_STREAM_TOOL === "1") {
    process.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: result.conversation_id,
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          tool_info: { name: "view_file", parameters: {}, output: "ok" },
          subagent_info: { conversation_id: "child-1", log_uri: "file:///fake" }
        }
      })}\n`
    );
  }
  process.stdout.write(`${JSON.stringify({ event: "result", result })}\n`);
} else {
  process.stdout.write(response);
}
