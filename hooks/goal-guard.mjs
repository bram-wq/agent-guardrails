#!/usr/bin/env node
// goal-guard. Holds the OBJECTIVE across turns, and refuses a turn that CLAIMS completion before the
// stopping command has actually been run green.
//
// ── THE MEASURED FAILURE ─────────────────────────────────────────────────────────────────────────
// One session in 2026: the operator said "continue the last piece of work". The agent inferred an
// objective (write two planning documents that did not exist on disk), spent twelve tool calls on it,
// and was stopped with "no, don't keep going here". Thirteen PreToolUse hooks were armed at the time
// and not one of them could fire, because every guard in the fleet answers "is this COMMAND allowed"
// and none of them holds "is this the RIGHT OBJECTIVE, and has it been PROVEN finished".
//
// That is the whole gap this file closes. A hook estate built from refusals is ~100% "don't do the
// wrong thing" and ~0% direction. Nothing said *this is the right thing, and here is the command
// that proves it is done*. The rule ("state a machine-checkable DONE — a command, not prose") had
// been written down the whole time and did not hold, which is evidence about what a sentence can
// carry, not a discipline failure to try harder at. If it can be a mechanism, it must not be a
// sentence.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────────
//   node .claude/hooks/goal-guard.mjs --set "<objective>" --done "<command that proves it>" \
//        [--baseline "<what you measured today>"] [--invariant "<what must NOT change>"]
//   node .claude/hooks/goal-guard.mjs --prove      # RUNS that command, records the REAL exit code
//   node .claude/hooks/goal-guard.mjs --status     # what is active, and whether it is proven
//   node .claude/hooks/goal-guard.mjs --clear      # goal met or abandoned
//
// SessionStart re-injects the active goal and its stopping command, so the objective survives a
// /clear, a resume, and a compaction. Stop refuses to end a turn that asserts completion while the
// stopping command is unproven, and prints the exact command that earns it.
//
// ── WHY THE GUARD RUNS THE COMMAND ITSELF ────────────────────────────────────────────────────────
// The obvious design stamps the ledger from a PostToolUse payload when the stopping command is seen
// exiting 0. It was REJECTED on measurement: no hook in the fleet read a Bash exit code from a
// payload, so the payload schema would have been GUESSED, and a guard built on a guessed schema is a
// probe that can lie positively with a green light on it. `--prove` runs the command and reads the
// real exit status instead. The exit code is measured, never inferred.
//
// ⚠ NAMED LIMITATION, NOT A SILENT ONE. Because `--prove` spawns the command from inside a hook, the
// PreToolUse chain does NOT see it — so anything a stopping command could name would run past every
// other guard. Two controls compensate, applied at BOTH --set and --prove:
//   • DENY_DONE_RE, a small documented denylist of obviously destructive shapes (defence in depth,
//     so a known-bad shape gets a specific message). `GOAL_GUARD_DENY_RE` EXTENDS it; nothing
//     shrinks it.
//   • The ALLOWLIST below, which is the actual control: a stopping command must MATCH a
//     verification shape, and every `&&` segment must match independently.
//
// ── FALSE POSITIVES ARE THE RISK THAT MATTERS ────────────────────────────────────────────────────
// A guard that fires on ordinary conversation gets switched off within a day, and a disabled guard is
// worse than none — it produces the reassurance without the check. So this one is deliberately narrow
// in two independent ways, and EITHER is enough to keep it silent:
//   • IT IS OPT-IN. With no goal set, it never fires. Setting a goal is the act that arms it.
//   • THE CLAIM DETECTOR IS LINE-ANCHORED. It fires on a line that OPENS with `result:` (a
//     machine-read completion token), `DONE`, `Done.` or `verified complete` — the shapes a
//     completion is ASSERTED in — and stays silent through "not done", "what would done mean",
//     `DONE WHEN: <cmd>` (this guard's own goal format) or the word result in a sentence.
//     ⚠ A claim line INSIDE A FENCED CODE BLOCK STILL FIRES. That is deliberate and stated here
//     because an earlier version of this comment claimed the opposite while the code did no fence
//     tracking — documented behaviour that does not exist is worse than a known gap, since the next
//     reader trusts the comment instead of the regex. Erring toward firing is the safe direction for
//     a guard whose failure mode is letting an unproven completion through, and the escape is always
//     available: drop the claim line, or prove the goal.
//
// ── FAIL DIRECTIONS, DELIBERATELY ASYMMETRIC ─────────────────────────────────────────────────────
// The DECISION fails CLOSED: a goal is active, a completion is claimed, and the ledger cannot be read
// or shows a non-zero exit → BLOCK, and say NOTHING WAS PROVEN rather than anything a reader could
// mistake for a pass. The HARNESS fails OPEN: oversize, unparseable or unrecognised input exits 0,
// because a hook bug must never brick a session. CLAUDE_HOOKS_QUIET=1 suppresses informational
// context, but it never lifts a blocking Stop decision.
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename, resolve } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("goal-guard.mjs");

