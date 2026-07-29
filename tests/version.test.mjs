import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { ROOT, makeTempDir } from "./helpers.mjs";

const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

test("repository version metadata is synchronized", () => {
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `All version metadata matches ${expectedVersion}.\n`);
});

test("version checker reports mismatched metadata", () => {
  const root = makeTempDir("agy-version-");
  for (const file of [
    "package.json",
    "package-lock.json",
    "plugins/agy/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json"
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  const pluginFile = path.join(root, "plugins/agy/.claude-plugin/plugin.json");
  const plugin = JSON.parse(fs.readFileSync(pluginFile, "utf8"));
  plugin.version = "9.9.9";
  fs.writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);

  const result = spawnSync(process.execPath, [SCRIPT, "--check", "--root", root], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /out of sync/);
});
