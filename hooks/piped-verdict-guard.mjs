#!/usr/bin/env node
// PreToolUse piped-verdict-guard (Bash). DENIES a command whose VERDICT is thrown away by a pipe.
//
// THE DEFECT (seen twice in ONE session). In bash, `$?` after a pipeline is the exit status of the LAST
// stage, not of the command whose answer you wanted. The shape that shipped was:
//
//     git push … 2>&1 | grep -v … | tail -8
//
// `grep -v` dropped the failure lines and `tail` exited 0, so the turn read as a clean push. The push had
// in fact been BLOCKED and the branch never reached the remote. A merge request was then reported as
// ready, pointing at a branch that did not exist, and the reviewer pressed a button that failed. Both
// occurrences were committed while trying to keep OUTPUT SHORT — which is the real trap: the truncating
// filter is added for readability and silently takes the verdict with it.
//
// This is the dominant defect class of agent shell work arriving through shell semantics rather than
// through our own code: "empty" and "couldn't find out" printing the same sentence.
//
// ── WHY THIS DENIES RATHER THAN WARNS ────────────────────────────────────────────────────────────────
// A warning nobody reads is worth nothing, and this one would arrive exactly when attention is elsewhere
// (the agent is truncating output because it wants the answer, not the transcript). A deny costs one turn
// and the replacement is mechanical. What makes a deny safe is that every command it refuses has a form
// it allows which runs the SAME processes and additionally surfaces the real status — `rc=${PIPESTATUS[0]}`
// in the next statement, or a redirect-then-check. The escape hatch is "write the correct command", not
// "switch the guard off".
//
// ⚠ Do NOT overstate that. Appending `; echo "EXIT=$rc"` does not change what RUNS, but it does change
// the COMPOUND command's own exit status to the last command's — so a rewrite is not status-preserving
// for anything chaining off it with `&&`. The deny message says so and prints `rc=` capture rather than
// a bare `echo "$?"` for that reason.
//
// ── FALSE POSITIVES MATTER MORE THAN MISSES HERE ─────────────────────────────────────────────────────
// Piping is ubiquitous and almost always harmless. A guard that fires on every pipe is disabled inside a
// day, and a disabled guard is worse than none. So the rule is narrow at both ends and must satisfy all
// three conditions at once:
//   1. the pipeline's FIRST command is verdict-bearing — its exit code IS the answer (see below);
//   2. the pipeline's LAST command is a PURE output filter — one that discards status rather than
//      producing it (`grep -q`, `jq -e` and `sed 'q1'` produce a verdict on purpose and are NOT this);
//   3. the real status is not recovered — no `${PIPESTATUS[0]}` in the very next statement, and no
//      `set -o pipefail` in force at that point.
//
// ── THE SCOPE IS MEASURED, NOT ASSERTED ──────────────────────────────────────────────────────────────
// Every Bash tool call in a corpus of local transcripts (~6,000 commands, ~4,700 containing a pipe) was
// run through candidate rules. A first draft that treated every build/test/gate script as
// verdict-bearing would have denied ~16% of all history; "git writes only" ~3%. What ships is narrower
// still: `git push` / `git merge` / `git rebase` ONLY. Live telemetry on the wider rule showed thousands
// of runs for a dozen fires, each fire costing the operator a re-typed command while CI — not the local
// run — was the verdict that gated the merge. The guard was narrowed to the ONE measured origin defect:
// a push whose failure was masked by `| grep -v | tail`. A masked `git merge` / `git rebase` is the same
// defect on the same object (the branch's own history), so those two stay with it. Everything else a
// pipe can hide is a LOCAL verdict that CI re-judges anyway.
//
// ── WHAT IS DELIBERATELY LET THROUGH ─────────────────────────────────────────────────────────────────
//   • `npm run test | lint | build`, `npx vitest`, gate scripts, release scripts — local verdicts. A
//     masked red here costs one wrong sentence in a transcript and is re-judged by CI before anything
//     merges.
//   • `git cherry-pick` / `git am` — neither shipped an incident, and the rule is to deny the measured
//     defect, not its neighbours.
//   • Cloud-CLI reads piped to `head`/`jq`/`tr` — the single biggest family. The OUTPUT is the answer,
//     and a failed call prints its error to stderr, which the Bash tool shows.
//   • Generic `npx` / `pnpm` / `yarn` / `turbo`, and generic `bash scripts/*`.
//   • Any pipeline whose head is a READ — `git log | head`, `git status --porcelain | wc -l`, `ls | head`,
//     `rg pat | head`. The output is the answer and the exit code carries nothing. This is the
//     overwhelming majority of piping, and firing on it is what gets a guard deleted.
//   • A verdict-bearing command in a NON-HEAD position (`echo x | git push | tail`).
//   • A last stage that is not an output filter (`npm run x | mail -s`, `… | xargs …`).
//   • Quoted text and heredoc bodies are NOT stripped by a full shell parser. This hook does not need one
//     because a MISS here costs a warning that did not fire, never a security bypass. The scanner is
//     quote-aware only far enough to avoid SPLITTING on a `|` inside quotes — `grep -E 'a|b'` must not
//     fabricate a pipeline stage — and NEWLINES end a statement, which neutralises heredoc bodies.
//
// FAIL-OPEN on any error (exit 0), like every guard here: a hook bug must never brick real work.
// CLAUDE_HOOKS_QUIET=1 lifts it — this one blocks, so its escape valve must work. Both test runners strip
// the variable so it can never hide a green.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("piped-verdict-guard.mjs");

