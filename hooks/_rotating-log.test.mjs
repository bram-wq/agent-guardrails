// Behavioural test for _rotating-log.mjs — run: `node hooks/_rotating-log.test.mjs`.
//
// CONTRACT: a bounded append-only log never loses a line to its own bound. Each property is asserted in
// both directions: rotation FIRES past the bound and stays silent below it; prune DELETES a segment the
// newest window no longer needs and KEEPS one the window still needs, one inside its grace period, and
// one whose file name sorts older than the lines it holds (the double-rotation misorder).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDir } from "./_scratch-dir.mjs";
import { appendLine, prune, readLines, rotateIfOver, segmentsOf } from "./_rotating-log.mjs";

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}${ok ? "" : `, got ${got}`}`);
};

const lineAt = (ts, text) => `${ts}\t${text}\n`;
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const LINES = (max, keep = max) => ({ maxLines: max, keep, weight: () => 1 });
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

// ── nothing on disk ──────────────────────────────────────────────────────────────────────────────
{
  const f = join(scratchDir("rotlog-none"), "log");
  check("ALLOW no live file and no segment reads as null (nothing recorded), not as an empty log", readLines(f), null);
  check("ALLOW rotateIfOver on a missing file does nothing", rotateIfOver(f, LINES(0)), false);
}

// ── an unreadable log throws, so "could not find out" never prints as "nothing recorded" ───────────
{
  const f = join(scratchDir("rotlog-dir"), "log");
  mkdirSync(f);
  let got;
  try {
    readLines(f);
    got = "returned";
  } catch {
    got = "threw";
  }
  check("FIRE  a log path that is a directory THROWS instead of reading as empty", got, "threw");
}

// ── below the bound: no rotation ─────────────────────────────────────────────────────────────────
{
  const f = join(scratchDir("rotlog-below"), "log");
  for (let i = 0; i < 5; i++) appendLine(f, lineAt(iso(i), `l${i}`), LINES(10));
  check("ALLOW below maxLines no segment is created", segmentsOf(f).length, 0);
  check("ALLOW below maxLines every line reads back in order", readLines(f).map((l) => l.split("\t")[1]).join(","), "l0,l1,l2,l3,l4");
}

// ── past the bound: the live file is moved aside, and nothing is lost ──────────────────────────────
{
  const f = join(scratchDir("rotlog-lines"), "log");
  for (let i = 0; i < 11; i++) appendLine(f, lineAt(iso(i), `l${i}`), LINES(10));
  check("FIRE  past maxLines the live file is rotated into one segment", segmentsOf(f).length, 1);
  check("FIRE  the rotation moved the file: no live file remains until the next append", existsSync(f), false);
  check("ALLOW every line is still readable after the rotation", readLines(f).length, 11);
  appendLine(f, lineAt(iso(11), "l11"), LINES(10));
  check("ALLOW the next append starts a fresh live file and reads after the segment", readLines(f).at(-1).split("\t")[1], "l11");
}
{
  const f = join(scratchDir("rotlog-bytes"), "log");
  const bound = { maxBytes: 100, keep: 100, weight: (l) => Buffer.byteLength(l) + 1 };
  appendLine(f, lineAt(iso(0), "x".repeat(40)), bound);
  check("ALLOW below maxBytes nothing rotates", segmentsOf(f).length, 0);
  appendLine(f, lineAt(iso(1), "y".repeat(40)), bound);
  appendLine(f, lineAt(iso(2), "z".repeat(40)), bound);
  check("FIRE  past maxBytes the live file is rotated", segmentsOf(f).length, 1);
}

// ── two rotations back to back: the second moves only its own fresh file ─────────────────────────
{
  const f = join(scratchDir("rotlog-double"), "log");
  for (let i = 0; i < 4; i++) appendFileSync(f, lineAt(iso(i), `a${i}`));
  check("FIRE  (premise) the first rotation moves the full file", rotateIfOver(f, LINES(3)), true);
  appendFileSync(f, lineAt(iso(4), "b0"));
  // A second process that decided to rotate from the OLD size now renames whatever is at the path.
  check("FIRE  (premise) a late second rotation moves the fresh one-line file", rotateIfOver(f, LINES(0)), true);
  check("ALLOW the two rotations leave two segments: neither replaced the other", segmentsOf(f).length, 2);
  check("ALLOW every line of both files is still readable", readLines(f).length, 5);
}

// ── a straggler that opened the live file before the rename writes into the segment ───────────────
{
  const f = join(scratchDir("rotlog-straggler"), "log");
  for (let i = 0; i < 3; i++) appendFileSync(f, lineAt(iso(i), `s${i}`));
  rotateIfOver(f, LINES(2));
  const [seg] = segmentsOf(f);
  appendFileSync(seg, lineAt(iso(3), "straggler"));
  check("ALLOW a line written into a segment after its rotation is still read", readLines(f).some((l) => l.endsWith("\tstraggler")), true);
}

// ── prune ────────────────────────────────────────────────────────────────────────────────────────
function segmentWith(f, name, lines, mtime) {
  const p = `${f}.seg-${name}`;
  writeFileSync(p, lines.join(""));
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}
{
  const f = join(scratchDir("rotlog-prune-old"), "log");
  const old = segmentWith(f, "0000000000100-aa", [lineAt(iso(0), "old0"), lineAt(iso(1), "old1")], HOUR_AGO);
  for (let i = 10; i < 13; i++) appendFileSync(f, lineAt(iso(i), `new${i}`));
  const deleted = prune(f, LINES(99, 3));
  check("FIRE  an idle segment older than the whole newest window is deleted", deleted.includes(old) && !existsSync(old), true);
  check("ALLOW the newest window is intact after the prune", readLines(f).length, 3);
}
{
  const f = join(scratchDir("rotlog-prune-grace"), "log");
  const fresh = segmentWith(f, "0000000000100-aa", [lineAt(iso(0), "old0")]);
  for (let i = 10; i < 13; i++) appendFileSync(f, lineAt(iso(i), `new${i}`));
  prune(f, LINES(99, 3));
  check("ALLOW a segment written inside its grace period is kept, even when the window no longer needs it", existsSync(fresh), true);
}
{
  const f = join(scratchDir("rotlog-prune-needed"), "log");
  const needed = segmentWith(f, "0000000000100-aa", [lineAt(iso(0), "old0"), lineAt(iso(11), "inside")], HOUR_AGO);
  for (let i = 10; i < 13; i++) appendFileSync(f, lineAt(iso(i), `new${i}`));
  prune(f, LINES(99, 3));
  check("ALLOW an idle segment holding a line inside the newest window is kept", existsSync(needed), true);
}
{
  const f = join(scratchDir("rotlog-prune-misorder"), "log");
  // The segment whose NAME sorts first holds the NEWEST lines; the one named later holds the oldest.
  const newestButFirstName = segmentWith(f, "0000000000001-aa", [lineAt(iso(20), "n20"), lineAt(iso(21), "n21")], HOUR_AGO);
  const oldestButLaterName = segmentWith(f, "0000000000900-bb", [lineAt(iso(0), "o0")], HOUR_AGO);
  appendFileSync(f, lineAt(iso(22), "n22"));
  prune(f, LINES(99, 3));
  check("ALLOW prune judges by line timestamps: the newest lines survive though their segment's name sorts first", existsSync(newestButFirstName), true);
  check("FIRE  …and the segment of genuinely old lines is deleted though its name sorts later", existsSync(oldestButLaterName), false);
}
{
  const f = join(scratchDir("rotlog-prune-short"), "log");
  const only = segmentWith(f, "0000000000100-aa", [lineAt(iso(0), "o0")], HOUR_AGO);
  appendFileSync(f, lineAt(iso(1), "n1"));
  check("ALLOW below `keep` in total nothing is deleted", prune(f, LINES(99, 10)).length === 0 && existsSync(only), true);
}

// ── concurrent writers: every line survives the rotations they trigger ─────────────────────────────
{
  const f = join(scratchDir("rotlog-concurrent"), "log");
  const P = 6;
  const N = 150;
  const mod = pathToFileURL(join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "_rotating-log.mjs")).href;
  const child = `import { appendLine } from ${JSON.stringify(mod)};
for (let i = 0; i < ${N}; i++) appendLine(${JSON.stringify(f)}, new Date().toISOString() + "\\tp" + process.argv[1] + "-" + i + "\\n", { maxLines: 20, keep: 20, weight: () => 1 });`;
  const codes = await Promise.all(
    Array.from({ length: P }, (_, p) =>
      new Promise((res) =>
        spawn(process.execPath, ["--input-type=module", "-e", child, String(p)], { stdio: ["ignore", "ignore", "inherit"] }).on("exit", res),
      ),
    ),
  );
  check("FIRE  (premise) every writer process exited 0", codes.every((c) => c === 0), true);
  const have = new Set((readLines(f) ?? []).map((l) => l.split("\t")[1]));
  let lost = 0;
  for (let p = 0; p < P; p++) for (let i = 0; i < N; i++) if (!have.has(`p${p}-${i}`)) lost++;
  check(`ALLOW ${P} processes × ${N} appends through rotations every 20 lines lose no line`, lost, 0);
  check("FIRE  (premise) the writers really did rotate the log", segmentsOf(f).length > 1, true);
}

console.log(fails ? `\n${fails} case(s) FAILED` : "\nall cases passed");
process.exit(fails ? 1 : 0);
