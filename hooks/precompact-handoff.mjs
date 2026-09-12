#!/usr/bin/env node
// PreCompact precompact-handoff. Writes a DURABLE handoff file — the armed goal, whether it is proven,
// and the last refusals this project's guards issued — right before the context window is summarised.
// NEVER blocks and never prints a decision.
//
// ── THE INCIDENT CLASS ───────────────────────────────────────────────────────────────────────────
// A long session compacted mid-task. The summary kept the narrative and dropped the two things that
// were load-bearing: the exact stopping command the goal was armed with, and the fact that the fence
// had just refused a `git push origin main` (so the branch was NOT on the remote). The next turn
// re-derived the objective from prose, called the push "done", and the Stop guard was the only thing
// that caught it. A summary is lossy by construction; the state that must survive it belongs in a
// FILE that a `SessionStart` re-injection and a human can read.
//
// ── WHAT THE HOOKS REFERENCE SAYS (https://code.claude.com/docs/en/hooks, read 2026-09-12) ───────
// Fields relied on, verbatim from the reference:
//   • PreCompact input: "In addition to the common input fields, PreCompact hooks receive `trigger`
//     and `custom_instructions`. For `manual`, `custom_instructions` contains what the user passes
//     into `/compact` and is `null` when they pass nothing. For `auto`, `custom_instructions` is
//     `null`." Common fields used: `session_id`, `cwd`, `hook_event_name`.
//   • Matcher: "`manual` — /compact; `auto` — Auto-compact when the conversation reaches the
//     auto-compact window."
//   • Output: "Exit with code 2 to block compaction … You can also block by returning JSON with
//     `"decision": "block"`." and "Claude Code discards a PreCompact hook's `systemMessage` and
//     `continue` fields." The decision-control table lists PreCompact under "Top-level `decision`"
//     with key fields `decision: "block"`, `reason` — NO `additionalContext` row for PreCompact.
//   ⇒ There is no supported way to inject context INTO the compaction from this event. So the
//     mechanism is: write the handoff file and print NOTHING (stdout empty, exit 0 — "empty stdout
//     means no decision"). The goal itself reaches the post-compaction context through goal-guard's
//     SessionStart hook, which the reference says runs again with `source` = `"compact"` ("`compact`
//     after compaction"). This hook makes that re-injection's input durable and adds what the goal
//     record does not hold: the proof state at the moment of compaction and the recent refusals.
//
// ── FAIL DIRECTION ───────────────────────────────────────────────────────────────────────────────
// Everything fails OPEN, because this hook has nothing to fail closed TOWARD: a block here would
// refuse the compaction that keeps the session alive ("If compaction was triggered to recover from a
// context-limit error … the underlying error surfaces and the current request fails"). Garbage stdin,
// an oversize payload, a wrong event, an unreadable goal, an unwritable state dir → exit 0, no
// stdout. A handoff that could not be written is said on STDERR (the operator's debug log), and
// "could not write" is worded differently from "nothing to write".
//
// ── TELEMETRY CAVEAT ─────────────────────────────────────────────────────────────────────────────
// Importing goal-guard.mjs runs its module-scope `recordInvocation("goal-guard.mjs")`, so every
// compaction adds one `run` line to goal-guard's denominator (making it look LESS busy, never more
// trigger-happy — the direction _fire-log.mjs documents as tolerable). The import is deliberate: the
// goal file is keyed by WORKTREE (`goalDir`/`worktreeKey`), and recomputing that key here would be
// the second copy of a slug that must never drift from the first.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectKey, readLog, recordFire, recordInvocation } from "./_fire-log.mjs";
import { goalDir, ledgerVerdict, readGoal, stateRoot, worktreeKey } from "./goal-guard.mjs";

recordInvocation("precompact-handoff.mjs");

/** A PreCompact payload is a few hundred bytes; above this it is not one we recognise. Fail-open. */
export const MAX_EVENT_BYTES = 64 * 1024;
/** How many refusals the handoff carries — the recent ones are the ones a summary would lose. */
export const MAX_REFUSALS = 10;
/** Fire-log verdicts that are refusals. `warn` is advice, not a refusal, and is left out. */
const REFUSAL_VERDICTS = new Set(["deny", "block"]);

/**
 * Where the handoff lives. Beside the goal state, never in the repo (a dirty tree voids gate results):
 *   HOOK_STATE_DIR set  → <HOOK_STATE_DIR>/handoff/<slug>.md      (the hermetic tests)
 *   otherwise           → $XDG_STATE_HOME/claude-hooks/handoff/<slug>.md
 * `<slug>` is goal-guard's worktree key, so a handoff and the goal it describes share one name.
 * @returns {{path:string, slug:string}|null} null when no state root can be resolved
 */
export function handoffPath(env = process.env, cwd = process.cwd()) {
  const slug = worktreeKey(cwd, () => {}).slug; // silent: the keying notice belongs to goal-guard's CLI
  const root = env.HOOK_STATE_DIR ? goalDir(env, cwd) : stateRoot(env);
  if (!root) return null;
  return { path: join(root, "handoff", `${slug}.md`), slug };
}

/**
 * The last refusals recorded for THIS project, oldest first, or a status the caller must not confuse
 * with "none": `{unreadable:true}` when the log could not be read, `{path:null}` when there is no log.
 * @returns {{refusals:Array<{ts:string,hook:string,verdict:string,kind:string}>, unreadable:boolean, path:string|null}}
 */
export function recentRefusals(env = process.env, cwd = process.cwd(), max = MAX_REFUSALS) {
  const log = readLog(env);
  if (log.unreadable || !log.path) return { refusals: [], unreadable: !!log.unreadable, path: log.path };
  const here = projectKey(cwd);
  const mine = log.fires.filter((f) => f.project === here && REFUSAL_VERDICTS.has(f.verdict));
  return { refusals: mine.slice(-max), unreadable: false, path: log.path };
}

