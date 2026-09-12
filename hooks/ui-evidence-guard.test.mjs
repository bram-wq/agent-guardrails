// Behavioural tests for ui-evidence-guard — run: `node hooks/ui-evidence-guard.test.mjs`.
// Must-fire (UI diff + completion claim + no evidence), must-not-fire controls (no claim / no UI
// files / evidence present), and the mutation target. Needs `git` on PATH for the real-repo block.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  decide,
  freshEvidenceCount,
  committedAtMs,
  newestUiChangeMs,
  CLAIM_RE,
  MIN_SHOT_BYTES,
  isCommentOnlyDiff,
} from "./ui-evidence-guard.mjs";
import { scratchDir } from "./_scratch-dir.mjs";

let failures = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n  ", e.message);
  }
};
const UI = ["apps/web/app/(frontend)/learner/page.tsx"];

t(
  "★ MUST FIRE: claim + UI diff + zero evidence is blocked, and the block names .evidence/",
  () => {
    const v = decide({
      message: "The quiet panel is done and verified.",
      uiFiles: UI,
      evidenceCount: 0,
    });
    assert.equal(v.block, true);
    assert.match(v.reason, /\.evidence\//);
  },
);
t("☑ MUST NOT FIRE: the same claim with fresh evidence passes", () => {
  assert.equal(
    decide({ message: "done and verified", uiFiles: UI, evidenceCount: 3 })
      .block,
    false,
  );
});
t(
  "☑ MUST NOT FIRE: a claim on a branch with no user-visible diff passes",
  () => {
    assert.equal(
      decide({ message: "the gate fix is done", uiFiles: [], evidenceCount: 0 })
        .block,
      false,
    );
  },
);
t("☑ MUST NOT FIRE: a progress report that claims nothing passes", () => {
  assert.equal(
    decide({
      message: "still building the i18n branch, judge running",
      uiFiles: UI,
      evidenceCount: 0,
    }).block,
    false,
  );
});
t("★ the claim regex sees the shapes turns actually use", () => {
  for (const m of [
    "Done — all four pages fixed.",
    "shipped to staging",
    "this is now ready for the team",
  ])
    assert.equal(CLAIM_RE.test(m), true, m);
});
t("★ freshEvidenceCount counts only files newer than the fork", () => {
  const d = scratchDir("uieg");
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  const old = join(d, ".evidence/task/old.png"),
    fresh = join(d, ".evidence/task/new.png");
  // ⚠ REAL-SIZE FIXTURES. These used to be the 1-byte strings "x" and "y", which meant the whole
  // test suite asserted the behaviour of a file no capture could ever produce — and any size
  // predicate added later would be validated against fixtures that assumed none existed.
  const shot = Buffer.alloc(MIN_SHOT_BYTES + 1, 7);
  writeFileSync(old, shot);
  writeFileSync(fresh, shot);
  const cut = Date.now() - 60_000;
  utimesSync(old, new Date(cut - 120_000), new Date(cut - 120_000));
  assert.equal(freshEvidenceCount(d, cut), 1);
});

t(
  "★ MUST FIRE: a .txt, a 0-byte .png and a truncated .png are NOT evidence",
  () => {
    // The count was once `mtime >= fork` with no extension or size test, so `touch .evidence/x`
    // satisfied the guard against screen-unseen merges. Verified live before the fix: a .txt plus a
    // ZERO-BYTE .png produced evidenceCount 2 and decide() returned block:false.
    const d = scratchDir("uieg-junk");
    mkdirSync(join(d, ".evidence/task"), { recursive: true });
    writeFileSync(join(d, ".evidence/task/notes.txt"), Buffer.alloc(50_000, 1)); // big, wrong type
    writeFileSync(join(d, ".evidence/task/empty.png"), "");
    writeFileSync(
      join(d, ".evidence/task/truncated.png"),
      Buffer.alloc(200, 1),
    );
    assert.equal(freshEvidenceCount(d, 0), 0);
    // …and the guard therefore still blocks the completion claim.
    assert.equal(
      decide({
        message: "done",
        uiFiles: ["apps/web/app/x.tsx"],
        evidenceCount: 0,
      }).block,
      true,
    );
  },
);

t("☑ MUST NOT FIRE: a real screenshot counts, and unblocks the claim", () => {
  const d = scratchDir("uieg-real");
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    writeFileSync(
      join(d, `.evidence/task/shot.${ext}`),
      Buffer.alloc(60_000, 3),
    );
  }
  assert.equal(
    freshEvidenceCount(d, 0),
    4,
    "every image type a capture tool saves must count",
  );
  assert.equal(
    decide({
      message: "done",
      uiFiles: ["apps/web/app/x.tsx"],
      evidenceCount: 4,
    }).block,
    false,
  );
});
t(
  "★ MUST NOT FIRE: a REBASE must not invalidate evidence already captured",
  () => {
    // Measured live on this guard: screenshots captured, then a rebase moved the merge-base
    // COMMITTER date 26 minutes past the evidence — and the guard reported "no screenshot newer than
    // the branch fork" while two correct shots sat in .evidence/.
    //
    // Worse than a missed defect: it punishes the rebase an intake rule REQUIRES before a PR may
    // open, so obeying one rule destroys the evidence for another. That is how a guard gets deleted.
    //
    // Author dates survive a rebase; committer dates do not. This asserts the arithmetic directly:
    // a shot taken AFTER work began but BEFORE a later fork point must still count.
    const d = scratchDir("uieg-rebase");
    mkdirSync(join(d, ".evidence/task"), { recursive: true });
    const shot = join(d, ".evidence/task/shot.png");
    writeFileSync(shot, Buffer.alloc(MIN_SHOT_BYTES + 1, 9));

    const workBegan = Date.now() - 60 * 60_000; // branch's first commit, author date
    const shotAt = Date.now() - 30 * 60_000; // screenshot captured mid-work
    const laterFork = Date.now() - 10 * 60_000; // merge-base after rebasing onto newer main
    utimesSync(shot, new Date(shotAt), new Date(shotAt));

    assert.equal(
      freshEvidenceCount(d, workBegan),
      1,
      "anchored to when work began, the screenshot counts",
    );
    assert.equal(
      freshEvidenceCount(d, laterFork),
      0,
      "anchored to a post-rebase merge-base it does not — which is the bug, pinned here so the " +
        "cutoff choice cannot silently regress to the merge-base again",
    );
  },
);

