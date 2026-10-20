#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Thin wrapper that runs one headless Antigravity (`agy`) turn and prints a
// compact result for Claude Code. Async execution and cancellation are left to
// the caller (Bash run_in_background / TaskStop); this script only forwards
// signals so that stopping it also stops agy's process tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const USAGE = `Usage:
  node agy-task.mjs [options] [--] <prompt...>
  node agy-task.mjs [options] --prompt-file <path>   (use "-" to read stdin)
  node agy-task.mjs --check

Runs one headless agy turn (agy --output-format json --disable-slash-commands -p <prompt>).
Options end at the first prompt word or at "--".

Options:
  --mode read|write|auto  read (default): agy default mode plus a read-only instruction in the prompt;
                          requested, not enforced: agy's own permission settings decide
                          write: --mode accept-edits; auto: --mode auto
  --no-sandbox            do not pass --sandbox (sandbox is on by default)
  --conversation <id>     follow up in an existing agy conversation
  --model <model>         agy model id (see: agy models)
  --effort <level>        reasoning effort: low|medium|high|xhigh|max (model-dependent)
  --agent <name>          agy agent to use
  --add-dir <path>        add a workspace directory (repeatable)
  --json-schema <schema>  JSON schema file path or inline JSON (root must be "type":"object")
  --timeout <duration>    agy --print-timeout, e.g. 10m (default: unlimited)
  --cwd <dir>             working directory for agy (default: current directory)
  --prompt-file <path>    read the prompt from a file ("-" = stdin)
  --raw                   print agy's JSON output verbatim
  --check                 check that agy is installed, recent enough (>= 1.4.0) and signed in
  -h, --help              show this help

Relative --add-dir, --json-schema and --prompt-file paths resolve against --cwd when it is
given, otherwise against the current directory; --cwd resolves against the current directory.

Exit codes:
  0            success
  1            agy rejected its arguments (agy exit 1)
  2            usage error (wrapper or agy)
  3            agy runtime error: non-SUCCESS status, missing structured output,
               unexpected exit code or unparseable output
  4            partial response: --timeout expired
  126          agy could not be started
  127          agy not found
  129/130/143  interrupted by SIGHUP/SIGINT/SIGTERM (agy's process tree is stopped)
  --check exits 0 when ready and 1 otherwise.
Environment: AGY_BIN overrides the agy executable.`;

const VALUE_OPTIONS = new Set([
  "--mode", "--conversation", "--model", "--effort", "--agent", "--add-dir",
  "--json-schema", "--timeout", "--cwd", "--prompt-file"
]);
const MODES = { read: [], write: ["--mode", "accept-edits"], auto: ["--mode", "auto"] };
const IS_WINDOWS = process.platform === "win32";
const MAX_PROMPT_BYTES = (IS_WINDOWS ? 30 : 100) * 1024;
const READ_GUARD =
  "Read-only task: do not create, modify, or delete files, and do not run commands that change state " +
  "(installs, git commit/checkout/reset, writes to network services). Only read and analyze, then answer.\n\n";
const MIN_AGY_VERSION = [1, 4, 0];
const TIMEOUT_PATTERN = /time[\s_-]?out|timed[\s_-]?out|deadline/i;
const ERROR_STATUS_PATTERN = /error|fail/i;
const NOTEWORTHY_STDERR = /warn|error|denied|refus/i;
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const KILL_GRACE_MS = 5_000;
const DRAIN_GRACE_MS = 2_000;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { mode: "read", sandbox: true, addDirs: [], raw: false, check: false, help: false, words: [] };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (name === "-h" || name === "--help") opts.help = true;
    else if (name === "--no-sandbox") opts.sandbox = false;
    else if (name === "--raw") opts.raw = true;
    else if (name === "--check") opts.check = true;
    else if (VALUE_OPTIONS.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[(index += 1)];
      if (value === undefined || value === "") throw new UsageError(`${name} requires a value.`);
      const key = name.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === "addDir") opts.addDirs.push(value);
      else opts[key] = value;
    } else {
      throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  opts.words = argv.slice(index);
  if (!Object.hasOwn(MODES, opts.mode)) throw new UsageError(`--mode must be read, write, or auto (got "${opts.mode}").`);
  opts.cwd = path.resolve(opts.cwd ?? process.cwd());
  opts.addDirs = opts.addDirs.map((dir) => path.resolve(opts.cwd, dir));
  if (opts.jsonSchema && !opts.jsonSchema.trim().startsWith("{")) opts.jsonSchema = path.resolve(opts.cwd, opts.jsonSchema);
  return opts;
}

function readPrompt(opts) {
  if (opts.promptFile && opts.words.length) throw new UsageError("Pass the prompt either as arguments or with --prompt-file, not both.");
  let prompt = opts.words.join(" ");
  if (opts.promptFile) {
    try {
      prompt = fs.readFileSync(opts.promptFile === "-" ? 0 : path.resolve(opts.cwd, opts.promptFile), "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read --prompt-file ${opts.promptFile}: ${error.message}`);
    }
  }
  if (!prompt.trim()) throw new UsageError("A non-empty prompt is required.");
  // agy settings such as toolPermission "always-proceed" can auto-approve edits, so read mode asks explicitly.
  if (opts.mode === "read") prompt = READ_GUARD + prompt;
  if (prompt.includes("\0")) throw new UsageError("The prompt contains a NUL byte, which cannot be passed as an argument.");
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_PROMPT_BYTES) {
    throw new UsageError(
      `The prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES / 1024} KB limit; ` +
        "put the material in a file and tell agy to read it."
    );
  }
  return prompt;
}

