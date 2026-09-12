import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir, reapScratchDirs } from "../hooks/_scratch-dir.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = scratchDir("host-launcher-controls");
try {
  const launcher = join(root, "scripts/host-run.mjs");
  const project = join(scratch, "project");
  const run = (args, env = process.env) => spawnSync(process.execPath, [launcher, ...args], {
    env, encoding: "utf8", timeout: 30000,
  });
  if (process.platform === "win32") {
    const result = run(["prepare", "claude", project]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires POSIX/);
    assert.equal(existsSync(project), false);
    console.log("✓ host launcher explicitly refuses unsupported Windows rather than emitting evidence");
  } else {
    const prepared = run(["prepare", "claude", project]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const before = readFileSync(join(project, ".claude/settings.json"), "utf8");
    assert.equal(run(["prepare", "claude", project]).status, 2);
    assert.equal(readFileSync(join(project, ".claude/settings.json"), "utf8"), before);
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    // Version-only stub. Any inference launch crashes, so refusal cannot be
    // mistaken for an observed host session.
    writeFileSync(join(bin, "claude"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo test-version; else exit 97; fi\n', { mode: 0o755 });
    const env = { ...process.env, PATH: bin + delimiter + process.env.PATH };
    delete env.HOST_PROOF_EXPECT_VERSION;
    const args = ["run", "claude", project, join(scratch, "receipt")];
    const missing = run(args, env);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /unpinned or mismatched/);
    const mismatched = run(args, { ...env, HOST_PROOF_EXPECT_VERSION: "another-version" });
    assert.equal(mismatched.status, 2);
    assert.match(mismatched.stderr, /unpinned or mismatched/);
    assert.equal(existsSync(join(scratch, "receipt")), false);
    writeFileSync(join(project, ".claude/settings.json"), before + "\n");
    const changed = run(args, { ...env, HOST_PROOF_EXPECT_VERSION: "test-version" });
    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /source\/config\/tooling changed/);
    console.log("✓ real installation refuses reuse, absent/wrong CLI pins and changed config before launch");
  }
} finally { reapScratchDirs(); }
