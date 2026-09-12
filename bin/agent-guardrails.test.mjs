// Behavioral test for bin/agent-guardrails.mjs — run: `node bin/agent-guardrails.test.mjs`.
// Drives the CLI exactly as a user would (a child process, cwd = a scratch project) and asserts on
// the files it leaves behind. No test framework.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir } from "../hooks/_scratch-dir.mjs";
import { projectKey } from "../hooks/_fire-log.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "agent-guardrails.mjs");
// Every file init ships, relative to hooks/ with `/` separators: the hooks, the helpers, and the data
// files a hook loads beside itself (rules/*.json). Mirrors packagedHookFiles() in the CLI.
const listFiles = (dir, rel = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name), `${rel}${d.name}/`) : [`${rel}${d.name}`],
  );
const SHIPPED = listFiles(join(ROOT, "hooks")).filter(
  (f) => (f.endsWith(".mjs") && !f.endsWith(".test.mjs") && !f.includes("/")) || /^rules\/[^/]+\.json$/.test(f),
);
const EXAMPLE = JSON.parse(readFileSync(join(ROOT, "settings.example.json"), "utf8")).hooks;
const entryFile = (h) => [h.command, ...(h.args ?? [])].find((a) => typeof a === "string" && a.endsWith(".mjs"))?.split(/[\\/]/).pop(); // --user writes an absolute path, which is backslashed on Windows
/** settings.example.json may wire a hook ahead of its file landing; init merges only what ships. */
const exampleEntries = (pred = () => true) =>
  Object.entries(EXAMPLE).flatMap(([ev, groups]) => groups.flatMap((g) => g.hooks.filter((h) => pred(ev, g, h))));
const SHIPPED_ENTRIES = exampleEntries((ev, g, h) => SHIPPED.includes(entryFile(h)));
const UNSHIPPED_ENTRIES = exampleEntries((ev, g, h) => !SHIPPED.includes(entryFile(h)));

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
  const installed = listFiles(join(dir, ".claude", "hooks"));
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
  const wanted = SHIPPED_ENTRIES.length;
  check(
    `merged settings carry all ${wanted} SHIPPED hook entries from settings.example.json (${UNSHIPPED_ENTRIES.length} wired ahead of their file)`,
    s && hookEntries(s).length === wanted,
    s ? `got ${hookEntries(s).length}` : "",
  );
  for (const h of UNSHIPPED_ENTRIES)
    check(`an example entry whose hook does not ship yet is skipped AND named: ${entryFile(h)}`, new RegExp(`skip\\s+.*${entryFile(h)}.*does not ship`).test(r.out), r.out);
  check("no merged entry points at a file init did not copy", s && hookEntries(s).every((h) => existsSync(join(dir, ".claude", "hooks", entryFile(h)))), s ? hookEntries(s).map(entryFile).join(",") : "");
  check("init never invents an `if` on a shipped entry", s && hookEntries(s).every((h) => !("if" in h)), "");
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
  const exampleBash = exampleEntries((ev, g, h) => ev === "PreToolUse" && g.matcher === "Bash" && SHIPPED.includes(entryFile(h))).length;
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
  const left = listFiles(join(dir, ".claude", "hooks")).sort();
  check("foreign hook file survives", left.includes("my-own-guard.mjs"), left.join(","));
  check("byte-identical shipped copies are deleted", !left.includes("prose-guard.mjs") && !left.includes("_fire-log.mjs"), left.join(","));
  check("the locally modified hook is kept…", left.includes("runaway-guard.mjs"), left.join(","));
  check("…and reported as kept", /keep\s+.*runaway-guard\.mjs.*locally modified/.test(r.out), r.out);
  // counts come from what ships, never typed: a guard added to hooks/ must not turn this red
  check(
    "uninstall summary counts entries, files and kept files",
    r.out.includes(`${SHIPPED_ENTRIES.length} hook entries removed, ${SHIPPED.length - 1} file(s) deleted, 1 modified file(s) kept`),
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
  check("…leaves an empty settings object and no hook files", readFileSync(join(fresh, ".claude", "settings.json"), "utf8") === "{}\n" && listFiles(join(fresh, ".claude", "hooks")).length === 0);
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
  const bashGuards = SHIPPED.filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && !/^(ui-evidence|goal|scope)-guard\.mjs$|^precompact-handoff\.mjs$/.test(f));
  check(`…one line per Bash guard (${bashGuards.length})`, (allow.out.match(/^allow /gm) ?? []).length === bashGuards.length, allow.out);
  check("try with no Stop/Edit/PreCompact guard in the list", !/goal-guard|ui-evidence-guard|scope-guard|precompact-handoff/.test(allow.out), allow.out);
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
  check("doctor sends precompact-handoff a PreCompact event, no incident on file", /ok\s+precompact-handoff\.mjs: allows its benign event \(PreCompact\); no incident on file/.test(doc.out), doc.out);
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

