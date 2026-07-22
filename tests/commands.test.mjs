import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ROOT, ROOT } from "./helpers.mjs";

function readPlugin(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("plugin exposes the intended command surface", () => {
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort(), [
    "cancel.md",
    "continue.md",
    "rescue.md",
    "result.md",
    "run.md",
    "setup.md",
    "status.md"
  ]);
});

test("run and continue require direct invocation and confirmed full access", () => {
  for (const name of ["run.md", "continue.md"]) {
    const source = readPlugin(`commands/${name}`);
    assert.match(source, /disable-model-invocation:\s*true/);
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /--full-access/);
    assert.match(source, /--confirm-full-access/);
    assert.match(source, /dangerously-skip-permissions/);
    assert.match(source, /foreground/i);
    assert.match(source, /Cancel full-access run \(Recommended\)/);
  }
  assert.match(readPlugin("commands/continue.md"), /--continue-command/);
});

test("rescue uses an explicit thin subagent and cannot request full access", () => {
  const command = readPlugin("commands/rescue.md");
  const agent = readPlugin("agents/agy-rescue.md");
  const skill = readPlugin("skills/agy-cli-runtime/SKILL.md");

  assert.match(command, /subagent_type: "agy:agy-rescue"/);
  assert.doesNotMatch(command, /^context:\s*fork\b/m);
  assert.match(command, /Do not call `Skill\(agy:rescue\)`/);
  assert.match(command, /--full-access/);
  assert.match(command, /use `\/agy:run --full-access`/i);
  assert.match(command, /Never infer write access/i);

  assert.match(agent, /Use exactly one `Bash` call/);
  assert.match(agent, /Never infer or add write access/);
  assert.match(agent, /Never pass `--full-access` or `--confirm-full-access`/);
  assert.match(agent, /Do not inspect the repository/);
  assert.match(agent, /Return companion stdout exactly as-is/);
  assert.match(skill, /user-invocable:\s*false/);
});

test("job management commands are deterministic slash-only entrypoints", () => {
  for (const name of ["status.md", "result.md", "cancel.md"]) {
    const source = readPlugin(`commands/${name}`);
    assert.match(source, /disable-model-invocation:\s*true/);
    assert.match(source, /allowed-tools:\s*Bash\(node:\*\)/);
    assert.match(source, /agy-companion\.mjs/);
  }
});

test("marketplace and plugin manifests agree on version and name", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readPlugin(".claude-plugin/plugin.json"));
  assert.equal(marketplace.plugins[0].name, "agy");
  assert.equal(plugin.name, "agy");
  assert.equal(marketplace.plugins[0].version, plugin.version);
});
