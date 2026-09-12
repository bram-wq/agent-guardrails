#!/usr/bin/env node
// Behavioural test for hooks/adapters/codex.mjs — run: `node hooks/adapters/codex.test.mjs`.
//
// CONTRACT: a Codex CLI hook event (docs/CODEX.md) fed through the adapter yields the SAME verdict the
// guard gives under Claude Code — each demo incident refused, each twin allowed — expressed in Codex's
// PreToolUse deny / Stop block / SessionStart context shapes. The adapter's own defects (garbage
// stdin, an unknown event or tool, a guard that crashes or prints junk) fail OPEN; an oversize
// PreToolUse payload fails CLOSED, an oversize Stop fails open (a Stop that blocks on oversize input
// would loop). apply_patch is split per file so the file guards judge every path a patch touches.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "../_scratch-dir.mjs";
import { MAX_EVENT_BYTES, fold, parseGuardArgs, patchToEvents, translate } from "./codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HERE, "codex.mjs");
const TELEMETRY = scratchDir("codex-adapter-telemetry");
const ENV = { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(TELEMETRY, "fires.log") };
delete ENV.CLAUDE_HOOKS_QUIET;

/** Every field Codex sends on every event (docs/CODEX.md F5), so a guard that reads one is exercised. */
const common = (hook_event_name, cwd = process.cwd()) => ({
  session_id: "codex-test",
  transcript_path: "",
  cwd,
  hook_event_name,
  model: "test-model",
  permission_mode: "default",
  turn_id: "turn-1",
});
const bash = (command, cwd) => ({ ...common("PreToolUse", cwd), tool_name: "Bash", tool_use_id: "call-1", tool_input: { command } });
const patch = (body, cwd) => ({ ...common("PreToolUse", cwd), tool_name: "apply_patch", tool_use_id: "call-2", tool_input: { command: body } });

/** Run the adapter on raw stdin bytes; classify its single stdout write the way Codex would read it. */
function runRaw(input, guards, env = ENV) {
  const r = spawnSync(process.execPath, [ADAPTER, ...guards], { input, encoding: "utf8", env });
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  if (r.status !== 0) return { verdict: `EXIT_${r.status}`, stdout, stderr };
  if (!stdout) return { verdict: "allow", stdout, stderr };
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { verdict: `UNPARSEABLE:${stdout.slice(0, 40)}`, stdout, stderr };
  }
  const hso = j.hookSpecificOutput ?? {};
  if (hso.permissionDecision === "deny") return { verdict: "deny", reason: hso.permissionDecisionReason, json: j, stdout, stderr };
  if (j.decision === "block") return { verdict: "block", reason: j.reason, json: j, stdout, stderr };
  if (hso.additionalContext != null) return { verdict: "context", reason: hso.additionalContext, json: j, stdout, stderr };
  return { verdict: "json", json: j, stdout, stderr };
}
const run = (ev, guards, env) => runRaw(JSON.stringify(ev), guards, env);

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};
const pair = (guard, incident, twin, mk = bash) => {
  check(`FIRE  ${guard}: ${JSON.stringify(incident).slice(0, 70)}`, run(mk(incident), [guard]).verdict, "deny");
  check(`ALLOW ${guard} twin: ${JSON.stringify(twin).slice(0, 70)}`, run(mk(twin), [guard]).verdict, "allow");
};

// ── Bash: every demo incident denied through the adapter, every twin allowed ─────────────────────
pair("fence-guard", "git push origin main", "git push origin feature/x");
pair("fence-guard", 'sh -c "pulumi up --yes"', "pulumi preview");
pair("runaway-guard", "yes for sure", "yes | head -3");
pair("prose-guard", "please run the tests again", "npm test");
pair("piped-verdict-guard", "git push origin main 2>&1 | tail -2", "git push origin main");
pair("piped-verdict-guard", "git merge --no-ff topic 2>&1 | tail -3", "npm test 2>&1 | tail -5");
pair("config-tamper-guard", "sed -i 's/goal-guard/goal-guard.off/' .claude/settings.json", "cat .claude/settings.json");
{
  const key = "AKIA" + "J7Q2M4X9K1LP3ZRW"; // concatenated so this source never carries the shape
  pair("secret-write-guard", `printf 'AWS_ACCESS_KEY_ID=${key}\\n' > .env`, "cat .env.example");
}
// the prompt-only guard warns through additionalContext and never denies, under Codex too
{
  const warn = run(bash('git commit -m "fix: TypeError: x is not a function"'), ["root-cause-guard"]);
  check("WARN  root-cause-guard: a fix claim with no frame → additionalContext, not a deny", warn.verdict, "context");
  check("      …with Codex's hookEventName stamped", warn.json?.hookSpecificOutput?.hookEventName, "PreToolUse");
  check("ALLOW root-cause-guard twin: a frame is named", run(bash('git commit -m "fix: TypeError: x, see chunk.js:1:15825"'), ["root-cause-guard"]).verdict, "allow");
}

