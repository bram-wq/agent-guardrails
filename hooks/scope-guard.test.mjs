// Standalone behavioral test for scope-guard.mjs — run: `node hooks/scope-guard.test.mjs`.
// Calls the hook exactly as the Claude Code harness does (event JSON on stdin, native paths),
// and asserts allow/deny/opt-in/fail-open. No test framework — a hook must be verifiable anywhere.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "scope-guard.mjs");

function decisionFor(ev) {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify(ev),
    encoding: "utf8",
  });
  return out.trim()
    ? JSON.parse(out).hookSpecificOutput.permissionDecision
    : "ALLOW";
}

const dir = mkdtempSync(join(tmpdir(), "sg-"));
writeFileSync(
  join(dir, ".agent-scope"),
  JSON.stringify({
    allow: ["packages/db/**"],
    deny: ["**/auth.ts"],
    reason: "slice B",
  }),
);
const at = (p) => join(dir, ...p.split("/"));

const cases = [
  // [tool, relPath, expected]
  ["Edit", "packages/db/foo.sql", "ALLOW"], // in allow
  ["Edit", "packages/db/sub/deep/m.sql", "ALLOW"], // ** matches nested
  ["Write", "apps/web/features/x.ts", "deny"], // outside allow
  ["Edit", "apps/web/lib/auth.ts", "deny"], // deny wins
  // ★ Added by mutation testing. The `apps/web/lib/auth.ts` case above LOOKS like it covers
  // "deny wins", but that path is ALSO outside `allow`, so the allow-branch denies it either way — the
  // deny list was never actually exercised. Disabling the deny branch entirely left this file green.
  // THIS case is the only shape where the deny branch is load-bearing: inside `allow` AND on `deny`.
  // A passing test is not the same as a test that can fail; only a mutation run tells them apart.
  ["Edit", "packages/db/auth.ts", "deny"], // in allow AND in deny → ONLY the deny branch can produce this
  ["Edit", ".agent-scope", "ALLOW"], // may edit own scope
];

let fails = 0;
for (const [tool, p, want] of cases) {
  const got = decisionFor({
    tool_name: tool,
    tool_input: { file_path: at(p) },
    cwd: dir,
  });
  const ok = got === want;
  if (!ok) fails++;
  console.log(
    `${ok ? "✓" : "✗ FAIL"}  ${tool} ${p} → want ${want}, got ${got}`,
  );
}

// Non-edit tool is ignored.
{
  const got = decisionFor({
    tool_name: "Bash",
    tool_input: { command: "ls" },
    cwd: dir,
  });
  const ok = got === "ALLOW";
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  Bash ignored → ${got}`);
}

// Malformed scope → fail-open allow.
writeFileSync(join(dir, ".agent-scope"), "not json{");
{
  const got = decisionFor({
    tool_name: "Edit",
    tool_input: { file_path: at("anything.ts") },
    cwd: dir,
  });
  const ok = got === "ALLOW";
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  malformed scope → fail-open ${got}`);
}

