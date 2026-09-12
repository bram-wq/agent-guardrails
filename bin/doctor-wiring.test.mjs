import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scratchDir } from "../hooks/_scratch-dir.mjs";

const cli = fileURLToPath(new URL("./agent-guardrails.mjs", import.meta.url));
const project = scratchDir("doctor-wiring");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: project, encoding: "utf8", timeout: 60000,
  env: { ...process.env, HOOK_CTX: "test", HOOK_STATE_DIR: join(project, "state"), HOOK_FIRE_LOG: join(project, "fires") },
});
assert.equal(run("init").status, 0);
assert.equal(run("doctor", "--strict").status, 0);
console.log("✓ strict doctor accepts the actual fresh installation");
const path = join(project, ".claude", "settings.json");
const original = readFileSync(path, "utf8");
for (const change of [
  settings => { settings.hooks = {}; },
  settings => { settings.hooks.PreToolUse[0].matcher = "NeverThisTool"; },
  settings => { settings.hooks.PreToolUse[0].hooks[0].command = "echo"; },
  settings => { settings.hooks.PreToolUse[0].hooks[0].async = true; },
]) {
  const settings = JSON.parse(original);
  change(settings);
  writeFileSync(path, JSON.stringify(settings));
  const result = run("doctor", "--strict");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /missing shipped registration/);
}
console.log("✓ strict doctor refuses missing, misrouted and non-executing registrations");
writeFileSync(path, original);
assert.equal(run("doctor", "--strict").status, 0);
console.log("✓ restoring wiring restores strict installation health");
