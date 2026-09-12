#!/usr/bin/env node
// bench — the per-call cost of each guard, measured, not recalled.
//
// Every PreToolUse guard is a fresh Node process on every matching tool call, so the number that
// decides whether a guard stays installed is its wall time on a BENIGN event (the common case), not
// its time on the incident. This spawns each hook N times with a benign event of its own type, and
// `node -e 0` the same way as the floor, and prints p50/p95 as a markdown table. See docs/BENCH.md.
//
//   node scripts/bench.mjs            # N=30
//   node scripts/bench.mjs --n 100
//
// Runs are tagged HOOK_CTX=test and pointed at a throwaway fire log and state dir, so a bench never
// inflates the live denominator that `agent-guardrails report` reads.
import { spawnSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { scratchDir } from "../hooks/_scratch-dir.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOKS = join(ROOT, "hooks");
const argv = process.argv.slice(2);
const nIdx = argv.indexOf("--n");
const N = nIdx === -1 ? 30 : Number(argv[nIdx + 1]);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--n") { i++; continue; }
  if (argv[i] !== "--json") {
    console.error(`bench: unknown option ${argv[i]}`);
    process.exit(1);
  }
}
if (!Number.isInteger(N) || N < 1) {
  console.error("bench: --n must be a positive integer");
  process.exit(1);
}

const scratch = scratchDir("agent-guardrails-bench");
const cwd = scratch;
const base = { session_id: "bench", transcript_path: "", cwd };
const bash = (command) => ({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

// Enumerate registrations, not a second hand-maintained list of guard names.
// For write-tool alternatives we sample Edit only; this is startup/common-path cost,
// not a coverage claim about every tool or every rule within a guard.
const configuration = readFileSync(join(ROOT, "settings.example.json"));
const CASES = Object.entries(JSON.parse(configuration).hooks).flatMap(([event, groups]) =>
  groups.flatMap(group => group.hooks.map(registration => {
    const tool = event === "PreToolUse" ? group.matcher.split("|")[0] : null;
    const hook = registration.args[0].split("/").at(-1);
    if (registration.command !== "node" || !/^[\w-]+\.mjs$/.test(hook))
      throw new Error(`bench: unsupported registration for ${event}`);
    const ev = tool === "Bash" ? bash("npm test") : {
      ...base, hook_event_name: event, stop_hook_active: false,
      last_assistant_message: "Still looking.",
      ...(tool ? { tool_name: tool, tool_input: { file_path: join(cwd, "README.md") } } : {}),
    };
    return { hook, ev, event: tool ? `${event}·${tool}` : event };
  })),
);
const env = {
  ...process.env,
  HOOK_CTX: "test",
  HOOK_FIRE_LOG: join(scratch, "fires.log"),
  HOOK_STATE_DIR: join(scratch, "goals"),
};
delete env.CLAUDE_HOOKS_QUIET; // a quiet session would measure an early return, not the guard

function timeOnce(args, input) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, args, { input, encoding: "utf8", env, cwd, timeout: 15000 });
  const ms = performance.now() - t0;
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  if (r.stdout.trim()) {
    const response = JSON.parse(r.stdout);
    if (response.decision === "block" || response.hookSpecificOutput?.permissionDecision === "deny")
      throw new Error(`bench: benign event was refused by ${args[0]}`);
  }
  return ms;
}

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function sample(label, args, input) {
  timeOnce(args, input); // one warm-up, discarded: the OS page cache is not what is being measured
  const t = [];
  for (let i = 0; i < N; i++) t.push(timeOnce(args, input));
  t.sort((a, b) => a - b);
  return { label, samples: t, p50: percentile(t, 50), p95: percentile(t, 95), min: t[0], max: t[t.length - 1] };
}

const rows = [];
try {
  rows.push({ event: "—", ...sample("node -e 0 (baseline)", ["-e", "0"], "") });
  for (const c of CASES)
    rows.push({ event: c.event, ...sample(c.hook, [join(HOOKS, c.hook)], JSON.stringify(c.ev)) });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const baseline = rows[0].p50;
if (argv.includes("--json")) {
  console.log(JSON.stringify({
    schemaVersion: 1, measuredAt: new Date().toISOString(),
    configurationSha256: createHash("sha256").update(configuration).digest("hex"),
    node: process.version, platform: platform(), release: release(), arch: arch(),
    samplesPerRow: N, warmupsPerRow: 1, unit: "milliseconds", rows,
  }, null, 2));
  process.exit(0);
}
const f = (x) => x.toFixed(1);
console.log(`command: node scripts/bench.mjs${nIdx === -1 ? "" : ` --n ${N}`}`);
console.log(`date: ${new Date().toISOString().slice(0, 10)} · os: ${platform()} ${release()} ${arch()} · node: ${process.version} · N=${N} per row (+1 warm-up)`);
console.log("");
console.log("| hook | event | p50 ms | p95 ms | min | max | p50 − baseline |");
console.log("|---|---|---:|---:|---:|---:|---:|");
for (const r of rows)
  console.log(`| ${r.label} | ${r.event} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.min)} | ${f(r.max)} | ${r === rows[0] ? "—" : f(r.p50 - baseline)} |`);
const bashRows = rows.filter((r) => r.event === "PreToolUse·Bash");
const bashSum = bashRows.reduce((a, r) => a + r.p50, 0);
console.log("");
console.log(
  `Bash tool call, sum of the ${bashRows.length} Bash-matched guards' p50 if run serially: ${f(bashSum)} ms; ` +
    `This is not measured host latency: parallel scheduling and resource contention are not modeled.`,
);
