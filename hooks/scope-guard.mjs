#!/usr/bin/env node
// PreToolUse scope-guard (Edit|MultiEdit|Write|NotebookEdit) — WRITE-TIME enforcement of task scope.
// OPT-IN + fail-open on the HARNESS, fail-closed on a SCOPE FILE it cannot trust.
//
// WHY: a checkout-level lock stops two sessions from entangling one git index, but it does NOT scope
// WHAT a session may edit. With agent worktrees + concurrent sessions, an agent told to "fix a typo in
// module X" will happily drive-by edit `auth.ts` or a migration. A protected-paths list in CONTRIBUTING
// is a REVIEW-time human check — too late, the file is already rewritten. This hook is the write-time
// teeth: it blocks an Edit/Write outside the paths the current task declared, at the moment of
// temptation.
//
// OPT-IN: enforcement exists only when a `.agent-scope` JSON file governs the path being written (an
// agent-worktree/task drops it; a developer working solo has none → zero friction). Shape:
//   { "allow": ["packages/db/**", "apps/web/lib/feature.ts"], "deny": ["**/auth.ts"], "reason": "slice B" }
//   - deny wins over allow. If `allow` is non-empty and the path matches none → blocked.
//   - `allow` absent/empty → only `deny` filters (allow-all-except-deny).
// FAIL-OPEN: no scope file governing the path, a scope file that is not JSON, or ANY exception → ALLOW.
// A hook bug must never brick real editing.
// FAIL-CLOSED: a scope file that PARSES but is not the shape above (a non-object, a string `allow`,
// a glob over GLOB_MAX_LEN) → DENY, naming the defect. Measured before the fix: `{"allow":"packages/db/**"}`,
// `[]`, `null`, `5` and `"str"` all became allow-all silently — a one-character typo in the scope file
// removed the guard without a line of output.
//
// ★ WHICH .agent-scope APPLIES — this was the whole guard.
// Originally the file was read from `ev.cwd` ALONE, and a path that resolved to `../…` from cwd was
// treated as "outside cwd" and waved through. In an agent worktree — the ONLY configuration parallel
// lanes ever run in — the session cwd is the main checkout while the files live in a SIBLING directory,
// so EVERY write in a scoped lane resolved to `../…` and hit that fail-open. Measured on the real hook
// before the fix: a lane declaring allow `packages/db/**` wrote `<lane>/apps/web/drive-by.ts` and the
// decision was ALLOW. Per-lane scoping was decorative in exactly the configuration it was built for —
// written, believed live, never reachable. (A second shape was open for the same reason: a session
// whose cwd is a SUBDIRECTORY of its own worktree never found the scope file at the lane root.)
//
// The fix is deliberately NOT "deny anything outside cwd" — that would be a wholesale flip to
// fail-closed, and a guard that bricks sessions gets switched off, which is worse than no guard. The
// bug was that a path inside the AGENT'S OWN WORKTREE was being mistaken for a path outside any lane.
// So we RESOLVE THE LANE the path belongs to (scopeRootFor) and apply THAT tree's `.agent-scope`.
// A path no `.agent-scope` governs is still allowed, exactly as before.
//
// ★ SYMLINKS. The path was matched as WRITTEN, never as RESOLVED. Measured: `packages/db/abs-link.ts ->
// /outside/target.ts` under allow `packages/db/**` was ALLOWED and the write landed outside the tree.
// Now the target is resolved through its nearest existing ancestor (realpathSync) and a resolved path
// that leaves the lane root is denied; one that stays inside is matched on BOTH spellings.
//
// ★ THE GLOB MATCHER. `globToRe` emitted `(?:.*/)?` per `**/`, exponential in the number of stars: an
// allow entry of twelve `**/` against a 30-deep path took >20 s, twenty-five took 4 min. The hook runs
// under a 10 s timeout, a timed-out PreToolUse hook renders NO decision, and `.agent-scope` is
// agent-writable — so the pattern was an allow-all. Replaced by a segment walk whose backtracking is
// bounded by the segment count; repeated `**/` collapse first; a glob over GLOB_MAX_LEN is malformed.
//
// ★ SELF-EDIT. `.agent-scope` was exempt unconditionally, so a scoped agent widened its own scope in one
// Write. The exemption now holds only when the proposed content does not WIDEN: new allow ⊆ old allow
// and new deny ⊇ old deny. An Edit whose old_string does not apply is denied (cannot evaluate → closed);
// an event proposing no content at all keeps the old exemption (nothing proposed, nothing widened).
//
// NOTE on flushing: we compute a decision, `process.stdout.write` at most ONCE, and let the process exit
// NATURALLY (no process.exit() after a write). process.exit() does not drain an async stdout pipe, so a
// deny payload written right before it is silently truncated — an allow-by-accident. Falling off the end
// (readFileSync is synchronous; nothing keeps the loop alive) flushes stdout first.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("scope-guard.mjs");

