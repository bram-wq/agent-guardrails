// Behavioral test for bin/agent-guardrails.mjs — run: `node bin/agent-guardrails.test.mjs`.
// Drives the CLI exactly as a user would (a child process, cwd = a scratch project) and asserts on
// the files it leaves behind. No test framework.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir } from "../hooks/_scratch-dir.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "agent-guardrails.mjs");
const SHIPPED = readdirSync(join(ROOT, "hooks")).filter(
  (f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"),
);

function cli(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOOK_CTX: "test", ...env },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

let fails = 0;
function check(name, cond, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
}
const settingsOf = (dir) => JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
const hookEntries = (s) =>
  Object.values(s.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
const backups = (dir) =>
  readdirSync(join(dir, ".claude")).filter((f) => f.startsWith("settings.json.bak-"));

// ── 1. init into an empty project ────────────────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-init");
  const r = cli(["init"], dir);
  check("init exits 0", r.code === 0, r.out);
  const installed = readdirSync(join(dir, ".claude", "hooks"));
  check(
    "init copies every non-test hook (and nothing else)",
    installed.length === SHIPPED.length && installed.every((f) => SHIPPED.includes(f)),
    `installed=${installed.join(",")}`,
  );
  check("init copies no *.test.mjs", installed.every((f) => !f.endsWith(".test.mjs")));
  let s;
  try {
    s = settingsOf(dir);
  } catch (e) {
    s = null;
  }
  check("init writes valid settings.json", s !== null);
  const example = JSON.parse(readFileSync(join(ROOT, "settings.example.json"), "utf8")).hooks;
  const wanted = Object.values(example).flatMap((g) => g.flatMap((x) => x.hooks)).length;
  check(
    `merged settings carry all ${wanted} hook entries from settings.example.json`,
    s && hookEntries(s).length === wanted,
    s ? `got ${hookEntries(s).length}` : "",
  );
  check("init on a fresh project writes no backup", backups(dir).length === 0);
  check("init prints what it did", /copy/.test(r.out) && /settings\.json/.test(r.out), r.out);

  // ── 2. re-running is idempotent ────────────────────────────────────────────────────────────────
  const before = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
  const again = cli(["init"], dir);
  check("second init exits 0", again.code === 0, again.out);
  check(
    "second init leaves settings.json byte-identical",
    readFileSync(join(dir, ".claude", "settings.json"), "utf8") === before,
  );
  check("second init adds no duplicate hook entries", hookEntries(settingsOf(dir)).length === wanted);
  check("second init writes no backup", backups(dir).length === 0);
  check("second init says there was nothing to do", /nothing to do/.test(again.out), again.out);

  // ── 5. doctor passes on a fresh install ────────────────────────────────────────────────────────
  const doc = cli(["doctor"], dir);
  check("doctor exits 0 on a fresh install", doc.code === 0, doc.out);
  check("doctor reports every guard as ok", !/FAIL/.test(doc.out), doc.out);
}

// ── 3. existing unrelated hooks and settings are preserved ───────────────────────────────────────
{
  const dir = scratchDir("agr-merge");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mine = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node", args: ["my-own-guard.mjs"], timeout: 5 }],
        },
      ],
      Notification: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  };
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(mine, null, 2));
  const r = cli(["init"], dir);
  check("init over existing settings exits 0", r.code === 0, r.out);
  const s = settingsOf(dir);
  check("unrelated top-level keys survive", JSON.stringify(s.permissions) === JSON.stringify(mine.permissions));
  check("unrelated event (Notification) survives", JSON.stringify(s.hooks.Notification) === JSON.stringify(mine.hooks.Notification));
  const bashGroup = s.hooks.PreToolUse.find((g) => g.matcher === "Bash");
  check(
    "pre-existing hook in the same matcher group is kept, first",
    bashGroup && bashGroup.hooks[0].args[0] === "my-own-guard.mjs",
  );
  const exampleBash = JSON.parse(readFileSync(join(ROOT, "settings.example.json"), "utf8"))
    .hooks.PreToolUse.filter((g) => g.matcher === "Bash")
    .reduce((n, g) => n + g.hooks.length, 0);
  check(
    "new Bash guards are appended to the existing Bash group, not a duplicate group",
    s.hooks.PreToolUse.filter((g) => g.matcher === "Bash").length === 1 &&
      bashGroup.hooks.length === 1 + exampleBash,
    `groups=${s.hooks.PreToolUse.length} bashHooks=${bashGroup?.hooks.length} want=${1 + exampleBash}`,
  );
  const b = backups(dir);
  check("a timestamped backup is written before merging", b.length === 1, b.join(","));
  check(
    "the backup is the pre-merge file",
    b.length === 1 && readFileSync(join(dir, ".claude", b[0]), "utf8") === JSON.stringify(mine, null, 2),
  );
}

