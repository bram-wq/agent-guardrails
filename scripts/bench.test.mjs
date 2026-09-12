import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (...args) => spawnSync(process.execPath, ["scripts/bench.mjs", ...args], {
  cwd: root, encoding: "utf8", timeout: 60000,
});
// Removing a configured hook from benchmark coverage must fail this integration check.
const result = run("--n", "1", "--json");
assert.equal(result.status, 0, result.stderr);
assert.doesNotThrow(() => JSON.parse(result.stdout), "--json must emit a machine-readable receipt");
const report = JSON.parse(result.stdout);
const settings = JSON.parse(readFileSync(new URL("../settings.example.json", import.meta.url)));
const registered = settings.hooks.PreToolUse.find(x => x.matcher === "Bash").hooks
  .map(x => x.args[0].split("/").at(-1)).sort();
assert.deepEqual(report.rows.filter(x => x.event === "PreToolUse·Bash").map(x => x.label).sort(), registered);
console.log("✓ benchmark covers every installed Bash guard");
assert.equal(report.schemaVersion, 1);
assert.match(report.configurationSha256, /^[a-f0-9]{64}$/);
assert.equal(report.samplesPerRow, 1);
assert.ok(report.rows.every(x => x.samples.length === 1 && x.samples.every(Number.isFinite)));
console.log("✓ benchmark preserves raw measurements and configuration identity");
for (const args of [["--wat"], ["--n"], ["--n", "0"], ["--n", "1.5"]]) {
  const refusal = run(...args);
  assert.notEqual(refusal.status, 0);
  assert.equal(refusal.stdout, "");
}
console.log("✓ invalid options refuse without a performance receipt");
