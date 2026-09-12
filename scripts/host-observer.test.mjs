import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scratchDir, reapScratchDirs } from "../hooks/_scratch-dir.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = scratchDir("observer-controls");
try {
  const descriptor = join(scratch, "handler.json");
  const events = join(scratch, "events.jsonl");
  const probes = { benign: "printf 'hello' > notes.txt", protected: "printf 'change' > .agent-scope" };
  const guard = join(root, "hooks/config-tamper-guard.mjs");
  writeFileSync(descriptor, JSON.stringify({ executable: process.execPath, args: [guard], probes, eventsPath: events }));
  const env = { ...process.env, AGENT_GUARDRAILS_HOST_EVENTS: events, HOOK_CTX: "test", HOOK_FIRE_LOG: join(scratch, "fires") };
  delete env.CONFIG_GUARD_ALLOW;
  for (const command of Object.values(probes)) {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: scratch, tool_input: { command } });
    const options = { input, encoding: "utf8", env, cwd: scratch, timeout: 20000 };
    const direct = spawnSync(process.execPath, [guard], options);
    const observed = spawnSync(process.execPath, [join(root, "scripts/host-observer.mjs"), descriptor], options);
    assert.equal(observed.status, direct.status);
    assert.equal(observed.stdout, direct.stdout);
    assert.equal(observed.stderr, direct.stderr);
  }
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n").map(JSON.parse), [
    { probe: "benign", actual: "allow" }, { probe: "protected", actual: "deny" },
  ]);
  console.log("✓ observer forwards real guard outputs unchanged and records both controls (synthetic event test, not host proof)");
  writeFileSync(descriptor, JSON.stringify({ executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"], probes, eventsPath: events, timeoutMs: 100 }));
  const timed = spawnSync(process.execPath, [join(root, "scripts/host-observer.mjs"), descriptor], {
    input: JSON.stringify({ tool_input: { command: probes.protected } }), encoding: "utf8", timeout: 5000,
  });
  assert.equal(timed.status, 2);
  assert.equal(JSON.parse(readFileSync(events, "utf8").trim().split("\n").at(-1)).actual, "observer-timeout");
  console.log("✓ observer timeout emits a blocking exit and an unknown observation, never an allow");
} finally { reapScratchDirs(); }
