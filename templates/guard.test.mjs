// Behavioural test for __NAME__.mjs — run: `node hooks/__NAME__.test.mjs`.
//
// CONTRACT: <one sentence — what is refused, and the one distinction that keeps the twin allowed.>
//
// Spawns the hook exactly as Claude Code does (event JSON on stdin), reads the decision from stdout,
// exits non-zero on the first miss, and prints one summary line. No framework.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, MAX_EVENT_BYTES } from "./__NAME__.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "__NAME__.mjs");
const ENV = { ...process.env, HOOK_CTX: "test" };

/** Feed raw stdin to the hook. */
function feed(input) {
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: ENV });
  if (r.status !== 0) return { verdict: `EXIT_${r.status}`, out: r.stdout ?? "" };
  const out = (r.stdout ?? "").trim();
  if (!out) return { verdict: "allow", out };
  try {
    return { verdict: JSON.parse(out).hookSpecificOutput.permissionDecision, out };
  } catch {
    return { verdict: `UNPARSEABLE:${out.slice(0, 40)}`, out };
  }
}
const decideVia = (command, tool = "Bash") =>
  feed(JSON.stringify({ tool_name: tool, tool_input: { command } })).verdict;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};

// ── MUST FIRE — the incident, verbatim ────────────────────────────────────────────────────────────
check("FIRE  ★ the incident: <replace with the verbatim command>", decideVia("replace-me-with-the-incident"), "deny");
check("FIRE  the pure decider carries the fix in its reason", typeof decide("replace-me-with-the-incident"), "string");

// ── MUST NOT FIRE — the legitimate twin ───────────────────────────────────────────────────────────
check("ALLOW the twin: <replace with the command that looks the same and is fine>", decideVia("npm test"), "allow");
check("ALLOW the word inside an argument is not the command", decideVia("git log --grep=replace-me-with-the-incident"), "allow");
check("ALLOW the pure decider returns null for the twin", decide("npm test"), null);

// ── HARNESS: fail-open on garbage, fail-closed on oversize, scoped to Bash ────────────────────────
{
  const r = spawnSync(process.execPath, [HOOK], { input: "not json{", encoding: "utf8", env: ENV });
  check("ALLOW garbage stdin → exit 0, no output (fail-open)", r.status === 0 && !r.stdout.trim(), true);
}
{
  const big = JSON.stringify({ tool_name: "Bash", tool_input: { command: "x".repeat(MAX_EVENT_BYTES + 1) } });
  const r = feed(big);
  check("DENY  oversize stdin is refused, not waved through (fail-closed)", r.verdict, "deny");
  check("DENY  …and the reason says it was NOT scanned", /NOT scanned/.test(r.out), true);
}
check("ALLOW a non-Bash tool is ignored", decideVia("replace-me-with-the-incident", "Read"), "allow");

if (fails) {
  console.error(`\n[__NAME__.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[__NAME__.test] all cases passed.");
