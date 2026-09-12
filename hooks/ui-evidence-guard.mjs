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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

// Instrumented so the fire log can SEE this guard: a guard whose zero is unreadable can never be
// pruned on evidence, only on a guess.
recordInvocation("ui-evidence-guard.mjs");

export const CLAIM_RE =
  /\b(done|completed?|finished|shipped|fixed|verified|works|ready for (?:review|the team|staging))\b/i;
// The paths that render. Adjust to the repo's layout; the rule is "what a user can see".
export const UI_PATH_RE = /^apps\/web\/(app|components|messages)\//;

/** Pure decider, tested directly. */
export function decide({ message, uiFiles, evidenceCount }) {
  if (!CLAIM_RE.test(String(message ?? ""))) return { block: false };
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
export const SHOT_RE = /\.(png|jpe?g|webp)$/i;

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
 * Commit time (ms) of the last commit that touched `rel`, or NULL when the path is untracked or git
 * cannot answer. NULL means "no provenance", never "old" — every caller falls back to mtime, which
 * is the honest answer for a shot Playwright just produced and nothing has recorded yet.
 *
 * Why this exists: freshness was once decided by FILE MTIME, and a rebase or a checkout rewrites the
 * mtime of every working-tree file to now. Screenshots committed a day earlier and belonging to a
 * DIFFERENT task were refused as STALE on one head and then passed the identical test on the rebased
 * head, where they were attached to an unrelated PR as its evidence. The tool did not withhold
 * evidence; it manufactured it, on exactly the PRs most likely to carry real UI work, because those
 * are the ones that get rebased. A commit date rides with the content and no checkout can move it.
 *
 * KNOWN LIMIT, deliberately not engineered around: in a SHALLOW clone `git log -1 -- <path>` cannot
 * walk history, so it reports the graft commit's own date for every tracked path. This hook runs
 * locally, where worktrees share the primary's full object store. If it is ever run against a
 * shallow checkout, `git rev-parse --is-shallow-repository` is the check to add here.
 */
export function committedAtMs(git, rel) {
  let out;
  try {
    out = git("log", "-1", "--format=%ct", "--", rel);
  } catch {
    return null; // git unavailable here — no provenance, NOT "old"
  }
  if (out == null) return null;
  const t = Number(String(out).trim());
  return Number.isFinite(t) && t > 0 ? t * 1000 : null;
}

export function freshEvidenceCount(root, sinceEpochMs, git = null) {
  let n = 0;
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
          // Git time when the shot is COMMITTED (a checkout cannot move it); mtime only when it is
          // untracked, i.e. genuinely just produced and not yet recorded.
          const committed = git ? committedAtMs(git, relative(root, p)) : null;
          if (
            (committed ?? st.mtimeMs) >= sinceEpochMs &&
            st.size >= MIN_SHOT_BYTES
          )
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

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
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
  if (!CLAIM_RE.test(message)) process.exit(0);
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
  let uiFiles = [],
    anchorMs = 0;
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch === "main" || branch === "HEAD") process.exit(0); // nothing branch-scoped to prove
    const base = git("merge-base", "origin/main", "HEAD");
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
