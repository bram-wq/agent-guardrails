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
 * A process killed by SIGKILL never reaches an exit handler, so the second half is a bounded SWEEP
 * at startup: before the first directory of a given prefix is created, this run removes stale
 * corpses of that same prefix left by earlier runs. It is bounded by PREFIX (only names this process
 * has asked for), by SHAPE (only `<prefix><6 alphanumerics>`, which is what mkdtemp produces) and by
 * AGE (older than STALE_AFTER_MS), so it can never reap a concurrent sibling's live fixtures.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = new Set();
let armed = false;

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;
const sweptPrefixes = new Set();

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
  if (!sweptPrefixes.has(normalised)) {
    sweptPrefixes.add(normalised);
    sweepStaleScratchDirs(normalised);
  }
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