/**
 * Pure renderer: the handoff document from already-gathered facts. Everything a test asserts on the
 * file's content can be asserted here without a process.
 * @param {object} facts
 * @param {string} facts.slug
 * @param {"auto"|"manual"|string} facts.trigger
 * @param {boolean} facts.hasInstructions  whether `/compact` was given custom instructions (their
 *   TEXT is not copied — it is the user's message to the summariser, not state, and this file is
 *   read by later sessions)
 * @param {object|null} facts.goal  goal-guard's record, or null when nothing is armed
 * @param {{proven:boolean,why:string}|null} facts.verdict
 * @param {{refusals:object[],unreadable:boolean,path:string|null}} facts.refusals
 * @param {string} facts.sessionId
 * @param {string} facts.cwd
 * @param {string} [facts.now]  ISO timestamp
 */
export function render(facts) {
  const now = facts.now ?? new Date().toISOString();
  const lines = [
    `# Handoff — ${facts.slug}`,
    ``,
    `written:   ${now}`,
    `event:     PreCompact (trigger: ${facts.trigger})`,
    `session:   ${facts.sessionId || "unknown"}`,
    `worktree:  ${facts.cwd}`,
    `/compact instructions: ${facts.hasInstructions ? "given (not copied here — they address the summariser, not the next session)" : "none"}`,
    ``,
    `## Goal (goal-guard)`,
  ];
  if (!facts.goal) {
    lines.push(`no goal armed — nothing was proven or disproven; arm one with \`node .claude/hooks/goal-guard.mjs --set … --done …\``);
  } else {
    lines.push(`GOAL:      ${facts.goal.goal}`);
    if (facts.goal.baseline) lines.push(`BASELINE:  ${facts.goal.baseline}`);
    if (facts.goal.invariant) lines.push(`INVARIANT: ${facts.goal.invariant}`);
    lines.push(`DONE WHEN: ${facts.goal.doneCommand}`);
    lines.push(`ARMED AT:  ${facts.goal.setAt ?? "unknown"}`);
    const v = facts.verdict ?? { proven: false, why: "no verdict could be computed" };
    lines.push(`STATE:     ${v.proven ? "PROVEN" : "UNPROVEN"} — ${v.why}`);
  }
  lines.push(``, `## Last refusals (this project, oldest first, max ${MAX_REFUSALS})`);
  const r = facts.refusals ?? { refusals: [], unreadable: false, path: null };
  if (r.unreadable) lines.push(`fire log could not be read (${r.path}) — this is a read failure, not "no refusals"`);
  else if (!r.path) lines.push(`no fire log path could be resolved — refusals unknown, not absent`);
  else if (r.refusals.length === 0) lines.push(`none recorded in ${r.path}`);
  else for (const f of r.refusals) lines.push(`- ${f.ts}  ${f.hook}  ${f.verdict}  ${f.kind}`);
  lines.push(
    ``,
    `## After compaction`,
    `goal-guard's SessionStart hook re-injects the goal above (source "compact"); PreCompact itself`,
    `cannot inject context (the reference discards \`systemMessage\` and lists no \`additionalContext\`),`,
    `so this file is the durable copy. Re-measure before acting: a handoff is a lead, not an instruction.`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Gather the facts for one event and write the file. Returns what was written (for tests) or null
 * with a reason. Never throws.
 * @returns {{path:string, body:string}|{path:string|null, error:string}}
 */
export function writeHandoff(ev, env = process.env) {
  const cwd = typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();
  const target = handoffPath(env, cwd);
  if (!target) return { path: null, error: "no state root (set HOOK_STATE_DIR, XDG_STATE_HOME or HOME)" };
  const goal = readGoal(env, cwd);
  const verdict = goal ? ledgerVerdict(goal, env, cwd) : null;
  const body = render({
    slug: target.slug,
    trigger: typeof ev.trigger === "string" ? ev.trigger : "unknown",
    hasInstructions: typeof ev.custom_instructions === "string" && ev.custom_instructions.length > 0,
    goal,
    verdict,
    refusals: recentRefusals(env, cwd),
    sessionId: typeof ev.session_id === "string" ? ev.session_id : "",
    cwd,
  });
  try {
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, body);
  } catch (e) {
    return { path: target.path, error: `could not write ${target.path}: ${e.message}` };
  }
  return { path: target.path, body };
}

function main() {
  let ev;
  try {
    const input = readFileSync(0);
    if (input.length > MAX_EVENT_BYTES) return; // fail-open: not a PreCompact payload we recognise
    ev = JSON.parse(input.toString("utf8"));
  } catch {
    return; // fail-open: nothing to hand off from an unreadable event
  }
  if (!ev || typeof ev !== "object" || ev.hook_event_name !== "PreCompact") return;
  let result;
  try {
    result = writeHandoff(ev, process.env);
  } catch (e) {
    result = { path: null, error: `unexpected: ${e && e.message}` };
  }
  if (result.error) {
    // stderr on exit 0 is the operator's debug log, never the model's — the right audience for
    // "the handoff was NOT written", which must not read like "nothing to hand off".
    process.stderr.write(`precompact-handoff: NOT written — ${result.error}\n`);
    return;
  }
  // The single fire line: this hook "fires" by writing. `kind` is a constant, never a path.
  recordFire("precompact-handoff.mjs", "write", "handoff-written");
  // No stdout, ever: a PreCompact stdout is a `decision`, and this hook has none.
}

// basename compare (not a full-URL compare): on Windows argv[1] is a backslash path.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
