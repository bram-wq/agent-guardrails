#!/usr/bin/env node
// PreToolUse runaway-guard (fail-open). DENIES commands that generate output FOREVER by construction.
//
// THE INCIDENT CLASS. An operator answered a yes/no question with "yes for sure". It reached the shell,
// where `yes` is a real command that prints its argument until killed. It wrote gigabytes before the
// harness stopped it. Nothing was corrupted, but the disk churned, the answer never arrived, and the
// session spent a round recovering from a two-word confirmation.
//
// The lesson is NOT "type more carefully". A human confirming something should never be able to fill a
// disk, and the class is broader than one word: `yes`, `cat /dev/urandom`, `cat /dev/zero`, an endless
// `seq`, `while true` echoing — each produces infinite stdout with no natural stop.
//
// WHAT MAKES A GENERATOR SAFE: a BOUND. `yes | head -3`, `head -c 1M /dev/urandom`, `timeout 2 yes` are
// all fine and common — the consumer or the clock stops them. So this denies an unbounded generator ONLY
// when nothing in its command bounds it. That distinction is the whole guard; without it this would block
// `yes | apt-get install` and get switched off within a day, which is how a guard stops protecting.
//
// Scope is deliberately narrow. This is not a general "dangerous command" filter — a separate
// destructive-command guard owns that. It closes exactly one hole: infinite output from a shell that was
// handed prose.
//
// FAIL-OPEN: any parse error exits 0 and allows. A guard bug must never block real work.
import { readFileSync } from "node:fs";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("runaway-guard.mjs");

// Generators that never stop on their own. Anchored at a command boundary so `git log --grep=yes`,
// `npm run yes-man`, and a path like ./yesod are untouched.
const INFINITE = [
  { re: /(^|[;&|]\s*)yes\b/, what: "`yes` prints forever until killed" },
  {
    re: /(^|[;&|]\s*)(cat|dd\b[^\n]*\bif=)\s*[^\n]*\/dev\/(urandom|random|zero)/,
    what: "reading /dev/urandom|random|zero never reaches EOF",
  },
  {
    // `seq` is infinite ONLY with an `inf`/`infinity` operand (`seq inf`, `seq 1 inf`, `seq 1 2 inf`).
    // `seq 5` counts 1..5 and exits — it is finite, and denying it was a false positive that blocked
    // real work. Leading tokens absorb flags (`seq -w 1 inf`) but not a redirect, so
    // `seq 1 5 > inf.txt` is untouched.
    re: /(^|[;&|]\s*)seq\s+([-\w.]+\s+)*-?inf(inity)?\b/,
    what: "`seq … inf` counts up forever",
  },
  {
    re: /(^|[;&|]\s*)(while\s+(true|:)|for\s*\(\(\s*;\s*;\s*\)\))/,
    what: "an unconditional loop with no break",
  },
];

// Anything that stops an infinite stream: a bounding consumer, a byte/line cap, or a clock.
// `head`/`tail -n`/`sed q`/`awk exit`/`timeout`/`-c N` all qualify.
const BOUNDED =
  /\|\s*(head|sed\s+-n[^|]*q|awk[^|]*exit|grep\s+-m\s*\d+|tail\s+-n\s*\d+)\b|(^|\s)timeout\s+\d|(^|\s)-c\s*\d|\bcount=\d|\bhead\s+-c\b/;

function deny(reason) {
  recordFire("runaway-guard.mjs", "deny", "runaway");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

try {
  const ev = JSON.parse(readFileSync(0, "utf8"));
  if (ev.tool_name !== "Bash") process.exit(0);
  const cmd = String((ev.tool_input && ev.tool_input.command) || "");
  if (!cmd) process.exit(0);

  const hit = INFINITE.find((g) => g.re.test(cmd));
  if (!hit) process.exit(0);
  if (BOUNDED.test(cmd)) process.exit(0); // bounded → the common, legitimate form

  deny(
    `Runaway output: ${hit.what}, and nothing in this command bounds it. A two-word answer like ` +
      `"yes for sure" has reached the shell this way before and wrote gigabytes before it was killed.\n\n` +
      `If you meant to run it, add a bound — \`| head -n 20\`, \`head -c 1M\`, or \`timeout 5 …\`.\n` +
      `If you were answering a question rather than running a command, just send the words without the ` +
      `leading \`!\`.`,
  );
} catch {
  /* fail-open */
}
process.exit(0);