// ── STATE LOCATION ───────────────────────────────────────────────────────────────────────────────
// XDG state, never the repo. A goal is session/work state, not repo content — writing it into the
// tree would dirty the working copy, and a dirty tree voids every gate result. HOOK_STATE_DIR exists
// so the tests can run fully hermetic; when set it IS the goal dir, unsliced.
//
// ⚠ ONE FILE PER MACHINE WAS THE DEFECT (measured twice in one week). Two agents in two linked
// worktrees shared a single goal.json: lane A's `--prove` ran lane B's stopping command (exit 1) and
// stamped B's goal UNPROVEN; then B's `--prove` ran A's (a segfault, exit 139) and recorded that
// against A. So the goal — and its ledger — are keyed by the WORKTREE the caller is in:
//     $XDG_STATE_HOME/claude-hooks/goals/<basename>-<sha1(toplevel)[0..8]>/goal.json
// The hash is there because two clones can share a basename. `git rev-parse --show-toplevel` of the
// caller's cwd is the key, so `cd <worktree> && node …/goal-guard.mjs …` arms THAT tree, and a hook
// event keys by the session's `cwd`. A directory that is not inside a git worktree is keyed by its
// own absolute path, and says so on stderr: falling back to a shared file is exactly the collision
// this removes, so it is not a fallback at all.
// The ledger moves WITH the goal, never shared: ledgerVerdict matches on command text + timestamp, so
// a shared ledger would let lane B's green `npm test` prove lane A's identical command — a cross-lane
// false PROVEN, the failure direction this guard exists to refuse.
export function stateRoot(env = process.env) {
  const state =
    env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : null);
  return state ? join(state, "claude-hooks") : null;
}

const keyCache = new Map();
/**
 * The worktree a directory belongs to, as a state-dir slug.
 * @returns {{toplevel:string, slug:string, isGit:boolean}}
 */
