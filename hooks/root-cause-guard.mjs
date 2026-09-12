#!/usr/bin/env node
/**
 * root-cause-guard — a FIX aimed at a named crash must be aimed by an ARTIFACT, not by a theory.
 *
 * ── THE FAILURE CLASS (one incident, three wrong fixes) ──────────────────────────────────────────
 * An internal dashboard answered "A server error occurred" on every load. The log repeated
 *     TypeError: 861014.startsWith is not a function
 * Three fixes were authored, shipped or nearly shipped, each aimed at a DIFFERENT plausible
 * `.startsWith` call found by READING CODE:
 *
 *   1. a helper in the actions module      — guard deployed to staging; the crash CONTINUED.
 *   2. a predicate two files over          — PR opened; the function has ZERO callers.
 *   3. "a numeric key in the database"     — asserted in a commit message and a message to a
 *                                            colleague; the query returned ZERO such rows.
 *
 * The actual cause was found in ninety seconds once the DEPLOYED BYTES were read: the stack named
 * an SSR chunk and three offsets, and the chunk literally contained
 *     if (861014..startsWith(a)) …
 * — the bundler had inlined a module id where a resolved path string belonged. No amount of reading
 * source could have found it, because THE SOURCE WAS CORRECT; the bundle was not.
 *
 * Cost: hours, two dead PRs, and one wrong explanation sent to the engineer whose page was down.
 *
 * ── WHAT THIS GUARD DOES, AND THE LINE IT WILL NOT CROSS ─────────────────────────────────────────
 * It cannot know whether a diagnosis is right — a hook sees the command, never the conclusion. So
 * this guard checks one MECHANICAL thing: when a commit or PR body CLAIMS to fix a runtime error
 * that was quoted from a log, does the same body carry EVIDENCE THAT THE SITE WAS LOCATED — a stack
 * frame, a deployed artifact, a query result — or only prose?
 *
 * FIRES on a commit/PR whose message contains a quoted runtime error (`TypeError: …`,
 * `ReferenceError: …`, `is not a function`, `Cannot read propert…`) AND names no locating evidence.
 * Locating evidence is any of: a stack frame (`at …:line:col` or a `.js:N:N` offset), a chunk or
 * bundle path, an explicit "measured"/"read the deployed"/"query returned" phrase with a number, or
 * a test name that reproduces it.
 *
 * DOES NOT FIRE on: a fix with no quoted runtime error (most commits), a defensive-hardening commit
 * that SAYS it is defensive, a revert, or any body that already carries a frame/offset/artifact.
 *
 * ⚠ IT IS A PROMPT, NOT A BLOCK. It exits 0 with a warning on stderr, because the honest answer to
 * "did you locate this?" is sometimes "no, and I am shipping a guard anyway" — which is legitimate
 * when SAID OUT LOUD (both wrong guards above were reasonable as hardening; they were dishonest as
 * fixes). What it refuses to allow is the silent version.
 */
import { readFileSync } from "node:fs";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

// Instrumented so the fire log can SEE this guard: a guard whose zero is unreadable can never be
// pruned on evidence, only on a guess.
recordInvocation("root-cause-guard.mjs");

/** A runtime error quoted from a log — the shape that means "something crashed in production". */
const QUOTED_ERROR =
  /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b\s*:|is not a function|Cannot read propert|of undefined|of null\b/;

/** Evidence that the SITE was located, not guessed. Any ONE of these is enough. */
const LOCATING_EVIDENCE = [
  // A stack frame, in either shape node prints:
  //   at foo (Table.tsx:88:12)      ← named frame, any extension (caught by its own test)
  //   at /abs/path/file.js:1:15825  ← bare frame
  /\bat\s+[^\n]*?[\w./\\-]+\.[a-z]{2,4}:\d+:\d+/i,
  /[\w./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx):\d+:\d+/i, // a bundle/source offset anywhere
  /chunks?\/|\.next\/server\/|bundle\b|deployed bytes|deployed image|pulled the (running )?image/i,
  /\b(query|scan|probe|grep|count)\b[^.\n]{0,60}\b(returned|reported|shows?|found)\b[^.\n]{0,40}\d/i,
  /\breproduc(es|ed|ing)\b[^.\n]{0,40}\btest\b/i,
  /\bcontrol (run|case)\b/i,
];

/** An honest self-declaration that this is hardening rather than a located fix. */
const DECLARED_DEFENSIVE =
  /\bdefensive\b|\bhardening\b|\bbelt and braces\b|\bdoes not (claim to )?(fix|locate)\b|\bsite (is )?(not|un)(known|located)\b/i;

export function verdict(body) {
  const text = String(body ?? "");
  if (!QUOTED_ERROR.test(text))
    return { fire: false, why: "no quoted runtime error" };
  if (DECLARED_DEFENSIVE.test(text))
    return { fire: false, why: "declares itself defensive" };
  if (LOCATING_EVIDENCE.some((re) => re.test(text)))
    return { fire: false, why: "carries locating evidence" };
  return {
    fire: true,
    why: "quotes a runtime error but names no stack frame, no artifact, and no query result",
  };
}

function main() {
  let ev = {};
  try {
    ev = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0); // fail-open: a guard that crashes must not block the session
  }
  const cmd = String(ev?.tool_input?.command ?? "");
  // A commit, or a pull/merge request opened from a forge CLI (`gh pr create`, or any `<cli> mr create`).
  if (!/git\s+commit|\b\w+\s+(?:mr|pr)\s+create\b/.test(cmd))
    process.exit(0);

  const v = verdict(cmd);
  if (!v.fire) process.exit(0);

  // A PROMPT, not a block — recorded with verdict "warn" so the log never implies this guard
  // refused anything.
  recordFire("root-cause-guard.mjs", "warn", "root-cause-evidence-missing");
  process.stderr.write(
    `\n⚠ ROOT-CAUSE EVIDENCE MISSING — this message quotes a runtime error and claims a fix, but\n` +
      `  names no stack frame, no deployed artifact, and no query result.\n\n` +
      `  This has gone wrong before: three fixes were aimed at three different plausible call sites\n` +
      `  found by reading source. All three were wrong; the crash was in the BUNDLE, not the source,\n` +
      `  and it took ninety seconds to find once the deployed chunk was read at the offsets the\n` +
      `  stack named.\n\n` +
      `  Either LOCATE it — read the stack's file:line:col, pull the deployed artifact, run the query\n` +
      `  and quote the count — or SAY it is defensive hardening. Both are fine. Silence is not.\n`,
  );
  process.exit(0); // prompt, never a block — see the header
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
)
  main();
