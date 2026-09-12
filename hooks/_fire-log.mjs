// _fire-log — the DENOMINATOR for "does this guard earn its keep".
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// When a hook records nothing about its own activity, "this guard never fires" is an absence claim
// with no denominator — and deleting a guard on that basis is how you remove the one that was
// quietly working. This file is the missing measurement: every guard records that it RAN and that it
// FIRED, so a removal decision can be made on counts rather than on a guess.
//
// ── WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────────
// A fire line is: timestamp · hook · verdict · kind · ctx · project. THAT IS ALL.
//
// `project` was appended last. The log lives under $XDG_STATE_HOME, which is one file for every
// project on the machine, so `report` run in a fresh repo printed the counts of whichever OTHER
// project had been busiest — a confident table about the wrong codebase. The key is the basename of
// the git toplevel (or of cwd outside git) plus a short hash of its path, so two clones that share
// a name still count apart. Appended, never inserted: lines written before the column existed still
// parse, and readLog reports their project as "-", never as the current one.
//
// The reason text is NOT recorded, and that is a security decision rather than an oversight. A denial
// reason embeds the offending command, and a guard that denies SECRET WRITES would therefore log the
// secret to disk. `kind` is a short constant authored in the hook source (never user or command
// data), validated against KIND_RE, and dropped if it does not match. Counts are what the removal
// decision needs; reasons are what an incident needs, and an incident has the transcript.
//
// ── WHY RUNS ARE RECORDED TOO ────────────────────────────────────────────────────────────────────
// Fires alone cannot answer the question. "0 fires" is ambiguous between NEVER FIRED and NEVER RAN,
// and those have opposite implications for deletion. So each hook also records its own runs; see
// recordInvocation for why the denominator is per HOOK rather than per EVENT.
//
// ── COST ─────────────────────────────────────────────────────────────────────────────────────────
// The rejected design was a wrapper process around each hook. Node startup is ~80ms and a busy
// PreToolUse matcher can run a dozen hooks, so that design adds over a second to EVERY tool call. A
// guard that slow gets switched off, and a disabled guard is worse than none. In-process
// appendFileSync is ~0.05ms, so the whole scheme costs well under a millisecond per event.
//
// ── FAIL DIRECTION ───────────────────────────────────────────────────────────────────────────────
// TELEMETRY MUST NEVER BREAK A GUARD. Nothing here throws: a hook that cannot record its fire must
// still fire, because a guard bricked by its own instrumentation trades a real control for a metric —
// the worst trade available.
//
// ⚠ THE RETURN CONTRACT IS NOT UNIFORM. The two shapes are:
//   recordFire / recordInvocation → boolean. false means NOTHING WAS WRITTEN.
//   readLog                       → always an object; `unreadable: true` is the failure signal, and
//                                   it is deliberately distinct from an empty-but-readable log.
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

/** XDG state dir, never the repo: a dirty working tree voids every gate result. */
export function fireLogPath(env = process.env) {
  if (env.HOOK_FIRE_LOG) return env.HOOK_FIRE_LOG;
  const state =
    env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : null);
  return state ? join(state, "claude-hooks", "hook-fires.log") : null;
}

// Bounded ON WRITE, not only on read. At a dozen hook runs per tool call this is the file that would
// actually run away.
//
// ⚠ THE BOUND IS IN BYTES. An earlier LINE bound was gated behind `size > MAX_LINES * 64` to avoid
// reading the file on every append — but a run line is ~38 bytes, so the byte trigger was never
// reached and the trim NEVER RAN. Its own test caught it. Size is what statSync reports, so size is
// what the bound is expressed in. On exceeding MAX, the newest HALF is kept — trimming to exactly the
// cap would put the file back on the trigger and force a full read on every subsequent append.
export const MAX_FIRE_BYTES = 2_000_000;
export const KEEP_FIRE_BYTES = 1_000_000;

/** `kind` is a source-authored constant. Anything else is dropped rather than written. */
export const KIND_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Depth bound for the toplevel walk — no repo is 64 directories deep, and a hook must never turn
// into an unbounded stat() loop.
const MAX_WALK = 64;

/**
 * The git toplevel that contains `dir` (a `.git` DIRECTORY for a checkout, a `.git` FILE for a
 * worktree), or `dir` itself when none is found. A filesystem walk rather than `git rev-parse`:
 * that is a subprocess on every hook run in a file whose whole budget is "well under a millisecond",
 * and it needs git on PATH, which a hook context cannot assume.
 */