export function worktreeKey(cwd = process.cwd(), warn = defaultWarn) {
  const from = resolve(cwd);
  if (keyCache.has(from)) return keyCache.get(from);
  let top = null;
  try {
    top = execFileSync("git", ["-C", from, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    top = null; // not a git worktree, or git itself is unavailable — both handled loudly below
  }
  const toplevel = top ? resolve(top) : from;
  if (!top)
    warn(
      `goal-guard: ${from} is not inside a git worktree — keying the goal by that directory itself, ` +
        `never by a shared file.`,
    );
  const hash = createHash("sha1").update(toplevel).digest("hex").slice(0, 8);
  const key = { toplevel, slug: `${basename(toplevel)}-${hash}`, isGit: !!top };
  keyCache.set(from, key);
  return key;
}
function defaultWarn(s) {
  process.stderr.write(s + "\n");
}

export function goalDir(env = process.env, cwd = process.cwd()) {
  if (env.HOOK_STATE_DIR) return env.HOOK_STATE_DIR; // explicit dir wins, unsliced — the hermetic tests
  const root = stateRoot(env);
  return root ? join(root, "goals", worktreeKey(cwd).slug) : null;
}
export const goalFile = (env = process.env, cwd = process.cwd()) => {
  const d = goalDir(env, cwd);
  return d ? join(d, "goal.json") : null;
};
export const ledgerFile = (env = process.env, cwd = process.cwd()) => {
  const d = goalDir(env, cwd);
  return d ? join(d, "goal-ledger.log") : null;
};

// Bounded: an unbounded append is a decision nobody made.
// ⚠ THE BOUND IS ENFORCED ON WRITE, NOT ONLY ON READ. The first version of this file sliced to the
// last MAX_LEDGER_LINES when READING and appended without limit, so the file grew forever while the
// code read as bounded — the bound described an intention nobody implemented. Caught by a full-depth
// review on a branch its author had already certified green.
export const MAX_LEDGER_LINES = 2000;
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

// ── THE DENYLIST (defence in depth) ──────────────────────────────────────────────────────────────
// A stopping command must be a VERIFICATION, and a verification is read-only.
//
// ⚠ THIS IS AN ENUMERATED DENYLIST, NOT A PROOF OF READ-ONLYNESS. It refuses the shapes NAMED below
// and nothing else; a mutating command it does not enumerate passes THIS check. Read it as "the
// shapes we know to refuse", never as "anything that mutates is refused" — the latter is an absence
// claim with no denominator. It runs FIRST so a known-destructive shape gets a specific message, but
// the allowlist below is what actually bounds execution.
//
// CONFIGURABLE, IN ONE DIRECTION. `GOAL_GUARD_DENY_RE` (a regex source, matched case-insensitively)
// is OR-ed onto this default; nothing in the environment can remove an entry. A guard whose floor
// can be lowered from a shell variable is a sentence in a hook's clothes.
export const DENY_DONE_RE =
  /(\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\b|\bgit\s+push\b.*(?:\s--force\b|\s-f\b|\s--force-with-lease\b)|\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b|\bTRUNCATE\s|\bDELETE\s+FROM\b|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bcurl\b.*\|\s*(?:ba)?sh\b)/i;

/** The effective denylist: the default, extended (never replaced) by GOAL_GUARD_DENY_RE. */
export function denyDoneRe(env = process.env) {
  const extra = env.GOAL_GUARD_DENY_RE;
  if (!extra) return DENY_DONE_RE;
  try {
    return new RegExp(`${DENY_DONE_RE.source}|(?:${extra})`, "i");
  } catch {
    // An unparseable extension must not silently DISABLE the floor. Fall back to the default and
    // say so, once, on stderr — "could not extend" and "extended" must not look the same.
    process.stderr.write(
      `goal-guard: GOAL_GUARD_DENY_RE is not a valid regex; using the default denylist only.\n`,
    );
    return DENY_DONE_RE;
  }
}

// ── THE ALLOWLIST (the actual control) ───────────────────────────────────────────────────────────
// A denylist CANNOT establish read-only-ness — it only enumerates the harm someone already thought
// of, so anything unenumerated executes. A reviewer blocked exactly that: `--prove` ran an arbitrary
// string through `shell: true` from inside a hook, and the residual-risk argument ("the human wrote
// the command") was FALSE — the agent writes --done itself. So the control is positive: a stopping
// command must MATCH one of these verification shapes, and every `&&` segment must match
// independently.
//
// ⚠ `npm run <anything>` IS TOO WIDE. `npm run deploy` is a destructive action wearing an
// allowlisted head, and no regex can see through a script name to what package.json makes it do. So
// the script name itself is constrained to verification NAMESPACES. The default set is the one most
// repositories converge on; `GOAL_GUARD_ALLOW_NPM_RE` (a regex source, anchored for you) EXTENDS it
// for a repo whose verification scripts live elsewhere.
// ⚠ AND TOO NARROW COSTS SILENTLY. An earlier shape accepted one colon segment for `test:` while
// accepting any depth for `gate:`, so a repo's own headline verification commands were refused. A
// guard that refuses the commands it should be recommending does not get tightened by its users; it
// gets worked around, which is how a control becomes decoration. Every namespace accepts full depth.
// The separator stays `:` (not `[:-]`) so hyphenated WRITERS beside these names — `gate-index`,
// `test-strength:accept`, both of which wrote a baseline in the measured repo — stay refused by
// shape rather than by an exception list.
export const ALLOWED_NPM_SCRIPT_RE =
  /^(?:gates?:[\w:.-]+|ci:[\w:.-]+|check:[\w:.-]+|test(?::[\w:.-]+)?|typecheck(?::[\w:.-]+)?|lint(?::[\w:.-]+)?|verify(?::[\w:.-]+)?)$/;
export function allowedNpmScriptRe(env = process.env) {
  const extra = env.GOAL_GUARD_ALLOW_NPM_RE;
  if (!extra) return ALLOWED_NPM_SCRIPT_RE;
  try {
    return new RegExp(`^(?:${ALLOWED_NPM_SCRIPT_RE.source.slice(1, -1)}|(?:${extra}))$`);
  } catch {
    process.stderr.write(
      `goal-guard: GOAL_GUARD_ALLOW_NPM_RE is not a valid regex; using the default allowlist only.\n`,
    );
    return ALLOWED_NPM_SCRIPT_RE;
  }
}
// RESIDUAL, stated honestly: `node <file>.mjs` is allowlisted, so a file written first can still
// contain anything. Inside the repo that is strictly weaker than arbitrary shell — the file is on
// disk, in the diff, and passed through the Write hooks. It is WEAKER STILL out of repo: an absolute
// path to /tmp gets none of that visibility. Not zero, and no comment should imply it is.
export const ALLOWED_DONE_SEGMENT_RE =
  /^(?:npm\s+(?:run\s+[\w:.-]+|test)(?:\s+--)?|node\s+[\w@./-]+\.(?:mjs|js|cjs)|npx\s+vitest|npm\s+exec\s+vitest)(?:\s+[\w@:./=,-]+)*$/;

// Shell metacharacters are refused outright: `&&` is the ONLY composition allowed, because it is the
// one this code implements itself (segments run sequentially, stopping at the first non-zero). A `;`,
// a pipe, a redirect, a subshell or a backtick would each let an allowlisted head tow an arbitrary
// tail — `npm run x; <anything>` — which is the denylist failure wearing a different hat.
// ⚠ THE `&` CASE NEEDS BOTH LOOKAROUNDS. `&(?!&)` alone matches the SECOND `&` of a legitimate `&&`
// (it is followed by a space), which refused every composed command — caught by the accept-side
// test, which is exactly why the allowlist is asserted in both directions and not just on bypasses.
export const SHELL_METACHAR_RE = /[;|`\n\r<>(){}$]|(?<!&)&(?!&)|\\/;

/**
 * Words that describe ACTIVITY or SENTIMENT rather than a state. Nothing can fail them, so an
 * objective built on one cannot be finished — only abandoned. Kept deliberately short: every entry
 * has appeared in a real goal that then drifted.
 */
const UNFALSIFIABLE_RE =
  /\b(improve|refactor|handle|support|robust|properly|clean\s*up|optimi[sz]e|better|modernn?i[sz]e|world[- ]class|seamless|streamline|finish\s+off|make\s+it\s+work)\b/i;

/**
 * An objective must be a DELTA, not an activity or a capability.
 *
 * ── WHY THIS EXISTS (measured over one 18-hour session) ──────────────────────────────────────────
 * The goals armed that day were "fix the root causes properly" and "make push-to-deploy flawless".
 * Both are UNBOUNDED BY CONSTRUCTION: a capability has no finish line, so the agent supplied its own
 * and kept finding adjacent work that was genuinely real, while the one change the operator wanted
 * sat unlanded. The operator said it four times: "we are circling", "why do you keep extending the
 * fix without completing it".
 *
 * That is not a discipline failure. It is an agent applying the ONLY stopping rule it was given.
 * This guard refuses an objective whose wording cannot be failed. `--baseline` and `--invariant`
 * are OPTIONAL here — a repo that wants them mandatory can require them at the call site — but when
 * given, the baseline must read as a measurement, not a judgement.
 *
 * ⚠ SHAPE ONLY, NEVER TRUTH. This proves the objective is FALSIFIABLE, never that the baseline is
 * accurate — a lie in --baseline passes here. Read it as "this goal CAN be finished", never as
 * "this goal is right".
 */
export function validateObjective(goal, baseline, invariant) {
  const g = String(goal ?? "").trim();
  const b = String(baseline ?? "").trim();
  if (!g) return { ok: false, why: "the objective is empty" };
  const m = g.match(UNFALSIFIABLE_RE);
  if (m)
    return {
      ok: false,
      why: `the objective turns on "${m[0]}", which names activity, not a state — nothing can fail it`,
    };
  if (b && UNFALSIFIABLE_RE.test(b))
    return {
      ok: false,
      why: "the --baseline reads as a judgement, not a measurement — give the number, status or output you observed",
    };
  void invariant; // free text; its value is that it is PRINTED back every SessionStart
  return { ok: true };
}

/**
 * May this string be executed by --prove?
 * @returns {{ok:boolean, why:string}}
 */
export function validateDoneCommand(cmd, env = process.env) {
  const raw = String(cmd ?? "").trim();
  if (!raw) return { ok: false, why: "the stopping command is empty" };
  if (denyDoneRe(env).test(raw))
    return {
      ok: false,
      why: "it names a DESTRUCTIVE shape — a stopping command is a read-only verification, and --prove would run it where no other guard can see it",
    };
  if (SHELL_METACHAR_RE.test(raw))
    return {
      ok: false,
      why: "it contains a shell metacharacter; only `&&` composition is allowed, so an allowlisted command cannot tow an arbitrary tail",
    };
  const npmAllowed = allowedNpmScriptRe(env);
  const segments = raw.split("&&").map((s) => s.trim());
  for (const seg of segments) {
    if (!ALLOWED_DONE_SEGMENT_RE.test(seg))
      return {
        ok: false,
        why: `this segment is not a recognised VERIFICATION shape: \`${seg}\``,
      };
    // `node -e`/`--eval`/`-p` is arbitrary code with a node-shaped head, i.e. the allowlist defeated
    // by its own entry. The regex above already refuses a flag in the file position; this is the
    // explicit second check so the intent survives an edit to that pattern.
    if (/\s-(?:e|p|-eval|-print)\b/.test(seg))
      return {
        ok: false,
        why: `inline evaluation (\`-e\`/\`-p\`) is arbitrary code, not a verification: \`${seg}\``,
      };
    const npmRun = /^npm\s+run\s+([\w:.-]+)/.exec(seg);
    if (npmRun && !npmAllowed.test(npmRun[1]))
      return {
        ok: false,
        why: `\`${npmRun[1]}\` is not a verification script — allowed namespaces are test* lint* typecheck* check:* verify:* gate:* gates:* ci:* (extend with GOAL_GUARD_ALLOW_NPM_RE)`,
      };
  }
  return { ok: true, why: `${segments.length} verification segment(s)` };
}

