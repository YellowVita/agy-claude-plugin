// SPDX-License-Identifier: Apache-2.0

const VALID_OUTPUT_FORMATS = new Set(["text", "json", "stream-json"]);

export function validateOutputFormat(value) {
  const format = String(value ?? "").trim();
  if (!VALID_OUTPUT_FORMATS.has(format)) {
    throw new Error(`Unsupported output format "${format}". Use text, json, or stream-json.`);
  }
  return format;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`agy returned invalid ${label}: ${error.message}`);
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const keys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
  return Object.fromEntries(
    keys
      .filter((key) => Number.isFinite(usage[key]))
      .map((key) => [key, Number(usage[key])])
  );
}

function summarizePayload(payload, extra = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("agy structured output did not contain a result object.");
  }
  if (typeof payload.status !== "string" || !payload.status) {
    throw new Error("agy structured output did not contain a terminal status.");
  }
  if (typeof payload.response !== "string" && payload.structured_output === undefined) {
    throw new Error("agy structured output did not contain response or structured_output.");
  }
  return {
    payload,
    response: typeof payload.response === "string" ? payload.response : "",
    structuredOutput: payload.structured_output,
    conversationId: typeof payload.conversation_id === "string" ? payload.conversation_id : null,
    remoteStatus: typeof payload.status === "string" ? payload.status : null,
    durationSeconds: Number.isFinite(payload.duration_seconds) ? Number(payload.duration_seconds) : null,
    numTurns: Number.isFinite(payload.num_turns) ? Number(payload.num_turns) : null,
    usage: normalizeUsage(payload.usage),
    toolCallCount: extra.toolCallCount ?? 0,
    subagentCount: extra.subagentCount ?? 0,
    recentSteps: extra.recentSteps ?? [],
    subagents: extra.subagents ?? []
  };
}

function observeStreamEvent(state, event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event !== "string") {
    throw new Error("agy stream-json line did not contain an event object.");
  }
  if (typeof event.conversation_id === "string") {
    state.conversationId = event.conversation_id;
  }
  const update = event.step_update;
  if (!state.conversationId && typeof update?.conversation_id === "string") {
    state.conversationId = update.conversation_id;
  }
  const updateConversationId =
    typeof update?.conversation_id === "string" ? update.conversation_id : state.conversationId;
  if (update?.tool_info) {
    const toolKey = Number.isFinite(update.step_index)
      ? `${updateConversationId ?? "unknown"}:step:${update.step_index}`
      : `tool:${state.lineNumber}`;
    if (!state.toolKeys.has(toolKey)) {
      state.toolKeys.add(toolKey);
      state.toolCallCount += 1;
    }
  }
  if (update?.subagent_info) {
    const conversationId = update.subagent_info.conversation_id ?? null;
    const logUri = update.subagent_info.log_uri ?? null;
    const existing = state.subagents.find(
      (entry) =>
        (conversationId && entry.conversationId === conversationId) ||
        (!conversationId && logUri && entry.logUri === logUri)
    );
    const summary = {
      conversationId,
      logUri
    };
    if (existing) {
      Object.assign(existing, summary);
    } else {
      state.subagents.push(summary);
      state.subagents = state.subagents.slice(-20);
    }
    state.subagentCount = state.subagents.length;
  }
  if (update) {
    state.phase = String(update.state ?? "step").toLowerCase();
    const step = {
      stepIndex: Number.isFinite(update.step_index) ? Number(update.step_index) : null,
      conversationId: updateConversationId ?? null,
      state: typeof update.state === "string" ? update.state : null,
      stepType: typeof update.step_type === "string" ? update.step_type : null,
      toolName:
        update.tool_info?.canonical_name ??
        update.tool_info?.canonical_tool_name ??
        update.tool_info?.name ??
        null,
      subagentConversationId: update.subagent_info?.conversation_id ?? null
    };
    const existingStepIndex =
      step.stepIndex === null
        ? -1
        : state.recentSteps.findIndex(
            (candidate) =>
              candidate.conversationId === step.conversationId &&
              candidate.stepIndex === step.stepIndex
          );
    if (existingStepIndex >= 0) {
      state.recentSteps[existingStepIndex] = step;
    } else {
      state.recentSteps.push(step);
    }
    state.recentSteps = state.recentSteps.slice(-20);
  }
  if (event.event === "result") {
    state.phase = "done";
    state.terminal = event.result;
    if (typeof event.result?.conversation_id === "string") {
      state.conversationId = event.result.conversation_id;
    }
  }
}

