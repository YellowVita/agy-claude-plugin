// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

export function resolveDirectory(value = process.cwd()) {
  const absolute = path.resolve(value || process.cwd());
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absolute}`);
  }
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function findGitMetadataRoot(directory) {
  let candidate = directory;
  while (true) {
    try {
      const metadataPath = path.join(candidate, ".git");
      const stat = fs.lstatSync(metadataPath);
      if (stat.isDirectory() && fs.statSync(path.join(metadataPath, "HEAD")).isFile()) {
        return candidate;
      }
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(metadataPath, "utf8"));
        if (match) {
          const gitDirectory = path.resolve(candidate, match[1]);
          if (
            fs.statSync(gitDirectory).isDirectory() &&
            fs.statSync(path.join(gitDirectory, "HEAD")).isFile()
          ) {
            return candidate;
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        return null;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

export function resolveWorkspaceRoot(cwd) {
  const directory = resolveDirectory(cwd);
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    timeout: 10_000
  });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    try {
      return resolveDirectory(result.stdout.trim());
    } catch {
      return findGitMetadataRoot(directory) ?? directory;
    }
  }
  return findGitMetadataRoot(directory) ?? directory;
}