function buildAgyArgs(opts, prompt) {
  const args = ["--output-format", "json", "--disable-slash-commands", ...MODES[opts.mode]];
  if (opts.sandbox) args.push("--sandbox");
  if (opts.conversation) args.push("--conversation", opts.conversation);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.agent) args.push("--agent", opts.agent);
  for (const dir of opts.addDirs) args.push("--add-dir", dir);
  if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);
  if (opts.timeout) args.push("--print-timeout", opts.timeout);
  args.push("-p", prompt); // -p must be last, immediately followed by the prompt.
  return args;
}

function agyBinary() {
  return process.env.AGY_BIN || "agy";
}

function spawnFailure(error) {
  const bin = agyBinary();
  if (error?.code === "ENOENT") {
    return {
      code: 127,
      message: `agy-task: the agy executable was not found (${bin}). Install the Antigravity CLI and make sure ` +
        "`agy` is on PATH (or set AGY_BIN to its full path), then run `agy` once in an interactive terminal to sign in."
    };
  }
  if (IS_WINDOWS && error?.code === "EINVAL") {
    return {
      code: 126,
      message: `agy-task: could not start ${bin}: .cmd/.bat shims are not supported; set AGY_BIN to the full path of agy.exe.`
    };
  }
  return { code: 126, message: `agy-task: could not start ${bin}: ${error?.message ?? error}` };
}

function readSettings() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const file = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { file, error: "not a JSON object" };
    return { file, settings: value };
  } catch (error) {
    return error?.code === "ENOENT" ? { file, settings: {} } : { file, error: error.message };
  }
}

function settingValue(result, key) {
  if (result.error) return "unknown";
  const value = result.settings[key];
  return typeof value === "string" && value ? value : "default";
}

// Strip ANSI sequences and spinner frames so only meaningful stderr lines remain.
function cleanLines(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*[⠀-⣿]/.test(line));
}

function tail(lines, count = 20) {
  return lines.slice(-count).join("\n");
}

function parsePayload(stdout) {
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  try {
    const value = JSON.parse(stdout.trim());
    if (isObject(value)) return value;
  } catch {
    // Fall through to the line-based fallback.
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{")).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (isObject(value)) return value;
    } catch {
      // Try the previous candidate line.
    }
  }
  return null;
}