// No scope file → opt-in allow.
{
  const d2 = mkdtempSync(join(tmpdir(), "sg-noscope-"));
  const got = decisionFor({
    tool_name: "Edit",
    tool_input: { file_path: join(d2, "x.ts") },
    cwd: d2,
  });
  const ok = got === "ALLOW";
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  no scope file → opt-in allow ${got}`);
  rmSync(d2, { recursive: true, force: true });
}

// ── WORKTREE LANES ────────────────────────────────────────────────────────────────────────────────
// ★ RED BEFORE GREEN, measured against the hook as it stood: EVERY case in this block returned ALLOW,
// the drive-by write included. The cause was one line — a path was made relative to the SESSION cwd,
// and anything resolving to `../…` was treated as "outside cwd" and waved through. A sibling worktree
// ALWAYS resolves to `../…`, and every parallel lane runs in a worktree, so per-lane scoping had never
// once been enforced in the only configuration it runs in.
// The `deny` cases here are the guard; the ALLOW cases are what stops the fix from being "deny
// everything outside cwd", which would brick every legitimate cross-tree edit and get the hook
// switched off. Both directions or neither.
//
// The fixture is a worktree AS THIS HOOK SEES ONE: a `.git` FILE (a worktree's .git is a gitdir
// pointer, not a directory) beside the `.agent-scope`. No git binary required; the hook reads the
// filesystem, so the filesystem is the fixture.
{
  const lane = mkdtempSync(join(tmpdir(), "sg-lane-"));
  const session = mkdtempSync(join(tmpdir(), "sg-session-")); // session cwd — declares NO scope
  const unscoped = mkdtempSync(join(tmpdir(), "sg-unscoped-")); // a lane that declared nothing
  const broken = mkdtempSync(join(tmpdir(), "sg-broken-")); // a lane whose scope will not parse
  writeFileSync(join(lane, ".git"), "gitdir: /elsewhere/.git/worktrees/lane\n");
  writeFileSync(
    join(unscoped, ".git"),
    "gitdir: /elsewhere/.git/worktrees/unscoped\n",
  );
  writeFileSync(
    join(broken, ".git"),
    "gitdir: /elsewhere/.git/worktrees/broken\n",
  );
  writeFileSync(
    join(lane, ".agent-scope"),
    JSON.stringify({
      allow: ["packages/db/**"],
      deny: ["**/secret.ts"],
      reason: "lane feat/x",
    }),
  );
  writeFileSync(join(broken, ".agent-scope"), "not json{");

  const laneCases = [
    // [cwd, path-inside-the-lane, expected, what it proves]
    [
      session,
      "apps/web/drive-by.ts",
      "deny",
      "MUST FIRE — out-of-scope write into the lane from a main-checkout session (the measured hole)",
    ],
    [
      session,
      "packages/db/m.sql",
      "ALLOW",
      "control — an IN-SCOPE write in that same lane must still land",
    ],
    [
      session,
      "packages/db/secret.ts",
      "deny",
      "deny wins across the lane boundary too (in allow AND in deny)",
    ],
    [
      session,
      ".agent-scope",
      "ALLOW",
      "control — a lane may still adjust its own scope",
    ],
    [
      join(lane, "apps"),
      "apps/web/drive-by.ts",
      "deny",
      "MUST FIRE — cwd is a SUBDIR of the lane; the scope file sits at the lane ROOT",
    ],
    [
      join(lane, "apps"),
      "packages/db/m.sql",
      "ALLOW",
      "control — same nested cwd, in-scope path",
    ],
  ];
  for (const [cwd, p, want, why] of laneCases) {
    const got = decisionFor({
      tool_name: "Write",
      tool_input: { file_path: join(lane, ...p.split("/")) },
      cwd,
    });
    const ok = got === want;
    if (!ok) fails++;
    console.log(
      `${ok ? "✓" : "✗ FAIL"}  lane ${p} → want ${want}, got ${got}   [${why}]`,
    );
  }

  // FAIL-OPEN IS DELIBERATE AND STAYS. A lane that declared no scope, and a lane whose scope file is
  // unparseable, must both ALLOW — the fix narrows a mistaken "outside cwd", it does not widen the
  // deny. A hook bug must never brick a session.
  for (const [tree, label] of [
    [unscoped, "a worktree with NO .agent-scope"],
    [broken, "a worktree whose .agent-scope will not parse"],
  ]) {
    const got = decisionFor({
      tool_name: "Write",
      tool_input: { file_path: join(tree, "apps", "web", "x.ts") },
      cwd: session,
    });
    const ok = got === "ALLOW";
    if (!ok) fails++;
    console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → fail-open ${got}`);
  }

  for (const d of [lane, session, unscoped, broken])
    rmSync(d, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
if (fails) {
  console.error(`\n[scope-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[scope-guard.test] all cases passed.");
