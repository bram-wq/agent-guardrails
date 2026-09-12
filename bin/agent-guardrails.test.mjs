// Behavioral test for bin/agent-guardrails.mjs — run: `node bin/agent-guardrails.test.mjs`.
// Drives the CLI exactly as a user would (a child process, cwd = a scratch project) and asserts on
// the files it leaves behind. No test framework.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir } from "../hooks/_scratch-dir.mjs";
import { projectKey } from "../hooks/_fire-log.mjs";

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

  // and a populated log produces the table with the never-ran / ran-never-fired distinction.
  // The log is machine-wide, so every line carries a project column; `report` shows THIS project.
  const here = projectKey(dir);
  const log = join(dir, "fires.log");
  writeFileSync(
    log,
    [
      `2026-09-12T00:00:00.000Z\trun\tprose-guard.mjs\tlive\t${here}`,
      `2026-09-12T00:00:01.000Z\trun\tprose-guard.mjs\tlive\t${here}`,
      `2026-09-12T00:00:02.000Z\tfire\tprose-guard.mjs\tdeny\tnot-a-command\tlive\t${here}`,
      `2026-09-12T00:00:03.000Z\trun\tscope-guard.mjs\ttest\t${here}`,
      // another project on the same machine, and a line from before the column existed
      "2026-09-12T00:00:04.000Z\trun\trunaway-guard.mjs\tlive\telsewhere-deadbeef",
      "2026-09-12T00:00:05.000Z\trun\trunaway-guard.mjs\tlive",
      "",
    ].join("\n"),
  );
  const t = cli(["report"], dir, { HOOK_FIRE_LOG: log });
  check("populated report exits 0", t.code === 0, t.out);
  check("report names the project it is scoped to", t.out.includes(`Project: ${here}`), t.out);
  check("prose-guard row shows 2 runs, 1 fire, 50.0%", /prose-guard\.mjs\s+2\s+1\s+50\.0%/.test(t.out), t.out);
  check('scope-guard row reads "ran, never fired"', /scope-guard\.mjs\s+1\s+0\s+0\.0%.*ran, never fired/.test(t.out), t.out);
  check(
    'runaway-guard row reads "never ran" — the other project\'s run and the legacy line are not this project\'s',
    /runaway-guard\.mjs\s+0\s+0\s+n\/a.*never ran/.test(t.out),
    t.out,
  );
  check("…and the hidden lines are named, not silently dropped", /Hidden: elsewhere-deadbeef \(1\), 1 line\(s\) with no project column/.test(t.out), t.out);
  check("denominator line counts 3 run lines and 1 fire line for this project, 6 in the file", /Denominator: 3 run line\(s\) and 1 fire line\(s\) for .* \(6 in the whole file\)/.test(t.out), t.out);

  const a = cli(["report", "--all"], dir, { HOOK_FIRE_LOG: log });
  check("report --all exits 0", a.code === 0, a.out);
  check("--all counts the other project's run and the legacy line", /runaway-guard\.mjs\s+2\s+0\s+0\.0%/.test(a.out), a.out);
  check("--all lists every project with its line count", /Every project \(--all\): .*elsewhere-deadbeef \(1\)/.test(a.out), a.out);

  // a log holding ONLY other projects' lines must not read as "never ran"
  const foreign = join(dir, "foreign.log");
  writeFileSync(foreign, "2026-09-12T00:00:04.000Z\trun\trunaway-guard.mjs\tlive\telsewhere-deadbeef\n");
  const f = cli(["report"], dir, { HOOK_FIRE_LOG: foreign });
  check("report on a log with only other projects exits 0", f.code === 0, f.out);
  check('…and says "No runs recorded for THIS project", naming the others', /No runs recorded for THIS project/.test(f.out) && /1 line\(s\) belong to others/.test(f.out), f.out);
  check("…and prints no fire-rate table", !/\bn\/a\b/.test(f.out) && !/\brate\b/.test(f.out), f.out);

  // unreadable ≠ empty
  const bad = join(dir, "not-a-file");
  mkdirSync(bad);
  const u = cli(["report"], dir, { HOOK_FIRE_LOG: bad });
  check("report exits 2 when the log cannot be read", u.code === 2, u.out);
  check("…and says so, not 'No runs recorded'", /could not read/.test(u.out) && !/No runs recorded/.test(u.out), u.out);
}

