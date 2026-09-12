// Behavioural test for precompact-handoff.mjs — run: `node hooks/precompact-handoff.test.mjs`.
//
// CONTRACT: on a PreCompact event the hook writes `<state>/handoff/<worktree-slug>.md` carrying the
// armed goal, its proof state and the project's last refusals, and prints NOTHING (a PreCompact stdout
// is a `decision`, and blocking compaction is the one thing this hook must never do). It exits 0 on
// every path, including the ones where the file could not be written.
//
// THE INCIDENT: an auto-compaction summarised away the stopping command and a fresh fence refusal;
// the next turn called an unpushed branch "done". The must-fire case is that event, with a goal armed.
// THE TWIN: a manual `/compact` with custom instructions — the file is still written, and the
// instructions are neither copied nor altered (no stdout).
//
// Hermetic: HOOK_STATE_DIR is a scratch dir (goal-guard keys the goal there, unsliced) and
// HOOK_FIRE_LOG is a scratch file, so nothing here reads or writes the machine's real state.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./_scratch-dir.mjs";
import { projectKey } from "./_fire-log.mjs";
import { clearGoal, stamp, writeGoal } from "./goal-guard.mjs";
import { handoffPath, MAX_EVENT_BYTES, MAX_REFUSALS, render } from "./precompact-handoff.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "precompact-handoff.mjs");
const WORK = scratchDir("pch-work"); // the session's cwd: not a git worktree, keyed by its own path
const STATE = scratchDir("pch-state");
const LOG = join(scratchDir("pch-log"), "fires.log");
const ENV = (() => {
  const e = { ...process.env, HOOK_CTX: "test", HOOK_STATE_DIR: STATE, HOOK_FIRE_LOG: LOG };
  delete e.CLAUDE_HOOKS_QUIET;
  return e;
})();
const HERE = projectKey(WORK);
const FILE = handoffPath(ENV, WORK).path;

function feed(input, env = ENV, cwd = WORK) {
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env, cwd, timeout: 20000 });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: r.stderr ?? "" };
}
const event = (extra = {}) =>
  JSON.stringify({
    session_id: "sess-1",
    transcript_path: "",
    cwd: WORK,
    hook_event_name: "PreCompact",
    trigger: "auto",
    custom_instructions: null,
    ...extra,
  });
const fileText = () => (existsSync(FILE) ? readFileSync(FILE, "utf8") : null);
const resetFile = () => rmSync(FILE, { force: true });
const fireLine = (hook, verdict, kind, project, ts = "2026-09-12T00:00:00.000Z") =>
  `${ts}\tfire\t${hook}\t${verdict}\t${kind}\ttest\t${project}\n`;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

// ── MUST FIRE ★ auto compaction with an armed goal → the handoff file carries the goal ────────────
{
  resetFile();
  writeGoal("the handoff hook exists and its suite is green", "node hooks/precompact-handoff.test.mjs", ENV, {}, WORK);
  writeFileSync(
    LOG,
    fireLine("fence-guard.mjs", "deny", "push-protected", HERE, "2026-09-12T10:00:00.000Z") +
      fireLine("scope-guard.mjs", "deny", "out-of-scope", HERE, "2026-09-12T10:00:01.000Z") +
      fireLine("root-cause-guard.mjs", "warn", "unproven-fix", HERE, "2026-09-12T10:00:02.000Z") +
      fireLine("fence-guard.mjs", "deny", "foreign-project-kind", "elsewhere-deadbeef", "2026-09-12T10:00:03.000Z"),
  );
  const r = feed(event());
  check("FIRE  ★ auto compaction, goal armed: exit 0", r.status, 0);
  check("FIRE  …stdout is EMPTY — no decision, compaction proceeds", r.out, "");
  const t = fileText();
  check("FIRE  …the handoff file exists at <state>/handoff/<slug>.md", t !== null, true);
  check("FIRE  …and carries GOAL:", /^GOAL:\s+the handoff hook exists/m.test(t ?? ""), true);
  check("FIRE  …and DONE WHEN: with the exact stopping command", /^DONE WHEN: node hooks\/precompact-handoff\.test\.mjs$/m.test(t ?? ""), true);
  check("FIRE  …and STATE: UNPROVEN when nothing has been run", /^STATE:\s+UNPROVEN — /m.test(t ?? ""), true);
  check("FIRE  …and names the trigger", /trigger: auto\)/.test(t ?? ""), true);
  check("FIRE  …and the session id", /^session:\s+sess-1$/m.test(t ?? ""), true);
  check("FIRE  …lists this project's fence refusal", /fence-guard\.mjs  deny  push-protected/.test(t ?? ""), true);
  check("FIRE  …and its scope refusal", /scope-guard\.mjs  deny  out-of-scope/.test(t ?? ""), true);
  check("FIRE  …but NOT the warn line (advice is not a refusal)", /root-cause-guard/.test(t ?? ""), false);
  check("FIRE  …and NOT another project's refusal (keyed by its kind — the line never prints the project)", /foreign-project-kind/.test(t ?? ""), false);
  check("FIRE  …exactly two refusal lines are listed", (t ?? "").match(/^- /gm)?.length ?? 0, 2);
  check("FIRE  …the hook recorded its own fire line", /\tfire\tprecompact-handoff\.mjs\twrite\thandoff-written\t/.test(readFileSync(LOG, "utf8")), true);
  check("FIRE  …and says how the goal comes back after compaction", /SessionStart hook re-injects the goal/.test(t ?? ""), true);

  // the proof state is read live: a green stamp after arming flips the file to PROVEN
  stamp(0, "node hooks/precompact-handoff.test.mjs", ENV, WORK);
  const again = feed(event());
  check("FIRE  a green --prove stamp → STATE: PROVEN in the rewritten file", again.status === 0 && /^STATE:\s+PROVEN — proven green/m.test(fileText() ?? ""), true);
}

