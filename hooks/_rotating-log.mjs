// _rotating-log — an append-only log whose size bound never erases a line another process just wrote.
//
// ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────────────────────────
// goal-guard's ledger and the fire log were bounded by READ-TRIM-REWRITE: append, read the whole file,
// and if it was past the bound write the newest part back over the same path. Sessions in one worktree
// share the ledger, so a stamp appended by another process between that read and that write was erased
// by the rewrite. A size re-check before the write narrowed the window but could not close it, and
// once the ledger sat at its ceiling EVERY stamp re-trimmed, so every stamp opened the window again.
// Losing a RED stamp is the direction that matters: the newest surviving entry reads green and an
// unproven completion goes through.
//
// ── THE DESIGN ───────────────────────────────────────────────────────────────────────────────────
// Nothing is ever rewritten in place.
//   APPEND   appendFileSync (O_APPEND): each line lands whole, after every other writer's line.
//   ROTATE   when the live file is past its bound, renameSync MOVES it to a segment with a name no
//            other rotation can pick (time + 64 random bits), so a rename never replaces a file.
//            Two processes that both decide to rotate each move whatever is at the path at that
//            moment: the second one moves the first's fresh, near-empty file into its own segment.
//            Nothing is overwritten either way.
//   STRAGGLE a writer that opened the live file just before the rename writes into the moved file.
//            Its line is in a segment, and readers read segments.
//   PRUNE    a segment is deleted only when BOTH hold: every line in it is older than the oldest line
//            of the newest `keep` weight across all files (judged by each line's own timestamp, not
//            by file names, so a misordered double rotation cannot delete the newer lines), AND it has
//            not been written for graceMs, so no straggler can still be appending to it.
//
// ── HONEST LIMITS ────────────────────────────────────────────────────────────────────────────────
// • A line is lost only if a writer stalls between opening the live file and writing for longer than
//   graceMs AND more than `keep` newer lines are written meanwhile. A single appendFileSync does not
//   stall for a minute outside a frozen process.
// • readLines reads the live file first, then the segments. A rotation landing between the two reads
//   can report a line TWICE; it can never report it zero times.
// • Order across files is not guaranteed: callers that need "newest" sort by the line's timestamp.
// • The bound is approximate: the live file plus the segments still needed to cover `keep`, so on
//   disk it is about twice `keep`, plus any segment still inside its grace period.
//
// Lines must start with an ISO-8601 UTC timestamp followed by a tab: that is what PRUNE compares.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** How long a rotated segment must sit unwritten before PRUNE may delete it. */
export const SEGMENT_GRACE_MS = 60_000;

const SEGMENT_MARK = ".seg-";

/** Rotated segments of `file`, oldest name first (names start with a zero-padded millisecond time). */
export function segmentsOf(file) {
  const prefix = basename(file) + SEGMENT_MARK;
  let names;
  try {
    names = readdirSync(dirname(file));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => n.startsWith(prefix)).sort().map((n) => join(dirname(file), n));
}

/** A file's text through ONE descriptor, or null when it does not exist. Any other error throws. */
function readText(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const split = (text) => (text ?? "").split("\n").filter(Boolean);

/**
 * Every line of the log: the rotated segments (oldest name first), then the live file.
 * @returns {string[] | null} null when neither the live file nor any segment exists. An unreadable file THROWS,
 *   so a caller can tell "nothing recorded" from "could not find out".
 */
export function readLines(file) {
  // The live file FIRST. A rotation between this read and the listing below moves lines already held
  // here into a segment that the listing then finds: a duplicate, never a gap.
  const live = readText(file);
  const segs = segmentsOf(file);
  if (live === null && segs.length === 0) return null;
  const out = [];
  for (const s of segs) out.push(...split(readText(s)));
  out.push(...split(live));
  return out;
}

/**
 * @typedef {object} Bound
 * @property {number} [maxLines]  rotate when the live file holds more lines than this
 * @property {number} [maxBytes]  …or more bytes than this (checked with fstat, without reading the file)
 * @property {number} keep        the weight of newest lines PRUNE must always leave readable
 * @property {(line: string) => number} weight
 * @property {number} [graceMs]   defaults to SEGMENT_GRACE_MS
 * @property {number} [now]       for tests; defaults to Date.now()
 */

/**
 * Append one line (it must end with "\n"), then rotate and prune if the live file is past its bound.
 * The append THROWS on failure. A rotation or prune failure is swallowed: the line is already durable, and
 * a bound that could not be enforced this time is enforced by the next append.
 * @param {string} file
 * @param {string} line
 * @param {Bound} bound
 */
export function appendLine(file, line, bound) {
  mkdirSync(dirname(file), { recursive: true });
  appendWithRetry(file, line);
  try {
    rotateIfOver(file, bound);
  } catch {
    // e.g. Windows refuses to rename a file another process holds open. The next append retries.
  }
}

// Windows can refuse an open for a moment while another process renames the same path (EBUSY/EPERM).
// A few short retries ride that out there. Anywhere else, and for a refusal that persists, the error
// THROWS to the caller, which decides what "not recorded" means.
const TRANSIENT_OPEN = process.platform === "win32" ? new Set(["EBUSY", "EPERM", "EACCES"]) : new Set();
function appendWithRetry(file, line) {
  for (let attempt = 0; ; attempt++) {
    try {
      appendFileSync(file, line);
      return;
    } catch (e) {
      if (!TRANSIENT_OPEN.has(e.code) || attempt >= 4) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** @returns {boolean} whether this call moved the live file into a segment. */
export function rotateIfOver(file, bound) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") return false; // another process rotated it a moment ago
    throw e;
  }
  let over;
  try {
    over =
      bound.maxBytes !== undefined
        ? fstatSync(fd).size > bound.maxBytes
        : split(readFileSync(fd, "utf8")).length > bound.maxLines;
  } finally {
    closeSync(fd);
  }
  if (!over) return false;
  const now = bound.now ?? Date.now();
  const seg = `${file}${SEGMENT_MARK}${String(now).padStart(13, "0")}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(file, seg);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  prune(file, bound);
  return true;
}

/**
 * Delete the segments nothing needs. See PRUNE in the header.
 * @returns {string[]} the segments deleted
 */
export function prune(file, bound) {
  const now = bound.now ?? Date.now();
  const graceMs = bound.graceMs ?? SEGMENT_GRACE_MS;
  const segs = segmentsOf(file).map((path) => ({ path, lines: split(readText(path)) }));
  const entries = [...segs.flatMap((s) => s.lines), ...split(readText(file))]
    .map((l) => ({ ts: l.split("\t")[0], w: bound.weight(l) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  let acc = 0;
  let cutoff = null;
  for (const e of entries) {
    acc += e.w;
    if (acc >= bound.keep) {
      cutoff = e.ts;
      break;
    }
  }
  if (cutoff === null) return []; // everything on disk is still inside the window
  const deleted = [];
  for (const s of segs) {
    const newest = s.lines.reduce((m, l) => {
      const ts = l.split("\t")[0];
      return ts > m ? ts : m;
    }, "");
    if (s.lines.length && !(newest < cutoff)) continue; // it holds a line the window still needs
    let fd;
    try {
      fd = openSync(s.path, "r");
    } catch (e) {
      if (e.code === "ENOENT") continue; // another process pruned it
      throw e;
    }
    let idleMs;
    try {
      idleMs = now - fstatSync(fd).mtimeMs;
    } finally {
      closeSync(fd);
    }
    if (idleMs < graceMs) continue; // a straggler may still be writing into it
    try {
      unlinkSync(s.path);
      deleted.push(s.path);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return deleted;
}
