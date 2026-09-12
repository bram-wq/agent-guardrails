/**
 * scratch-dir — a temp directory that CANNOT be forgotten.
 *
 * WHY: test fixtures that build miniature git repositories leak thousands of directories (and far
 * more inodes) when every call site has to remember its own cleanup. A cleanup that is opt-in at
 * each call site is a cleanup that some call site will forget, and the forgetting is silent.
 *
 * So: creating the directory IS registering it. The reaper is armed lazily on first use and runs on
 * `process.exit`, which is synchronous — `rmSync` is the only shape that can complete inside it.
 *
 * A process killed by SIGKILL never reaches an exit handler. Its leftovers require explicit
 * operator cleanup: age and prefix do not prove the owning process is dead. Allocation must
 * never delete another process's directory, however old that directory happens to be.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = new Set();
let armed = false;

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

// Explicit maintenance only. The caller must establish that no live owner uses these paths;
// this age-based helper cannot establish ownership and is never called during allocation.
export function sweepStaleScratchDirs(prefix, opts = {}) {
  const base = opts.base ?? tmpdir();
  const ageMs = opts.ageMs ?? STALE_AFTER_MS;
  const now = opts.now ?? Date.now();
  const removed = [];
  const kept = [];
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return { removed, kept };
  }
  const cutoff = now - ageMs;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (!MKDTEMP_SUFFIX.test(name.slice(prefix.length))) continue;
    const p = join(base, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (st.mtimeMs > cutoff) {
        kept.push(p);
        continue;
      }
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // Raced with another sweeper, or not ours to remove. Best effort by design.
    }
  }
  return { removed, kept };
}

/**
 * Make a scratch directory that will be removed when the process exits.
 * @param {string} prefix e.g. "uieg-split" — a trailing "-" is added if absent.
 * @returns {string} absolute path to the new directory
 */
export function scratchDir(prefix) {
  if (typeof prefix !== "string" || prefix.trim() === "")
    throw new TypeError("scratchDir(prefix): prefix must be a non-empty string");
  const normalised = prefix.endsWith("-") ? prefix : `${prefix}-`;
  const d = mkdtempSync(join(tmpdir(), normalised));
  live.add(d);
  if (!armed) {
    armed = true;
    process.on("exit", reapScratchDirs);
  }
  return d;
}

/** Remove every directory `scratchDir` handed out. Idempotent, never throws. */
export function reapScratchDirs() {
  for (const d of live) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best effort by design.
    }
  }
  live.clear();
}
