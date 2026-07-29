// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import { parseStructuredOutput, renderSuccessfulOutput } from "./structured-output.mjs";

function escapeCell(value) {
  return String(value ?? "-").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatDuration(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = Date.parse(job.completedAt ?? "") || Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${remainder}s`;
  }
  return `${remainder}s`;
}

export function renderSetup(result) {
  if (!result.available) {
    return [
      "# Antigravity Setup",
      "",
      "agy is unavailable or incompatible.",
      "",
      result.detail,
      result.version ? `Detected version: ${result.version}` : null,
      result.stateDirectory ? `State: ${result.stateDirectory} (${result.stateWritable ? "writable" : "not writable"})` : null,
      ""
    ]
      .filter((line) => line !== null)
      .join("\n");
  }
  const capabilities = Object.entries(result.capabilities ?? {})
    .map(([name, enabled]) => `${name}=${enabled ? "yes" : "no"}`)
    .join(", ");
  return [
    "# Antigravity Setup",
    "",
    ...(result.actions ?? []),
    ...(result.actions?.length ? [""] : []),
    `Executable: ${result.binary}`,
    `Version: ${result.version}`,
    `Required features: ${capabilities || "verified"}`,
    `State: ${result.stateDirectory ?? "unavailable"} (${result.stateWritable ? "writable" : "not writable"})`,
    `Stop review gate: ${result.reviewGateEnabled ? "enabled (experimental)" : "disabled"}`,
    "Authentication: not probeable through a noninteractive agy subcommand.",
    "If authentication is required, run `agy` in a terminal with an interactive TTY and retry.",
    "If Claude Code's `! agy` reports `/dev/tty` unavailable, run `agy` in a separate terminal window.",
    ""
  ].join("\n");
}

export function renderQueued(job) {
  const title = job.kind === "review" ? "Antigravity Review Queued" : "Antigravity Job Queued";
  return [
    `# ${title}`,
    "",
    `Job: ${job.id}`,
    `Mode: ${job.mode}`,
    `Output: ${job.outputFormat}`,
    "",
    `Check: /agy:status ${job.id}`,
    `Wait: /agy:status ${job.id} --wait`,
    `Result: /agy:result ${job.id}`,
    `Cancel: /agy:cancel ${job.id}`,
    ""
  ].join("\n");
}

function isReviewResult(value) {
  return (
    value &&
    typeof value === "object" &&
    ["approve", "needs-attention"].includes(value.verdict) &&
    typeof value.summary === "string" &&
    Array.isArray(value.findings) &&
    Array.isArray(value.next_steps)
  );
}

