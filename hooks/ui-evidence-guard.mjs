#!/usr/bin/env node
// Stop ui-evidence-guard. BLOCKS a turn that claims UI work is done while the branch's diff touches
// user-visible files and no rendered evidence exists for it.
//
// ── THE FAILURE CLASS ────────────────────────────────────────────────────────────────────────────
// A batch of UI branches once merged green on tests alone; a rendered walk ran AFTERWARDS as a sweep
// and found dozens of UX defects — noise in a status table that had to be pointed out on a live
// screen, and untranslated pages inside a localised session. The written policy ("screenshots in
// .evidence/ before done") was a sentence; a branch could merge screen-unseen. This is the
// mechanism: the turn cannot END claiming a UI change is done with nothing rendered.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────────────────────────
// Stop event, `ev.last_assistant_message` only (never the transcript). `stop_hook_active` honoured —
// fires at most once per continuation chain. The block costs one turn and names the exact missing
// artefact.
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, sep } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

// Instrumented so the fire log can SEE this guard: a guard whose zero is unreadable can never be
// pruned on evidence, only on a guess.
recordInvocation("ui-evidence-guard.mjs");

// ── THE CLAIM DETECTOR ───────────────────────────────────────────────────────────────────────────
// A bare word list was wrong in both directions (adversarial probe): it BLOCKED `Not done yet —
// still failing.`, `Done? Not sure.`, a fenced block containing `npm run done`, `the CI works by
// polling`, `I have not verified anything` and `completed 2 of 5, 3 remain`; and it ALLOWED
// `Implemented and merged.`, `Deployed to staging.`, `Ready for merge.`, `Resolved.` and `All green —
// shipping now`. So: fenced and inline code is stripped first; a negation within three words before
// the claim word suppresses it; a `?` right after it suppresses it; a number right after it is a
// count, not a verdict; `works by/as/like/via/through` is a description; and the missing claim words
// are in. CLAIM_RE stays exported as the WORD list; claimsDone() is the decision.
export const CLAIM_RE =
  /\b(done|completed?|finished|shipped|shipping|fixed|verified|works|implemented|merged|deployed|resolved|landed|ready for (?:review|the team|staging|merge|qa))\b/gi;
const NEGATION_RE =
  /\b(?:not|never|no|nothing|none|isn'?t|aren'?t|wasn'?t|weren'?t|haven'?t|hasn'?t|hadn'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|couldn'?t|won'?t|wouldn'?t|shouldn'?t|yet|until|unless|without|before|almost|nearly|partially|half|un)\b/i;
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WORKS_DESCRIPTIVE_RE = /^\s+(?:by|as|like|via|through)\b/i;

/** The message with code removed — a command in a code block is an instruction, not a verdict. */
export function stripCode(text) {
  return String(text ?? "").replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " ");
}

/** Does this turn CLAIM the UI work is finished? */
export function claimsDone(message) {
  if (typeof message !== "string") return false;
  const text = stripCode(message);
  CLAIM_RE.lastIndex = 0;
  for (let m; (m = CLAIM_RE.exec(text)); ) {
    const word = m[1].toLowerCase();
    const after = text.slice(m.index + m[0].length);
    // `Done?` is a question; `completed 2 of 5` is a count.
    if (/^\s*\?/.test(after) || /^\s+\d/.test(after)) continue;
    if (word === "works" && WORKS_DESCRIPTIVE_RE.test(after)) continue;
    // Negation window: the three words before the claim, bounded at the previous sentence.
    const before = text.slice(Math.max(0, m.index - 120), m.index).split(/[.!?;\n]/).pop() ?? "";
    const window = before.trim().split(/\s+/).filter(Boolean).slice(-3).join(" ");
    if (NEGATION_RE.test(window)) continue;
    return true;
  }
  return false;
}

// The paths that render. Adjust to the repo's layout; the rule is "what a user can see".
// Which paths are user-visible. The default is the monorepo this was extracted from — its app,
// components, messages, styles and public trees plus the tailwind config (a stylesheet or a theme
// token changes what renders as surely as a component does; `apps/web/styles/g.css` once slipped past
// a narrower default). Set UI_EVIDENCE_PATHS to a regex source for yours
// (`UI_EVIDENCE_PATHS='^(src/components|src/pages)/'`).
// An invalid regex falls back to the default rather than to "nothing is UI", because a guard that a
// typo turns inert is a guard nobody notices is gone.
export const DEFAULT_UI_PATH_RE =
  /^apps\/web\/(?:(?:app|components|messages|styles|public)\/|tailwind\.config\.[cm]?[jt]s$)/;