const SCOPE_FILE = ".agent-scope";
// Depth bound. No real repo is 64 directories deep; the cap exists so a pathological path can never
// turn a PreToolUse hook into an unbounded walk (this hook is registered with a 10s timeout, and a hook
// that times out is killed BEFORE it can deny — a silent removal of the guard).
const MAX_WALK = 64;
// A glob longer than this is not a path pattern anybody typed; it is treated as a malformed scope.
export const GLOB_MAX_LEN = 512;

/**
 * Nearest ancestor of `startDir` that declares a scope, or null.
 *
 * `.git` is the STOP boundary: a git checkout root (a dir) and a worktree root (a FILE — a worktree's
 * `.git` is a short gitdir pointer) both carry it. Reaching one without having seen a `.agent-scope`
 * means this tree declares no scope, and the answer is ALLOW. Without that boundary the walk would
 * leave the repo and could pick up a stray file in a parent directory.
 *
 * WHY NOT `git rev-parse --show-toplevel`: it is a subprocess on every Edit/Write in a hook with a 10s
 * budget, it needs git on PATH, and it answers a slightly different question (the tree root, not the
 * nearest declared scope) — while this walk is a handful of stat() calls and works in a bare temp dir,
 * so the test can exercise it without standing up a repo.
 */
function laneRootFor(startDir) {
  let d = startDir;
  for (let i = 0; i < MAX_WALK; i++) {
    // `.agent-scope` is checked BEFORE `.git`, because a worktree root has BOTH and the scope wins.
    if (existsSync(join(d, SCOPE_FILE))) return d;
    if (existsSync(join(d, ".git"))) return null; // tree root, no scope declared here
    const up = dirname(d);
    if (up === d) return null; // filesystem root
    d = up;
  }
  return null;
}

/**
 * The directory whose `.agent-scope` governs `abs`, or null if none does.
 *
 * The in-cwd case is answered EXACTLY as before (cwd's own scope file), so the ordinary
 * one-session-one-checkout path is byte-for-byte unchanged. Only when that does not apply — the
 * worktree lane, or a cwd nested inside one — do we resolve the lane root from the target path.
 */
function scopeRootFor(cwd, abs) {
  const relToCwd = relative(cwd, abs).split("\\").join("/");
  const insideCwd =
    relToCwd !== "" && !relToCwd.startsWith("../") && !isAbsolute(relToCwd);
  if (insideCwd && existsSync(join(cwd, SCOPE_FILE))) return cwd;
  return laneRootFor(dirname(abs));
}

/**
 * `abs` with every symlink resolved. The file usually does not exist yet (a Write creates it), so the
 * nearest EXISTING ancestor is realpath'd and the remaining segments are appended verbatim.
 */
function resolveThroughSymlinks(abs) {
  const tail = [];
  let d = abs;
  for (let i = 0; i < MAX_WALK; i++) {
    if (existsSync(d)) return join(realpathSync(d), ...tail.reverse());
    const up = dirname(d);
    if (up === d) return abs; // nothing on the way exists; nothing to resolve
    tail.push(d.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    d = up;
  }
  return abs;
}

// ── glob matching: a segment walk, never a regex ─────────────────────────────────────────────────
// `**` as a whole segment = zero or more directories; `*` = a run of non-slash chars; `?` = one.
// A `**` glued to other characters inside a segment behaves as `*` (minimatch semantics).

// Wildcard match of ONE segment: `*` and `?` only, iterative, backtracks to the last `*` (O(n·m)).
function segmentMatches(pat, str) {
  let p = 0, s = 0, starP = -1, starS = -1;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === str[s])) { p++; s++; continue; }
    if (p < pat.length && pat[p] === "*") { starP = p++; starS = s; continue; }
    if (starP >= 0) { p = starP + 1; s = ++starS; continue; }
    return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