export function gitToplevel(dir = process.cwd()) {
  let d = resolve(dir);
  try {
    d = realpathSync(d);
  } catch {
    /* keep the resolved path */
  }
  let cur = d;
  for (let i = 0; i < MAX_WALK; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return d;
}

const keyCache = new Map();
/**
 * The project column: `<basename>-<8 hex of sha1(toplevel)>`, e.g. `showcase-3f9a1c2b`. Cached per
 * process — a hook computes it at most once, and a hook is one process.
 * @param {string} [cwd]
 */
export function projectKey(cwd = process.cwd()) {
  if (keyCache.has(cwd)) return keyCache.get(cwd);
  let key;
  try {
    const top = gitToplevel(cwd);
    key = `${basename(top) || "root"}-${createHash("sha1").update(top).digest("hex").slice(0, 8)}`;
  } catch {
    key = "-"; // telemetry never breaks a guard; an unattributed line is still a counted line
  }
  keyCache.set(cwd, key);
  return key;
}

function append(line, env) {
  const f = fireLogPath(env);
  if (!f) return false;
  try {
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, line);
    const size = statSync(f).size;
    // statSync is cheap; reading and rewriting is not — so the read happens only once the file is
    // genuinely over the cap.
    //
    // ⚠ THE RE-CHECK NARROWS THE RACE; IT DOES NOT CLOSE IT. An append landing between the read and
    // the write is still lost. This is TELEMETRY, the trim runs only above 2 MB, and a handful of
    // lost count lines at that moment cannot change a verdict that is about "ever fired" and orders
    // of magnitude. If this log ever becomes evidence rather than a counter, it needs a real lock.
    if (size > MAX_FIRE_BYTES) {
      const body = readFileSync(f, "utf8");
      if (statSync(f).size === size) {
        // Cut at a line boundary so the trim can never leave a half-line the parser would drop.
        const cut = body.length - KEEP_FIRE_BYTES;
        const nl = body.indexOf("\n", cut);
        writeFileSync(f, nl === -1 ? "" : body.slice(nl + 1));
      }
    }
    return true;
  } catch {
    return false; // telemetry never breaks a guard
  }
}

/**
 * Is this process a TEST harness, or a real session?
 *
 * Without this field the log cannot tell the two apart, and the result is a number nobody can use:
 * hook test suites spawn guards in a loop, so raw counts show hundreds of "fires" per minute that no
 * operator ever saw. Test traffic counted as live inflates exactly the number that keeps a hook alive.
 *
 * ⚠ THREE SIGNALS, NOT ONE. `HOOK_CTX` is set by gate runners (which spawn hook tests as plain
 * `node`, where VITEST is absent); `VITEST` covers suites run under vitest; `NODE_ENV` catches the
 * rest. Any one of them is enough.
 *
 * ⚠ AND THE THIRD VALUE MATTERS MOST. Lines written before this field existed carry NO ctx, and
 * readLog reports them as "unknown" — never "live". Back-filling them as live would manufacture
 * exactly the confident wrong rate this field was added to prevent.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"test"|"live"}
 */
export function fireCtx(env = process.env, argv = process.argv) {
  if (
    env.HOOK_CTX === "test" ||
    env.VITEST ||
    env.VITEST_WORKER_ID ||
    env.NODE_ENV === "test"
  )
    return "test";
  // ⚠ THE ENTRYPOINT IS A SIGNAL THE ENVIRONMENT DOES NOT CARRY. Every check above is an ENV VAR.
  // A plain `node foo.test.mjs` — how these suites are run — sets none of them, so without this
  // line its fires would be recorded as `live`.
  return isTestEntrypoint(argv?.[1]) ? "test" : "live";
}

/**
 * Does this process's entry file NAME it as a test? Filename only — deliberately not a path
 * heuristic, because a directory called `tests/` says nothing about the file being run, and
 * widening this is how a live fire would get silently discounted as test traffic.
 */
export function isTestEntrypoint(entry) {
  if (typeof entry !== "string" || entry === "") return false;
  const base = entry.split(/[\\/]/).pop() ?? "";
  return /\.test\.(mjs|cjs|js|ts|tsx)$/.test(base);
}

/**
 * Record that a guard FIRED (denied, blocked, or warned).
 * @param {string} hook  the hook's filename, e.g. "scope-guard.mjs"
 * @param {string} verdict  "deny" | "block" | "warn"
 * @param {string} [kind]  short source-authored category, e.g. "out-of-scope"
 * @returns {boolean} whether the line reached disk — callers must not claim it did otherwise
 */
export function recordFire(hook, verdict, kind) {
  const k = KIND_RE.test(String(kind ?? "")) ? String(kind) : "-";
  recordLastSeen(hook, "fire");
  return append(
    `${new Date().toISOString()}\tfire\t${hook}\t${verdict}\t${k}\t${fireCtx()}\t${projectKey()}\n`,
    process.env,
  );
}