function parseAgyError(stderrLines) {
  for (const line of [...stderrLines].reverse()) {
    const match = line.match(/AGY_ERROR:\s*(\{.*\})\s*$/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function describeAction(action) {
  if (typeof action === "string") return action;
  if (action && typeof action === "object") {
    const name = action.name ?? action.tool ?? action.tool_name ?? action.action ?? action.type;
    const detail = action.command ?? action.path ?? action.file ?? action.target ?? action.description;
    if (name || detail) return [name, detail].filter(Boolean).join(" ");
  }
  return JSON.stringify(action);
}

function formatDuration(value) {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}s` : "-";
}

function renderResult({ opts, payload, code, signal, stderrLines }) {
  const status = typeof payload.status === "string" ? payload.status : "";
  const agyError = parseAgyError(stderrLines);
  // A --print-timeout expiry exits 0 with a stderr warning; it must never mask a reported error.
  const timedOut = Boolean(opts.timeout) && code === 0 && !ERROR_STATUS_PATTERN.test(status) &&
    stderrLines.some((line) => TIMEOUT_PATTERN.test(line));
  let errorMessage = null;
  if (code !== 0 || (status.toUpperCase() !== "SUCCESS" && !timedOut)) {
    const jsonError = typeof payload.error === "string" ? payload.error : payload.error?.message;
    const stderrError = stderrLines.find((line) => /^error:/i.test(line))?.replace(/^error:\s*/i, "");
    const fallback = signal ? `agy was killed by ${signal}` :
      code !== 0 ? `agy exited with code ${code}` : `agy reported status ${status || "(missing)"}`;
    const details = [`status=${agyError?.status ?? (status || "missing")}`];
    if (typeof agyError?.retryable === "boolean") details.push(`retryable=${agyError.retryable}`);
    errorMessage = `${jsonError || agyError?.short_error || stderrError || fallback} (${details.join(", ")})`;
  }
  const structured = payload.structured_output;
  const hasStructured = structured !== undefined && structured !== null;
  if (!errorMessage && opts.jsonSchema && !hasStructured) {
    errorMessage = "structured output missing: --json-schema was requested but agy returned no structured_output";
  }
  const label = errorMessage ? "ERROR" : timedOut ? "PARTIAL" : "OK";

  const prose = typeof payload.response === "string" ? payload.response.trim() : "";
  const body = opts.jsonSchema && hasStructured ? JSON.stringify(structured, null, 2) : prose;
  const conversation = typeof payload.conversation_id === "string" && payload.conversation_id ? payload.conversation_id : null;
  const lines = body ? [body, ""] : [];
  lines.push(
    "---",
    `[agy] status=${label} conversation=${conversation ?? "-"} turns=${payload.num_turns ?? "-"} ` +
      `duration=${formatDuration(payload.duration_seconds)} mode=${opts.mode} sandbox=${opts.sandbox ? "on" : "off"} ` +
      `permission=${settingValue(readSettings(), "toolPermission")}`
  );
  const denied = Array.isArray(payload.denied_actions) ? payload.denied_actions : [];
  if (denied.length) lines.push(`[agy] denied actions: ${denied.map(describeAction).join(", ")}`);
  if (timedOut) lines.push("[agy] timed out: response is partial");
  if (errorMessage) lines.push(`[agy] error: ${errorMessage}`);
  if (conversation) lines.push(`[agy] continue with: --conversation ${conversation}`);
  return { text: `${lines.join("\n")}\n`, exitCode: errorMessage ? 3 : timedOut ? 4 : 0 };
}

function compareVersions(actual, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] !== minimum[i]) return actual[i] - minimum[i];
  }
  return 0;
}

function runCheck() {
  const bin = agyBinary();
  const spawnOpts = { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
  const notReady = (detail, hint = true) => {
    process.stdout.write(`ready: no\ndetail: ${detail}\n`);
    if (hint) process.stdout.write("hint: run `agy` once in an interactive terminal to sign in, then retry --check.\n");
    return 1;
  };
  const version = spawnSync(bin, ["--version"], spawnOpts);
  if (version.error) return notReady(spawnFailure(version.error).message.replace(/^agy-task: /, ""), false);
  const versionText = (version.stdout || version.stderr).trim() || "unknown";
  process.stdout.write(`agy: ${bin}\nversion: ${versionText}\n`);
  if (version.status !== 0) return notReady(tail(cleanLines(version.stderr), 5) || `agy --version exited with code ${version.status}`, false);
  const match = versionText.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return notReady(`could not parse the agy version "${versionText}"`, false);
  if (compareVersions(match.slice(1, 4).map(Number), MIN_AGY_VERSION) < 0) {
    return notReady(`agy ${MIN_AGY_VERSION.join(".")} or newer is required (found ${match[0]}); update agy with \`agy update\`.`, false);
  }
  const settings = readSettings();
  process.stdout.write(
    `settings: ${settings.file}${settings.error ? ` (unreadable: ${settings.error})` : ""}\n` +
      `toolPermission: ${settingValue(settings, "toolPermission")}\nagentMode: ${settingValue(settings, "agentMode")}\n`
  );
  // agy 1.4.2 only accepts global flags before the subcommand.
  const models = spawnSync(bin, ["--output-format", "json", "models"], spawnOpts);
  const payload = parsePayload(models.stdout ?? "");
  const entries = payload?.status === "SUCCESS" && Array.isArray(payload.command?.data?.models) ? payload.command.data.models : null;
  if (models.status === 0 && entries?.length) {
    const names = entries.map((entry) => entry?.id ?? entry?.name ?? String(entry));
    const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? ", ..." : "");
    process.stdout.write(`models: ${names.length} available (${shown})\nready: yes\n`);
    return 0;
  }
  const reported = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
  return notReady(
    models.error?.message || reported || tail(cleanLines(models.stderr), 5) ||
      (entries ? "agy models returned no models" : `agy models exited with code ${models.status}`)
  );
}

