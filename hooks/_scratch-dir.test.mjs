import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { scratchDir, reapScratchDirs } from "./_scratch-dir.mjs";

// A directory's age does not establish that its owning process has died.
const prefix = `guardrails-live-owner-${process.pid}`;
const active = scratchDir(prefix);
const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
utimesSync(active, old, old);
const child = spawnSync(process.execPath, ["--input-type=module", "-e",
  `import {scratchDir} from ${JSON.stringify(new URL("./_scratch-dir.mjs", import.meta.url).href)}; scratchDir(${JSON.stringify(prefix)});`
], { encoding: "utf8", timeout: 10000 });
assert.equal(child.status, 0, child.stderr);
assert.ok(existsSync(active), "starting a sibling must not delete this live process's old fixture");
console.log("✓ scratch allocation preserves another live process's old directory");
reapScratchDirs();
assert.equal(existsSync(active), false);
console.log("✓ the owning process still cleans its own directory");