export function uiPathRe(env = process.env) {
  const src = env.UI_EVIDENCE_PATHS;
  if (!src) return DEFAULT_UI_PATH_RE;
  try {
    return new RegExp(src);
  } catch {
    return DEFAULT_UI_PATH_RE;
  }
}
export const UI_PATH_RE = uiPathRe();

/** Pure decider, tested directly. */
export function decide({ message, uiFiles, evidenceCount }) {
  if (!claimsDone(message)) return { block: false };
  if (!uiFiles || uiFiles.length === 0) return { block: false };
  if (evidenceCount > 0) return { block: false };
  return {
    block: true,
    reason:
      `[ui-evidence-guard] this turn claims completion while the branch changes ${uiFiles.length} user-visible file(s) ` +
      `(${uiFiles.slice(0, 3).join(", ")}${uiFiles.length > 3 ? ", …" : ""}) and .evidence/ holds NO screenshot newer than the branch's newest UI change. ` +
      `Branches have merged screen-unseen before and a post-hoc walk found dozens of defects; code that looks right is not evidence. ` +
      `Render it (dev server + Playwright, or the staging walk), save shots under .evidence/<task>/, name them in the report — or soften the claim.`,
  };
}

/**
 * What counts as a screenshot. An earlier version counted ANY file under .evidence/ newer than the
 * fork, so `touch .evidence/x` satisfied the guard — as did a .txt and a ZERO-BYTE .png, verified
 * live. A guard against screen-unseen merges that accepts a text file is not a guard; it is a ritual.
 */
export const SHOT_RE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * The bytes an image actually starts with. Size alone was the test, and `head -c 6000 /dev/urandom
 * > a.png` passed it — 6 KB of noise counted as a rendered screen. The extension is a name; the
 * magic number is the file. PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, WebP `RIFF….WEBP`.
 */
export function looksLikeImage(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head ?? []);
  if (b.length < 12) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return true;
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return true;
  return false;
}
/** Read only the header; a screenshot is not read whole to be recognised. */
function fileLooksLikeImage(path) {
  const buf = Buffer.alloc(12);
  let fd;
  try {
    fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, 12, 0);
    return looksLikeImage(buf.subarray(0, n));
  } catch {
    return false; // unreadable = not evidence
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A real screenshot of any viewport is tens of KB. The floor is deliberately far BELOW that — it is
 * here to reject empty and truncated files, not to judge image quality, so it must never fail an
 * honest capture. 5 KB is an order of magnitude below the smallest real screenshot (a 390x844
 * viewport PNG is tens of KB) and comfortably above the 0-byte, header-only and truncated files a
 * failed or interrupted capture leaves behind.
 *
 * ⚠ NOT scoped to a per-branch directory, deliberately. Evidence dirs are named by TASK
 * (.evidence/staging-audit/), not by branch, so a branch-slug filter would reject correctly-filed
 * screenshots and the guard would be switched off inside a week. Over-firing is the worse failure.
 */
export const MIN_SHOT_BYTES = 5000;

/**
 * A changed line that is ENTIRELY a comment. Deliberately conservative: if even one changed line in
 * a file is code, the file is NOT exempt and evidence is still required.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\*\/)/;

/**
 * Does this file's diff consist of nothing but comment lines?
 *
 * ── WHY THIS EXEMPTION EXISTS ───────────────────────────────────────────────────────────────────
 * Deleting two dangling `// eslint-disable-next-line` comments from a form component once made this
 * guard demand a rendered screenshot of an auth-gated admin page, to prove that removing two comments
 * had not changed a pixel. It cannot have.
 *
 * That is the over-firing direction, and this guard has produced it twice — first by letting a
 * rebase invalidate real evidence, then by demanding evidence for a diff with no runtime content. A
 * guard that makes honest work expensive gets switched off, and takes the real refusal with it.
 *
 * ⚠ THE TEST IS "EVERY CHANGED LINE IS A COMMENT", NOT "SOME ARE". One code line anywhere in the
 * file disqualifies the whole file, so this cannot be used to smuggle a render change past the
 * guard by burying it among comments. The residual blind spot is a change confined to a multi-line
 * STRING whose every line begins with `//` or `*`; the cost there is one missed screenshot, and the
 * alternative is parsing TSX inside a hook.
 */
export function isCommentOnlyDiff(patch) {
  const changed = String(patch ?? "")
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1));
  if (changed.length === 0) return false; // no changes at all is not an exemption
  return changed.every((l) => l.trim() === "" || COMMENT_LINE.test(l));
}

