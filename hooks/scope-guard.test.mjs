// Standalone behavioral test for scope-guard.mjs — run: `node hooks/scope-guard.test.mjs`.
// Calls the hook exactly as the Claude Code harness does (event JSON on stdin, native paths),
// and asserts allow/deny/opt-in/fail-open. No test framework — a hook must be verifiable anywhere.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "scope-guard.mjs");

function outputFor(ev) {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify(ev),
    encoding: "utf8",
    timeout: 10_000, // the harness's own budget; a hang here is the allow-by-timeout, not a slow test
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}
const decisionFor = (ev) => outputFor(ev)?.permissionDecision ?? "ALLOW";
const reasonFor = (ev) => outputFor(ev)?.permissionDecisionReason ?? "";

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
  // Changed 2026-09-12: a scope file that does not parse now DENIES (a corrupt config is the world's
  // defect, not the hook's; allow-all on a typo was a silent hole). The hook's own bugs still fail open.
  const ok = got === "deny";
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  MUST FIRE — an unparseable .agent-scope denies, naming the file → ${got}`);
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

  // A lane that declared NO scope allows (opt-in). A lane whose scope file will not PARSE denies
  // since 2026-09-12 (see the malformed-scope case above): the fix that narrowed "outside cwd" still
  // must not widen the deny for the unscoped tree, and that is pinned here.
  for (const [tree, label, want] of [
    [unscoped, "a worktree with NO .agent-scope", "ALLOW"],
    [broken, "a worktree whose .agent-scope will not parse", "deny"],
  ]) {
    const got = decisionFor({
      tool_name: "Write",
      tool_input: { file_path: join(tree, "apps", "web", "x.ts") },
      cwd: session,
    });
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → ${got}`);
  }

  for (const d of [lane, session, unscoped, broken])
    rmSync(d, { recursive: true, force: true });
}

