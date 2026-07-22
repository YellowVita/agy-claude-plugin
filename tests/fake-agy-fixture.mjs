#!/usr/bin/env node

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("agy 1.1.5-fake\n");
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
process.stdout.write(process.env.FAKE_AGY_STDOUT ?? "fake response\n");