// ── THE CLAIM DETECTOR ───────────────────────────────────────────────────────────────────────────
// Line-anchored. `result:` is the machine-read completion token (any case); the prose shapes are
// case-pinned so that "done with the first half, moving on" and "DONE WHEN: <cmd>" — this guard's
// own goal format, which an agent echoes at the start of a task — stay silent.
export const RESULT_CLAIM_RE = /^[ \t]*result:/im;
export const PROSE_CLAIM_RE =
  /^[ \t]*(?:DONE\b(?![ \t]+WHEN\b)|Done\.|[Vv]erified complete\b)/m;

/** @param {string} text an assistant message @returns {boolean} */
export function claimsCompletion(text) {
  const s = String(text ?? "");
  return RESULT_CLAIM_RE.test(s) || PROSE_CLAIM_RE.test(s);
}

// ── GOAL RECORD ──────────────────────────────────────────────────────────────────────────────────
export function readGoal(env = process.env, cwd = process.cwd()) {
  const f = goalFile(env, cwd);
  if (!f || !existsSync(f)) return null;
  try {
    const g = JSON.parse(readFileSync(f, "utf8"));
    if (!g || typeof g.goal !== "string" || typeof g.doneCommand !== "string")
      return null;
    return g;
  } catch {
    return null; // an unreadable goal is NOT an active goal — arming on garbage would fire forever
  }
}

