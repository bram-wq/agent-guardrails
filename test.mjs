#!/usr/bin/env node
// Test runner: every hooks/*.test.mjs, hooks/adapters/*.test.mjs and bin/*.test.mjs, sequentially, in plain Node. Output streams
// through; the first red suite stops the run with a non-zero exit. No framework — a hook must be
// verifiable by `node <file>` alone, and so must its runner.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const suites = [];
for (const dir of ["hooks", "hooks/adapters", "bin"]) {
  for (const f of readdirSync(join(ROOT, dir)).sort())
    if (f.endsWith(".test.mjs")) suites.push(join(dir, f));
}

const started = Date.now();
let passed = 0;
let cases = 0;
// Suites print one line per case: `✓ …` from the shared helper, `ok - …` from the ui-evidence suite.
// The total is COUNTED here so the number the README quotes is computed, never typed.
const CASE_LINE = /^\s*(?:✓|ok - )/;
for (const s of suites) {
  console.log(`\n=== ${s}`);
  const r = spawnSync(process.execPath, [join(ROOT, s)], { encoding: "utf8", cwd: ROOT });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  cases += (r.stdout ?? "").split("\n").filter((l) => CASE_LINE.test(l)).length;
  if (r.status !== 0) {
    console.log(`\nFAIL ${s} (exit ${r.status ?? r.signal}) — ${passed} of ${suites.length} suite(s) passed before it.`);
    process.exit(1);
  }
  passed++;
}
console.log(
  `\n${passed}/${suites.length} suites passed, ${cases} cases, in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