// ── Commands whose EXIT CODE is the answer ───────────────────────────────────────────────────────────
// Small tables rather than one regex, so every entry is separately readable and nothing spans.

// "Did it land?" is answered by the exit code and by nothing else. `git log`, `git status`, `git diff`,
// `git show`, `git merge-base` are READS whose OUTPUT is the answer, and are deliberately absent.
// This set IS the guard: the measured incident was a masked push, and a masked merge or rebase is the
// same defect on the same object. Nothing else is denied — see the header.
const GIT_VERDICT_SUBS = new Set(["push", "merge", "rebase"]);

// ── Pure output filters — stages that DISCARD status rather than producing it ────────────────────────
// `tee` is included on purpose: it preserves the text but still discards the status, and the rewrite
// keeps both. See isPureFilter() for the stages that are excluded because they own the verdict.
const FILTERS = new Set([
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "wc",
  "cut",
  "sed",
  "awk",
  "sort",
  "uniq",
  "tr",
  "column",
  "jq",
  "less",
  "more",
  "cat",
  "tee",
  "fold",
  "nl",
  "od",
  "xxd",
]);
const GREPS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

// `set -o pipefail` / `-eo` / `-euo pipefail` turn a pipeline's status into the rightmost failure, so the
// verdict survives. `set +o pipefail` turns it back off. Both are matched against a single STATEMENT, so
// a `pipefail` merely MENTIONED (`echo pipefail`, a commit message, a grep pattern) cannot enable it.
const PIPEFAIL_ON = /(?:^|[\s(])set\s+-[a-z]*o\s+pipefail\b/;
const PIPEFAIL_OFF = /(?:^|[\s(])set\s+\+[a-z]*o\s+pipefail\b/;

/**
 * Split a command into STATEMENTS, each a list of pipeline SEGMENTS.
 *
 * ONE left-to-right pass. There is deliberately no regex here at all: superlinear blow-ups in guards
 * come from a regex that can begin matching at many positions and re-walk the same run from each. A
 * single character scan has no start positions to restart from, so this is O(n) by construction rather
 * than by measurement.
 *
 * Statement separators: `;`  `&&`  `||`  `&`  newline. A NEWLINE really is a statement terminator, and
 * that detail is load-bearing twice over: it keeps a multi-line block from being read as one pipeline, and
 * it means a heredoc BODY containing a `|` cannot fabricate a stage on the introducer's pipeline.
 * Pipe separators: `|` and `|&`.
 *
 * ⚠ `&` is NOT always a separator — `2>&1` and `&>f` are redirects, and getting this wrong silently
 * disarms the guard on the exact command that motivated it: splitting `git push … 2>&1 | tail` at the `&`
 * leaves the head segment `git push … 2>` and a second statement `1 | tail`, whose head is `1`. Neither
 * fires. So a `&` adjacent to a `>` on either side stays literal.
 *
 * @param {string} s
 * @returns {string[][]} statements → segments
 */
export function splitStatements(s) {
  const n = s.length;
  const statements = [];
  let segs = [];
  let cur = "";
  let prevSig = ""; // last non-whitespace character consumed as ordinary text
  const endSeg = () => {
    segs.push(cur);
    cur = "";
  };
  const endStmt = () => {
    endSeg();
    statements.push(segs);
    segs = [];
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    // A backslash escape hides whatever follows from every rule below, exactly as the shell does.
    if (ch === "\\" && i + 1 < n) {
      cur += ch + s[i + 1];
      prevSig = s[i + 1];
      i += 2;
      continue;
    }
    // Quoted runs are copied VERBATIM. The point is only to stop a `|` or `;` inside quotes from
    // splitting: `grep -E 'a|b'` is ONE stage and `git commit -m "a; b"` is ONE statement. An
    // unterminated quote runs to the end, which keeps the text rather than guessing.
    if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      const end = e === -1 ? n : e + 1;
      cur += s.slice(i, end);
      prevSig = "'";
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, n);
      cur += s.slice(i, end);
      prevSig = '"';
      i = end;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endStmt();
      prevSig = "";
      i++;
      continue;
    }
    if (ch === "&") {
      if (s[i + 1] === "&") {
        endStmt();
        prevSig = "";
        i += 2;
        continue;
      }
      // `&>file` and `2>&1` — a redirect, not a separator. See the ⚠ above; this one line is the
      // difference between the guard firing on the measured incident and never seeing it.
      if (s[i + 1] === ">" || prevSig === ">") {
        cur += ch;
        prevSig = ch;
        i++;
        continue;
      }
      endStmt();
      prevSig = "";
      i++;
      continue;
    }
    if (ch === "|") {
      if (s[i + 1] === "|") {
        endStmt();
        prevSig = "";
        i += 2;
        continue;
      }
      if (s[i + 1] === "&") {
        endSeg(); // `|&` is a pipe that also carries stderr
        prevSig = "";
        i += 2;
        continue;
      }
      endSeg();
      prevSig = "";
      i++;
      continue;
    }
    cur += ch;
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  endStmt();
  return statements;
}

/**
 * The command word of a segment, plus its whitespace tokens.
 *
 * Strips the wrappers that sit BEFORE the real command: subshell/group openers, `$( … )`, a `VAR=value`
 * prefix, and the transparent modifiers (`time`, `sudo`, `command`, `nohup`, `exec`, `!`). Every pattern
 * is anchored at `^` and the loop is bounded, so this cannot become the thing it is guarding against.
 *
 * `VAR=$( …` is handled BEFORE the plain-assignment rule on purpose: the plain rule's value pattern would
 * otherwise swallow `$(npm` as the value and hand back `run` as the command word.
 *
 * @param {string} seg
 * @returns {{ word: string, toks: string[] }}
 */
export function commandWordOf(seg) {
  let s = seg.trim();
  for (let k = 0; k < 8; k++) {
    const before = s;
    s = s.replace(/^\w+=(?=[$`])/, ""); // VAR=$( … )  /  VAR=` … `  → keep the substitution
    s = s.replace(/^\$\(\s*/, ""); // $( …
    s = s.replace(/^[({`]+\s*/, ""); // ( …   { …   ` …
    s = s.replace(/^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/, ""); // VAR=value cmd
    s = s.replace(/^(?:!|time|command|nohup|sudo|exec)\s+/, ""); // transparent prefixes
    if (s === before) break;
  }
  const toks = s.split(/\s+/).filter(Boolean);
  // Basename, so `/usr/bin/git` and `./node_modules/.bin/vitest` are still their command word.
  const word = (toks[0] ?? "").split("/").pop() ?? "";
  return { word, toks };
}

/** First token after the command word that is not a flag. `-c k=v` / `-C dir` swallow the next token. */
function firstOperand(toks, from = 1) {
  for (let k = from; k < toks.length; k++) {
    const t = toks[k];
    if (t[0] !== "-") return t;
    if (t === "-c" || t === "-C") k++; // consumes its argument, whatever it is
  }
  return "";
}

/**
 * Is this LAST stage a pure output filter — one that throws the status away?
 *
 * The distinction is not cosmetic. `git push … | grep -q 'up-to-date'` deliberately makes grep the
 * verdict producer, and denying it would be a false positive on a correct command — the direction that
 * gets a guard deleted. Same for `jq -e`, `sed 'q1'` and an awk program that calls `exit`.
 *
 * @param {{word:string, toks:string[]}} h
 * @returns {boolean}
 */
export function isPureFilter(h) {
  const { word, toks } = h;
  if (!FILTERS.has(word)) return false;
  const rest = toks.slice(1);
  const hasShort = (letter) =>
    rest.some((t) => /^-[a-zA-Z]+$/.test(t) && t.includes(letter));
  if (GREPS.has(word)) {
    if (hasShort("q")) return false;
    if (rest.some((t) => t === "--quiet" || t === "--silent")) return false;
  }
  if (word === "jq") {
    if (hasShort("e")) return false;
    if (rest.some((t) => t === "--exit-status")) return false;
  }
  // `sed 'q1'` / `sed -n '/x/q3'` exit with a chosen status; a plain `q` still exits 0.
  if (word === "sed" && rest.some((t) => /q[1-9]/.test(t))) return false;
  // An awk program calling exit chooses the status.
  if (word === "awk" && rest.some((t) => /\bexit\b/.test(t))) return false;
  return true;
}

/**
 * Is this segment's command one whose EXIT CODE is the answer? Returns a human label, or null.
 * Only `git push` / `git merge` / `git rebase` qualify. The npm / vitest / gate-script arms that once
 * stood here are gone, and their must-NOT-fire cases in the test pin that.
 * @param {{word:string, toks:string[]}} h
 * @returns {string|null}
 */
export function verdictOf(h) {
  const { word, toks } = h;
  if (word !== "git") return null;
  const sub = firstOperand(toks);
  return GIT_VERDICT_SUBS.has(sub) ? `git ${sub}` : null;
}

/**
 * Pure decision. Returns null to ALLOW, or the finding to deny on.
 *
 * ⚠ RECOVERY IS CHECKED PER STATEMENT, not against the whole command. An earlier draft did
 * `if (cmd.includes("PIPESTATUS")) return null;`, which independent reviewers flagged as a real bypass:
 * an unrelated `${PIPESTATUS[0]}` ANYWHERE — including one attached to a different pipeline three
 * statements later, where the array has already been clobbered — exempted every earlier unsafe
 * pipeline. Worse, it is trivially typeable: mentioning the word bought silence. `${PIPESTATUS[0]}`
 * now counts ONLY in the statement IMMEDIATELY following the pipeline, which is the only place bash
 * still holds those values.
 *
 * @param {string} rawCommand
 * @returns {{ verdict: string, filter: string, statement: string } | null}
 */
export function decide(rawCommand) {
  const cmd = String(rawCommand ?? "");
  if (!cmd) return null;

  const statements = splitStatements(cmd);
  let pipefail = false;
  for (let i = 0; i < statements.length; i++) {
    const segs = statements[i];
    const text = segs.join("|");
    // Order matters: `set +o pipefail` must be able to cancel an earlier enable.
    if (PIPEFAIL_OFF.test(text)) pipefail = false;
    else if (PIPEFAIL_ON.test(text)) pipefail = true;

    if (segs.length < 2) continue; // no pipe → the exit code is already the command's own
    if (pipefail) continue; // the shell is carrying the failure through for us

    const verdict = verdictOf(commandWordOf(segs[0]));
    if (!verdict) continue;
    const last = commandWordOf(segs[segs.length - 1]);
    if (!isPureFilter(last)) continue;

    // The ONLY statement where bash still holds this pipeline's PIPESTATUS is the next one.
    const next = statements[i + 1] ? statements[i + 1].join("|") : "";
    if (next.includes("PIPESTATUS")) continue;

    return { verdict, filter: last.word, statement: text.trim().slice(0, 200) };
  }
  return null;
}

function deny(reason) {
  recordFire("piped-verdict-guard.mjs", "deny", "piped-verdict");
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

// ── SIZE CAP ─────────────────────────────────────────────────────────────────────────────────────────
// 64 KiB, measured: across the real Bash commands in the transcript corpus the largest is ~11 KB, so
// this denies nothing anyone has ever run. It is kept even though the scanner above is linear by
// construction, because "linear by construction" is a claim about the code as it is TODAY. Above the
// cap the answer is a visible refusal rather than a hook that runs past its 10s timeout, gets killed,
// and is treated as a pass.
export const MAX_EVENT_BYTES = 64 * 1024;

function main() {
  try {
    if (process.env.CLAUDE_HOOKS_QUIET === "1") return;
    const input = readFileSync(0);
    if (input.length > MAX_EVENT_BYTES) {
      deny(
        `piped-verdict-guard: the hook payload is ${input.length} bytes, over the ${MAX_EVENT_BYTES}-byte ` +
          `cap, so the command was NOT scanned. A guard that exceeds its 10s timeout is killed before it ` +
          `can answer and the command runs unchecked — oversize input is refused rather than waved through. ` +
          `Write the large content to a file and run a short command against it.`,
      );
      return;
    }
    const ev = JSON.parse(input.toString("utf8"));
    if (ev.tool_name !== "Bash") return;
    const hit = decide((ev.tool_input && ev.tool_input.command) || "");
    if (!hit) return;
    deny(
      `PIPED VERDICT: \`${hit.verdict}\` is piped into \`${hit.filter}\`, so this command's exit code is ` +
        `${hit.filter}'s, not ${hit.verdict}'s. A failure will report as a success.\n\n` +
        `This has shipped before: \`git push … 2>&1 | grep -v … | tail -8\` read as a clean push while the ` +
        `push had been BLOCKED and the branch never reached the remote. A merge request was reported ` +
        `as ready, pointing at a branch that did not exist, and the button the reviewer pressed failed.\n\n` +
        `Rewrite it so the verdict survives — capture the status into a variable, do not read a bare $?:\n` +
        `    cmd > /tmp/x.log 2>&1; rc=$?; tail -8 /tmp/x.log; echo "EXIT=$rc"\n` +
        `or keep the pipeline and take the HEAD stage's status:\n` +
        `    cmd | ${hit.filter} …; rc=\${PIPESTATUS[0]}; echo "EXIT=$rc"\n` +
        `or put \`set -o pipefail;\` in front of it.\n\n` +
        `\${PIPESTATUS[0]} is only valid in the statement IMMEDIATELY after the pipeline — one more ` +
        `command in between and it describes that command instead. And note the compound line still ` +
        `EXITS with the last command's status, so if anything chains off it with && you must use $rc ` +
        `explicitly.\n\n` +
        `statement: ${hit.statement}`,
    );
  } catch {
    /* fail-open */
  }
  // Exit NATURALLY so stdout drains. process.exit() does not flush an async stdout pipe, and a truncated
  // deny payload is an allow-by-accident (the note scope-guard carries, for the same reason).
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