export function writeGoal(
  goal,
  doneCommand,
  env = process.env,
  extra = {},
  cwd = process.cwd(),
) {
  const f = goalFile(env, cwd);
  if (!f)
    throw new Error(
      "no goal path could be resolved (set HOOK_STATE_DIR, XDG_STATE_HOME or HOME)",
    );
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(
    f,
    JSON.stringify(
      {
        goal,
        doneCommand,
        baseline: extra.baseline ?? null,
        invariant: extra.invariant ?? null,
        setAt: new Date().toISOString(),
        // PROVENANCE. A goal armed by one session is a LEAD to the next, not an instruction: an
        // inherited goal string once described ANOTHER agent's in-flight work, and acting on it
        // nearly committed someone else's half-done change. null = unknown armer, which the reader
        // treats exactly like a foreign one.
        armedBySession: env.CLAUDE_SESSION_ID ?? null,
      },
      null,
      2,
    ),
  );
}

/** How long an armed goal stays ACTIVE before the injection demands re-confirmation. */
export const GOAL_TTL_MS = 48 * 60 * 60 * 1000;

export function clearGoal(env = process.env, cwd = process.cwd()) {
  const f = goalFile(env, cwd);
  if (f && existsSync(f)) rmSync(f);
}

// ── LEDGER ───────────────────────────────────────────────────────────────────────────────────────
// One line per proof attempt: ISO ts, exit code, and the exact command. Append-only.
/** @returns {boolean} whether the stamp actually reached disk — callers must not claim it did otherwise. */
export function stamp(exitCode, command, env = process.env, cwd = process.cwd()) {
  const f = ledgerFile(env, cwd);
  // No resolvable path means NOTHING WAS RECORDED. Returning quietly would let --prove print
  // "recorded exit=0" over a write that never happened — could-not-do printed as done, inside the
  // very guard built to stop it.
  if (!f) return false;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(
    f,
    `${new Date().toISOString()}\texit=${exitCode}\t${String(command).replace(/\s+/g, " ")}\n`,
  );
  // Enforce the bound HERE, where the file grows. Trimming keeps the NEWEST lines because
  // ledgerVerdict answers "what happened most recently", so the tail is the load-bearing end.
  try {
    const before = statSync(f).size;
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LEDGER_LINES) {
      // OPTIMISTIC CONCURRENCY. read-then-write is not atomic, and sessions in one worktree share
      // this file: a stamp appended by another process between our read and our write would be
      // erased by the rewrite. Losing a RED stamp is the direction that matters — it would leave the
      // newest surviving entry green and let an unproven completion through. So the size is
      // re-checked immediately before writing, and if the file moved at all the trim is ABANDONED.
      // Skipping costs a file that stays oversized until the next stamp; guessing costs a verdict.
      if (statSync(f).size === before) {
        writeFileSync(f, lines.slice(-MAX_LEDGER_LINES).join("\n") + "\n");
      }
    }
  } catch {
    // A trim failure must never lose the stamp that was just recorded, and must never be reported as
    // a proof failure: the claim is already durable on the line above.
  }
  return true;
}

