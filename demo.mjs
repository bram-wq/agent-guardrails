#!/usr/bin/env node
// 60-second demo: feed each guard the same JSON Claude Code sends a PreToolUse hook, once with a command
// that MUST be refused and once with its legitimate twin that MUST pass. Run: `node demo.mjs`
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "hooks");
const CASES = [
  ["runaway-guard",       "yes for sure",                         "yes | head -3"],
  ["prose-guard",         "please run the tests again",           "npm test"],
  ["piped-verdict-guard", "git push origin main 2>&1 | tail -2",   "git push origin main"],
  ["piped-verdict-guard", "git merge --no-ff topic 2>&1 | tail -3", "npm test 2>&1 | tail -5"],
];

function run(hook, command) {
  const r = spawnSync("node", [join(HOOKS, `${hook}.mjs`)], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8",
  });
  try {
    const out = JSON.parse(r.stdout || "{}");
    const d = out.hookSpecificOutput?.permissionDecision;
    return { decision: d === "deny" ? "REFUSED" : "allowed", reason: out.hookSpecificOutput?.permissionDecisionReason ?? "" };
  } catch { return { decision: "allowed", reason: "" }; }
}

let failures = 0;
for (const [hook, bad, good] of CASES) {
  const a = run(hook, bad), b = run(hook, good);
  const okA = a.decision === "REFUSED", okB = b.decision === "allowed";
  if (!okA || !okB) failures++;
  console.log(`\n${hook}`);
  console.log(`  ${okA ? "✔" : "✘"} must-fire      ${JSON.stringify(bad).padEnd(44)} → ${a.decision}`);
  if (a.reason) console.log(`      reason: ${a.reason.split("\n")[0].slice(0, 110)}`);
  console.log(`  ${okB ? "✔" : "✘"} must-not-fire  ${JSON.stringify(good).padEnd(44)} → ${b.decision}`);
}
console.log(failures ? `\n${failures} case(s) misbehaved` : "\nEvery guard fired where it must and stayed silent where it must not.");
process.exit(failures ? 1 : 0);
