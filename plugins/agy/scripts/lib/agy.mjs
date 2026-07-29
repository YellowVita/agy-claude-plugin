import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { formatCommandFailure, runCommand, runCommandStreaming } from "./process.mjs";
import {
  createStreamJsonCollector,
  createStructuredFailureOutput,
  parseStructuredOutput,
  validateOutputFormat
} from "./structured-output.mjs";
import { resolveDirectory } from "./workspace.mjs";

const DEFAULT_PRINT_TIMEOUT = "5m0s";
const DEFAULT_OUTPUT_FORMAT = "json";
const OUTER_TIMEOUT_GRACE_MS = 30_000;
const VALID_EFFORTS = new Set(["low", "medium", "high"]);
const MINIMUM_AGY_VERSION = [1, 1, 8];
const REQUIRED_HELP_FEATURES = [
  { name: "json output", pattern: /--output-format[\s\S]*(?:json|stream-json)/i },
  { name: "stream-json output", pattern: /stream-json/i },
  { name: "JSON schema validation", pattern: /--json-schema/i }
];

function isSupportedAgyVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MINIMUM_AGY_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_AGY_VERSION[index]) {
      return true;
    }
    if (actual[index] < MINIMUM_AGY_VERSION[index]) {
      return false;
    }
  }
  return true;
}

function executableNames(platform) {
  return platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"];
}

function resolveExecutableCandidate(candidate, platform) {
  const absolute = path.resolve(candidate);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      return null;
    }
    fs.accessSync(absolute, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    try {
      return fs.realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  } catch {
    return null;
  }
}

export function resolveAgyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.AGY_PATH) {
    if (!path.isAbsolute(env.AGY_PATH)) {
      throw new Error("AGY_PATH must be an absolute executable path.");
    }
    const resolved = resolveExecutableCandidate(env.AGY_PATH, platform);
    if (!resolved) {
      throw new Error(`AGY_PATH is not an executable file: ${env.AGY_PATH}`);
    }
    return resolved;
  }

  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of executableNames(platform)) {
      const resolved = resolveExecutableCandidate(path.join(directory, name), platform);
      if (resolved) {
        return resolved;
      }
    }
  }
  throw new Error("The agy executable was not found. Install Antigravity, add agy to PATH, or set AGY_PATH.");
}

export function parseDurationMs(value) {
  const source = String(value ?? "").trim();
  if (!source) {
    throw new Error("Print timeout cannot be empty.");
  }

  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = "";
  let match;
  while ((match = pattern.exec(source)) !== null) {
    consumed += match[0];
    total += Number(match[1]) * units[match[2]];
  }
  if (consumed !== source || !Number.isFinite(total) || total <= 0) {
    throw new Error(`Invalid duration "${source}". Use values such as 30s, 5m0s, or 1h.`);
  }
  return Math.ceil(total);
}

function normalizeExtraDirectories(cwd, values = []) {
  return values.map((value) => resolveDirectory(path.resolve(cwd, value)));
}