// ── 13. `if` on a hook entry rides through init/uninstall verbatim, and is never invented ────────
// The hooks reference (read 2026-09-12) documents `if` as a per-handler permission-rule filter,
// tool events only, best-effort. No shipped entry carries one (see the table in bin/), so the
// plumbing is proven on a COPY of the package whose settings.example.json has one.
{
  const copy = scratchDir("agr-if");
  for (const d of ["bin", "hooks", "templates"]) cpSync(join(ROOT, d), join(copy, d), { recursive: true });
  const ex = JSON.parse(readFileSync(join(ROOT, "settings.example.json"), "utf8"));
  const bashGroup = ex.hooks.PreToolUse.find((g) => g.matcher === "Bash");
  const pv = bashGroup.hooks.find((h) => entryFile(h) === "piped-verdict-guard.mjs");
  pv.if = "Bash(git *)";
  // an entry wired ahead of its file: must be skipped by name, with its `if` never reaching settings
  bashGroup.hooks.push({ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/ghost-guard.mjs"], timeout: 10, if: "Bash(rm *)" });
  writeFileSync(join(copy, "settings.example.json"), JSON.stringify(ex, null, 2) + "\n");
  const COPY_CLI = join(copy, "bin", "agent-guardrails.mjs");
  const run = (args, cwd, env = {}) => {
    const r = spawnSync(process.execPath, [COPY_CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOOK_CTX: "test", ...env } });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const proj = scratchDir("agr-if-proj");
  const r = run(["init"], proj);
  check("if: init exits 0", r.code === 0, r.out);
  const s = settingsOf(proj);
  const got = hookEntries(s).find((h) => entryFile(h) === "piped-verdict-guard.mjs");
  check("if: the entry's `if` round-trips verbatim into settings.json", got && got.if === "Bash(git *)", JSON.stringify(got));
  check("if: no other entry gained an `if`", hookEntries(s).filter((h) => "if" in h).length === 1, "");
  check("if: the entry keeps its other fields (timeout) beside `if`", got && got.timeout === 10 && got.type === "command", JSON.stringify(got));
  check("if: an unshipped entry is skipped by name…", /skip\s+PreToolUse\(Bash\) → ghost-guard\.mjs/.test(r.out), r.out);
  check("if: …and its `if` never reaches settings.json", !hookEntries(s).some((h) => entryFile(h) === "ghost-guard.mjs"), "");
  const before = readFileSync(join(proj, ".claude", "settings.json"), "utf8");
  const again = run(["init"], proj);
  check("if: second init is idempotent with an `if` present (identity is command+args, not `if`)", again.code === 0 && readFileSync(join(proj, ".claude", "settings.json"), "utf8") === before, again.out);

  // an operator's OWN `if` on a shipped entry survives init: not dropped, not duplicated, not widened
  const own = scratchDir("agr-if-own");
  mkdirSync(join(own, ".claude"), { recursive: true });
  writeFileSync(join(own, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/fence-guard.mjs"], timeout: 10, if: "Bash(git *)" }] }] },
  }, null, 2));
  check("if: init over an operator's narrowed entry exits 0", run(["init"], own).code === 0, "");
  const fences = hookEntries(settingsOf(own)).filter((h) => entryFile(h) === "fence-guard.mjs");
  check("if: the operator's narrowed fence entry is kept, once, with its `if`", fences.length === 1 && fences[0].if === "Bash(git *)", JSON.stringify(fences));

  // --user rewrites the path and keeps the `if`
  const home = scratchDir("agr-if-home");
  const u = run(["init", "--user"], proj, { HOME: home, USERPROFILE: home });
  check("if: --user init exits 0", u.code === 0, u.out);
  let us = null;
  try { us = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")); } catch {}
  const ug = us && hookEntries(us).find((h) => entryFile(h) === "piped-verdict-guard.mjs");
  check("if: --user keeps the `if` while rewriting the path to an absolute one", ug && ug.if === "Bash(git *)" && !ug.args[0].includes("${CLAUDE_PROJECT_DIR}"), JSON.stringify(ug));

  // uninstall removes the entry regardless of its `if`
  const un = run(["uninstall"], proj);
  check("if: uninstall removes an entry that carries an `if`", un.code === 0 && !existsSync(join(proj, ".claude", "hooks", "piped-verdict-guard.mjs")) && !JSON.stringify(settingsOf(proj)).includes("piped-verdict-guard"), un.out);
}

// ── 14. --agent codex: init writes .codex/hooks.json through the adapter; uninstall is symmetric ──
// The Codex contract (docs/CODEX.md): `<repo>/.codex/hooks.json`, `command` is a STRING, matcher is a
// regex, Codex's file-edit tool is `apply_patch`. Entries are derived from settings.example.json so the
// two agents wire the same guards on the same events.
{
  const dir = scratchDir("agr-codex");
  const r = cli(["init", "--agent", "codex"], dir);
  check("codex: init exits 0", r.code === 0, r.out);
  check("codex: nothing is written under .claude/", !existsSync(join(dir, ".claude")));
  const installed = listFiles(join(dir, ".codex", "hooks"));
  check("codex: every shipped hook file lands under .codex/hooks/, plus the adapter, nothing else",
    installed.length === SHIPPED.length + 1 && SHIPPED.every((f) => installed.includes(f)) && installed.includes("adapters/codex.mjs"), installed.join(","));
  let h = null;
  try { h = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8")); } catch {}
  check("codex: writes valid .codex/hooks.json", h !== null);
  const entries = h ? hookEntries(h) : [];
  const claudeGroups = Object.values(EXAMPLE).flatMap((groups) => groups.filter((g) => g.hooks.some((x) => SHIPPED.includes(entryFile(x))))).length;
  check(`codex: one entry per Claude matcher group (${claudeGroups}), each a command string, no args array`,
    entries.length === claudeGroups && entries.every((e) => typeof e.command === "string" && !("args" in e)), JSON.stringify(entries));
  const adapterPath = join(dir, ".codex", "hooks", "adapters", "codex.mjs");
  // init writes the path as the child's cwd resolves it; on macOS the tmpdir is a symlink (/var →
  // /private/var), so the expected prefix is the canonical form, not the spelling the test used.
  const canonicalAdapter = join(realpathSync(dir), ".codex", "hooks", "adapters", "codex.mjs");
  check("codex: every entry spawns the installed adapter by absolute, quoted path", entries.every((e) => e.command.startsWith(`node "${canonicalAdapter}" `)), entries.map((e) => e.command).join("\n"));
  const bashEntry = h?.hooks?.PreToolUse?.find((g) => g.matcher === "^Bash$")?.hooks?.[0];
  const editEntry = h?.hooks?.PreToolUse?.find((g) => g.matcher === "^apply_patch$")?.hooks?.[0];
  check("codex: the Bash group becomes matcher ^Bash$ with every Bash guard", !!bashEntry && /fence-guard,prose-guard,runaway-guard,piped-verdict-guard,root-cause-guard,secret-write-guard,config-tamper-guard$/.test(bashEntry.command), bashEntry?.command);
  check("codex: the Edit family becomes matcher ^apply_patch$ with the three file guards", !!editEntry && /scope-guard,secret-write-guard,config-tamper-guard$/.test(editEntry.command), editEntry?.command);
  check("codex: Stop, SessionStart and PreCompact entries carry no matcher", ["Stop", "SessionStart", "PreCompact"].every((ev) => h?.hooks?.[ev]?.length === 1 && !("matcher" in h.hooks[ev][0])), JSON.stringify(h?.hooks));
  check("codex: timeouts ride through from the example (max of the group)", bashEntry?.timeout === 10 && h?.hooks?.Stop?.[0]?.hooks?.[0]?.timeout === 15, "");
  check("codex: init prints the trusted-project caveat", /trusted project/.test(r.out), r.out);

  const before = readFileSync(join(dir, ".codex", "hooks.json"), "utf8");
  const again = cli(["init", "--agent", "codex"], dir);
  check("codex: second init is idempotent (byte-identical, nothing to do)", again.code === 0 && readFileSync(join(dir, ".codex", "hooks.json"), "utf8") === before && /nothing to do/.test(again.out), again.out);
  check("codex: --agent=codex form is accepted", cli(["init", "--agent=codex", "--dry-run"], dir).code === 0);

  // the installed adapter answers from its install site, resolving the guards beside it
  const ev = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "t", cwd: dir, tool_name: "Bash", tool_input: { command: "git push origin main" } });
  const a = spawnSync(process.execPath, [adapterPath, "fence-guard"], { input: ev, encoding: "utf8", env: { ...process.env, HOOK_CTX: "test" } });
  check("codex: the INSTALLED adapter denies the fence incident from its install site", a.status === 0 && /"permissionDecision":"deny"/.test(a.stdout), a.stdout + a.stderr);

  const un = cli(["uninstall", "--agent", "codex"], dir);
  check("codex: uninstall exits 0", un.code === 0, un.out);
  check("codex: uninstall removes every entry and file it added", readFileSync(join(dir, ".codex", "hooks.json"), "utf8") === "{}\n" && listFiles(join(dir, ".codex", "hooks")).length === 0, un.out);
  check("codex: uninstall summary counts entries and files", un.out.includes(`${claudeGroups} hook entries removed, ${SHIPPED.length + 1} file(s) deleted, 0 modified file(s) kept`), un.out);
  check("codex: a backup of hooks.json is written before unmerging", readdirSync(join(dir, ".codex")).some((f) => f.startsWith("hooks.json.bak-")));
}

// ── 15. --agent codex over a foreign hooks.json: merge keeps theirs, uninstall gives it back ──────
{
  const dir = scratchDir("agr-codex-merge");
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const mine = {
    description: "theirs",
    hooks: {
      PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 ~/.codex/hooks/policy.py", timeout: 30 }] }],
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "python3 ~/.codex/hooks/notes.py" }] }],
    },
  };
  const original = JSON.stringify(mine, null, 2) + "\n";
  writeFileSync(join(dir, ".codex", "hooks.json"), original);
  const r = cli(["init", "--agent", "codex"], dir);
  check("codex-merge: init over a foreign hooks.json exits 0", r.code === 0, r.out);
  const h = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  check("codex-merge: the foreign description survives", h.description === "theirs");
  const bashGroup = h.hooks.PreToolUse.find((g) => g.matcher === "^Bash$");
  check("codex-merge: our Bash entry is appended to THEIR ^Bash$ group, theirs first", bashGroup.hooks.length === 2 && bashGroup.hooks[0].command === "python3 ~/.codex/hooks/policy.py", JSON.stringify(bashGroup));
  check("codex-merge: their matcher-bearing SessionStart group is kept and ours is a separate group", h.hooks.SessionStart.length === 2 && h.hooks.SessionStart[0].matcher === "startup|resume", JSON.stringify(h.hooks.SessionStart));
  check("codex-merge: a timestamped backup was written", readdirSync(join(dir, ".codex")).filter((f) => f.startsWith("hooks.json.bak-")).length === 1);
  const un = cli(["uninstall", "--agent", "codex"], dir);
  check("codex-merge: init then uninstall round-trips hooks.json byte-for-byte", un.code === 0 && readFileSync(join(dir, ".codex", "hooks.json"), "utf8") === original, readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  const dry = cli(["uninstall", "--agent", "codex", "--dry-run"], dir);
  check("codex-merge: a second uninstall is a no-op", /nothing to do/.test(dry.out) || /0 hook entries removed/.test(dry.out), dry.out);
}

