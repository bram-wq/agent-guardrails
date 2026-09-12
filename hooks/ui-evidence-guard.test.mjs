// Behavioural tests for ui-evidence-guard — run: `node hooks/ui-evidence-guard.test.mjs`.
// Must-fire (UI diff + completion claim + no evidence), must-not-fire controls (no claim / no UI
// files / evidence present), and the mutation target. Needs `git` on PATH for the real-repo block.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import {
  decide,
  freshEvidenceCount,
  committedTimeMap,
  newestUiChangeMs,
  claimsDone,
  stripCode,
  looksLikeImage,
  resolveBaseRef,
  DEFAULT_UI_PATH_RE,
  MIN_SHOT_BYTES,
  isCommentOnlyDiff,
} from "./ui-evidence-guard.mjs";
import { scratchDir } from "./_scratch-dir.mjs";

// ── FIXTURES THAT ARE IMAGES ─────────────────────────────────────────────────────────────────────
// A screenshot is recognised by its MAGIC BYTES, not its name, so every fixture carries a real
// header. `fakeShot` is header + padding (enough for the guard); `realPng` is a structurally valid
// PNG — signature, IHDR, a deflated IDAT, IEND, CRCs — so the accept side is proven on a file an
// image viewer would open, not on bytes that merely begin correctly.
const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 1), Buffer.from("WEBPVP8 ")]),
  gif: Buffer.from("GIF89a\x01\x00\x01\x00"),
};
const fakeShot = (ext = "png", size = MIN_SHOT_BYTES + 1) =>
  Buffer.concat([MAGIC[ext], Buffer.alloc(size - MAGIC[ext].length, 7)]);
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A valid RGBA PNG of noise (an LCG, so it does not deflate below MIN_SHOT_BYTES). */
function realPng(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  let seed = 0x2545f491;
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 1; x < stride; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[y * stride + x] = seed >>> 24;
    }
  }
  return Buffer.concat([
    MAGIC.png,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
// The well-known 1x1 transparent PNG, as a viewer would save it.
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
t("★ the claim detector sees the shapes turns actually use", () => {
  for (const m of [
    "Done — all four pages fixed.",
    "shipped to staging",
    "this is now ready for the team",
  ])
    assert.equal(claimsDone(m), true, m);
});

// ── THE CLAIM DETECTOR, both directions (adversarial probe) ──────────────────────────────────────
t("★ MUST FIRE: the claim shapes a bare word list MISSED", () => {
  for (const m of [
    "Implemented and merged.",
    "Deployed to staging.",
    "Ready for merge.",
    "Resolved.",
    "All green — shipping now",
    "Landed on main.",
    "It failed at first. Done.",
  ]) {
    assert.equal(claimsDone(m), true, m);
    assert.equal(decide({ message: m, uiFiles: UI, evidenceCount: 0 }).block, true, m);
  }
});
t("☑ MUST NOT FIRE: the non-claims a bare word list BLOCKED", () => {
  for (const m of [
    "Not done yet — still failing.",
    "Done? Not sure.",
    "Run this first:\n```\nnpm run done\n```\nthen report back.",
    "the CI works by polling",
    "I have not verified anything",
    "completed 2 of 5, 3 remain",
    "This isn't fixed; the panel is still blank.",
    "Almost done — two pages left.",
    "Never verified on mobile.",
    "run `npm run verified` before the demo",
    "still building the i18n branch, judge running",
  ]) {
    assert.equal(claimsDone(m), false, m);
    assert.equal(decide({ message: m, uiFiles: UI, evidenceCount: 0 }).block, false, m);
  }
});
t("stripCode removes fenced and inline code, including an unterminated fence", () => {
  assert.equal(stripCode("a ```x``` b").trim(), "a   b");
  assert.equal(stripCode("a `done` b").trim(), "a   b");
  assert.equal(/done/.test(stripCode("a ```\ndone\n")), false, "an unterminated fence swallows to the end");
});
t("a non-string message is not a claim", () => {
  assert.equal(claimsDone(["Done."]), false);
  assert.equal(claimsDone(null), false);
  assert.equal(decide({ message: undefined, uiFiles: UI, evidenceCount: 0 }).block, false);
});

// ── WHAT IS UI: the default path set ─────────────────────────────────────────────────────────────
t("★ MUST FIRE: styles, public assets and the tailwind config are user-visible by default", () => {
  for (const f of [
    "apps/web/styles/g.css",
    "apps/web/public/logo.svg",
    "apps/web/tailwind.config.ts",
    "apps/web/tailwind.config.js",
    "apps/web/app/page.tsx",
    "apps/web/components/Nav.tsx",
    "apps/web/messages/en.json",
  ])
    assert.equal(DEFAULT_UI_PATH_RE.test(f), true, f);
});
t("☑ MUST NOT FIRE: server code, tests and other packages are not UI by default", () => {
  for (const f of ["apps/web/lib/db.ts", "apps/api/src/x.ts", "packages/ui/tailwind.config.ts", "apps/web/tailwind.config.ts.bak", "scripts/x.mjs"])
    assert.equal(DEFAULT_UI_PATH_RE.test(f), false, f);
});
t("★ freshEvidenceCount counts only files newer than the fork", () => {
  const d = scratchDir("uieg");
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  const old = join(d, ".evidence/task/old.png"),
    fresh = join(d, ".evidence/task/new.png");
  // ⚠ REAL-SIZE FIXTURES. These used to be the 1-byte strings "x" and "y", which meant the whole
  // test suite asserted the behaviour of a file no capture could ever produce — and any size
  // predicate added later would be validated against fixtures that assumed none existed.
  const shot = fakeShot();
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
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
    writeFileSync(join(d, `.evidence/task/shot.${ext}`), fakeShot(ext, 60_000));
  }
  assert.equal(
    freshEvidenceCount(d, 0),
    5,
    "every image type a capture tool saves must count",
  );
  assert.equal(
    decide({
      message: "done",
      uiFiles: ["apps/web/app/x.tsx"],
      evidenceCount: 5,
    }).block,
    false,
  );
});

// ── MAGIC BYTES: a name is not a file ────────────────────────────────────────────────────────────
t("★ MUST FIRE: `head -c 6000 /dev/urandom > a.png` is NOT evidence", () => {
  // Verified live before the fix: 6 KB of noise named .png satisfied the size floor and counted.
  const d = scratchDir("uieg-noise");
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  const noise = Buffer.alloc(6000);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    noise[i] = seed >>> 24;
  }
  noise[0] = 0x00; // whatever the LCG produced, make sure it is not accidentally a signature
  writeFileSync(join(d, ".evidence/task/a.png"), noise);
  writeFileSync(join(d, ".evidence/task/b.jpg"), Buffer.alloc(6000, 0x41)); // "AAAA…" named .jpg
  writeFileSync(join(d, ".evidence/task/c.webp"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(5996, 0)])); // RIFF but not WEBP
  assert.equal(freshEvidenceCount(d, 0), 0);
  for (const b of [noise, Buffer.alloc(6000, 0x41), Buffer.alloc(3)]) assert.equal(looksLikeImage(b), false);
});
t("☑ MUST NOT FIRE: a REAL PNG (signature, IHDR, deflated IDAT, IEND) is accepted", () => {
  const png = realPng();
  assert.ok(png.length >= MIN_SHOT_BYTES, `fixture must clear the size floor (${png.length} bytes)`);
  // Prove the fixture is structurally a PNG, not just a header: the IDAT inflates back to the raster.
  const idatAt = png.indexOf("IDAT", 8, "latin1");
  const idatLen = png.readUInt32BE(idatAt - 4);
  assert.equal(inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLen)).length, (64 * 4 + 1) * 64);
  const d = scratchDir("uieg-realpng");
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  writeFileSync(join(d, ".evidence/task/real.png"), png);
  assert.equal(freshEvidenceCount(d, 0), 1);
  assert.equal(decide({ message: "done", uiFiles: UI, evidenceCount: 1 }).block, false);
});
t("looksLikeImage recognises every signature a capture tool writes, from a viewer-saved PNG down", () => {
  assert.equal(looksLikeImage(Buffer.from(ONE_PIXEL_PNG_B64, "base64")), true, "1x1 PNG from a base64 constant");
  for (const ext of Object.keys(MAGIC)) assert.equal(looksLikeImage(fakeShot(ext, 64)), true, ext);
  assert.equal(looksLikeImage(Buffer.alloc(11, 0x89)), false, "shorter than a header is not an image");
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
    writeFileSync(shot, fakeShot());

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
function splitRepo({ uiFile = "apps/web/app/page.tsx" } = {}) {
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
  mkdirSync(join(d, uiFile, ".."), { recursive: true });
  writeFileSync(
    join(d, uiFile),
    uiFile.endsWith(".css") ? ".new { color: red }\n" : 'export default () => <div className="new" />;\n',
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "ui change"], T.uiChange);
  const uiSha = git(["rev-parse", "HEAD"]);
  mkdirSync(join(d, ".evidence/task"), { recursive: true });
  const shot = join(d, ".evidence/task/shot.png");
  writeFileSync(shot, fakeShot());
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
    writeFileSync(join(d, ".evidence/other-task/01.png"), fakeShot());
    const cut = Date.now() - 60_000;
    // The ONE git call the guard makes: `log --name-only --format=%ct -- .evidence`, newest first.
    const committedLongAgo = () =>
      `${Math.floor((Date.now() - 31 * 3600_000) / 1000)}\n\n.evidence/other-task/01.png\n`;

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
    writeFileSync(join(d, ".evidence/task/01.png"), fakeShot());
    // `git log -- .evidence` never names an untracked path. That is "no provenance", never "old";
    // treating it as 0 would date every fresh Playwright capture to 1970 and refuse all of it.
    assert.equal(
      freshEvidenceCount(d, Date.now() - 60_000, () => ""),
      1,
    );
  },
);