// ── 4. dry-run writes nothing ────────────────────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-dry");
  const r = cli(["init", "--dry-run"], dir);
  check("dry-run exits 0", r.code === 0, r.out);
  check("dry-run creates no .claude directory", !existsSync(join(dir, ".claude")));
  check("dry-run still describes the plan", /\[dry-run\]/.test(r.out) && /settings\.json/.test(r.out), r.out);
}

// ── 6. init refuses to touch a settings.json it cannot parse ─────────────────────────────────────
{
  const dir = scratchDir("agr-broken");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
  const r = cli(["init"], dir);
  check("init exits non-zero on unparseable settings.json", r.code !== 0);
  check("…and leaves the file as it was", readFileSync(join(dir, ".claude", "settings.json"), "utf8") === "{ not json");
}

// ── 7. report on an empty log states the denominator, not zeros ──────────────────────────────────
{
  const dir = scratchDir("agr-report");
  const r = cli(["report"], dir, { HOOK_FIRE_LOG: join(dir, "never-written.log") });
  check("report exits 0 on an empty log", r.code === 0, r.out);
  check('report says "No runs recorded" with the path', /No runs recorded in .*never-written\.log/.test(r.out), r.out);
  check("report names the zero denominator explicitly", /denominator is zero/i.test(r.out), r.out);
  check("report prints no fire-rate table on an empty log", !/rate/.test(r.out.split("\n")[0]) && !/0\.0%/.test(r.out), r.out);

  // and a populated log produces the table with the never-ran / ran-never-fired distinction
  const log = join(dir, "fires.log");
  writeFileSync(
    log,
    [
      "2026-09-12T00:00:00.000Z\trun\tprose-guard.mjs\tlive",
      "2026-09-12T00:00:01.000Z\trun\tprose-guard.mjs\tlive",
      "2026-09-12T00:00:02.000Z\tfire\tprose-guard.mjs\tdeny\tnot-a-command\tlive",
      "2026-09-12T00:00:03.000Z\trun\tscope-guard.mjs\ttest",
      "",
    ].join("\n"),
  );
  const t = cli(["report"], dir, { HOOK_FIRE_LOG: log });
  check("populated report exits 0", t.code === 0, t.out);
  check("prose-guard row shows 2 runs, 1 fire, 50.0%", /prose-guard\.mjs\s+2\s+1\s+50\.0%/.test(t.out), t.out);
  check('scope-guard row reads "ran, never fired"', /scope-guard\.mjs\s+1\s+0\s+0\.0%.*ran, never fired/.test(t.out), t.out);
  check('runaway-guard row reads "never ran"', /runaway-guard\.mjs\s+0\s+0\s+n\/a.*never ran/.test(t.out), t.out);
  check("denominator line counts 3 run lines and 1 fire line", /Denominator: 3 run line\(s\) and 1 fire line\(s\)/.test(t.out), t.out);

  // unreadable ≠ empty
  const bad = join(dir, "not-a-file");
  mkdirSync(bad);
  const u = cli(["report"], dir, { HOOK_FIRE_LOG: bad });
  check("report exits 2 when the log cannot be read", u.code === 2, u.out);
  check("…and says so, not 'No runs recorded'", /could not read/.test(u.out) && !/No runs recorded/.test(u.out), u.out);
}

// ── 8. usage ─────────────────────────────────────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-usage");
  check("no command → usage, exit 1", cli([], dir).code === 1);
  check("unknown command → exit 1", cli(["frobnicate"], dir).code === 1);
  check("--help → exit 0", cli(["--help"], dir).code === 0);
}

console.log(fails ? `\n[agent-guardrails.test] ${fails} FAILED.` : "\n[agent-guardrails.test] all cases passed.");
process.exit(fails ? 1 : 0);