// Segment walk with `**` = zero or more segments; backtracks to the last `**`, bounded by the
// segment counts (O(globSegs · pathSegs)) whatever the pattern says.
export function globMatches(glob, path) {
  // `**/**/**/x` means `**/x`: consecutive `**` segments collapse so the walk has one star to return to.
  const gs = glob
    .split("/")
    .map((g) => (g === "**" ? g : g.replace(/\*\*+/g, "*")))
    .filter((g, i, a) => !(g === "**" && a[i - 1] === "**"));
  const ps = path.split("/");
  let g = 0, p = 0, starG = -1, starP = -1;
  while (p < ps.length) {
    if (g < gs.length && gs[g] === "**") { starG = g++; starP = p; continue; }
    if (g < gs.length && segmentMatches(gs[g], ps[p])) { g++; p++; continue; }
    if (starG >= 0) { g = starG + 1; p = ++starP; continue; }
    return false;
  }
  while (g < gs.length && gs[g] === "**") g++;
  return g === gs.length;
}
export const matchesAny = (path, globs) => globs.some((g) => globMatches(g, path));

// ── scope file shape ─────────────────────────────────────────────────────────────────────────────
// Returns { allow, deny, reason } or a string naming the defect. Only called on JSON that parsed.
function validateScope(scope) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope))
    return `.agent-scope is ${scope === null ? "null" : Array.isArray(scope) ? "an array" : `a ${typeof scope}`}, not an object`;
  for (const key of ["allow", "deny"]) {
    const v = scope[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `.agent-scope "${key}" is a ${typeof v}, not an array of globs`;
    for (const g of v) {
      if (typeof g !== "string") return `.agent-scope "${key}" contains a ${typeof g}, not a glob string`;
      if (g.length > GLOB_MAX_LEN)
        return `.agent-scope "${key}" has a ${g.length}-char glob, above the ${GLOB_MAX_LEN}-char limit`;
    }
  }
  return { allow: scope.allow ?? [], deny: scope.deny ?? [], reason: scope.reason };
}

// ── self-edit: allowed only when it does not widen ───────────────────────────────────────────────
// Returns null to ALLOW, or the reason to DENY. Every "cannot tell" path is a deny.
function scopeSelfEditReason(ev, current) {
  const tool = ev.tool_name;
  const inp = ev.tool_input || {};
  // An event that proposes NOTHING (no content, no old_string, no edits) cannot widen anything and a
  // Write without content writes nothing — that is the old exemption, kept for that shape only.
  if (inp.content === undefined && inp.old_string === undefined && inp.edits === undefined) return null;
  let proposed;
  if (/^Write$/i.test(tool)) {
    proposed = typeof inp.content === "string" ? inp.content : null;
  } else if (/^(Edit|MultiEdit)$/i.test(tool)) {
    const edits = /^Edit$/i.test(tool) ? [inp] : Array.isArray(inp.edits) ? inp.edits : [];
    proposed = current;
    for (const e of edits) {
      if (typeof e.old_string !== "string" || typeof e.new_string !== "string" || !proposed.includes(e.old_string)) {
        proposed = null;
        break;
      }
      proposed = e.replace_all
        ? proposed.split(e.old_string).join(e.new_string)
        : proposed.replace(e.old_string, () => e.new_string);
    }
  } else {
    proposed = null;
  }
  const ASK = "Ask the orchestrator / widen the scope in a separate approved change.";
  const cannot =
    `Cannot evaluate this ${tool} of .agent-scope (the proposed content could not be derived), so it is refused. ${ASK}`;
  if (proposed === null) return cannot;

  let next;
  try {
    next = validateScope(JSON.parse(proposed));
  } catch {
    return cannot;
  }
  if (typeof next === "string") return `${next} — the proposed .agent-scope is refused. ${ASK}`;
  const old = validateScope(JSON.parse(current)); // already validated by the caller

  const widensAllow =
    old.allow.length > 0 && (next.allow.length === 0 || !next.allow.every((g) => old.allow.includes(g)));
  const widensDeny = !old.deny.every((g) => next.deny.includes(g));
  if (widensAllow || widensDeny) {
    return (
      `.agent-scope self-edit refused: it would WIDEN this task's scope ` +
      `(${widensAllow ? "adds allow paths" : "drops deny paths"}). A task may narrow its own scope, never widen it. ${ASK}`
    );
  }
  return null;
}

