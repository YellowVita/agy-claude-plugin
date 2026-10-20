import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ROOT, makeTempDir } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");
const MANIFESTS = [
  "package.json",
  "package-lock.json",
  "plugins/agy/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json"
];

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
}

function copyManifests() {
  const root = makeTempDir("agy-version-");
  for (const file of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

test("the repository's version fields agree", () => {
  const version = readJson(ROOT, "package.json").version;
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `Version ${version} is consistent across 6 fields.\n`);
});

test("--check lists every field when one disagrees", () => {
  const root = copyManifests();
  const marketplace = readJson(root, ".claude-plugin/marketplace.json");
  marketplace.metadata.version = "9.9.9";
  fs.writeFileSync(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify(marketplace));

  const result = run("--check", "--root", root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Version fields disagree/);
  assert.match(result.stderr, /marketplace\.json metadata\.version: 9\.9\.9/);
});

test("bumping writes the version to every field and keeps the files formatted", () => {
  const root = copyManifests();
  const result = run("1.2.3-rc.1", "--root", root);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readJson(root, "package.json").version, "1.2.3-rc.1");
  const lock = readJson(root, "package-lock.json");
  assert.equal(lock.version, "1.2.3-rc.1");
  assert.equal(lock.packages[""].version, "1.2.3-rc.1");
  assert.equal(readJson(root, "plugins/agy/.claude-plugin/plugin.json").version, "1.2.3-rc.1");
  const marketplace = readJson(root, ".claude-plugin/marketplace.json");
  assert.equal(marketplace.metadata.version, "1.2.3-rc.1");
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "agy").version, "1.2.3-rc.1");

  const text = fs.readFileSync(path.join(root, "package.json"), "utf8");
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  assert.equal(run("--check", "--root", root).status, 0);
});

test("invalid versions and arguments are rejected without writing", () => {
  const root = copyManifests();
  const before = fs.readFileSync(path.join(root, "package.json"), "utf8");

  for (const args of [["v1.0"], ["1.0"], [], ["1.0.0", "--check"], ["1.0.0", "2.0.0"]]) {
    const result = run(...args, "--root", root);
    assert.equal(result.status, 2, `expected usage error for ${JSON.stringify(args)}`);
  }
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), before);
});