// ── ADVERSARIAL PROBE (2026-09-12): five holes, each with the incident and its legitimate twin ─────
function check(ok, label) {
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label}`);
}
const scoped = (scope) => {
  const d = mkdtempSync(join(tmpdir(), "sg-probe-"));
  writeFileSync(join(d, ".agent-scope"), typeof scope === "string" ? scope : JSON.stringify(scope));
  return d;
};
const ev = (d, tool, p, extra = {}) => ({
  tool_name: tool,
  tool_input: { file_path: join(d, ...p.split("/")), ...extra },
  cwd: d,
});

// 1. EXPONENTIAL GLOB. `globToRe` emitted `(?:.*/)?` per `**/`; measured: 12 stars vs a 30-deep path
//    >20 s, 25 stars 4 min. The hook's 10 s timeout killed it, and a timed-out PreToolUse hook renders
//    NO decision — so an agent-writable `.agent-scope` was an allow-all.
{
  const stars = Array(25).fill("**").join("/") + "/x";
  const deep = Array(30).fill("d").join("/") + "/y.ts"; // does not end in x → must DENY
  const d = scoped({ allow: [stars] });
  const t0 = Date.now();
  const got = decisionFor(ev(d, "Write", deep));
  const wall = Date.now() - t0;
  check(got === "deny" && wall < 5000, `MUST FIRE — 25-star allow vs 30-deep path → ${got} in ${wall} ms (whole hook, incl. node start)`);
  // The matcher alone, in-process (node start-up is ~40 ms and would swamp a 50 ms bound on the spawn).
  const ms = execFileSync(
    process.execPath,
    ["--input-type=module", "-e",
      `import { matchesAny } from ${JSON.stringify(pathToFileURL(HOOK).href)}; // a file URL: a bare Windows drive path is not an ESM specifier
       const t = process.hrtime.bigint();
       const hit = matchesAny(${JSON.stringify(deep)}, [${JSON.stringify(stars)}]);
       console.log(JSON.stringify({ hit, ms: Number(process.hrtime.bigint() - t) / 1e6 }));`],
    { input: "", encoding: "utf8" }, // empty stdin → the hook's own top-level run fails open, silently
  );
  const r = JSON.parse(ms.trim().split("\n").pop());
  check(r.hit === false && r.ms < 50, `MUST FIRE — matcher alone: 25 stars vs 30-deep path in ${r.ms.toFixed(2)} ms, no match`);
  check(decisionFor(ev(d, "Write", Array(30).fill("d").join("/") + "/x")) === "ALLOW", "control — same pattern, path ending in x → ALLOW");
  rmSync(d, { recursive: true, force: true });

  const d2 = scoped({ allow: ["packages/db/**"], deny: ["**/auth.ts"] });
  check(decisionFor(ev(d2, "Write", "packages/db/a/b/c.sql")) === "ALLOW", "MUST NOT FIRE — plain packages/db/** still allows (segment walk)");
  check(decisionFor(ev(d2, "Write", "packages/db/x/auth.ts")) === "deny", "control — **/auth.ts still denies at depth (segment walk)");
  check(decisionFor(ev(d2, "Write", "packages/dbx/c.sql")) === "deny", "control — `db/**` does not match `dbx/` (segment walk is segment-exact)");
  rmSync(d2, { recursive: true, force: true });

  const d3 = scoped({ allow: ["packages/db/**", "a".repeat(513)] });
  const why = reasonFor(ev(d3, "Write", "packages/db/m.sql"));
  check(why.includes(".agent-scope") && why.includes("513"), `MUST FIRE — a 513-char glob is a malformed scope → deny naming it: ${why.slice(0, 60)}…`);
  rmSync(d3, { recursive: true, force: true });
}

// 2. SYMLINKS. Measured: `packages/db/abs-link.ts -> /outside/target.ts` under allow `packages/db/**`
//    was ALLOWED and the write landed outside the tree. Resolve, then decide.
{
  const outside = mkdtempSync(join(tmpdir(), "sg-outside-"));
  writeFileSync(join(outside, "target.ts"), "// outside\n");
  mkdirSync(join(outside, "dir"));
  const d = scoped({ allow: ["packages/db/**"], deny: ["**/auth.ts"] });
  mkdirSync(join(d, "packages", "db"), { recursive: true });
  symlinkSync(join(outside, "target.ts"), join(d, "packages", "db", "abs-link.ts"));
  symlinkSync(join(outside, "dir"), join(d, "packages", "db", "linked-dir"));
  writeFileSync(join(d, "packages", "db", "real.ts"), "// real\n");
  mkdirSync(join(d, "apps"));
  symlinkSync(join(d, "apps"), join(d, "packages", "db", "to-apps")); // inside the tree, outside allow

  const why = reasonFor(ev(d, "Write", "packages/db/abs-link.ts"));
  check(why.includes("symlink") && why.includes(outside), "MUST FIRE — symlinked FILE inside allow pointing outside the tree → deny");
  check(decisionFor(ev(d, "Write", "packages/db/linked-dir/new.ts")) === "deny", "MUST FIRE — new file under a symlinked DIR pointing outside the tree → deny");
  check(decisionFor(ev(d, "Write", "packages/db/to-apps/x.ts")) === "deny", "MUST FIRE — symlink that stays in the tree but lands outside allow → deny");
  check(decisionFor(ev(d, "Edit", "packages/db/real.ts")) === "ALLOW", "MUST NOT FIRE — a real file inside allow → ALLOW");
  check(decisionFor(ev(d, "Write", "packages/db/brand-new/deep/file.ts")) === "ALLOW", "MUST NOT FIRE — a not-yet-existing path inside allow → ALLOW");
  rmSync(d, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// 3. MALFORMED SHAPE. Measured: `{"allow":"packages/db/**"}`, `[]`, `null`, `5`, `"str"` each parsed
//    and silently became allow-all. A scope that PARSES but is not the documented shape now denies,
//    naming the file and the defect. (JSON that does not parse stays fail-open — the frozen cases
//    above pin that; see the report.)
{
  for (const [raw, label] of [
    ['{"allow":"packages/db/**"}', "allow is a string"],
    ["[]", "an array"],
    ["null", "null"],
    ["5", "a number"],
    ['"str"', "a string"],
    ['{"allow":["packages/db/**", 7]}', "allow holds a number"],
  ]) {
    const d = scoped(raw);
    const why = reasonFor(ev(d, "Write", "apps/web/x.ts"));
    check(why.includes(".agent-scope") && why.length > 0, `MUST FIRE — scope ${label} → deny naming .agent-scope: ${why.slice(0, 70)}…`);
    rmSync(d, { recursive: true, force: true });
  }
  const d = scoped({ allow: ["packages/db/**"], deny: ["**/auth.ts"], reason: "ok" });
  check(decisionFor(ev(d, "Write", "packages/db/x.ts")) === "ALLOW", "MUST NOT FIRE — a valid scope file allows as before");
  check(decisionFor(ev(d, "Write", "apps/web/x.ts")) === "deny", "control — and denies as before");
  rmSync(d, { recursive: true, force: true });
  const d2 = scoped({ deny: ["**/auth.ts"] }); // allow absent is a documented shape
  check(decisionFor(ev(d2, "Write", "apps/web/x.ts")) === "ALLOW", "MUST NOT FIRE — allow absent → allow-all-except-deny, as documented");
  rmSync(d2, { recursive: true, force: true });
}

// 4. SELF-EDIT WIDENING. `.agent-scope` was exempt unconditionally: one Write of
//    {"allow":["**"]} and the scoped agent was unscoped. Narrowing stays free; widening is refused.
{
  const base = { allow: ["packages/db/**", "apps/web/lib/f.ts"], deny: ["**/auth.ts"], reason: "slice B" };
  const d = scoped(base);
  const current = readFileSync(join(d, ".agent-scope"), "utf8");
  const write = (content) => ev(d, "Write", ".agent-scope", { content });
  const edit = (old_string, new_string) => ev(d, "Edit", ".agent-scope", { old_string, new_string });

  let why = reasonFor(write(JSON.stringify({ ...base, allow: ["**"] })));
  check(why.includes("WIDEN") && why.includes("orchestrator"), "MUST FIRE — Write that adds allow paths → deny, says ask the orchestrator");
  check(decisionFor(write(JSON.stringify({ ...base, deny: [] }))) === "deny", "MUST FIRE — Write that drops a deny path → deny");
  check(decisionFor(write(JSON.stringify({ ...base, allow: [] }))) === "deny", "MUST FIRE — Write that empties allow (= allow-all) → deny");
  check(decisionFor(edit('"packages/db/**"', '"**"')) === "deny", "MUST FIRE — Edit that widens an allow glob → deny");
  check(decisionFor(edit("not-in-the-file", "x")) === "deny", "MUST FIRE — Edit whose old_string does not apply → fail closed");
  check(decisionFor(write("{not json")) === "deny", "MUST FIRE — Write of unparseable content → fail closed");
  check(decisionFor(write('{"allow":"**"}')) === "deny", "MUST FIRE — Write of a malformed shape → fail closed");
  check(decisionFor(ev(d, "MultiEdit", ".agent-scope", { edits: [{ old_string: '"**/auth.ts"', new_string: '"**/nothing.ts"' }] })) === "deny", "MUST FIRE — MultiEdit that swaps out a deny glob → deny");

  check(decisionFor(write(current)) === "ALLOW", "MUST NOT FIRE — Write of identical content → ALLOW");
  check(decisionFor(write(JSON.stringify({ ...base, allow: ["packages/db/**"] }))) === "ALLOW", "MUST NOT FIRE — Write that narrows allow → ALLOW");
  check(decisionFor(write(JSON.stringify({ ...base, deny: ["**/auth.ts", "**/secret.ts"] }))) === "ALLOW", "MUST NOT FIRE — Write that adds a deny → ALLOW");
  check(decisionFor(edit('"slice B"', '"slice B — renamed"')) === "ALLOW", "MUST NOT FIRE — Edit that only changes reason → ALLOW");
  check(decisionFor(edit(',"apps/web/lib/f.ts"', "")) === "ALLOW", "MUST NOT FIRE — Edit that removes an allow entry → ALLOW");
  rmSync(d, { recursive: true, force: true });
}

// 5. TOOL NAME. The matcher was `/^(Edit|Write|NotebookEdit)$/` — MultiEdit walked straight past it.
{
  const d = scoped({ allow: ["packages/db/**"] });
  check(decisionFor(ev(d, "MultiEdit", "apps/web/x.ts", { edits: [] })) === "deny", "MUST FIRE — MultiEdit outside scope → deny");
  check(decisionFor(ev(d, "write", "apps/web/x.ts")) === "deny", "MUST FIRE — lower-case tool name outside scope → deny");
  check(decisionFor(ev(d, "MultiEdit", "packages/db/x.ts", { edits: [] })) === "ALLOW", "MUST NOT FIRE — MultiEdit inside scope → ALLOW");
  check(decisionFor({ tool_name: "Read", tool_input: { file_path: join(d, "apps", "web", "x.ts") }, cwd: d }) === "ALLOW", "MUST NOT FIRE — Read is not a write tool → ignored");
  rmSync(d, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
if (fails) {
  console.error(`\n[scope-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[scope-guard.test] all cases passed.");