t("committedTimeMap: git that cannot answer yields NO provenance — never 0", () => {
  assert.equal(
    committedTimeMap(() => {
      throw new Error("not a git repository");
    }).size,
    0,
  );
  assert.equal(committedTimeMap(() => "").size, 0);
  assert.equal(committedTimeMap(() => "not-a-number\n\n.evidence/x.png\n").has(".evidence/x.png"), false);
  assert.equal(committedTimeMap(() => "0\n\n.evidence/x.png\n").has(".evidence/x.png"), false);
  const m = committedTimeMap(
    () => "1788081139\n\n.evidence/a.png\n.evidence/b.png\n\n1700000000\n\n.evidence/a.png\n",
  );
  assert.equal(m.get(".evidence/a.png"), 1788081139000, "the NEWEST commit wins (first seen in log order)");
  assert.equal(m.get(".evidence/b.png"), 1788081139000);
  assert.equal(m.size, 2);
});

// ── ONE git call for the whole evidence tree, not one per shot ───────────────────────────────────
// `git log -1 -- <shot>` per screenshot cost ~9 s at 1,740 committed shots — inside a Stop hook with
// a 15 s budget. A hook killed at its timeout reads as a PASS, so latency here is a bypass.
t("★ MUST FIRE in < 500 ms: 400 COMMITTED shots decide from one log walk, and their commit time wins over mtime", () => {
  const d = scratchDir("uieg-many");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(d, "no-global-gitconfig"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_AUTHOR_DATE: T.base,
    GIT_COMMITTER_DATE: T.base, // 2025 — long before any cutoff below
  };
  const git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(d, ".evidence/many"), { recursive: true });
  const shot = fakeShot();
  for (let i = 0; i < 400; i++) writeFileSync(join(d, `.evidence/many/${String(i).padStart(3, "0")}.png`), shot);
  git("add", "-A");
  git("commit", "-q", "-m", "400 shots");
  // mtimes are NOW; commit times are 2025. Against a cutoff of one minute ago, NOTHING is fresh —
  // and if the map were empty (or a per-shot call silently failed) mtime would say 400.
  const t0 = performance.now();
  const stale = freshEvidenceCount(d, Date.now() - 60_000, git);
  const all = freshEvidenceCount(d, 0, git);
  const ms = performance.now() - t0;
  assert.equal(stale, 0, "committed-in-2025 shots are not fresh evidence for today's cutoff");
  assert.equal(all, 400, "…but every one of them is a recognised image");
  assert.ok(ms < 500, `two decisions over 400 committed shots took ${ms.toFixed(0)} ms (budget 500)`);
});