// ── 15b. a Windows-shaped hooks.json is unmerged on every OS (CI red 2026-09-12: uninstall on
//        windows-latest matched nothing because the shipped name is `adapters/codex.mjs` and the
//        installed command carried backslashes) ──────────────────────────────────────────────────
{
  const dir = scratchDir("agr-codex-winpath");
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const ours = { type: "command", command: 'node "C:\\Users\\dev\\proj\\.codex\\hooks\\adapters\\codex.mjs" fence-guard,prose-guard', timeout: 10 };
  const theirs = { type: "command", command: 'python3 "C:\\tools\\codex-policy.py"' };
  writeFileSync(join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [theirs, ours] }] } }, null, 2) + "\n");
  const un = cli(["uninstall", "--agent", "codex"], dir);
  const after = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  const left = after.hooks?.PreToolUse?.[0]?.hooks ?? [];
  check("codex-winpath: MUST-FIRE — our backslash-path adapter entry is removed", un.code === 0 && !left.some((h) => /codex\.mjs/.test(h.command)), un.out + "\n" + JSON.stringify(after));
  check("codex-winpath: MUST-NOT-FIRE — the foreign backslash-path entry stays, byte-identical", left.length === 1 && left[0].command === theirs.command, JSON.stringify(left));
}

// ── 15c. uninstall never takes a user's own entry that merely NAMES one of our basenames mid-string
//        (review 2026-09-12: a token match deleted `node /opt/mine/scope-guard.mjs --strict`) ─────
{
  const dir = scratchDir("agr-foreign-token");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const theirs = { type: "command", command: "node /opt/mine/scope-guard.mjs --strict" };
  const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [theirs] }] } }, null, 2) + "\n";
  writeFileSync(join(dir, ".claude", "settings.json"), original);
  const un = cli(["uninstall"], dir);
  check("foreign-token: MUST-NOT-FIRE — a foreign entry with our basename mid-command survives uninstall byte-for-byte", un.code === 0 && readFileSync(join(dir, ".claude", "settings.json"), "utf8") === original, un.out);
  const dir2 = scratchDir("agr-foreign-token-codex");
  mkdirSync(join(dir2, ".codex"), { recursive: true });
  const theirs2 = { type: "command", command: 'node /opt/mine/adapters/codex.mjs --strict' };
  const original2 = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [theirs2] }] } }, null, 2) + "\n";
  writeFileSync(join(dir2, ".codex", "hooks.json"), original2);
  const un2 = cli(["uninstall", "--agent", "codex"], dir2);
  check("foreign-token: MUST-NOT-FIRE — an unquoted foreign adapters/codex.mjs path is not ours", un2.code === 0 && readFileSync(join(dir2, ".codex", "hooks.json"), "utf8") === original2, un2.out);
}