t("☑ MUST NOT FIRE: a diff that is only comments needs no screenshot", () => {
  // Deleting two dangling `// eslint-disable-next-line` comments from a form component once made this
  // guard demand a rendered screenshot of an auth-gated admin page, to prove that removing two
  // comments had not moved a pixel.
  assert.equal(
    isCommentOnlyDiff(
      "--- a/x.tsx\n+++ b/x.tsx\n-          // eslint-disable-next-line jsx-a11y/label-has-for -- nested\n-    // another comment\n",
    ),
    true,
  );
  assert.equal(isCommentOnlyDiff("-  /* block */\n+  * continuation\n"), true);
});

t("★ MUST FIRE: ONE code line disqualifies the whole file", () => {
  // The load-bearing half. If "some lines are comments" were enough, a render change could be
  // smuggled past the guard by burying it among comments.
  assert.equal(
    isCommentOnlyDiff(
      "-  // a comment\n+  const x = 1;\n-  // another comment\n",
    ),
    false,
  );
  assert.equal(isCommentOnlyDiff('+  <div className="new" />\n'), false);
});

t("★ MUST FIRE: an EMPTY diff is not an exemption", () => {
  // Otherwise an unreadable or empty patch would silently excuse a file.
  assert.equal(isCommentOnlyDiff(""), false);
  assert.equal(isCommentOnlyDiff("--- a/x.tsx\n+++ b/x.tsx\n"), false);
  assert.equal(isCommentOnlyDiff(null), false);
});

// ── THE REAL CODE PATH: the hook itself, spawned against a real git repo ─────────────────────────
// Everything above tests pure functions. The anchor the CLI block computes — WHICH date a screenshot
// has to beat — has been wrong twice (merge-base committer date; oldest-commit author date), and
// neither version was reachable from a pure-function test. These spawn the hook the way Claude Code
// does (stdin event, cwd = the repo) over a repo built to the measured branch-split shape.
//
// Times model the incident: evidence captured 10:53; the split's first commit 13:22.
const HOOK = fileURLToPath(new URL("./ui-evidence-guard.mjs", import.meta.url));
const T = {
  base: "2025-03-10T08:00:00+00:00",
  stale: "2025-03-10T10:00:00+00:00", // a shot from BEFORE the UI change
  uiChange: "2025-03-10T10:40:00+00:00",
  shot: "2025-03-10T10:53:00+00:00", // evidence at 10:53 — after the change
  splitFirst: "2025-03-10T13:22:00+00:00", // the split's first commit
  lateTweak: "2025-03-10T14:00:00+00:00", // a UI change AFTER the shot
  rebase: "2025-03-10T15:00:00+00:00",
};
const epoch = (iso) => Date.parse(iso);