/**
 * Commit time (ms) of the newest commit touching each path under `.evidence/`, from ONE git call.
 * A path absent from the map is untracked — "no provenance", never "old" — and every caller falls
 * back to mtime for it, which is the honest answer for a shot Playwright just produced.
 *
 * Why commit time at all: freshness was once decided by FILE MTIME, and a rebase or a checkout
 * rewrites the mtime of every working-tree file to now. Screenshots committed a day earlier and
 * belonging to a DIFFERENT task were refused as STALE on one head and then passed the identical test
 * on the rebased head, where they were attached to an unrelated PR as its evidence. The tool did not
 * withhold evidence; it manufactured it. A commit date rides with the content.
 *
 * Why ONE call: the first version ran `git log -1 -- <shot>` per screenshot. At 1,740 committed shots
 * that is ~9 s inside a Stop hook with a 15 s budget — a guard one busy afternoon away from being
 * killed at its timeout, which reads as a pass. `git log --name-only --format=%ct -- .evidence` walks
 * the history once, newest first, so the first time a path appears is its newest commit.
 *
 * KNOWN LIMIT, deliberately not engineered around: in a SHALLOW clone the log cannot walk history, so
 * it reports the graft commit's own date for every tracked path. This hook runs locally, where
 * worktrees share the primary's full object store.
 * @returns {Map<string, number>} root-relative POSIX path → epoch ms
 */
export function committedTimeMap(git) {
  const map = new Map();
  let out;
  try {
    out = git("-c", "core.quotePath=false", "log", "--name-only", "--format=%ct", "--", ".evidence");
  } catch {
    return map; // git unavailable here — no provenance for anything, NOT "old"
  }
  let current = null;
  for (const raw of String(out ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) {
      const t = Number(line);
      current = Number.isFinite(t) && t > 0 ? t * 1000 : null;
      continue;
    }
    if (current != null && !map.has(line)) map.set(line, current);
  }
  return map;
}

export function freshEvidenceCount(root, sinceEpochMs, git = null) {
  let n = 0;
  const committed = git ? committedTimeMap(git) : null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          if (!SHOT_RE.test(e.name)) continue; // a .txt is not a screenshot
          const st = statSync(p);
          if (st.size < MIN_SHOT_BYTES) continue; // empty, header-only or truncated
          // Git time when the shot is COMMITTED (a checkout cannot move it); mtime only when it is
          // untracked, i.e. genuinely just produced and not yet recorded.
          const rel = relative(root, p).split(sep).join("/");
          const when = committed?.get(rel) ?? st.mtimeMs;
          if (when < sinceEpochMs) continue;
          if (!fileLooksLikeImage(p)) continue; // named .png, is not a PNG
          n++;
        } catch {
          /* unreadable = not evidence */
        }
      }
    }
  };
  walk(join(root, ".evidence"));
  return n;
}

/**
 * The branch this work forks from. `origin/main` is the common case; a repo whose default branch is
 * `master`, or a fork tracking `upstream`, or a clone with no remote at all, would otherwise make
 * `merge-base` throw and the hook exit 0 SILENTLY — an inert guard nobody notices is gone. Returns
 * null when none exists, and the caller says so on stderr before allowing.
 */