export function renderReviewResult(job, value) {
  const title = job.reviewKind === "adversarial" ? "Antigravity Adversarial Review" : "Antigravity Review";
  if (!isReviewResult(value)) {
    return [
      `# ${title}`,
      "",
      `Target: ${job.reviewTarget ?? "-"}`,
      "",
      "Antigravity returned structured output with an unexpected review shape.",
      "",
      "## Raw structured output",
      "",
      "```json",
      JSON.stringify(value ?? null, null, 2),
      "```",
      ""
    ].join("\n");
  }

  const lines = [
    `# ${title}`,
    "",
    `Target: ${job.reviewTarget ?? "-"}`,
    `Verdict: ${value.verdict}`,
    "",
    value.summary.trim(),
    "",
    "## Findings",
    ""
  ];
  if (value.findings.length === 0) {
    lines.push("No actionable findings.", "");
  } else {
    for (const finding of value.findings) {
      const location =
        finding.file && Number.isInteger(finding.line_start)
          ? `${finding.file}:${finding.line_start}${finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}`
          : finding.file ?? "unknown location";
      const confidence = Number.isFinite(finding.confidence)
        ? `, ${Math.round(finding.confidence * 100)}% confidence`
        : "";
      lines.push(
        `### [${String(finding.severity ?? "unknown").toUpperCase()}] ${finding.title ?? "Untitled finding"}`,
        "",
        `Location: ${location}${confidence}`,
        "",
        String(finding.body ?? "").trim(),
        "",
        finding.recommendation ? `Recommendation: ${String(finding.recommendation).trim()}` : "",
        ""
      );
    }
  }
  if (value.next_steps.length) {
    lines.push("## Next steps", "");
    for (const step of value.next_steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  if (job.conversationId) {
    lines.push(`Conversation: ${job.conversationId}`, `Continue: /agy:continue --job ${job.id} -- <follow-up>`, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function renderFailure(job, stdout, stderr) {
  const lines = [
    "# Antigravity Task Failed",
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Mode: ${job.mode}`,
    `Exit: ${job.exitStatus ?? "unknown"}${job.signal ? ` (${job.signal})` : ""}`
  ];
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  }
  if (stderr) {
    lines.push("", "## stderr", "", String(stderr).trimEnd());
  }
  if (stdout) {
    lines.push("", "## partial stdout", "", String(stdout).trimEnd());
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderExecution(job, execution) {
  if (job.status === "completed") {
    if (execution.stdoutStreamed) {
      return "";
    }
    if (job.kind === "review") {
      return renderReviewResult(job, execution.structured?.structuredOutput);
    }
    return renderSuccessfulOutput(job, execution.stdout, execution.structured);
  }
  return renderFailure(job, execution.stdoutStreamed ? "" : execution.stdout, execution.stderr);
}

export function renderStoredResult(job, stdout, stderr) {
  if (job.status === "completed") {
    if (job.kind === "review") {
      const structured = parseStructuredOutput(job.outputFormat ?? "json", stdout);
      return renderReviewResult(job, structured?.structuredOutput);
    }
    return stdout ? renderSuccessfulOutput(job, stdout) : `Antigravity job ${job.id} completed without stdout.\n`;
  }
  if (job.status === "cancelled") {
    return [
      "# Antigravity Task Cancelled",
      "",
      `Job: ${job.id}`,
      `Mode: ${job.mode}`,
      stderr ? `\n${String(stderr).trimEnd()}` : "",
      ""
    ].join("\n");
  }
  return renderFailure(job, stdout, stderr);
}

export function renderStatus(snapshot) {
  const lines = [
    "# Antigravity Plugin Status",
    "",
    `Workspace: ${snapshot.workspaceRoot}`,
    "Status is based on plugin-local processes and files, not an Antigravity server API.",
    ""
  ];
  if (!snapshot.jobs.length) {
    lines.push("No local Antigravity jobs are recorded.", "");
    return lines.join("\n");
  }
  lines.push("| Job | Status | Mode | Scope | Time |", "|---|---|---|---|---|");
  for (const job of snapshot.jobs) {
    lines.push(
      `| ${escapeCell(job.id)} | ${escapeCell(job.status)} | ${escapeCell(job.mode)} | ${job.background ? "background" : "foreground"} | ${formatDuration(job)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderSingleStatus(snapshot) {
  const job = snapshot.job;
  const usage = job.usage;
  const usageText = usage
    ? `${usage.total_tokens ?? "-"} total, ${usage.cache_read_tokens ?? 0} cache-read`
    : "-";
  const latestStep = job.recentSteps?.at?.(-1);
  const childSummary = Array.isArray(job.subagents)
    ? job.subagents.map((child) => child.conversationId).filter(Boolean).join(", ")
    : "";
  return [
    "# Antigravity Job Status",
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Mode: ${job.mode}`,
    `Output: ${job.outputFormat ?? "text"}`,
    `Scope: ${job.background ? "background" : "foreground"}`,
    `Time: ${formatDuration(job)}`,
    `Conversation: ${job.conversationId ?? "-"}`,
    `Usage: ${usageText}`,
    `Tool calls: ${job.toolCallCount ?? 0}`,
    `Subagents: ${job.subagentCount ?? 0}`,
    latestStep ? `Latest step: ${latestStep.stepType ?? "-"} / ${latestStep.state ?? "-"}` : null,
    childSummary ? `Child conversations: ${childSummary}` : null,
    job.errorMessage ? `Error: ${job.errorMessage}` : null,
    `Log: ${job.logFile}`,
    ""
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function renderCancel(job, outcome) {
  return [
    "# Antigravity Job Cancelled",
    "",
    `Job: ${job.id}`,
    `Signal method: ${outcome.method ?? "none"}`,
    `Signal delivered: ${outcome.delivered ? "yes" : "process already stopped"}`,
    "",
    `Check: /agy:status ${job.id}`,
    ""
  ].join("\n");
}
