#!/usr/bin/env node
// PreToolUse scope-guard (Edit|Write) — WRITE-TIME enforcement of task scope. OPT-IN + fail-open.
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
// FAIL-OPEN: no scope file governing the path, a parse error, or ANY exception → ALLOW. A hook bug must
// never brick real editing.
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
// NOTE on flushing: we compute a decision, `process.stdout.write` at most ONCE, and let the process exit
// NATURALLY (no process.exit() after a write). process.exit() does not drain an async stdout pipe, so a
// deny payload written right before it is silently truncated — an allow-by-accident. Falling off the end
// (readFileSync is synchronous; nothing keeps the loop alive) flushes stdout first.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("scope-guard.mjs");

const SCOPE_FILE = ".agent-scope";
// Depth bound. No real repo is 64 directories deep; the cap exists so a pathological path can never
// turn a PreToolUse hook into an unbounded walk (this hook is registered with a 10s timeout, and a hook
// that times out is killed BEFORE it can deny — a silent removal of the guard).
const MAX_WALK = 64;

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

// Minimal glob → RegExp: `**/` = any dirs (incl. none), `**` = anything, `*` = non-slash run, `?` = one non-slash.
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}
const matchesAny = (path, globs) => globs.some((g) => globToRe(g).test(path));

// Returns a deny-reason string, or null to ALLOW.
function decide() {
  const ev = JSON.parse(readFileSync(0, "utf8"));
  const tool = ev.tool_name || "";
  if (!/^(Edit|Write|NotebookEdit)$/.test(tool)) return null;

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
  const scope = JSON.parse(scopeRaw);
  const allow = Array.isArray(scope.allow) ? scope.allow : [];
  const denyList = Array.isArray(scope.deny) ? scope.deny : [];

  // Lane-relative POSIX path. `root` is either cwd (with abs proven under it) or an ANCESTOR of abs,
  // so this cannot escape — the guard is kept anyway, because a path we cannot place must fail OPEN.
  const rel = relative(root, abs).split("\\").join("/");
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) return null;

  // Always allow editing the scope file itself, so a scoped session can adjust its own scope.
  if (rel === SCOPE_FILE) return null;

  const why = scope.reason ? ` (task: ${scope.reason})` : "";
  if (denyList.length && matchesAny(rel, denyList)) {
    return (
      `Out of task scope${why}: '${rel}' is in this task's DENY list. Don't drive-by edit it — ` +
      `log a follow-up task instead (no-drive-by rule; protected paths).`
    );
  }
  if (allow.length && !matchesAny(rel, allow)) {
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