/**
 * A repo in the SPLIT shape. The UI change is authored 10:40 on `work`; a screenshot lands at 10:53;
 * then at 13:22 a NEW branch off main takes some later, non-UI work as its first commit and
 * cherry-picks the UI commit on top — cherry-pick keeps the AUTHOR date (10:40) and stamps a new
 * COMMITTER date (13:22). `.evidence/` is gitignored, as it is in the real repo.
 */
function splitRepo() {
  const d = scratchDir("uieg-split");
  const env = (when) => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(d, "no-global-gitconfig"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_AUTHOR_DATE: when ?? T.base,
    GIT_COMMITTER_DATE: when ?? T.base,
    HOOK_FIRE_LOG: join(d, "fires.log"),
  });
  const git = (args, when) =>
    execFileSync("git", args, {
      cwd: d,
      encoding: "utf8",
      env: env(when),
    }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(d, ".gitignore"), ".evidence/\n");
  writeFileSync(join(d, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["checkout", "-q", "-b", "work"]);
  mkdirSync(join(d, "apps/web/app"), { recursive: true });
  writeFileSync(
    join(d, "apps/web/app/page.tsx"),
    'export default () => <div className="new" />;\n',
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "ui change"], T.uiChange);
  const uiSha = git(["rev-parse", "HEAD"]);
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  const shot = join(d, ".evidence/task/shot.png");
  writeFileSync(shot, Buffer.alloc(MIN_SHOT_BYTES + 1, 9));
  utimesSync(shot, new Date(T.shot), new Date(T.shot));
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "split"]);
  mkdirSync(join(d, "scripts"), { recursive: true });
  writeFileSync(join(d, "scripts/later.mjs"), "// later, non-UI work\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "later non-ui work"], T.splitFirst);
  git(["cherry-pick", uiSha], T.splitFirst);
  const runHook = (message = "The panel is done and verified.") => {
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: d,
      encoding: "utf8",
      input: JSON.stringify({
        last_assistant_message: message,
        stop_hook_active: false,
      }),
      env: env(),
    });
    return { ...r, blocked: /"decision":"block"/.test(r.stdout ?? "") };
  };
  return {
    d,
    git,
    shot,
    runHook,
    setShotTime: (iso) => utimesSync(shot, new Date(iso), new Date(iso)),
  };
}