// ── 9. uninstall removes only what init added ────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-uninstall");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  const mine = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["my-own-guard.mjs"], timeout: 5 }] },
      ],
      Notification: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  };
  const original = JSON.stringify(mine, null, 2) + "\n";
  writeFileSync(join(dir, ".claude", "settings.json"), original);
  writeFileSync(join(dir, ".claude", "hooks", "my-own-guard.mjs"), "// mine\n");
  check("init before uninstall exits 0", cli(["init"], dir).code === 0);
  const beforeBackups = backups(dir).length;

  // a locally modified copy of a shipped hook is theirs now
  const modified = join(dir, ".claude", "hooks", "runaway-guard.mjs");
  writeFileSync(modified, readFileSync(modified, "utf8") + "// local tweak\n");

  const dry = cli(["uninstall", "--dry-run"], dir);
  check("uninstall --dry-run exits 0", dry.code === 0, dry.out);
  check("dry-run prints the plan", /\[dry-run\] unmerge/.test(dry.out) && /\[dry-run\] delete/.test(dry.out) && /\[dry-run\] keep/.test(dry.out), dry.out);
  check("dry-run deletes no file", existsSync(join(dir, ".claude", "hooks", "prose-guard.mjs")));
  check("dry-run writes no backup", backups(dir).length === beforeBackups);
  check("dry-run leaves settings as init left them", hookEntries(settingsOf(dir)).length > 2);

  const r = cli(["uninstall"], dir);
  check("uninstall exits 0", r.code === 0, r.out);
  check(
    "init then uninstall round-trips settings.json byte-for-byte",
    readFileSync(join(dir, ".claude", "settings.json"), "utf8") === original,
    readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
  );
  check("a timestamped backup is written before unmerging", backups(dir).length === beforeBackups + 1);
  const left = readdirSync(join(dir, ".claude", "hooks")).sort();
  check("foreign hook file survives", left.includes("my-own-guard.mjs"), left.join(","));
  check("byte-identical shipped copies are deleted", !left.includes("prose-guard.mjs") && !left.includes("_fire-log.mjs"), left.join(","));
  check("the locally modified hook is kept…", left.includes("runaway-guard.mjs"), left.join(","));
  check("…and reported as kept", /keep\s+.*runaway-guard\.mjs.*locally modified/.test(r.out), r.out);
  // counts come from what ships, never typed: a guard added to hooks/ must not turn this red
  const exampleEntries = Object.values(JSON.parse(readFileSync(join(ROOT, "settings.example.json"), "utf8")).hooks)
    .flatMap((g) => g.flatMap((x) => x.hooks)).length;
  check(
    "uninstall summary counts entries, files and kept files",
    r.out.includes(`${exampleEntries} hook entries removed, ${SHIPPED.length - 1} file(s) deleted, 1 modified file(s) kept`),
    r.out,
  );

  const again = cli(["uninstall"], dir);
  check("second uninstall exits 0, removes nothing, still names the kept file", again.code === 0 && /0 hook entries removed, 0 file\(s\) deleted, 1 modified/.test(again.out), again.out);
  check("second uninstall does not touch the kept file", existsSync(modified));

  // a project init created from nothing uninstalls to an empty object
  const fresh = scratchDir("agr-uninstall-fresh");
  cli(["init"], fresh);
  const u = cli(["uninstall"], fresh);
  check("uninstall after a from-scratch init exits 0", u.code === 0, u.out);
  check("…leaves an empty settings object and no hook files", readFileSync(join(fresh, ".claude", "settings.json"), "utf8") === "{}\n" && readdirSync(join(fresh, ".claude", "hooks")).length === 0);
}

// ── 10. try runs a command through every Bash guard without a session ────────────────────────────
{
  const dir = scratchDir("agr-try");
  const deny = cli(["try", "yes for sure"], dir);
  check("try 'yes for sure' exits 1", deny.code === 1, deny.out);
  check("…and prints DENY for runaway-guard with the first line of its reason", /^DENY  runaway-guard\.mjs: +Runaway output/m.test(deny.out), deny.out);
  check("…and allow for the guards that do not fire", /^allow prose-guard\.mjs$/m.test(deny.out), deny.out);
  const allow = cli(["try", "npm test"], dir);
  check("try 'npm test' exits 0", allow.code === 0, allow.out);
  check("…and every Bash guard prints allow", !/^(DENY|warn|error)/m.test(allow.out) && /^allow runaway-guard\.mjs$/m.test(allow.out), allow.out);
  const bashGuards = SHIPPED.filter((f) => !f.startsWith("_") && !/^(ui-evidence|goal|scope)-guard\.mjs$/.test(f));
  check(`…one line per Bash guard (${bashGuards.length})`, (allow.out.match(/^allow /gm) ?? []).length === bashGuards.length, allow.out);
  check("try with no Stop/Edit guard in the list", !/goal-guard|ui-evidence-guard|scope-guard/.test(allow.out), allow.out);
  const warn = cli(["try", 'git commit -m "fix: TypeError: x is not a function"'], dir);
  check("a prompt-only guard prints warn, and does not fail the command", warn.code === 0 && /^warn  root-cause-guard\.mjs: /m.test(warn.out), warn.out);
  check("try without a command exits 1", cli(["try"], dir).code === 1);
}

