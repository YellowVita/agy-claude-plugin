// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

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
    return `# Antigravity Setup\n\nagy is unavailable.\n\n${result.detail}\n`;
  }
  return [
    "# Antigravity Setup",
    "",
    `Executable: ${result.binary}`,
    `Version: ${result.version}`,
    "Authentication: not probeable through a noninteractive agy subcommand.",
    "If the first task requests authentication, run `! agy` interactively and retry.",
    ""
  ].join("\n");
}

export function renderQueued(job) {
  return [
    "# Antigravity Job Queued",
    "",
    `Job: ${job.id}`,
    `Mode: ${job.mode}`,
    "",
    `Check: /agy:status ${job.id}`,
    `Wait: /agy:status ${job.id} --wait`,
    `Result: /agy:result ${job.id}`,
    `Cancel: /agy:cancel ${job.id}`,
    ""
  ].join("\n");
}

function renderFailure(job, stdout, stderr) {
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
    return String(execution.stdout ?? "");
  }
  return renderFailure(job, execution.stdout, execution.stderr);
}

export function renderStoredResult(job, stdout, stderr) {
  if (job.status === "completed") {
    return stdout ? String(stdout) : `Antigravity job ${job.id} completed without stdout.\n`;
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
  return [
    "# Antigravity Job Status",
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase}`,
    `Mode: ${job.mode}`,
    `Scope: ${job.background ? "background" : "foreground"}`,
    `Time: ${formatDuration(job)}`,
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