// ── The fold: one Codex entry, several guards, ONE decision ──────────────────────────────────────
{
  const all = ["fence-guard", "prose-guard", "runaway-guard", "piped-verdict-guard", "root-cause-guard", "secret-write-guard", "config-tamper-guard"];
  const r = run(bash("git push origin main 2>&1 | tail -2"), all);
  check("FOLD  two guards deny → one deny", r.verdict, "deny");
  check("      …whose reason carries BOTH guards' reasons", /FENCE/.test(r.reason) && /PIPED VERDICT/.test(r.reason), true);
  check("      …exactly one JSON object on stdout", r.stdout.startsWith("{") && r.stdout.endsWith("}") && (r.stdout.match(/"permissionDecision"/g) ?? []).length === 1, true);
  check("FOLD  the benign twin through all seven → allow (empty stdout)", run(bash("npm test"), all).verdict, "allow");
  check("FOLD  one invocation, comma list == space list", run(bash("yes for sure"), ["fence-guard", "runaway-guard"]).verdict, "deny");
}

// ── apply_patch: split per file, judged by the file guards ───────────────────────────────────────
{
  const key = "AKIA" + "J7Q2M4X9K1LP3ZRW";
  const lane = scratchDir("codex-adapter-lane");
  const add = (file, line) => `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\n`;
  pair("secret-write-guard", add(".env", `AWS_ACCESS_KEY_ID=${key}`), add(".env.example", "AWS_ACCESS_KEY_ID=<your-key-here>"), (b) => patch(b, lane));
  writeFileSync(join(lane, ".agent-scope"), JSON.stringify({ allow: ["packages/db/**"], reason: "slice B" }));
  mkdirSync(join(lane, "packages", "db"), { recursive: true });
  mkdirSync(join(lane, "apps", "web"), { recursive: true });
  const update = (file) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch\n`;
  pair("scope-guard", update("apps/web/auth.ts"), update("packages/db/m.sql"), (b) => patch(b, lane));
  const multi = `*** Begin Patch\n*** Update File: packages/db/m.sql\n@@\n-a\n+b\n*** Add File: apps/web/x.ts\n+export {}\n*** End Patch\n`;
  check("FIRE  scope-guard: a patch touching one in-scope AND one out-of-scope file is denied", run(patch(multi, lane), ["scope-guard"]).verdict, "deny");
  const del = `*** Begin Patch\n*** Delete File: apps/web/auth.ts\n*** End Patch\n`;
  check("FIRE  scope-guard: a Delete File outside scope is denied", run(patch(del, lane), ["scope-guard"]).verdict, "deny");
  check("DENY  apply_patch with text but no recognisable header → refused, not passed unjudged", run(patch("not a patch at all", lane), ["scope-guard", "secret-write-guard"]).verdict, "deny");
  check("DENY  a unified-diff-shaped body carrying a secret is refused even though no file guard could see it", run(patch("*** Begin Patch\n--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+AWS_ACCESS_KEY_ID=AKIAJ7Q2M4X9K1LP3ZRW\n*** End Patch", lane), ["secret-write-guard"]).verdict, "deny");
  check("      …and the reason names the header form to use", /Add File/.test(run(patch("not a patch at all", lane), ["scope-guard"]).reason ?? ""), true);
  check("ALLOW apply_patch with an EMPTY body → nothing was asked, nothing refused", run(patch("", lane), ["scope-guard", "secret-write-guard"]).verdict, "allow");
  check("ALLOW apply_patch with a non-string command → nothing to judge", run({ ...patch("", lane), tool_input: { command: null } }, ["scope-guard"]).verdict, "allow");

  // the splitter itself
  const evs = patchToEvents(`*** Begin Patch\n*** Add File: a.txt\n+hello\n+world\n*** Update File: b.txt\n*** Move to: c.txt\n@@ -1 +1 @@\n-x\n+y\n*** Delete File: d.txt\n*** End Patch`, { cwd: "/lane" });
  check("SPLIT four events from Add + Update(Move) + Delete", evs.length, 4);
  check("SPLIT Add → Write with content", evs[0].tool_name === "Write" && evs[0].tool_input.content === "hello\nworld" && evs[0].tool_input.file_path === join("/lane", "a.txt"), true);
  check("SPLIT Update → Edit with old/new", evs[1].tool_name === "Edit" && evs[1].tool_input.old_string === "x" && evs[1].tool_input.new_string === "y", true);
  check("SPLIT Move to → a Write at the destination", evs[2].tool_name === "Write" && evs[2].tool_input.file_path === join("/lane", "c.txt"), true);
  check("SPLIT Delete → Edit naming the path", evs[3].tool_name === "Edit" && evs[3].tool_input.file_path === join("/lane", "d.txt"), true);
  check("SPLIT the synthetic event keeps the common fields (cwd)", evs[0].cwd, "/lane");
  check("SPLIT a non-string patch → no events", patchToEvents(42, {}).length, 0);
}

// ── Stop / SessionStart / PreCompact: pass through, answers translated ───────────────────────────
{
  const fake = scratchDir("codex-adapter-fake-guards");
  const w = (name, body) => writeFileSync(join(fake, name), `#!/usr/bin/env node\n${body}\n`);
  w("block-guard.mjs", 'process.stdout.write(JSON.stringify({ decision: "block", reason: "one more pass" }));');
  w("ctx-guard.mjs", 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "GOAL: x" }, systemMessage: "hi" }));');
  w("crash-guard.mjs", "process.exit(1);");
  w("junk-guard.mjs", 'process.stdout.write("not json");');
  w("deny-guard.mjs", 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } }));');
  const env = { ...ENV, AGR_GUARDS_DIR: fake };
  const stop = { ...common("Stop"), stop_hook_active: false, last_assistant_message: "DONE" };
  const s = run(stop, ["block-guard"], env);
  check("STOP  a guard's block → Codex Stop block shape", s.verdict, "block");
  check("      …with the reason", s.reason, "one more pass");
  check("STOP  the real ui-evidence-guard on a benign Stop → allow", run({ ...common("Stop"), stop_hook_active: false, last_assistant_message: "still working" }, ["ui-evidence-guard"]).verdict, "allow");
  check("STOP  stop_hook_active honoured by the real guard through the adapter → allow", run({ ...common("Stop"), stop_hook_active: true, last_assistant_message: "DONE" }, ["ui-evidence-guard", "goal-guard"]).verdict, "allow");
  check("STOP  a deny-shaped answer on Stop is NOT a block (wrong channel is ignored)", run(stop, ["deny-guard"], env).verdict, "allow");
  const ss = run({ ...common("SessionStart"), source: "startup" }, ["ctx-guard"], env);
  check("START a guard's additionalContext → Codex SessionStart context", ss.verdict, "context");
  check("      …hookEventName SessionStart, systemMessage carried", ss.json.hookSpecificOutput.hookEventName === "SessionStart" && ss.json.systemMessage === "hi", true);
  check("START the real goal-guard with no goal armed → allow", run({ ...common("SessionStart"), source: "startup" }, ["goal-guard"], { ...ENV, HOOK_STATE_DIR: scratchDir("codex-adapter-state") }).verdict, "allow");
  check("PRECOMPACT passes through and never blocks", run({ ...common("PreCompact"), trigger: "manual", custom_instructions: null }, ["precompact-handoff"], { ...ENV, HOOK_STATE_DIR: scratchDir("codex-adapter-state2") }).verdict, "allow");

  // ── fail-open on the adapter's and a guard's own defects ───────────────────────────────────────
  check("OPEN  a guard that crashes → allow, exit 0", run(bash("git push origin main"), ["crash-guard"], env).verdict, "allow");
  check("      …and it is named on stderr", /crash-guard\.mjs did not answer/.test(run(bash("x"), ["crash-guard"], env).stderr), true);
  check("OPEN  a guard that prints junk → allow", run(bash("x"), ["junk-guard"], env).verdict, "allow");
  check("OPEN  a crashing guard beside a denying one → the deny still holds", run(bash("x"), ["crash-guard", "deny-guard"], env).verdict, "deny");
  check("OPEN  a guard name that does not exist → allow, named on stderr", /guard not found/.test(run(bash("git push origin main"), ["ghost-guard"], env).stderr) && run(bash("git push origin main"), ["ghost-guard"], env).verdict === "allow", true);
  {
    const r = run(bash("git push origin main"), ["../fence-guard"]);
    check("OPEN  a guard name with a path in it is rejected (named on stderr), never spawned", /ignoring guard name "\.\.\/fence-guard"/.test(r.stderr) && r.verdict === "allow", true);
  }
  check("OPEN  no guard named → allow, exit 0", run(bash("git push origin main"), []).verdict, "allow");
}

