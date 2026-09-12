#!/usr/bin/env node
// PreToolUse __NAME__ (Bash). Scaffolded by `agent-guardrails new __NAME__`.
//
// THE INCIDENT: <quote the exact command that reached the shell and what it cost — one or two lines.
// That text is the first must-fire case in __NAME__.test.mjs; if you cannot quote it, this guard
// is not ready to exist yet.>
//
// THE TWIN: <the command that looks the same and is fine. It is the first must-not-fire case, and a
// guard with no twin gets switched off the first week it blocks real work.>
//
// FAIL DIRECTION. The harness fails OPEN: garbage stdin, a missing field, any exception → exit 0 with
// no output, because a guard that bricks a session is worse than no guard. The decision fails CLOSED:
// a payload over MAX_EVENT_BYTES is refused with a reason that says it was NOT scanned, because a
// hook killed at its timeout is treated as a pass and "could not check" must never print the same as
// "checked, fine". stdout is written at most ONCE and the process exits naturally — process.exit()
// after a write can truncate the deny payload into an accidental allow.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

// The denominator: recorded at module scope so "this guard never fires" is a measured claim.
recordInvocation("__NAME__.mjs");

// Above this the command is refused unscanned rather than risking the hook's timeout.
export const MAX_EVENT_BYTES = 64 * 1024;

// The incident, as a pattern anchored at a command boundary so a word inside an argument or a path
// is untouched. Replace `replace-me-with-the-incident` with the real shape.
const INCIDENT = /(^|[;&|]\s*)replace-me-with-the-incident\b/;

/**
 * Pure decider: the command string in, a deny reason out, or null to allow. Everything a test needs
 * to assert lives here, with no stdin and no process — the harness below is only plumbing.
 * @param {string} command
 * @returns {string|null}
 */
export function decide(command) {
  const cmd = String(command ?? "");
  if (!cmd) return null;
  if (!INCIDENT.test(cmd)) return null;
  return (
    `__NAME__: <say what this command does, why it went wrong before, and what it cost>.\n\n` +
    `<Carry the fix in the reason: the exact rewrite that is safe, so the next turn can act on it.>`
  );
}

// ONE write, then fall off the end. `kind` is a source-authored constant — never the command or the
// reason, which could put a secret on disk.
function deny(reason) {
  recordFire("__NAME__.mjs", "deny", "__NAME__");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

function main() {
  let input;
  try {
    input = readFileSync(0);
  } catch {
    return; // fail-open: nothing to scan is not a finding
  }
  if (input.length > MAX_EVENT_BYTES) {
    deny(
      `__NAME__: the hook payload is ${input.length} bytes, over the ${MAX_EVENT_BYTES}-byte cap, so the ` +
        `command was NOT scanned. Write the large content to a file and run a short command against it.`,
    );
    return;
  }
  let ev;
  try {
    ev = JSON.parse(input.toString("utf8"));
  } catch {
    return; // fail-open: an unparseable event carries nothing to be wrong about
  }
  if (!ev || ev.tool_name !== "Bash") return;
  let reason = null;
  try {
    reason = decide(ev.tool_input && ev.tool_input.command);
  } catch {
    reason = null; // fail-open: a bug in the decider must never block real work
  }
  if (reason) deny(reason);
  // exit naturally so stdout drains
}

// basename, not a full-URL compare: on Windows argv[1] is a backslash path and the URL compare never
// matched, so the hook exited silently with no verdict.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
