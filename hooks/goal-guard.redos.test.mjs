// Behavioural test: goal-guard's done-command allowlist answers in linear time —
// run: `node hooks/goal-guard.redos.test.mjs`.
//
// CONTRACT: ALLOWED_DONE_SEGMENT_RE refuses the input CodeQL js/redos named (`npx vitest ` followed by
// many `A:, `) in bounded time, and still accepts the Windows drive-letter arguments its tail exists for.
// Each probe runs in a CHILD process with a timeout, so a regression is a red case, never a hung suite.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchDir } from "./_scratch-dir.mjs";

const HOOK = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "goal-guard.mjs")).href;
const TELEMETRY = scratchDir("goal-guard-redos-telemetry");

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}${ok ? "" : `, got ${got}`}`);
};

/** @returns {{ matched: boolean, ms: number } | { hung: string }} */
function probe(input, timeoutMs = 10_000) {
  const code = `const { ALLOWED_DONE_SEGMENT_RE: re } = await import(${JSON.stringify(HOOK)});
const t = performance.now();
const matched = re.test(${JSON.stringify(input)});
process.stdout.write(JSON.stringify({ matched, ms: performance.now() - t }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(TELEMETRY, "fires.log") },
  });
  if (r.error || r.signal || r.status !== 0)
    return { hung: `status=${r.status} signal=${r.signal} ${r.error?.code ?? ""} ${(r.stderr ?? "").slice(0, 80)}` };
  return JSON.parse(r.stdout);
}
const verdict = (p) => ("hung" in p ? `did not finish (${p.hung})` : p.matched ? "accepted" : "refused");

// ── MUST FIRE: the named input is refused, fast ──────────────────────────────────────────────────
{
  const p = probe("npx vitest " + "A:, ".repeat(40) + "!");
  check(
    "FIRE  `npx vitest` + 40 × `A:, ` is decided inside 1 s (it took hours when each argument had two parses)",
    "hung" in p ? `did not finish in 10 s (${p.hung})` : p.ms < 1000 ? "fast" : `${p.ms.toFixed(0)} ms`,
    "fast",
  );
  check("FIRE  …and it is still REFUSED (a trailing `!` is not an allowed argument)", verdict(p), "refused");
}
{
  const p = probe("npx vitest " + "A:, ".repeat(5000) + "!");
  check(
    "FIRE  5,000 of the same arguments are decided inside 1 s (linear, not merely slower to explode)",
    "hung" in p ? `did not finish in 10 s (${p.hung})` : p.ms < 1000 ? "fast" : `${p.ms.toFixed(0)} ms`,
    "fast",
  );
}

// ── MUST NOT FIRE: what the tail exists to accept ────────────────────────────────────────────────
check("ALLOW a Windows drive-letter test path after npx vitest", verdict(probe("npx vitest C:\\repo\\hooks\\a.test.mjs")), "accepted");
check("ALLOW a drive-letter argument after a node script", verdict(probe("node C:\\repo\\scripts\\check.mjs D:\\out")), "accepted");
check("ALLOW `A:,`-shaped arguments themselves, when nothing refused follows them", verdict(probe("npx vitest " + "A:, ".repeat(40).trim())), "accepted");
check("ALLOW npm run with -- and ordinary flags", verdict(probe("npm run test -- --reporter=dot src/a.test.mjs")), "accepted");

console.log(fails ? `\n${fails} case(s) FAILED` : "\nall cases passed");
process.exit(fails ? 1 : 0);