// ── MUST NOT FIRE / SIDE: manual /compact with custom instructions ───────────────────────────────
{
  resetFile();
  const r = feed(event({ trigger: "manual", custom_instructions: "keep the list of open MRs verbatim" }));
  check("SIDE  manual /compact with instructions: exit 0", r.status, 0);
  check("SIDE  …stdout EMPTY — the instructions reach the summariser untouched", r.out, "");
  const t = fileText() ?? "";
  check("SIDE  …file still written, trigger manual", /trigger: manual\)/.test(t), true);
  check("SIDE  …the instructions' TEXT is not copied into the handoff", /open MRs verbatim/.test(t), false);
  check("SIDE  …but their presence is recorded", /\/compact instructions: given/.test(t), true);
  resetFile();
  feed(event({ trigger: "manual", custom_instructions: null }));
  check("SIDE  manual with null instructions → \"none\"", /\/compact instructions: none/.test(fileText() ?? ""), true);
}

// ── no goal armed → the file says so, no crash ───────────────────────────────────────────────────
{
  clearGoal(ENV, WORK);
  resetFile();
  const r = feed(event());
  check("SIDE  no goal armed: exit 0, empty stdout", r.status === 0 && r.out === "", true);
  const t = fileText() ?? "";
  check("SIDE  …file says no goal armed", /^no goal armed/m.test(t), true);
  check("SIDE  …and carries no GOAL: line", /^GOAL:/m.test(t), false);
  check("SIDE  …refusals section still present", /## Last refusals/.test(t), true);
}

// ── refusal bound and order ──────────────────────────────────────────────────────────────────────
{
  resetFile();
  let body = "";
  for (let i = 0; i < MAX_REFUSALS + 2; i++)
    body += fireLine("fence-guard.mjs", "deny", `kind-${String(i).padStart(2, "0")}`, HERE, `2026-09-12T11:${String(i).padStart(2, "0")}:00.000Z`);
  writeFileSync(LOG, body);
  feed(event());
  const t = fileText() ?? "";
  const listed = (t.match(/^- .*fence-guard\.mjs  deny  kind-\d+$/gm) ?? []).map((l) => l.slice(-2));
  check(`BOUND at most ${MAX_REFUSALS} refusals are listed`, listed.length, MAX_REFUSALS);
  check("BOUND …the NEWEST ones (the two oldest are dropped)", listed[0] === "02" && listed[listed.length - 1] === "11", true);
}

// ── "none" vs "could not read" vs "no path" are three different sentences ────────────────────────
{
  resetFile();
  rmSync(LOG, { force: true });
  feed(event());
  check("EMPTY no fire log at the path → \"none recorded in <path>\"", new RegExp(`none recorded in .*fires\\.log`).test(fileText() ?? ""), true);
  resetFile();
  const dirLog = join(scratchDir("pch-dirlog"), "fires.log");
  mkdirSync(dirLog); // a directory where the log should be: unreadable, not empty
  const r = feed(event(), { ...ENV, HOOK_FIRE_LOG: dirLog });
  check("UNREADABLE fire log is a directory: still exit 0 and the file is written", r.status === 0 && fileText() !== null, true);
  check("UNREADABLE …and the file says \"could not be read\", not \"none recorded\"", /could not be read/.test(fileText() ?? "") && !/none recorded/.test(fileText() ?? ""), true);
}

// ── HARNESS: fail-open on garbage, oversize, wrong event; never a decision ────────────────────────
{
  resetFile();
  const g = feed("not json{");
  check("ALLOW garbage stdin → exit 0, no output", g.status === 0 && g.out === "", true);
  check("ALLOW …and no file", fileText(), null);
  const big = feed(event({ custom_instructions: "x".repeat(MAX_EVENT_BYTES + 1) }));
  check("ALLOW oversize stdin → exit 0, no output (fail-open: there is nothing to fail closed toward)", big.status === 0 && big.out === "", true);
  check("ALLOW …and no file", fileText(), null);
  const wrong = feed(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: WORK }));
  check("ALLOW a PreToolUse event is ignored (exit 0, silent, no file)", wrong.status === 0 && wrong.out === "" && fileText() === null, true);
  const post = feed(JSON.stringify({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: "…", cwd: WORK }));
  check("ALLOW a PostCompact event is ignored", post.status === 0 && post.out === "" && fileText() === null, true);
  const nul = feed("null");
  check("ALLOW a JSON null event is ignored", nul.status === 0 && nul.out === "", true);
}