function normalizeJsonSchema(cwd, value) {
  if (value === null || value === undefined) {
    return null;
  }
  const source = String(value).trim();
  if (!source) {
    throw new Error("JSON schema cannot be empty.");
  }
  if (source.startsWith("{") || source.startsWith("[")) {
    try {
      JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid inline JSON schema: ${error.message}`);
    }
    return source;
  }

  const schemaPath = path.resolve(cwd, source);
  let contents;
  try {
    const stat = fs.statSync(schemaPath);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    contents = fs.readFileSync(schemaPath, "utf8");
  } catch (error) {
    throw new Error(`JSON schema file is not readable: ${schemaPath} (${error.message})`);
  }
  try {
    JSON.parse(contents);
  } catch (error) {
    throw new Error(`JSON schema file is invalid JSON: ${schemaPath} (${error.message})`);
  }
  return schemaPath;
}

export function buildAgyArgs(request) {
  const printTimeout = request.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
  parseDurationMs(printTimeout);
  const outputFormat = validateOutputFormat(request.outputFormat ?? DEFAULT_OUTPUT_FORMAT);
  const jsonSchema = normalizeJsonSchema(request.cwd, request.jsonSchema);

  if (!new Set(["safe", "write", "full-access"]).has(request.mode)) {
    throw new Error(`Unknown Antigravity permission mode: ${request.mode}`);
  }
  if (request.mode === "full-access" && !request.fullAccessConfirmed) {
    throw new Error("Full access requires direct user confirmation.");
  }
  if (request.effort && !VALID_EFFORTS.has(request.effort)) {
    throw new Error(`Unsupported effort "${request.effort}". Use low, medium, or high.`);
  }
  if (request.continueLatest && request.conversation) {
    throw new Error("Choose either --continue or --conversation, not both.");
  }
  if (request.project && request.newProject) {
    throw new Error("Choose either --project or --new-project, not both.");
  }
  if (jsonSchema && outputFormat === "text") {
    throw new Error("--json-schema requires --output-format json or stream-json.");
  }

  const args = ["--print-timeout", printTimeout, "--output-format", outputFormat];
  if (jsonSchema) {
    args.push("--json-schema", jsonSchema);
  }
  if (request.mode === "safe") {
    args.push("--mode", "plan", "--sandbox");
  } else if (request.mode === "write") {
    args.push("--mode", "accept-edits", "--sandbox");
  } else {
    args.push("--mode", "accept-edits", "--dangerously-skip-permissions");
  }

  if (request.continueLatest) {
    args.push("-c");
  } else if (request.conversation) {
    args.push("--conversation", request.conversation);
  }
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.agent) {
    args.push("--agent", request.agent);
  }
  if (request.effort) {
    args.push("--effort", request.effort);
  }
  for (const directory of normalizeExtraDirectories(request.cwd, request.addDirs)) {
    args.push("--add-dir", directory);
  }
  if (request.project) {
    args.push("--project", request.project);
  } else if (request.newProject) {
    args.push("--new-project");
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new Error("Antigravity requires a non-empty prompt.");
  }
  args.push("-p", request.prompt);
  return args;
}

export function probeAgy(options = {}) {
  try {
    const binary = resolveAgyBinary(options);
    const result = runCommand(binary, ["--version"], {
      env: options.env ?? process.env,
      timeout: 10_000
    });
    if (result.error || result.status !== 0) {
      return {
        available: false,
        binary,
        detail: formatCommandFailure(result)
      };
    }
    const version = result.stdout.trim() || result.stderr.trim() || "unknown";
    if (!isSupportedAgyVersion(version)) {
      return {
        available: false,
        binary,
        detail: `agy 1.1.8 or newer is required; found ${version}.`
      };
    }
    const help = runCommand(binary, ["--help"], {
      env: options.env ?? process.env,
      timeout: 10_000
    });
    if (help.error || help.status !== 0) {
      return {
        available: false,
        binary,
        version,
        detail: `Could not inspect required agy features: ${formatCommandFailure(help)}`
      };
    }
    const helpText = `${help.stdout}\n${help.stderr}`;
    const capabilities = Object.fromEntries(
      REQUIRED_HELP_FEATURES.map((feature) => [feature.name, feature.pattern.test(helpText)])
    );
    const missing = Object.entries(capabilities)
      .filter(([, supported]) => !supported)
      .map(([name]) => name);
    if (missing.length) {
      return {
        available: false,
        binary,
        version,
        capabilities,
        detail: `The installed agy lacks required features: ${missing.join(", ")}. Update agy and retry.`
      };
    }
    return { available: true, binary, version, capabilities };
  } catch (error) {
    return {
      available: false,
      binary: null,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function executeAgyTask(request, options = {}) {
  const env = options.env ?? process.env;
  const binary = resolveAgyBinary({ env });
  const args = buildAgyArgs(request);
  const outputFormat = validateOutputFormat(request.outputFormat ?? DEFAULT_OUTPUT_FORMAT);
  const printTimeoutMs = parseDurationMs(request.printTimeout ?? DEFAULT_PRINT_TIMEOUT);
  let stderrTail = "";
  const appendStderrTail = (chunk) => {
    stderrTail += chunk;
    if (Buffer.byteLength(stderrTail, "utf8") > 64 * 1024) {
      stderrTail = stderrTail.slice(-64 * 1024);
    }
    options.onStderr?.(chunk);
  };
  const streamCollector =
    outputFormat === "stream-json"
      ? createStreamJsonCollector({
          deferTerminal: true,
          onEventLine: (line) => options.onStdout?.(line),
          onProgress: options.onProgress
        })
      : null;
  const result = await runCommandStreaming(binary, args, {
    cwd: request.cwd,
    env,
    timeout: printTimeoutMs + OUTER_TIMEOUT_GRACE_MS,
    maxBuffer: 32 * 1024 * 1024,
    captureStdout: outputFormat !== "stream-json",
    captureStderr: outputFormat !== "stream-json",
    onStdout: streamCollector ? (chunk) => streamCollector.push(chunk) : options.onStdout,
    onStderr: outputFormat === "stream-json" ? appendStderrTail : options.onStderr
  });

  let errorMessage = result.error ? `agy execution failed: ${result.error.message}` : null;
  let structured = null;
  let stdout = result.stdout;
  const stderr = outputFormat === "stream-json" ? stderrTail : result.stderr;

  if (outputFormat === "stream-json") {
    try {
      structured = streamCollector.finish();
    } catch (error) {
      errorMessage ??= error instanceof Error ? error.message : String(error);
    }
    if (structured?.remoteStatus && structured.remoteStatus !== "SUCCESS") {
      errorMessage ??= `agy returned terminal status ${structured.remoteStatus}.`;
    }
    if (result.status !== 0 && !errorMessage) {
      errorMessage = `agy exited with status ${result.status ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}.`;
    }
    let terminalOutput = streamCollector.terminalLine();
    if (errorMessage && (!structured || structured.remoteStatus === "SUCCESS")) {
      terminalOutput = createStructuredFailureOutput("stream-json", {
        message: errorMessage,
        conversationId: streamCollector.snapshot().conversationId,
        exitStatus: result.status,
        signal: result.signal
      });
      structured = parseStructuredOutput("stream-json", terminalOutput);
    }
    if (terminalOutput) {
      options.onStdout?.(terminalOutput);
    }
  } else if (outputFormat === "json") {
    let parseError = null;
    if (stdout.trim()) {
      try {
        structured = parseStructuredOutput("json", stdout);
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      parseError = new Error("agy returned empty JSON output.");
    }
    if (result.status === 0 && parseError) {
      errorMessage ??= parseError.message;
    }
    if (structured?.remoteStatus && structured.remoteStatus !== "SUCCESS") {
      errorMessage ??= `agy returned terminal status ${structured.remoteStatus}.`;
    }
    if (request.outputFormatExplicit && (parseError || !stdout.trim())) {
      errorMessage ??=
        result.status !== 0
          ? `agy exited with status ${result.status ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}.`
          : parseError?.message;
      stdout = createStructuredFailureOutput("json", {
        message: errorMessage,
        exitStatus: result.status,
        signal: result.signal,
        rawOutput: result.stdout
      });
      structured = parseStructuredOutput("json", stdout);
    }
  }

  return {
    binary,
    exitStatus: result.status && result.status !== 0 ? result.status : errorMessage ? 1 : (result.status ?? 1),
    signal: result.signal,
    stdout,
    stderr,
    errorMessage,
    structured,
    stdoutPersisted: outputFormat === "stream-json",
    stderrPersisted: outputFormat === "stream-json" && Boolean(options.onStderr)
  };
}
