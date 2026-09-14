// Behavioural test for goal-guard's proof ledger under concurrency and rotation —
// run: `node hooks/goal-guard.ledger-rotation.test.mjs`.
//
// CONTRACT: a stamp that reached disk is never erased by the ledger's own size bound, and the verdict
// is the NEWEST stamp for the command by timestamp, wherever the ledger's lines now live.
//
// THE FIRST CASE IS THE DEFECT, MEASURED. The ledger used to be bounded by read-trim-rewrite. With the
// ledger at its ceiling, processes stamping at once erased each other's stamps: ledgerVerdict then
// reported a command that had run as "has not been run". The case uses only stamp() and ledgerVerdict(),
// which exist before and after the fix, so the same file measures both.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchDir } from "./_scratch-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = await import("./goal-guard.mjs");
const { stamp, ledgerVerdict, MAX_LEDGER_LINES } = mod;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}${ok ? "" : `, got ${got}`}`);
};

const TELEMETRY = scratchDir("goal-guard-rotation-telemetry");
const envFor = (dir) => ({ ...process.env, HOOK_STATE_DIR: dir, HOOK_CTX: "test", HOOK_FIRE_LOG: join(TELEMETRY, "fires.log") });
const ARMED = "2026-01-01T00:00:00.000Z";
const verdictOf = (dir, command) => ledgerVerdict({ doneCommand: command, setAt: ARMED }, envFor(dir));
const ledgerLine = (ts, code, command) => `${ts}\texit=${code}\t${command}\n`;

// ── concurrent stamps at the ceiling ─────────────────────────────────────────────────────────────
{
  const dir = scratchDir("goal-guard-rotation-concurrent");
  const prefill = Array.from({ length: MAX_LEDGER_LINES }, (_, i) => ledgerLine("2026-01-01T00:00:01.000Z", 0, `prefill-${i}`));
  writeFileSync(join(dir, "goal-ledger.log"), prefill.join(""));
  const P = 8;
  const N = 40;
  const child = `const m = await import(${JSON.stringify(pathToFileURL(join(HERE, "goal-guard.mjs")).href)});
for (let i = 0; i < ${N}; i++) m.stamp(1, "p" + process.argv[1] + "-" + i, process.env);`;
  const codes = await Promise.all(
    Array.from({ length: P }, (_, p) =>
      new Promise((res) =>
        spawn(process.execPath, ["--input-type=module", "-e", child, String(p)], { env: envFor(dir), stdio: ["ignore", "ignore", "inherit"] }).on("exit", res),
      ),
    ),
  );
  check("FIRE  (premise) every stamping process exited 0", codes.every((c) => c === 0), true);
  let lost = 0;
  let first = "";
  for (let p = 0; p < P; p++)
    for (let i = 0; i < N; i++) {
      const v = verdictOf(dir, `p${p}-${i}`);
      if (!/was exit=1 at/.test(v.why)) {
        lost++;
        first ||= `p${p}-${i}: ${v.why}`;
      }
    }
  check(`ALLOW ${P} processes × ${N} red stamps at the ledger's ceiling: every one is still the verdict for its command`, lost === 0 ? 0 : `${lost} lost (${first})`, 0);
}

// ── the verdict reads rotated segments ───────────────────────────────────────────────────────────
{
  const dir = scratchDir("goal-guard-rotation-segment");
  const env = envFor(dir);
  for (let i = 0; i < MAX_LEDGER_LINES; i++) stamp(0, `cmd-${i}`, env);
  stamp(0, "the-proof", env); // the stamp that pushes the ledger past its ceiling, so it rotates with it
  check("ALLOW a green stamp that rotated into a segment still proves its command", verdictOf(dir, "the-proof").proven, true);
}
{
  const dir = scratchDir("goal-guard-rotation-newest-by-time");
  writeFileSync(join(dir, "goal-ledger.log.seg-0000000000001-aa"), ledgerLine("2026-02-01T00:00:02.000Z", 1, "npm test"));
  writeFileSync(join(dir, "goal-ledger.log"), ledgerLine("2026-02-01T00:00:01.000Z", 0, "npm test"));
  check("FIRE  a NEWER red in a segment beats an older green in the live file", verdictOf(dir, "npm test").proven, false);
}
{
  const dir = scratchDir("goal-guard-rotation-newest-green");
  writeFileSync(join(dir, "goal-ledger.log.seg-0000000000001-aa"), ledgerLine("2026-02-01T00:00:02.000Z", 0, "npm test"));
  writeFileSync(join(dir, "goal-ledger.log"), ledgerLine("2026-02-01T00:00:01.000Z", 1, "npm test"));
  check("ALLOW a NEWER green in a segment beats an older red in the live file", verdictOf(dir, "npm test").proven, true);
}
{
  const dir = scratchDir("goal-guard-rotation-tie");
  writeFileSync(
    join(dir, "goal-ledger.log"),
    ledgerLine("2026-02-01T00:00:01.000Z", 1, "npm test") + ledgerLine("2026-02-01T00:00:01.000Z", 0, "npm test"),
  );
  check("FIRE  a red and a green stamped in the same millisecond read RED", verdictOf(dir, "npm test").proven, false);
}
{
  const dir = scratchDir("goal-guard-rotation-none");
  check("ALLOW (control) no ledger at all still says nothing has been run", verdictOf(dir, "npm test").why, "no proof ledger exists — nothing has been run");
}

console.log(fails ? `\n${fails} case(s) FAILED` : "\nall cases passed");
process.exit(fails ? 1 : 0);
