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
      return directory;
    }
  }
  return directory;
}