function snapshotState(state) {
  return {
    phase: state.phase,
    conversationId: state.conversationId,
    hasTerminal: Boolean(state.terminal),
    terminal: state.terminal,
    toolCallCount: state.toolCallCount,
    subagentCount: state.subagentCount,
    recentSteps: state.recentSteps.map((step) => ({ ...step })),
    subagents: state.subagents.map((subagent) => ({ ...subagent }))
  };
}

export function createStreamJsonCollector(options = {}) {
  const maxLineBytes = options.maxLineBytes ?? 32 * 1024 * 1024;
  const state = {
    buffer: "",
    lineNumber: 0,
    terminal: null,
    terminalLine: null,
    conversationId: null,
    toolCallCount: 0,
    subagentCount: 0,
    phase: "initializing",
    recentSteps: [],
    subagents: [],
    toolKeys: new Set()
  };

  const processLine = (line) => {
    state.lineNumber += 1;
    if (!line.trim()) {
      return;
    }
    if (state.terminal) {
      throw new Error("agy stream-json output contained an event after its terminal result.");
    }
    const event = parseJson(line, `stream-json event on line ${state.lineNumber}`);
    observeStreamEvent(state, event);
    const normalizedLine = `${line}\n`;
    if (event.event === "result") {
      state.terminalLine = normalizedLine;
      if (!options.deferTerminal) {
        options.onEventLine?.(normalizedLine, event);
        options.onProgress?.(snapshotState(state), event);
      }
      return;
    }
    options.onEventLine?.(normalizedLine, event);
    options.onProgress?.(snapshotState(state), event);
  };

  return {
    push(chunk) {
      state.buffer += String(chunk ?? "");
      while (true) {
        const newline = state.buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = state.buffer.slice(0, newline).replace(/\r$/, "");
        state.buffer = state.buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
          throw new Error(`agy stream-json event exceeded ${maxLineBytes} bytes.`);
        }
        processLine(line);
      }
      if (Buffer.byteLength(state.buffer, "utf8") > maxLineBytes) {
        throw new Error(`agy stream-json event exceeded ${maxLineBytes} bytes.`);
      }
    },
    finish() {
      if (state.buffer) {
        processLine(state.buffer.replace(/\r$/, ""));
        state.buffer = "";
      }
      if (!state.terminal) {
        throw new Error("agy stream-json output did not contain a terminal result event.");
      }
      return summarizePayload(state.terminal, {
        toolCallCount: state.toolCallCount,
        subagentCount: state.subagentCount,
        recentSteps: state.recentSteps,
        subagents: state.subagents
      });
    },
    snapshot() {
      return snapshotState(state);
    },
    terminalLine() {
      return state.terminalLine;
    }
  };
}

export function parseStructuredOutput(format, stdout) {
  const normalized = validateOutputFormat(format);
  if (normalized === "text") {
    return null;
  }

  if (normalized === "json") {
    return summarizePayload(parseJson(String(stdout ?? "").trim(), "JSON output"));
  }

  const collector = createStreamJsonCollector();
  collector.push(stdout);
  return collector.finish();
}

export function createStructuredFailureOutput(format, details = {}) {
  const result = {
    conversation_id: details.conversationId ?? null,
    status: "FAILED",
    response: "",
    duration_seconds: details.durationSeconds ?? 0,
    num_turns: details.numTurns ?? 0,
    error: {
      source: "agy-companion",
      message: details.message ?? "Antigravity task failed.",
      exit_status: details.exitStatus ?? null,
      signal: details.signal ?? null
    },
    usage: details.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0
    }
  };
  if (details.rawOutput) {
    const rawOutput = String(details.rawOutput);
    result.error.raw_output = rawOutput.slice(0, 4_096);
    if (rawOutput.length > 4_096) {
      result.error.raw_output_truncated = true;
    }
  }
  if (format === "stream-json") {
    return `${JSON.stringify({ event: "result", result })}\n`;
  }
  return `${JSON.stringify(result)}\n`;
}

function formatStructuredValue(value) {
  if (typeof value === "string") {
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderSuccessfulOutput(job, stdout, parsed = null) {
  const outputFormat = job.outputFormat ?? "text";
  if (outputFormat === "text" || job.outputFormatExplicit || outputFormat === "stream-json") {
    return String(stdout ?? "");
  }
  const structured = parsed ?? parseStructuredOutput(outputFormat, stdout);
  if (job.jsonSchemaRequested) {
    if (structured.structuredOutput === undefined) {
      throw new Error("agy JSON output did not contain structured_output for the requested schema.");
    }
    return formatStructuredValue(structured.structuredOutput);
  }
  return structured.response;
}