function killTree(child, signal) {
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function runTask(opts, prompt) {
  if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) throw new UsageError(`--cwd is not a directory: ${opts.cwd}`);
  const args = buildAgyArgs(opts, prompt);
  return new Promise((resolve) => {
    let child;
    try {
      // POSIX: own process group so the whole agy tree can be signalled at once.
      child = spawn(agyBinary(), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !IS_WINDOWS });
    } catch (error) {
      const failure = spawnFailure(error);
      process.stderr.write(`${failure.message}\n`);
      resolve(failure.code);
      return;
    }
    let stdout = "";
    let stderr = "";
    let forwarded = null;
    let exitInfo = null;
    let settled = false;
    let drainTimer = null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const signals = Object.keys(SIGNAL_EXIT).filter((s) => !IS_WINDOWS || s !== "SIGHUP");
    const onSignal = (signal) => {
      forwarded ??= signal;
      if (exitInfo) return;
      killTree(child, signal);
      setTimeout(() => !exitInfo && killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    const onExit = () => !exitInfo && child.pid !== undefined && killTree(child, "SIGKILL");
    for (const signal of signals) process.on(signal, onSignal);
    process.on("exit", onExit);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      for (const signal of signals) process.off(signal, onSignal);
      process.off("exit", onExit);
      resolve(result);
    };
    child.on("error", (error) => {
      if (child.pid !== undefined) return; // Runtime errors still end in "exit"/"close".
      const failure = spawnFailure(error);
      process.stderr.write(`${failure.message}\n`);
      settle(failure.code);
    });
    const done = () => !settled && settle(finish({ opts, stdout, stderr, ...exitInfo, forwarded }));
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      if (!IS_WINDOWS) killTree(child, "SIGTERM"); // Do not leave agy's process group behind.
      // A detached grandchild may keep the pipes open; give output a moment to drain, then stop waiting.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done();
      }, DRAIN_GRACE_MS);
    });
    child.on("close", () => exitInfo && done());
  });
}

function finish({ opts, stdout, stderr, code, signal, forwarded }) {
  const stderrLines = cleanLines(stderr);
  if (forwarded) {
    process.stderr.write(`agy-task: interrupted by ${forwarded}; agy was stopped.\n`);
    if (stderrLines.length) process.stderr.write(`${tail(stderrLines)}\n`);
    return SIGNAL_EXIT[forwarded] ?? 130;
  }
  const usageError = code === 1 || code === 2;
  const payload = parsePayload(stdout);
  if (!payload) {
    if (stdout.trim()) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    const reason = signal ? `agy was killed by ${signal}` : `agy exited with code ${code}`;
    process.stderr.write(`agy-task: ${reason} without valid JSON output.\n`);
    if (stderrLines.length) process.stderr.write(`${tail(stderrLines)}\n`);
    return usageError ? code : 3;
  }
  const rendered = renderResult({ opts, payload, code, signal, stderrLines });
  const finalCode = usageError ? code : rendered.exitCode;
  process.stdout.write(opts.raw ? (stdout.endsWith("\n") ? stdout : `${stdout}\n`) : rendered.text);
  // Keep stderr quiet on clean success; surface agy's diagnostics otherwise.
  if (stderrLines.length && (finalCode !== 0 || stderrLines.some((line) => NOTEWORTHY_STDERR.test(line)))) {
    process.stderr.write(`${tail(stderrLines)}\n`);
  }
  return finalCode;
}

async function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (opts.check) return runCheck();
    return await runTask(opts, readPrompt(opts));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`agy-task: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`agy-task: unexpected error: ${error?.message ?? error}\n`);
    return 3;
  }
}

process.exitCode = await main(process.argv.slice(2));