// ── cwd fallback, quiet mode, unwritable state ───────────────────────────────────────────────────
{
  resetFile();
  const r = feed(JSON.stringify({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null }), ENV, WORK);
  check("SIDE  no cwd on the event → keyed by process.cwd(), file written", r.status === 0 && fileText() !== null, true);
  resetFile();
  const quiet = feed(event(), { ...ENV, CLAUDE_HOOKS_QUIET: "1" });
  check("SIDE  CLAUDE_HOOKS_QUIET=1 still writes the file (durable persist is not a nudge)", quiet.status === 0 && fileText() !== null, true);
  // HOOK_STATE_DIR pointing at a FILE: the handoff dir cannot be created
  const blocker = join(scratchDir("pch-blocker"), "not-a-dir");
  writeFileSync(blocker, "x");
  const u = feed(event(), { ...ENV, HOOK_STATE_DIR: blocker });
  check("SIDE  unwritable state dir → exit 0, empty stdout (never a decision)", u.status === 0 && u.out === "", true);
  check("SIDE  …and stderr says NOT written (could-not-write ≠ nothing-to-write)", /precompact-handoff: NOT written/.test(u.err), true);
}

// ── pure functions ───────────────────────────────────────────────────────────────────────────────
{
  check("PATH  HOOK_STATE_DIR → <dir>/handoff/<slug>.md", FILE.startsWith(join(STATE, "handoff")) && FILE.endsWith(".md"), true);
  const xdg = handoffPath({ XDG_STATE_HOME: "/x/state" }, WORK);
  check("PATH  no HOOK_STATE_DIR → $XDG_STATE_HOME/claude-hooks/handoff/<slug>.md", xdg && xdg.path.startsWith(join("/x/state", "claude-hooks", "handoff")), true);
  check("PATH  no state root at all → null, never a repo path", handoffPath({}, WORK), null);
  const doc = render({
    slug: "s", trigger: "auto", hasInstructions: false, sessionId: "id", cwd: "/w", now: "2026-09-12T12:00:00.000Z",
    goal: { goal: "g", doneCommand: "npm test", baseline: "Today 3 red", invariant: "no schema change", setAt: "2026-09-12T11:00:00.000Z" },
    verdict: { proven: false, why: "not run" },
    refusals: { refusals: [], unreadable: false, path: "/log" },
  });
  check("RENDER baseline and invariant lines are carried when set", /^BASELINE:\s+Today 3 red$/m.test(doc) && /^INVARIANT: no schema change$/m.test(doc), true);
  check("RENDER the timestamp given is the one written", /^written:\s+2026-09-12T12:00:00\.000Z$/m.test(doc), true);
  const nopath = render({ slug: "s", trigger: "auto", hasInstructions: false, sessionId: "", cwd: "/w", goal: null, verdict: null, refusals: { refusals: [], unreadable: false, path: null } });
  check("RENDER no log path → \"refusals unknown, not absent\"", /refusals unknown, not absent/.test(nopath), true);
}

if (fails) {
  console.error(`\n[precompact-handoff.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[precompact-handoff.test] all cases passed.");