// ── 16. try --agent codex prints the same verdict table, through the adapter ─────────────────────
{
  const dir = scratchDir("agr-codex-try");
  const claude = cli(["try", "git push origin main 2>&1 | tail -2"], dir);
  const codex = cli(["try", "--agent", "codex", "git push origin main 2>&1 | tail -2"], dir);
  check("codex-try: exits 1 when a guard denies", codex.code === 1, codex.out);
  const rows = (o) => o.split("\n").filter((l) => /^(DENY|warn|allow|error) /.test(l)).map((l) => l.replace(/\s+/g, " "));
  check("codex-try: the verdict rows are IDENTICAL to the Claude table", JSON.stringify(rows(codex.out)) === JSON.stringify(rows(claude.out)), `claude:\n${rows(claude.out).join("\n")}\ncodex:\n${rows(codex.out).join("\n")}`);
  check("codex-try: names the adapter as the path the verdicts took", /via hooks\/adapters\/codex\.mjs/.test(codex.out), codex.out);
  const ok = cli(["try", "--agent", "codex", "npm test"], dir);
  check("codex-try: a benign command exits 0 with every guard allow", ok.code === 0 && !/^(DENY|error)/m.test(ok.out), ok.out);
  const warn = cli(["try", "--agent", "codex", 'git commit -m "fix: TypeError: x is not a function"'], dir);
  check("codex-try: the prompt-only guard still warns, exit 0", warn.code === 0 && /^warn  root-cause-guard\.mjs: /m.test(warn.out), warn.out);
  check("codex-try: an unknown --agent exits 1 and names the choices", (() => { const u = cli(["try", "--agent", "gemini", "npm test"], dir); return u.code === 1 && /expected one of claude, codex/.test(u.out); })());
  check("codex: doctor --agent codex is refused with a pointer, exit 1", cli(["doctor", "--agent", "codex"], dir).code === 1);
}