// Returns a deny-reason string, or null to ALLOW.
export const MAX_EVENT_BYTES = 8 * 1024 * 1024; // an Edit/Write event carries the file content
function decide() {
  const input = readFileSync(0, "utf8");
  if (input.length > MAX_EVENT_BYTES)
    return (
      `scope-guard: the hook payload is ${input.length} bytes, above the ${MAX_EVENT_BYTES}-byte limit, ` +
      `so the target path could not be checked against .agent-scope. Write the file in smaller pieces.`
    );
  const ev = JSON.parse(input);
  const tool = ev.tool_name || "";
  if (!/^(Edit|MultiEdit|Write|NotebookEdit)$/i.test(tool)) return null;

  const fp =
    (ev.tool_input &&
      (ev.tool_input.file_path || ev.tool_input.notebook_path)) ||
    "";
  if (!fp) return null;

  const cwd = ev.cwd || process.cwd();
  const abs = isAbsolute(fp) ? fp : join(cwd, fp);

  // WHICH tree's scope applies to THIS path. null → no `.agent-scope` governs it → opt-in allow.
  const root = scopeRootFor(cwd, abs);
  if (!root) return null;

  let scopeRaw;
  try {
    scopeRaw = readFileSync(join(root, SCOPE_FILE), "utf8");
  } catch {
    return null; // vanished between the stat and the read → not enforcing (opt-in)
  }
  // A scope file that does not PARSE is the world's defect, not the hook's: a lane declared a scope
  // and a typo would otherwise turn it into allow-all with no signal. Fail closed and name the file.
  // (Changed 2026-09-12; the earlier contract allowed here on "a hook bug must never brick a session",
  // but a corrupt config is not a hook bug, and the deny reason tells the agent exactly what to fix.)
  let parsed;
  try {
    parsed = JSON.parse(scopeRaw);
  } catch (e) {
    parsed = `\`.agent-scope\` in ${root} is not valid JSON (${String(e?.message ?? e).split("\n")[0]})`;
  }
  const scope = typeof parsed === "string" ? parsed : validateScope(parsed);
  if (typeof scope === "string") {
    return `${scope}. The scope cannot be enforced as written, so this edit is refused; fix .agent-scope first.`;
  }
  const { allow, deny: denyList } = scope;

  // Lane-relative POSIX path. `root` is either cwd (with abs proven under it) or an ANCESTOR of abs,
  // so this cannot escape — the guard is kept anyway, because a path we cannot place must fail OPEN.
  const rel = relative(root, abs).split("\\").join("/");
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) return null;

  // The RESOLVED path: through every symlink on the way. Leaving the lane root is a deny, whatever the
  // written spelling matched.
  const realRoot = realpathSync(root);
  const resolved = resolveThroughSymlinks(abs);
  const relReal = relative(realRoot, resolved).split("\\").join("/");
  if (relReal === "" || relReal.startsWith("../") || isAbsolute(relReal)) {
    return (
      `Out of task scope: '${rel}' resolves through a symlink to '${resolved}', outside this task's tree. ` +
      `A write through a link that leaves the lane is not scoped by .agent-scope — log it as a follow-up task instead.`
    );
  }

  // The scope file itself: editable only in the narrowing direction.
  if (rel === SCOPE_FILE) return scopeSelfEditReason(ev, scopeRaw);

  const why = scope.reason ? ` (task: ${scope.reason})` : "";
  const spellings = rel === relReal ? [rel] : [rel, relReal];
  if (denyList.length && spellings.some((p) => matchesAny(p, denyList))) {
    return (
      `Out of task scope${why}: '${rel}' is in this task's DENY list. Don't drive-by edit it — ` +
      `log a follow-up task instead (no-drive-by rule; protected paths).`
    );
  }
  if (allow.length && !spellings.every((p) => matchesAny(p, allow))) {
    return (
      `Out of task scope${why}: '${rel}' is not in this task's allowed paths (.agent-scope). ` +
      `Editing outside your declared slice is how two sessions collide — log it as a follow-up task instead.`
    );
  }
  return null;
}

let reason = null;
try {
  reason = decide();
} catch {
  reason = null; // fail-open: any error allows
}
if (reason) {
  recordFire("scope-guard.mjs", "deny", "out-of-scope");
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
// exit naturally (exit code 0) so stdout flushes before the process ends.