export const BASE_REF_CANDIDATES = ["origin/main", "origin/master", "upstream/main", "main"];
export function resolveBaseRef(git) {
  for (const ref of BASE_REF_CANDIDATES) {
    try {
      git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
      return ref;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/**
 * The evidence cutoff: the newest AUTHOR time (epoch ms) of any commit in `base..HEAD` that touched
 * one of `files`, or null when there is nothing to anchor to. A screenshot is fresh iff it postdates
 * this — it proves a render of the files as they stood when it was taken, so a later change to any
 * of them makes it stale, and nothing that happens to the BRANCH (rebase, split, cherry-pick) can
 * move it, because author times ride with the content. Shared with the evidence uploader so the
 * guard's idea of "fresh" and the uploader's cannot drift apart; see the CLI block below for the
 * two anchors this replaced.
 */
export function newestUiChangeMs(git, base, files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const times = git("log", "--format=%at", `${base}..HEAD`, "--", ...files)
    .split("\n")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return times.length ? Math.max(...times) * 1000 : null;
}

// basename, not split("/"): on Windows argv[1] is a backslash path, and split("/").pop() returned
// the whole path, so the hook never ran when spawned and exited silently with no verdict.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  let ev;
  try {
    const raw = readFileSync(0);
    if (raw.length > 4_000_000) process.exit(0);
    ev = JSON.parse(raw.toString("utf8"));
  } catch {
    process.exit(0);
  }
  if (ev?.stop_hook_active === true) process.exit(0);
  const message = ev?.last_assistant_message ?? "";
  if (!claimsDone(message)) process.exit(0);
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
  let uiFiles = [],
    anchorMs = 0;
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch === "main" || branch === "HEAD") process.exit(0); // nothing branch-scoped to prove
    const baseRef = resolveBaseRef(git);
    if (!baseRef) {
      // DOCUMENTED ALLOW. No base means no branch diff to judge — but "could not check" must not
      // print the same as "checked, fine", so the reason goes to stderr (the debug log) first.
      process.stderr.write(
        `ui-evidence-guard: none of ${BASE_REF_CANDIDATES.join(", ")} exists — no base to diff against, allowing.\n`,
      );
      process.exit(0);
    }
    const base = git("merge-base", baseRef, "HEAD");
    uiFiles = git("diff", "--name-only", `${base}..HEAD`)
      .split("\n")
      .filter((f) => UI_PATH_RE.test(f))
      // A file whose diff is only comments cannot have changed what renders. See
      // isCommentOnlyDiff for the measurement and for why one code line disqualifies the file.
      .filter((f) => {
        try {
          return !isCommentOnlyDiff(git("diff", `${base}..HEAD`, "--", f));
        } catch {
          return true; // could not read the patch ⇒ keep demanding evidence, never assume
        }
      });
    if (uiFiles.length === 0) process.exit(0); // nothing user-visible changed ⇒ nothing to prove
    // ⚠ THE CUTOFF IS THE NEWEST UI CHANGE, NOT THE BRANCH'S SHAPE. Two earlier anchors failed:
    //
    //   1. merge-base committer date — a REBASE moved it 26 minutes past two correct screenshots
    //      and the guard said "no screenshot newer than the branch fork".
    //   2. the branch's OLDEST commit author date — survived the rebase, then failed on a branch
    //      SPLIT: evidence captured mid-morning; the split's first commit authored that afternoon;
    //      the anchor moved past the shots and the uploader printed "no fresh screenshots — nothing
    //      to attach" after a full chain ran. Real evidence, silently discarded.
    //
    // Both anchors were about the BRANCH. The evidence is about the CONTENT: a screenshot proves a
    // render of the UI files as they stood when it was taken, so it is fresh iff it postdates the
    // NEWEST commit that touched those files. That is newestUiChangeMs — max AUTHOR time over
    // base..HEAD restricted to the changed UI files. Author times survive rebase AND split
    // (cherry-pick and rebase both preserve them), and a shot OLDER than the newest UI change is
    // still stale — that rule is kept, it is what makes this a guard rather than a ritual.
    anchorMs =
      newestUiChangeMs(git, base, uiFiles) ??
      Number(git("log", "-1", "--format=%ct", base)) * 1000;
  } catch {
    process.exit(0);
  } // cannot establish the diff ⇒ no finding, never a guess
  const verdict = decide({
    message,
    uiFiles,
    evidenceCount: freshEvidenceCount(process.cwd(), anchorMs, git),
  });
  if (!verdict.block) process.exit(0);
  recordFire("ui-evidence-guard.mjs", "block", "ui-evidence-missing");
  console.log(JSON.stringify({ decision: "block", reason: verdict.reason }));
}