// ── 8. usage ─────────────────────────────────────────────────────────────────────────────────────
{
  const dir = scratchDir("agr-usage");
  check("no command → usage, exit 1", cli([], dir).code === 1);
  check("unknown command → exit 1", cli(["frobnicate"], dir).code === 1);
  check("--help → exit 0", cli(["--help"], dir).code === 0);
  const h = cli(["--help"], dir).out;
  check("--help lists every command", ["init", "uninstall", "doctor", "try", "new", "report", "demo"].every((c) => new RegExp(`^  ${c} `, "m").test(h)), h);
  check("--help mentions --agent codex", /--agent codex/.test(h), h);
}

// ── the tarball carries every file init copies ───────────────────────────────────────────────────
// v0.3.0 shipped without hooks/rules/ in `files`: `npx github:…#v0.3.0 init` installed
// secret-write-guard with no rules file, the guard failed open, and `doctor` on a clean machine was
// the only thing that noticed. The packed list is what a user gets; assert it, do not assume it.
{
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  let names = null;
  try { names = JSON.parse(pack.stdout)[0].files.map((f) => f.path); } catch {}
  check("npm pack --dry-run --json parses", Array.isArray(names), pack.stdout.slice(0, 200) + pack.stderr.slice(0, 200));
  for (const f of SHIPPED) check(`the tarball carries hooks/${f}`, !!names && names.includes(`hooks/${f}`), names ? names.filter((n) => n.startsWith("hooks/")).join(",") : "no list");
}

console.log(fails ? `\n[agent-guardrails.test] ${fails} FAILED.` : "\n[agent-guardrails.test] all cases passed.");
process.exit(fails ? 1 : 0);