t(
  "★ MUST FIRE first (positive control for the harness): a shot from BEFORE the UI change is blocked through the real hook",
  () => {
    const r = splitRepo();
    r.setShotTime(T.stale);
    const v = r.runHook();
    assert.equal(v.status, 0, v.stderr);
    assert.equal(
      v.blocked,
      true,
      `expected a block, got stdout=${JSON.stringify(v.stdout)} stderr=${JSON.stringify(v.stderr)}`,
    );
    assert.match(v.stdout, /\.evidence\//);
  },
);
t(
  "☑ MUST NOT FIRE (regression, the measured branch split): a shot taken AFTER the UI change and BEFORE the split is accepted",
  () => {
    const r = splitRepo();
    // The fact the mechanism turns on, recorded IN the test so nobody has to trust the comment: on
    // this repo the branch's OLDEST commit author date is the split's 13:22 — past the 10:53 shot —
    // which is why the previous anchor threw the evidence away. Delete newestUiChangeMs and restore
    // that anchor, and the accept-assertion below goes red.
    const base = r.git(["merge-base", "origin/main", "HEAD"]);
    const oldestAuthor =
      Number(
        r
          .git(["log", "--reverse", "--format=%at", `${base}..HEAD`])
          .split("\n")[0],
      ) * 1000;
    assert.equal(
      oldestAuthor,
      epoch(T.splitFirst),
      "the split's first commit is authored 13:22",
    );
    assert.ok(
      oldestAuthor > epoch(T.shot),
      "…which is AFTER the 10:53 shot — the old anchor's failure",
    );
    // same repo, same code path as the block above; only the shot's mtime differs
    r.setShotTime(T.stale);
    assert.equal(
      r.runHook().blocked,
      true,
      "harness control: the stale shot blocks",
    );
    r.setShotTime(T.shot);
    const v = r.runHook();
    assert.equal(v.status, 0, v.stderr);
    assert.equal(
      v.blocked,
      false,
      `real evidence was discarded by a branch split: stdout=${JSON.stringify(v.stdout)}`,
    );
    assert.equal(v.stdout.trim(), "", "an accepted claim prints nothing");
  },
);
t(
  "★ MUST FIRE (the kept rule): a UI change made AFTER the shot makes it stale again",
  () => {
    const r = splitRepo();
    writeFileSync(
      join(r.d, "apps/web/app/page.tsx"),
      'export default () => <div className="newer" />;\n',
    );
    r.git(["add", "-A"]);
    r.git(["commit", "-q", "-m", "late ui tweak"], T.lateTweak);
    const v = r.runHook();
    assert.equal(
      v.blocked,
      true,
      "evidence older than the newest UI change is not evidence of it",
    );
  },
);
t(
  "☑ MUST NOT FIRE: a REBASE onto a newer main does not invalidate the accepted shot (through the real hook, not the arithmetic)",
  () => {
    const r = splitRepo();
    r.git(["checkout", "-q", "main"]);
    writeFileSync(join(r.d, "README.md"), "main moved\n");
    r.git(["add", "-A"]);
    r.git(["commit", "-q", "-m", "main moved"], T.rebase);
    r.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    r.git(["checkout", "-q", "split"]);
    r.git(["rebase", "-q", "main"], T.rebase); // committer dates → 15:00; author dates untouched
    const v = r.runHook();
    assert.equal(v.status, 0, v.stderr);
    assert.equal(
      v.blocked,
      false,
      `a rebase discarded real evidence: ${JSON.stringify(v.stdout)}`,
    );
  },
);
t(
  "★ newestUiChangeMs anchors to the CONTENT: max author time over the changed UI files, null with no files",
  () => {
    const r = splitRepo();
    const base = r.git(["merge-base", "origin/main", "HEAD"]);
    const g = (...a) => r.git(a);
    assert.equal(
      newestUiChangeMs(g, base, ["apps/web/app/page.tsx"]),
      epoch(T.uiChange),
    );
    assert.equal(newestUiChangeMs(g, base, []), null);
    // the non-UI file's later date must NOT leak into a UI anchor
    assert.equal(
      newestUiChangeMs(g, base, ["scripts/later.mjs"]),
      epoch(T.splitFirst),
    );
  },
);

// ── The rebase that manufactured evidence ────────────────────────────────────────────────────────
// Freshness was decided by FILE MTIME, and a rebase rewrites every working-tree mtime to now.
// Screenshots committed a day earlier, for a DIFFERENT task, were refused as STALE on one head and
// passed the identical test on the rebased head. This guard is the half that BLOCKS a done claim, so
// here the bug did not withhold evidence — it let an unevidenced claim through.

t(
  "★ MUST FIRE: a COMMITTED shot older than the cutoff is not fresh, even when its mtime is NOW",
  () => {
    const d = scratchDir("uieg-prov");
    mkdirSync(join(d, ".evidence/other-task"), { recursive: true });
    // mtime is NOW — exactly the state a rebase or a checkout leaves behind.
    writeFileSync(
      join(d, ".evidence/other-task/01.png"),
      Buffer.alloc(MIN_SHOT_BYTES + 1, 7),
    );
    const cut = Date.now() - 60_000;
    const committedLongAgo = () =>
      String(Math.floor((Date.now() - 31 * 3600_000) / 1000));

    // NEGATIVE CONTROL — this is the pre-fix code path (no git ⇒ mtime decides). It MUST count the
    // shot, or the assertion below proves nothing.
    assert.equal(freshEvidenceCount(d, cut), 1);

    assert.equal(freshEvidenceCount(d, cut, committedLongAgo), 0);
  },
);

t(
  "★ MUST NOT FIRE: an UNTRACKED shot has no commit, so mtime stays the honest answer",
  () => {
    const d = scratchDir("uieg-untracked");
    mkdirSync(join(d, ".evidence/task"), { recursive: true });
    writeFileSync(
      join(d, ".evidence/task/01.png"),
      Buffer.alloc(MIN_SHOT_BYTES + 1, 7),
    );
    // `git log -- <untracked>` exits 0 with EMPTY output. That is "no provenance", never "old";
    // treating it as 0 would date every fresh Playwright capture to 1970 and refuse all of it.
    assert.equal(
      freshEvidenceCount(d, Date.now() - 60_000, () => ""),
      1,
    );
  },
);

t("committedAtMs returns NULL — never 0 — when git cannot answer", () => {
  assert.equal(
    committedAtMs(() => {
      throw new Error("not a git repository");
    }, "x.png"),
    null,
  );
  assert.equal(
    committedAtMs(() => "", "x.png"),
    null,
  );
  assert.equal(
    committedAtMs(() => "not-a-number", "x.png"),
    null,
  );
  assert.equal(
    committedAtMs(() => "0", "x.png"),
    null,
  );
  assert.equal(
    committedAtMs(() => "1788081139", "x.png"),
    1788081139000,
  );
});

console.log(
  `\n[ui-evidence-guard.test] ${failures ? `${failures} failure(s).` : "all cases passed."}`,
);
process.exit(failures ? 1 : 0);