// ── THE BASE REF: main, master, upstream, or say so and allow ────────────────────────────────────
t("★ MUST FIRE: a repo whose remote is origin/master is still judged (positive control through the real hook)", () => {
  const r = splitRepo();
  r.git(["update-ref", "refs/remotes/origin/master", "refs/remotes/origin/main"]);
  r.git(["update-ref", "-d", "refs/remotes/origin/main"]);
  r.setShotTime(T.stale);
  const v = r.runHook();
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.blocked, true, `origin/master was not used as the base: ${JSON.stringify(v.stdout)} ${v.stderr}`);
});
t("★ MUST FIRE: with no remote at all, a local `main` is the base", () => {
  const r = splitRepo();
  r.git(["update-ref", "-d", "refs/remotes/origin/main"]);
  r.setShotTime(T.stale);
  assert.equal(r.runHook().blocked, true);
});
t("☑ MUST NOT FIRE (documented): no main/master/upstream anywhere ⇒ one stderr line, then allow", () => {
  const r = splitRepo();
  r.git(["update-ref", "-d", "refs/remotes/origin/main"]);
  r.git(["branch", "-m", "main", "trunk"]);
  r.setShotTime(T.stale); // would block if a base existed — see the case above
  const v = r.runHook();
  assert.equal(v.status, 0);
  assert.equal(v.blocked, false);
  assert.match(v.stderr, /ui-evidence-guard: none of .* allowing/);
  assert.equal(v.stdout.trim(), "", "an allow prints nothing on stdout");
});
t("resolveBaseRef tries the candidates in order and returns null when none exists", () => {
  const seen = [];
  const only = (present) => (...a) => {
    seen.push(a[3]);
    if (a[3] === `${present}^{commit}`) return "sha";
    throw new Error("missing");
  };
  assert.equal(resolveBaseRef(only("upstream/main")), "upstream/main");
  assert.deepEqual(seen, ["origin/main^{commit}", "origin/master^{commit}", "upstream/main^{commit}"]);
  assert.equal(resolveBaseRef(() => { throw new Error("missing"); }), null);
});

// ── A STYLESHEET IS USER-VISIBLE ─────────────────────────────────────────────────────────────────
t("★ MUST FIRE through the real hook: a change confined to apps/web/styles/g.css demands evidence", () => {
  const r = splitRepo({ uiFile: "apps/web/styles/g.css" });
  r.setShotTime(T.stale);
  const v = r.runHook();
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.blocked, true, `a stylesheet change went unjudged: ${JSON.stringify(v.stdout)}`);
  r.setShotTime(T.shot);
  assert.equal(r.runHook().blocked, false, "…and fresh evidence still satisfies it");
});

console.log(
  `\n[ui-evidence-guard.test] ${failures ? `${failures} failure(s).` : "all cases passed."}`,
);
process.exit(failures ? 1 : 0);
