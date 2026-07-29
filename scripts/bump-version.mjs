#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  ["package.json", [["version"]]],
  ["package-lock.json", [["version"], ["packages", "", "version"]]],
  ["plugins/agy/.claude-plugin/plugin.json", [["version"]]],
  [".claude-plugin/marketplace.json", [["metadata", "version"], ["plugins", 0, "version"]]]
];

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function getAtPath(value, keys) {
  return keys.reduce((current, key) => current?.[key], value);
}

function setAtPath(value, keys, version) {
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!current?.[key] || typeof current[key] !== "object") {
      throw new Error(`Missing version container at ${keys.join(".")}.`);
    }
    current = current[key];
  }
  current[keys.at(-1)] = version;
}

function parseArgs(argv) {
  const options = { check: false, root: process.cwd(), version: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      options.root = argv[++index];
      if (!options.root) {
        throw new Error("--root requires a directory.");
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }
  options.root = path.resolve(options.root);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageVersion = readJson(options.root, "package.json").version;
  const version = options.version ?? (options.check ? packageVersion : null);
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error("Provide a semantic version such as 0.3.0.");
  }

  const mismatches = [];
  const changed = [];
  for (const [file, paths] of TARGETS) {
    const json = readJson(options.root, file);
    if (options.check) {
      for (const keys of paths) {
        const actual = getAtPath(json, keys);
        if (actual !== version) {
          mismatches.push(`${file} ${keys.join(".")}: expected ${version}, found ${actual ?? "<missing>"}`);
        }
      }
      continue;
    }
    const before = JSON.stringify(json);
    for (const keys of paths) {
      setAtPath(json, keys, version);
    }
    if (JSON.stringify(json) !== before) {
      fs.writeFileSync(path.join(options.root, file), `${JSON.stringify(json, null, 2)}\n`);
      changed.push(file);
    }
  }
  if (mismatches.length) {
    throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
  }
  process.stdout.write(
    options.check
      ? `All version metadata matches ${version}.\n`
      : `Set version metadata to ${version}: ${changed.join(", ") || "no files changed"}.\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