/**
 * Is the ACTIVE goal's stopping command proven green?
 * Only the NEWEST attempt for that exact command counts — an old green followed by a red is a red,
 * which is the direction that matters: re-running after a change must be able to REVOKE a pass.
 * @returns {{proven:boolean, why:string}}
 */
export function ledgerVerdict(goal, env = process.env, cwd = process.cwd()) {
  const f = ledgerFile(env, cwd);
  if (!f || !existsSync(f))
    return { proven: false, why: "no proof ledger exists — nothing has been run" };
  let lines;
  try {
    lines = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-MAX_LEDGER_LINES);
  } catch (e) {
    return { proven: false, why: `the proof ledger could not be read (${e.message})` };
  }
  const want = String(goal.doneCommand).replace(/\s+/g, " ").trim();
  // ⚠ A STAMP MUST POSTDATE THE GOAL IT IS CLAIMED TO PROVE. Matching on the command string alone
  // meant re-arming a NEW objective with a previously-used verification reported PROVEN instantly,
  // from a run that happened before the goal existed — the guard's whole purpose defeated by its own
  // ledger. An unparseable or missing setAt is treated as UNPROVABLE rather than as "no lower bound",
  // because the permissive reading is the one that lets an unproven completion through.
  const armedAt = Date.parse(goal.setAt ?? "");
  if (!Number.isFinite(armedAt))
    return {
      proven: false,
      why: "the goal record has no readable setAt, so no stamp can be shown to postdate it — re-arm it with --set",
    };
  for (let i = lines.length - 1; i >= 0; i--) {
    const [ts, code, commandField] = lines[i].split("\t");
    if (String(commandField ?? "").trim() !== want) continue;
    const stampedAt = Date.parse(ts);
    if (!Number.isFinite(stampedAt) || stampedAt < armedAt) continue;
    return code === "exit=0"
      ? { proven: true, why: `proven green at ${ts}` }
      : { proven: false, why: `the last run of that command was ${code} at ${ts}` };
  }
  return {
    proven: false,
    why: `that exact command has not been run through --prove since this goal was armed (${goal.setAt})`,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

export function cli(argv, env = process.env, out = process.stdout, cwd = process.cwd()) {
  const say = (s) => out.write(s + "\n");
  // The CLI keys by where it is RUN: `cd <worktree> && node …/goal-guard.mjs` arms that worktree.
  const tree = env.HOOK_STATE_DIR ? null : worktreeKey(cwd).toplevel;
  const sayTree = () => tree && say(`WORKTREE:  ${tree}`);

  if (argv.includes("--clear")) {
    clearGoal(env, cwd);
    say("goal-guard: cleared. Nothing is armed.");
    sayTree();
    return 0;
  }

  if (argv.includes("--set")) {
    const goal = arg(argv, "--set");
    const done = arg(argv, "--done");
    const baseline = arg(argv, "--baseline");
    const invariant = arg(argv, "--invariant");
    if (!goal || !done) {
      say("goal-guard: --set needs BOTH an objective and --done '<command that proves it>'.");
      say("  A goal with no stopping command is the exact failure this guard exists to stop.");
      return 1;
    }
    const shaped = validateObjective(goal, baseline, invariant);
    if (!shaped.ok) {
      say(`goal-guard: REFUSED — ${shaped.why}`);
      say("  An objective is a DELTA, not an activity:");
      say("      --set       '<what is observably different afterwards>'");
      say("      --baseline  'Today <the measurement you just took>'   (optional)");
      say("      --invariant '<what must NOT change>'                  (optional)");
      say("      --done      '<the command that proves it>'");
      return 1;
    }
    const valid = validateDoneCommand(done, env);
    if (!valid.ok) {
      say(`goal-guard: REFUSED — ${valid.why}\n    ${done}`);
      say("  A stopping command must be a read-only VERIFICATION, and --prove runs it from inside a");
      say("  hook where no other guard sees it, so only recognised shapes are accepted:");
      say("      npm run <test|lint|typecheck|check:*|verify:*|gate:*|ci:*> · npm test · node <file>.mjs · npx vitest");
      say("  Compose with && only. No shell metacharacters, no inline -e/-p evaluation.");
      return 1;
    }
    writeGoal(goal, done, env, { baseline, invariant }, cwd);
    say("goal-guard: armed.");
    if (baseline) say(`    BASELINE:  ${baseline}`);
    say(`    GOAL:      ${goal}`);
    if (invariant) say(`    INVARIANT: ${invariant}`);
    say(`    DONE WHEN: ${done}`);
    sayTree();
    return 0;
  }

  const goal = readGoal(env, cwd);

  if (argv.includes("--status")) {
    if (!goal) {
      say("goal-guard: no goal is set. The guard is silent.");
      sayTree();
      return 0;
    }
    const v = ledgerVerdict(goal, env, cwd);
    say(`GOAL:      ${goal.goal}`);
    if (goal.baseline) say(`BASELINE:  ${goal.baseline}`);
    if (goal.invariant) say(`INVARIANT: ${goal.invariant}`);
    say(`DONE WHEN: ${goal.doneCommand}`);
    say(`STATE:     ${v.proven ? "PROVEN" : "UNPROVEN"} — ${v.why}`);
    sayTree();
    return v.proven ? 0 : 1;
  }

  if (argv.includes("--prove")) {
    if (!goal) {
      say("goal-guard: nothing to prove — no goal is set.");
      sayTree();
      return 1;
    }
    // Re-validate at execution, not only at --set: the goal file is plain JSON on disk and anything
    // that can write it can put an unvalidated command there. A control applied only at the writing
    // door is not a control on the executing door.
    const v = validateDoneCommand(goal.doneCommand, env);
    if (!v.ok) {
      say(
        `goal-guard: REFUSED — ${v.why}\n    ${goal.doneCommand}\n` +
          `  --prove executes from inside a hook, where no other guard sees the command, so only\n` +
          `  recognised verification shapes may run here.`,
      );
      return 1;
    }
    // NO SHELL. Each `&&` segment is spawned with shell:false and an explicit argv, so there is no
    // shell to inject into — the metacharacter check above is belt, this is braces. Segments run in
    // order and stop at the first non-zero, which is `&&` semantics implemented rather than delegated.
    let code = 0;
    for (const seg of goal.doneCommand.split("&&").map((s) => s.trim())) {
      const [bin, ...args] = seg.split(/\s+/);
      const r = spawnSync(bin, args, {
        shell: false,
        stdio: "inherit",
        env,
        timeout: 30 * 60 * 1000,
      });
      // A command killed by a signal or unspawnable has NO exit status. Recording that as anything
      // other than a failure would be "could not measure" printed as a pass, so it is stamped as a
      // non-zero.
      code = r.error || r.signal || typeof r.status !== "number" ? "killed" : r.status;
      if (code !== 0) break;
    }
    const recorded = stamp(code, goal.doneCommand, env, cwd);
    if (!recorded) {
      // Say the true thing. A run whose verdict reached no ledger has proven NOTHING — the Stop
      // guard will (correctly) still refuse, and printing "recorded" here would leave the reader
      // believing the opposite of the state they are in.
      say(
        `\ngoal-guard: the command exited ${code}, but NOTHING WAS RECORDED — no ledger path could be\n` +
          `  resolved (set HOOK_STATE_DIR, XDG_STATE_HOME or HOME). The goal remains UNPROVEN.`,
      );
      return 1;
    }
    say(`\ngoal-guard: recorded exit=${code} for\n    ${goal.doneCommand}`);
    return code === 0 ? 0 : 1;
  }

  say("goal-guard: usage --set '<objective>' --done '<command>' [--baseline …] [--invariant …] | --prove | --status | --clear");
  return 1;
}

// ── HOOK EVENTS ──────────────────────────────────────────────────────────────────────────────────
function block(reason) {
  recordFire("goal-guard.mjs", "block", "unproven-completion");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length) return cli(argv, env);

  let ev;
  try {
    const input = readFileSync(0);
    if (input.length > MAX_EVENT_BYTES) return 0; // fail-open: a hook killed at its timeout reads as a pass
    ev = JSON.parse(input.toString("utf8"));
  } catch {
    return 0; // fail-open: an unread event carries no claim to be wrong about
  }
  if (!ev || typeof ev !== "object") return 0;

  // A hook event keys by the SESSION's directory — `cwd` on the payload — so a session started in a
  // worktree judges that worktree's goal.
  const cwd = typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();
  const goal = readGoal(env, cwd);
  const evt = ev.hook_event_name;
  const quiet = env.CLAUDE_HOOKS_QUIET === "1";

  // ── DIRECTION: re-inject the objective so it survives /clear, resume and compaction ──
  if (evt === "SessionStart") {
    if (quiet || !goal) return 0;
    const v = ledgerVerdict(goal, env, cwd);
    // ── PROVENANCE + TTL: an inherited or stale goal is a LEAD, never an instruction. Same-session
    // re-injection (survives /clear and compaction) stays ACTIVE. A goal armed by a DIFFERENT
    // session — or an unknown one, since null cannot prove sameness — injects as INHERITED and
    // demands confirmation; a goal older than GOAL_TTL_MS injects as EXPIRED.
    const sameSession =
      goal.armedBySession != null &&
      ev.session_id != null &&
      goal.armedBySession === ev.session_id;
    const age = Date.now() - Date.parse(goal.setAt ?? "");
    // Unparseable setAt reads as EXPIRED, not fresh: a goal whose age cannot be established must
    // demand re-confirmation, never silently pass as current.
    const expired = !Number.isFinite(age) || age > GOAL_TTL_MS;
    const header = expired
      ? `▶ EXPIRED GOAL (armed ${goal.setAt}, older than ${GOAL_TTL_MS / 3600000}h) — a stale objective is a LEAD, not an instruction. Re-measure before acting; re-arm with --set to adopt it, or --clear it.`
      : sameSession
        ? "▶ ACTIVE GOAL (goal-guard — survives /clear, resume and compaction)"
        : "▶ INHERITED GOAL — armed by a DIFFERENT (or unknown) session. CONFIRM it with the operator or re-arm with --set before acting on it; --clear if it is stale. A goal string from a dead session is a lead, not an instruction.";
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: [
            header,
            `  GOAL:      ${goal.goal}`,
            ...(goal.baseline ? [`  BASELINE:  ${goal.baseline}`] : []),
            ...(goal.invariant ? [`  INVARIANT: ${goal.invariant}`] : []),
            `  DONE WHEN: ${goal.doneCommand}`,
            `  STATE:     ${v.proven ? "PROVEN" : "UNPROVEN"} — ${v.why}`,
            ...(env.HOOK_STATE_DIR ? [] : [`  WORKTREE:  ${worktreeKey(cwd).toplevel}`]),
            v.proven
              ? "  The stopping condition is met. Say so, then `--clear` it."
              : "  Prove it before claiming completion:  node .claude/hooks/goal-guard.mjs --prove",
          ].join("\n"),
        },
      }),
    );
    return 0;
  }

  // ── REFUSAL: a turn cannot END by claiming completion the stopping command has not earned ──
  if (evt === "Stop") {
    if (ev.stop_hook_active === true) return 0; // loop safety: never block the turn a block produced
    if (!goal) return 0; // opt-in: with no goal armed this guard is silent
    if (!claimsCompletion(ev.last_assistant_message)) return 0;
    const v = ledgerVerdict(goal, env, cwd);
    if (v.proven) return 0;
    block(
      [
        "goal-guard: this turn claims completion but NOTHING WAS PROVEN.",
        "",
        `  GOAL:      ${goal.goal}`,
        `  DONE WHEN: ${goal.doneCommand}`,
        `  STATE:     UNPROVEN — ${v.why}`,
        "",
        "Run the stopping command and record its REAL exit code — it is yours to run:",
        "    node .claude/hooks/goal-guard.mjs --prove",
        "",
        "If the goal genuinely changed, re-arm it rather than claiming the old one:",
        "    node .claude/hooks/goal-guard.mjs --set '<objective>' --done '<command>'",
        "If this turn is not a completion of that goal, drop the claim line (`result:` / `DONE` / `Done.` / `verified complete`) and say what remains.",
      ].join("\n"),
    );
    return 0;
  }

  return 0;
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("goal-guard.mjs") &&
  !process.env.GOAL_GUARD_NO_MAIN
) {
  process.exit(main());
}
