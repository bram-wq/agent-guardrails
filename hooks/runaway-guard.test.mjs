// Behavioural test for runaway-guard.mjs — run: `node hooks/runaway-guard.test.mjs`.
//
// CONTRACT: a command containing a generator that never stops (`yes`, /dev/urandom, an unconditional
// loop) is DENIED **unless something bounds it** — a bounding consumer (`| head`), a byte/line cap, or a
// clock (`timeout`). The bound is the entire distinction; without it this would block `yes | apt install`
// and be switched off within a day.
//
// This hook is separate from prose-guard on purpose: `yes` IS a real command, so prose-guard allows it.
// That gap is exactly what once filled a disk, and the first case below is that incident verbatim.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "runaway-guard.mjs");

function decide(command, tool = "Bash") {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
  });
  if (r.status !== 0) return `EXIT_${r.status}`;
  const out = r.stdout.trim();
  if (!out) return "allow";
  try {
    return JSON.parse(out).hookSpecificOutput.permissionDecision;
  } catch {
    return `UNPARSEABLE:${out.slice(0, 40)}`;
  }
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};

// ── MUST FIRE — unbounded generators ──────────────────────────────────────────────────────────────
check(
  "FIRE  ★ the disk-filling incident: 'yes for sure'",
  decide("yes for sure"),
  "deny",
);
check("FIRE  bare yes", decide("yes"), "deny");
check(
  "FIRE  cat /dev/urandom to a file",
  decide("cat /dev/urandom > f"),
  "deny",
);
check(
  "FIRE  unconditional loop",
  decide("while true; do echo x; done"),
  "deny",
);
check("FIRE  yes after a separator", decide("cd /tmp && yes"), "deny");
// `seq` had NO case here in either direction, which is how a backwards rule shipped: it denied the
// FINITE `seq 5` and let the genuinely infinite `seq inf` straight through. Verified against
// coreutils — `inf`, `infinity`, `1 inf` and `1 2 inf` all count up forever.
for (const [label, cmd] of [
  ["seq inf", "seq inf"],
  ["seq infinity", "seq infinity"],
  ["seq with an inf end value", "seq 1 inf"],
  ["seq with a step and inf", "seq 1 2 inf"],
  ["seq with a flag before inf", "seq -w 1 inf"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── MUST NOT FIRE — the SAME generators, bounded. These are legitimate and common. ─────────────────
for (const [label, cmd] of [
  ["yes piped into head", "yes | head -3"],
  ["yes under timeout", "timeout 2 yes"],
  ["urandom with a byte cap", "head -c 1M /dev/urandom > f"],
  ["dd with count=", "dd if=/dev/zero of=f count=10"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST NOT FIRE — the word appears but is not the command ───────────────────────────────────────
for (const [label, cmd] of [
  ["yes inside a grep pattern", "git log --grep=yes"],
  ["yes inside a script name", "npm run yes-man"],
  ["unrelated command", "git status --porcelain"],
  // ★ the regression: every one of these terminates on its own. The old rule denied the first.
  ["seq N is finite — counts 1..5 and exits", "seq 5"],
  ["seq with an explicit range", "seq 1 100"],
  ["seq with a step", "seq 0 2 10"],
  ["seq inf bounded by head", "seq inf | head -5"],
  ["inf only in a redirect target", "seq 1 5 > inf.txt"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── SCOPE + FAIL-OPEN ─────────────────────────────────────────────────────────────────────────────
check("ALLOW non-Bash tools are ignored", decide("yes", "Read"), "allow");
{
  const r = spawnSync("node", [HOOK], { input: "not json{", encoding: "utf8" });
  check(
    "ALLOW malformed event → exit 0, no output",
    r.status === 0 && !r.stdout.trim(),
    true,
  );
}

if (fails) {
  console.error(`\n[runaway-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[runaway-guard.test] all cases passed.");
