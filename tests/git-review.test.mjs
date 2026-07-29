import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  assertRepositorySnapshot,
  buildReviewPrompt,
  captureRepositorySnapshot,
  resolveReviewTarget,
  resolveTurnReviewTarget
} from "../plugins/agy/scripts/lib/git-review.mjs";
import { makeTempDir } from "./helpers.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo() {
  const cwd = makeTempDir("agy-review-git-");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "tests@example.com"]);
  git(cwd, ["config", "user.name", "Agy Tests"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

test("auto review scope prefers staged, unstaged, and untracked working-tree changes", () => {
  const cwd = initRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(cwd, "new.js"), "export const added = true;\n");

  const target = resolveReviewTarget(cwd, { scope: "auto" });
  assert.equal(target.mode, "working-tree");
  assert.match(target.status, /app\.js/);
  assert.match(target.status, /new\.js/);
});

test("auto review scope falls back to a branch diff when the working tree is clean", () => {
  const cwd = initRepo();
  git(cwd, ["checkout", "-b", "feature/test"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 3;\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-m", "feature"]);

  const target = resolveReviewTarget(cwd, { scope: "auto" });
  assert.equal(target.mode, "branch");
  assert.match(target.base, /^[0-9a-f]{40}$/);
  assert.deepEqual(target.changedFiles, ["app.js"]);
});

test("review refs are passed as argv and refs beginning with an option are rejected", () => {
  const cwd = initRepo();
  assert.throws(
    () => resolveReviewTarget(cwd, { scope: "branch", base: "--output=/tmp/not-allowed" }),
    /Unsafe git base ref/
  );
});

test("an explicit base selects branch scope even with working-tree changes", () => {
  const cwd = initRepo();
  git(cwd, ["checkout", "-b", "feature/base-selection"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 4;\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-m", "feature"]);
  fs.writeFileSync(path.join(cwd, "uncommitted.js"), "export const pending = true;\n");

  const target = resolveReviewTarget(cwd, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.match(target.base, /^[0-9a-f]{40}$/);
  assert.deepEqual(target.changedFiles, ["app.js"]);
  assert.throws(
    () => resolveReviewTarget(cwd, { scope: "working-tree", base: "main" }),
    /cannot be combined/
  );
});

test("review prompts use immutable commit OIDs instead of untrusted ref text", () => {
  const cwd = initRepo();
  const hostileRef = "main;echo${IFS}INJECTED;#";
  git(cwd, ["branch", hostileRef]);
  git(cwd, ["checkout", "-b", "feature/safe-prompt"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 5;\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-m", "feature"]);

  const target = resolveReviewTarget(cwd, { scope: "branch", base: hostileRef });
  const prompt = buildReviewPrompt(target);
  assert.match(target.base, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(prompt, /INJECTED|echo|IFS/);
  assert.match(prompt, new RegExp(`git diff ${target.base}`));
});

test("review snapshots detect repository changes before results are accepted", () => {
  const cwd = initRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.doesNotThrow(() => assertRepositorySnapshot(cwd, target.snapshot));

  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 9;\n");
  assert.throws(() => assertRepositorySnapshot(cwd, target.snapshot), /result is stale/);
});

test("review snapshots use repository-root paths when invoked from a subdirectory", () => {
  const cwd = initRepo();
  const subdirectory = path.join(cwd, "nested");
  fs.mkdirSync(subdirectory);
  fs.writeFileSync(path.join(cwd, "root.txt"), "root before\n");
  fs.writeFileSync(path.join(subdirectory, "nested.txt"), "nested before\n");

  const snapshot = captureRepositorySnapshot(subdirectory);
  assert.notEqual(snapshot.dirtyEntries["root.txt"], "missing");
  assert.notEqual(snapshot.dirtyEntries["nested/nested.txt"], "missing");
  assert.doesNotThrow(() => assertRepositorySnapshot(subdirectory, snapshot));

  fs.writeFileSync(path.join(cwd, "root.txt"), "root after\n");
  fs.writeFileSync(path.join(subdirectory, "nested.txt"), "nested after\n");
  assert.throws(() => assertRepositorySnapshot(subdirectory, snapshot), /result is stale/);
});

test("turn snapshots include committed and uncommitted paths changed after the baseline", () => {
  const cwd = initRepo();
  const baseline = captureRepositorySnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 6;\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-m", "turn commit"]);
  fs.writeFileSync(path.join(cwd, "pending.js"), "export const pending = true;\n");

  const target = resolveTurnReviewTarget(cwd, baseline);
  assert.equal(target.mode, "turn");
  assert.deepEqual(target.changedFiles, ["app.js", "pending.js"]);
  assert.equal(target.base, baseline.headOid);
});

test("turn evidence excludes unchanged hunks that were already dirty at the baseline", () => {
  const cwd = initRepo();
  const lines = [
    "const legacy = eval(userInput);",
    ...Array.from({ length: 12 }, (_, index) => `const filler${index} = ${index};`),
    "export const current = 1;"
  ];
  fs.writeFileSync(path.join(cwd, "app.js"), `${lines.join("\n")}\n`);
  const baseline = captureRepositorySnapshot(cwd, { includeDirtyContent: true });
  lines[lines.length - 1] = "export const current = 2;";
  fs.writeFileSync(path.join(cwd, "app.js"), `${lines.join("\n")}\n`);

  const target = resolveTurnReviewTarget(cwd, baseline);
  assert.deepEqual(target.changedFiles, ["app.js"]);
  assert.match(target.syntheticPatch, /current = 1/);
  assert.match(target.syntheticPatch, /current = 2/);
  assert.doesNotMatch(target.syntheticPatch, /eval\(userInput\)/);
});

test("binary-only turn changes are excluded so the review gate fails open", () => {
  const cwd = initRepo();
  const binaryPath = path.join(cwd, "asset.bin");
  fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
  const baseline = captureRepositorySnapshot(cwd, { includeDirtyContent: true });
  fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 4]));

  assert.throws(
    () => resolveTurnReviewTarget(cwd, baseline),
    /could not be isolated safely/
  );
});