// ── 11. new scaffolds a guard and its test from templates/ ───────────────────────────────────────
{
  const copy = scratchDir("agr-new");
  for (const d of ["bin", "hooks", "templates"]) cpSync(join(ROOT, d), join(copy, d), { recursive: true });
  const COPY_CLI = join(copy, "bin", "agent-guardrails.mjs");
  const run = (args) => {
    const r = spawnSync(process.execPath, [COPY_CLI, ...args], { cwd: copy, encoding: "utf8", env: { ...process.env, HOOK_CTX: "test" } });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const r = run(["new", "foo-guard"]);
  check("new foo-guard exits 0", r.code === 0, r.out);
  const hook = join(copy, "hooks", "foo-guard.mjs");
  const test = join(copy, "hooks", "foo-guard.test.mjs");
  check("new writes hooks/foo-guard.mjs and hooks/foo-guard.test.mjs", existsSync(hook) && existsSync(test));
  check("the placeholder is substituted everywhere", !/__NAME__/.test(readFileSync(hook, "utf8")) && !/__NAME__/.test(readFileSync(test, "utf8")));
  check("the scaffold records runs and fires through _fire-log", /recordInvocation\("foo-guard\.mjs"\)/.test(readFileSync(hook, "utf8")) && /recordFire\("foo-guard\.mjs"/.test(readFileSync(hook, "utf8")));
  const t = spawnSync(process.execPath, [test], { cwd: copy, encoding: "utf8", env: { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(copy, "fires.log") } });
  check("the scaffolded test passes as written", t.status === 0 && /all cases passed/.test(t.stdout), `${t.stdout}${t.stderr}`);
  check("the scaffolded test pre-writes fire, not-fire, garbage, oversize and wrong-tool cases", /FIRE/.test(t.stdout) && /ALLOW the twin/.test(t.stdout) && /garbage stdin/.test(t.stdout) && /oversize stdin/.test(t.stdout) && /non-Bash tool/.test(t.stdout), t.stdout);
  const before = readFileSync(hook, "utf8");
  const again = run(["new", "foo-guard"]);
  check("new refuses to overwrite an existing guard", again.code === 1 && /refusing to overwrite/.test(again.out), again.out);
  check("…and leaves the file untouched", readFileSync(hook, "utf8") === before);
  check("new rejects a name that is not a lower-case slug", run(["new", "Bad Name"]).code === 1);
  check("new without a name exits 1", run(["new"]).code === 1);
}

// ── 12. doctor feeds each hook its OWN event type and its known incident ─────────────────────────
{
  const dir = scratchDir("agr-doctor");
  cli(["init"], dir);
  const doc = cli(["doctor"], dir);
  check("doctor exits 0 on a healthy install", doc.code === 0, doc.out);
  for (const g of ["runaway-guard.mjs", "prose-guard.mjs", "piped-verdict-guard.mjs"])
    check(`doctor: ${g} allows its benign event and refuses its incident`, new RegExp(`ok\\s+${g}: allows its benign event \\(PreToolUse/Bash\\), refuses its incident`).test(doc.out), doc.out);
  check("doctor sends scope-guard an Edit event", /ok\s+scope-guard\.mjs: allows its benign event \(PreToolUse\/Edit\)/.test(doc.out), doc.out);
  check("doctor sends ui-evidence-guard a Stop event", /ok\s+ui-evidence-guard\.mjs: allows its benign event \(Stop\)/.test(doc.out), doc.out);
  check("doctor sends goal-guard Stop and SessionStart", /ok\s+goal-guard\.mjs: allows its benign event \(Stop, SessionStart\)/.test(doc.out), doc.out);
  check("doctor still checks node and settings paths", /ok\s+node v?\d+/.test(doc.out) && /settings → /.test(doc.out), doc.out);

  // a hook truncated to `process.exit(0)` parses and allows everything — the benign check alone passed it
  writeFileSync(join(dir, ".claude", "hooks", "runaway-guard.mjs"), "process.exit(0)\n");
  const bad = cli(["doctor"], dir);
  check("doctor exits 1 when a guard no longer refuses its incident", bad.code === 1, bad.out);
  check("…and names the guard and the incident", /FAIL\s+runaway-guard\.mjs: allows its benign event but does NOT refuse its incident "yes for sure"/.test(bad.out), bad.out);
  check("…while the untouched guards still pass", /ok\s+prose-guard\.mjs: .*refuses its incident/.test(bad.out), bad.out);

  // a hook that DENIES its benign event is the other failure direction
  writeFileSync(
    join(dir, ".claude", "hooks", "prose-guard.mjs"),
    'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"always"}}));\n',
  );
  const deny = cli(["doctor"], dir);
  check("doctor fails a guard that denies its benign event", deny.code === 1 && /FAIL\s+prose-guard\.mjs: deny on a benign PreToolUse event/.test(deny.out), deny.out);
}

// ── 8. usage ─────────────────────────────────────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-usage");
  check("no command → usage, exit 1", cli([], dir).code === 1);
  check("unknown command → exit 1", cli(["frobnicate"], dir).code === 1);
  check("--help → exit 0", cli(["--help"], dir).code === 0);
  const h = cli(["--help"], dir).out;
  check("--help lists every command", ["init", "uninstall", "doctor", "try", "new", "report", "demo"].every((c) => new RegExp(`^  ${c} `, "m").test(h)), h);
}

console.log(fails ? `\n[agent-guardrails.test] ${fails} FAILED.` : "\n[agent-guardrails.test] all cases passed.");
process.exit(fails ? 1 : 0);
