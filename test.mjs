#!/usr/bin/env node
// Test runner: every hooks/*.test.mjs and bin/*.test.mjs, sequentially, in plain Node. Output streams
// through; the first red suite stops the run with a non-zero exit. No framework — a hook must be
// verifiable by `node <file>` alone, and so must its runner.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const suites = [];
for (const dir of ["hooks", "bin"]) {
  for (const f of readdirSync(join(ROOT, dir)).sort())
    if (f.endsWith(".test.mjs")) suites.push(join(dir, f));
}

const started = Date.now();
let passed = 0;
for (const s of suites) {
  console.log(`\n=== ${s}`);
  const r = spawnSync(process.execPath, [join(ROOT, s)], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) {
    console.log(`\nFAIL ${s} (exit ${r.status ?? r.signal}) — ${passed} of ${suites.length} suite(s) passed before it.`);
    process.exit(1);
  }
  passed++;
}
console.log(`\n${passed}/${suites.length} suites passed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
