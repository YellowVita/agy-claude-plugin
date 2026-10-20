#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
//
// Keeps the release version identical in every manifest that carries it.
//
//   node scripts/bump-version.mjs <version>   write <version> to every field
//   node scripts/bump-version.mjs --check     exit 1 if the fields disagree
//
// --root <dir> points the script at another checkout (the tests use this).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Each entry names one version field: the file it lives in, a label for
// messages, and how to read and write it on the parsed JSON.
const FIELDS = [
  {
    file: "package.json",
    label: "version",
    get: (json) => json.version,
    set: (json, version) => { json.version = version; }
  },
  {
    file: "package-lock.json",
    label: "version",
    get: (json) => json.version,
    set: (json, version) => { json.version = version; }
  },
  {
    file: "package-lock.json",
    label: 'packages[""].version',
    get: (json) => json.packages?.[""]?.version,
    set: (json, version) => { json.packages[""].version = version; }
  },
  {
    file: "plugins/agy/.claude-plugin/plugin.json",
    label: "version",
    get: (json) => json.version,
    set: (json, version) => { json.version = version; }
  },
  {
    file: ".claude-plugin/marketplace.json",
    label: "metadata.version",
    get: (json) => json.metadata?.version,
    set: (json, version) => { json.metadata.version = version; }
  },
  {
    file: ".claude-plugin/marketplace.json",
    label: "plugins[agy].version",
    get: (json) => json.plugins?.find((plugin) => plugin.name === "agy")?.version,
    set: (json, version) => { json.plugins.find((plugin) => plugin.name === "agy").version = version; }
  }
];

function usage() {
  return "Usage: bump-version.mjs <version> | --check [--root <dir>]";
}

function parseArgs(args) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let check = false;
  let version;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--root") {
      if (!args[i + 1]) throw new Error("--root needs a directory.");
      root = path.resolve(args[++i]);
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (!arg.startsWith("-") && version === undefined) {
      version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n${usage()}`);
    }
  }
  if (check === (version !== undefined)) {
    throw new Error(usage());
  }
  if (version !== undefined && !SEMVER.test(version)) {
    throw new Error(`Not a semantic version: ${version}`);
  }
  return { root, check, version };
}

function loadFiles(root) {
  const files = new Map();
  for (const { file } of FIELDS) {
    if (!files.has(file)) {
      files.set(file, JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
    }
  }
  return files;
}

function check(root) {
  const files = loadFiles(root);
  const found = FIELDS.map((field) => ({ ...field, value: field.get(files.get(field.file)) }));
  const versions = new Set(found.map((field) => field.value));
  if (versions.size === 1 && found[0].value !== undefined) {
    console.log(`Version ${found[0].value} is consistent across ${found.length} fields.`);
    return 0;
  }
  console.error("Version fields disagree:");
  for (const field of found) {
    console.error(`  ${field.file} ${field.label}: ${field.value ?? "(missing)"}`);
  }
  console.error("Run: npm run bump-version -- <version>");
  return 1;
}

function bump(root, version) {
  const files = loadFiles(root);
  for (const field of FIELDS) {
    field.set(files.get(field.file), version);
  }
  for (const [file, json] of files) {
    fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`Updated ${file}`);
  }
  console.log(`Version set to ${version}.`);
  return 0;
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = options.check ? check(options.root) : bump(options.root, options.version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