/**
 * Record that a hook RAN — the denominator, per hook.
 *
 * ⚠ IT IS PER HOOK, NOT PER EVENT. settings.json splits one event (PreToolUse) across several
 * matcher groups, so a shared per-event counter would divide one hook's fires by another hook's
 * population and produce a confident wrong rate. Each hook counting its own runs makes the
 * denominator exact and needs no matcher reasoning at all.
 *
 * ⚠ NAMED CAVEAT: this is called at module scope, so a hook IMPORTED by a test records an invocation
 * it did not really serve. That inflates a denominator slightly (making a guard look LESS busy, never
 * more trigger-happy) and only for hooks whose tests import them.
 *
 * @param {string} hook  the hook's filename
 */
export function recordInvocation(hook) {
  recordLastSeen(hook, "run");
  return append(
    `${new Date().toISOString()}\trun\t${hook}\t${fireCtx()}\t${projectKey()}\n`,
    process.env,
  );
}

/**
 * THE LAST-SEEN LEDGER — evidence for RARE hooks, which the rolling log structurally cannot hold.
 *
 * The log is byte-bounded (MAX_FIRE_BYTES) and at a busy rate holds about two hours. A SessionEnd
 * hook fires ONCE PER SESSION END; a chatty PreToolUse guard evicts every rare lifecycle hook long
 * before anyone reads the file. A frequency-bounded log cannot answer a frequency question about
 * rare events, so a "registered but never ran" verdict read from it is false by construction.
 *
 * This ledger is keyed by hook and NEVER TRIMMED: one line per hook, so it stays small however long
 * it lives, and a hook proven once stays proven.
 *
 * ⚠ live and test are kept APART, for the same reason readLog refuses to backfill `ctx`. A hook
 * that has only ever run under a test runner is NOT evidence that its registration dispatches.
 */
export function lastSeenPath(env = process.env) {
  const f = fireLogPath(env);
  return f ? f.replace(/\.log$/, "") + "-last-seen.json" : null;
}

/** Read the ledger. `unreadable` is distinct from empty — the caller must be able to tell. */
export function readLastSeen(env = process.env) {
  const f = lastSeenPath(env);
  if (!f || !existsSync(f)) return { seen: {}, unreadable: false, path: f };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { seen: {}, unreadable: true, path: f };
    return { seen: parsed, unreadable: false, path: f };
  } catch {
    return { seen: {}, unreadable: true, path: f };
  }
}

/**
 * Stamp `hook` as observed. Read-modify-write of a small object; telemetry NEVER breaks a guard, so
 * every failure path returns false rather than throwing.
 * @returns {boolean} whether the stamp reached disk
 */
export function recordLastSeen(hook, kind, env = process.env) {
  const f = lastSeenPath(env);
  if (!f || !hook) return false;
  try {
    const { seen, unreadable } = readLastSeen(env);
    // A corrupt ledger is REPLACED, not merged onto — merging onto garbage keeps the garbage.
    const base = unreadable ? {} : seen;
    const ctx = fireCtx(env);
    const prev = base[hook] && typeof base[hook] === "object" ? base[hook] : {};
    base[hook] = { ...prev, [`${kind}_${ctx}`]: new Date().toISOString() };
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(base, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** @returns {{fires:object[], runs:object[], unreadable:boolean, path:string|null}} */
export function readLog(env = process.env) {
  const f = fireLogPath(env);
  if (!f || !existsSync(f))
    return { fires: [], runs: [], unreadable: false, path: f };
  try {
    const fires = [];
    const runs = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      const [ts, kind, a, b, c, d, e] = line.split("\t");
      // ⚠ `?? "unknown"` and NOT `?? "live"`. Lines written before the ctx field existed cannot be
      // classified, and calling them live would silently inflate the live population with test runs.
      // The same rule for `project`: a line written before the column existed is "-", never the
      // project reading it — otherwise a fresh repo would inherit another project's history.
      if (kind === "fire")
        fires.push({ ts, hook: a, verdict: b, kind: c, ctx: d ?? "unknown", project: e || "-" });
      else if (kind === "run") runs.push({ ts, hook: a, ctx: b ?? "unknown", project: c || "-" });
    }
    return { fires, runs, unreadable: false, path: f };
  } catch {
    // "could not read" must never print the same as "nothing recorded" — the caller decides what to
    // say, but it must be able to tell the two apart.
    return { fires: [], runs: [], unreadable: true, path: f };
  }
}