// ── the guards-dir override is a test-only switch, and a truncated answer is a deny ─────────────
{
  const fake = mkdtempSync(join(tmpdir(), "codex-adapter-gate-"));
  const noTest = { ...ENV, AGR_GUARDS_DIR: fake };
  delete noTest.HOOK_CTX;
  const r = run(bash("git push origin main"), ["fence-guard"], noTest);
  check("GATE  AGR_GUARDS_DIR without HOOK_CTX=test is ignored: the real fence-guard still denies", r.verdict, "deny");
  check("      …and the adapter says so on stderr", /AGR_GUARDS_DIR is ignored/.test(r.stderr), true);
  writeFileSync(join(fake, "flood-guard.mjs"), `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"x".repeat(${MAX_EVENT_BYTES} + 1024)}}));\n`);
  const flood = run(bash("x"), ["flood-guard"], { ...ENV, AGR_GUARDS_DIR: fake });
  check("DENY  a guard whose answer overruns the buffer is refused, never read as allow", flood.verdict, "deny");
  check("      …with a reason that names the guard and the byte cap", /flood-guard\.mjs printed more than/.test(flood.reason ?? ""), true);
}

// ── garbage, oversize, unknown ───────────────────────────────────────────────────────────────────
check("OPEN  garbage stdin → allow, exit 0", runRaw("{ not json", ["fence-guard"]).verdict, "allow");
check("OPEN  empty stdin → allow", runRaw("", ["fence-guard"]).verdict, "allow");
check("OPEN  a JSON array → allow", runRaw("[1,2]", ["fence-guard"]).verdict, "allow");
check("OPEN  unknown event (PostToolUse) → allow, no guard spawned", run({ ...common("PostToolUse"), tool_name: "Bash", tool_input: { command: "git push origin main" }, tool_response: {} }, ["fence-guard"]).verdict, "allow");
check("OPEN  unknown tool (an MCP tool) → allow", run({ ...common("PreToolUse"), tool_name: "mcp__fs__write", tool_input: { command: "git push origin main" } }, ["fence-guard"]).verdict, "allow");
check("OPEN  a Codex event with no hook_event_name → allow", run({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, ["fence-guard"]).verdict, "allow");
{
  const big = JSON.stringify(bash("x".repeat(MAX_EVENT_BYTES + 1024)));
  const r = runRaw(big, ["fence-guard"]);
  check(`CLOSED oversize PreToolUse (> ${MAX_EVENT_BYTES} bytes) → deny, exit 0`, r.verdict, "deny");
  check("       …the reason names the cap", /over the .*-byte cap/.test(r.reason), true);
  const bigStop = JSON.stringify({ ...common("Stop"), stop_hook_active: false, last_assistant_message: "DONE " + "x".repeat(MAX_EVENT_BYTES) });
  check("OPEN  oversize Stop → allow (a block here would loop)", runRaw(bigStop, ["ui-evidence-guard"]).verdict, "allow");
}
check("OPEN  a Claude-shaped Bash event with no Codex extras is judged the same", run({ tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command: "yes for sure" } }, ["runaway-guard"]).verdict, "deny");

// ── pure functions ───────────────────────────────────────────────────────────────────────────────
check("ARGS  comma and space lists merge, `.mjs` optional, duplicates dropped", parseGuardArgs(["a,b", "b.mjs", "c"]).names.join(" "), "a.mjs b.mjs c.mjs");
check("ARGS  a name with a slash, dot-dot or upper-case is rejected", parseGuardArgs(["../x", "A", "ok"]).rejected.length, 2);
check("MAP   unknown tool → no events", translate({ hook_event_name: "PreToolUse", tool_name: "Other" }).length, 0);
check("MAP   null → no events", translate(null).length, 0);
check("FOLD  PreToolUse with nothing → empty string", fold("PreToolUse", [{ deny: null, block: null, context: null, system: null }]), "");
check("FOLD  Stop ignores a deny and a context", fold("Stop", [{ deny: "x", block: null, context: "y", system: null }]), "");
check("FOLD  PreCompact never answers", fold("PreCompact", [{ deny: "x", block: "y", context: "z", system: "s" }]), "");

console.log(fails ? `\n[codex adapter] ${fails} FAILED.` : "\n[codex adapter] all cases passed.");
process.exit(fails ? 1 : 0);
