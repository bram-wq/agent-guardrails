#!/usr/bin/env node
// agent-guardrails — install, check, and measure the guard hooks.
//
//   npx github:bram-wq/agent-guardrails init [--user] [--dry-run]
//   npx github:bram-wq/agent-guardrails uninstall [--user] [--dry-run]
//   npx github:bram-wq/agent-guardrails doctor [--user]
//   npx github:bram-wq/agent-guardrails try '<bash command>'
//   npx github:bram-wq/agent-guardrails new <name>
//   npx github:bram-wq/agent-guardrails report [--all]
//   npx github:bram-wq/agent-guardrails demo
//
// Zero dependencies, plain Node >= 20, no shell. Every path is built with node:path so the same
// code runs on Linux, macOS and Windows.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_HOOKS = join(PKG_ROOT, "hooks");
const EXAMPLE = join(PKG_ROOT, "settings.example.json");
const PROJECT_PREFIX = "${CLAUDE_PROJECT_DIR}/.claude/hooks/";
const MIN_NODE_MAJOR = 20;

const USAGE = `agent-guardrails <command> [options]

  init       copy the hooks into .claude/hooks/ and merge the hooks block into .claude/settings.json
             --user      target ~/.claude instead of ./.claude
             --dry-run   print what would change; write nothing
  uninstall  remove ONLY the hook entries init added from settings.json (timestamped backup first)
             and delete copied hook files that are still byte-identical to the shipped copy; a
             locally modified hook and every foreign entry are kept (--user, --dry-run as above)
  doctor     check node version, that each installed hook parses, allows an event of its OWN type,
             and REFUSES its known incident; and that every hook settings.json references exists
             (--user for ~/.claude)
  try        \`try '<bash command>'\` — run the command through every Bash guard without a session:
             one line per guard (DENY / warn / allow); exit 1 if any guard denies
  new        \`new <name>\` — scaffold hooks/<name>.mjs and hooks/<name>.test.mjs from templates/;
             refuses to overwrite
  report     per-hook runs / fires / fire-rate from the fire log, with the denominator — for THIS
             project only (the log is machine-wide); --all for every project
  demo       run demo.mjs (each guard fed the incident and its legitimate twin)
`;

// ── shared ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
  }
  return { cmd: positional[0], rest: positional.slice(1), flags };
}

function targetDir(flags) {
  return flags.has("--user") ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
}

/** The shippable hooks: every hooks/*.mjs that is not a test. Helpers (_*.mjs) ship too. */
function packagedHookFiles() {
  return readdirSync(PKG_HOOKS)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .sort();
}

/** Guards only: the hooks that are registered in settings (helpers are imported, never run). */
function guardFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && !f.startsWith("_"))
    .sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The hooks block from settings.example.json, with each hook's path rewritten for the target.
 * Project installs keep ${CLAUDE_PROJECT_DIR}; a --user install has no project dir, so the args
 * point at the absolute ~/.claude/hooks path.
 */
function exampleHooksFor(hooksDir, isUser) {
  const block = readJson(EXAMPLE).hooks;
  if (!isUser) return block;
  const rewrite = (s) =>
    typeof s === "string" && s.startsWith(PROJECT_PREFIX)
      ? join(hooksDir, s.slice(PROJECT_PREFIX.length))
      : s;
  for (const groups of Object.values(block))
    for (const g of groups)
      for (const h of g.hooks) if (Array.isArray(h.args)) h.args = h.args.map(rewrite);
  return block;
}

/** Identity of a hook entry for de-duplication: command + args, nothing else. */
function hookKey(h) {
  return JSON.stringify([h.command ?? "", ...(Array.isArray(h.args) ? h.args : [])]);
}

/**
 * Merge `incoming` (event → groups) into `settings.hooks` WITHOUT clobbering: existing events,
 * groups and hook entries stay; a hook entry is added only if no entry with the same command+args
 * already exists anywhere under that event. Returns the number of entries added.
 */
function mergeHooks(settings, incoming) {
  settings.hooks ??= {};
  let added = 0;
  for (const [event, groups] of Object.entries(incoming)) {
    const existing = (settings.hooks[event] ??= []);
    const present = new Set();
    for (const g of existing) for (const h of g.hooks ?? []) present.add(hookKey(h));
    for (const g of groups) {
      const fresh = g.hooks.filter((h) => !present.has(hookKey(h)));
      if (fresh.length === 0) continue;
      // Same matcher (both may be undefined, as on Stop) → extend that group; else append a group.
      let slot = existing.find((e) => (e.matcher ?? null) === (g.matcher ?? null));
      if (!slot) {
        slot = g.matcher === undefined ? { hooks: [] } : { matcher: g.matcher, hooks: [] };
        existing.push(slot);
      }
      slot.hooks ??= [];
      for (const h of fresh) {
        slot.hooks.push(h);
        present.add(hookKey(h));
        added++;
      }
    }
  }
  return added;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── init ─────────────────────────────────────────────────────────────────────────────────────────

function init(flags) {
  const dry = flags.has("--dry-run");
  const isUser = flags.has("--user");
  const dir = targetDir(flags);
  const hooksDir = join(dir, "hooks");
  const settingsPath = join(dir, "settings.json");
  const say = (line) => console.log(`${dry ? "[dry-run] " : ""}${line}`);

  // 1. hooks
  let copied = 0;
  let unchanged = 0;
  for (const f of packagedHookFiles()) {
    const src = join(PKG_HOOKS, f);
    const dst = join(hooksDir, f);
    const existed = existsSync(dst);
    const same = existed && readFileSync(dst, "utf8") === readFileSync(src, "utf8");
    if (same) {
      unchanged++;
      continue;
    }
    if (!dry) {
      mkdirSync(hooksDir, { recursive: true });
      copyFileSync(src, dst);
    }
    say(`${existed ? "update" : "copy  "}  ${dst}`);
    copied++;
  }
  if (unchanged) say(`${unchanged} hook file(s) already current in ${hooksDir}`);

  // 2. settings
  let settings = {};
  let hadSettings = false;
  if (existsSync(settingsPath)) {
    hadSettings = true;
    try {
      settings = readJson(settingsPath);
    } catch (e) {
      console.error(`refusing to touch ${settingsPath}: it is not valid JSON (${e.message}).`);
      console.error("Fix or move it, then re-run init. Nothing was written.");
      return 1;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      console.error(`refusing to touch ${settingsPath}: top level is not an object.`);
      return 1;
    }
  }
  const added = mergeHooks(settings, exampleHooksFor(hooksDir, isUser));
  if (added === 0) {
    say(`settings already reference every hook: ${settingsPath}`);
  } else {
    if (hadSettings) {
      const backup = `${settingsPath}.bak-${timestamp()}`;
      if (!dry) copyFileSync(settingsPath, backup);
      say(`backup  ${backup}`);
    }
    if (!dry) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    say(`${hadSettings ? "merge " : "create"}  ${settingsPath}  (+${added} hook entr${added === 1 ? "y" : "ies"})`);
  }

  say(
    copied === 0 && added === 0
      ? "nothing to do — already installed."
      : `done: ${copied} file(s) ${dry ? "would be " : ""}copied, ${added} hook entr${added === 1 ? "y" : "ies"} ${dry ? "would be " : ""}added.`,
  );
  if (!dry && (copied || added))
    console.log("Next: `agent-guardrails doctor` to confirm each hook answers, then start a session.");
  return 0;
}

// ── event synthesis (doctor, try) ────────────────────────────────────────────────────────────────

/** The common fields every hook event carries, exactly as a session sends them. */
function baseEvent(hookEventName, sessionId) {
  return {
    hook_event_name: hookEventName,
    session_id: sessionId,
    transcript_path: "",
    cwd: process.cwd(),
    permission_mode: "default",
  };
}
function bashEvent(command, sessionId) {
  return { ...baseEvent("PreToolUse", sessionId), tool_name: "Bash", tool_input: { command } };
}

/** Guards that answer Stop / SessionStart / Edit, not a Bash command. Everything else is a Bash guard. */
const NOT_BASH_GUARDS = new Set(["ui-evidence-guard.mjs", "goal-guard.mjs", "scope-guard.mjs"]);

/** One known incident per shipped Bash guard — the must-fire case, verbatim from its test. */
const INCIDENTS = {
  "fence-guard.mjs": "git push origin main",
  "runaway-guard.mjs": "yes for sure",
  "prose-guard.mjs": "please run the tests",
  "piped-verdict-guard.mjs": "git push origin main 2>&1 | tail -2",
};

/** The benign event(s) a hook must allow — one of its OWN type, per hook. */
function benignEventsFor(file) {
  const sid = "doctor";
  switch (file) {
    case "scope-guard.mjs":
      return [
        {
          ...baseEvent("PreToolUse", sid),
          tool_name: "Edit",
          tool_input: { file_path: join(process.cwd(), "README.md"), old_string: "a", new_string: "b" },
        },
      ];
    case "ui-evidence-guard.mjs":
      return [{ ...baseEvent("Stop", sid), stop_hook_active: false, last_assistant_message: "still working on it" }];
    case "goal-guard.mjs":
      return [
        { ...baseEvent("Stop", sid), stop_hook_active: false, last_assistant_message: "still working on it" },
        { ...baseEvent("SessionStart", sid), source: "startup" },
      ];
    default:
      return [bashEvent("node --version", sid)];
  }
}

/**
 * Spawn a hook on an event and classify what came back.
 * verdict: "allow" (empty stdout) · "deny" · "block" · "context" (JSON with additionalContext) ·
 * "json" (other JSON) · "unparseable". A non-empty stderr is kept: a prompt-only guard talks there.
 */
function runHook(path, event) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify(event),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, HOOK_CTX: "test" },
  });
  if (r.error) return { error: r.error.message, status: null, verdict: "error", reason: "", stdout: "", stderr: "" };
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  const base = { status: r.status, stdout, stderr, reason: "" };
  if (stdout === "") return { ...base, verdict: "allow" };
  try {
    const j = JSON.parse(stdout);
    const hso = j.hookSpecificOutput ?? {};
    if (hso.permissionDecision === "deny") return { ...base, verdict: "deny", reason: String(hso.permissionDecisionReason ?? "") };
    if (j.decision === "block") return { ...base, verdict: "block", reason: String(j.reason ?? "") };
    if (hso.additionalContext != null || j.additionalContext != null)
      return { ...base, verdict: "context", reason: String(hso.additionalContext ?? j.additionalContext) };
    return { ...base, verdict: "json" };
  } catch {
    return { ...base, verdict: "unparseable" };
  }
}

// ── try ──────────────────────────────────────────────────────────────────────────────────────────
// "Would this command be refused?" used to need a live session and a transcript to read. This
// synthesises the PreToolUse Bash event and runs it through every Bash guard the package ships —
// discovered from hooks/ at run time, so a private guard dropped in there is covered too.

function tryCommand(rest) {
  const command = rest.join(" ");
  if (!command) {
    console.error("try: give the command as one argument, e.g.  agent-guardrails try 'yes for sure'");
    return 1;
  }
  const guards = guardFiles(PKG_HOOKS).filter((f) => !NOT_BASH_GUARDS.has(f));
  if (guards.length === 0) {
    console.error(`try: no Bash guards found in ${PKG_HOOKS}`);
    return 2;
  }
  const event = bashEvent(command, "try");
  let denied = 0;
  let errored = 0;
  const w = Math.max(...guards.map((f) => f.length)) + 1;
  for (const f of guards) {
    const name = `${f}:`.padEnd(w);
    const r = runHook(join(PKG_HOOKS, f), event);
    const first = (s) => s.split("\n").find((l) => l.trim() !== "") ?? "";
    if (r.verdict === "error" || r.status !== 0 || r.verdict === "unparseable") {
      errored++;
      console.log(`error ${name} ${r.error ?? (r.verdict === "unparseable" ? `stdout is not JSON: ${r.stdout.slice(0, 60)}` : `exit ${r.status}`)}`);
    } else if (r.verdict === "deny" || r.verdict === "block") {
      denied++;
      console.log(`DENY  ${name} ${first(r.reason)}`);
    } else if (r.verdict === "context" || r.stderr) {
      console.log(`warn  ${name} ${first(r.verdict === "context" ? r.reason : r.stderr)}`);
    } else console.log(`allow ${f}`);
  }
  console.log(
    denied
      ? `\n${denied} of ${guards.length} guard(s) would refuse: ${JSON.stringify(command)}`
      : `\nno guard refuses: ${JSON.stringify(command)}`,
  );
  return denied ? 1 : errored ? 2 : 0;
}

// ── new ──────────────────────────────────────────────────────────────────────────────────────────
// A guard written from a blank file forgot one of: fail-open on garbage, fail-closed on oversize,
// the single stdout write, or the fire log — each has shipped missing at least once. The template
// carries all four and a test that pins them, so the author only fills in the incident and the twin.

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function scaffold(rest) {
  const raw = rest[0];
  if (!raw) {
    console.error("new: give a name, e.g.  agent-guardrails new secret-write-guard");
    return 1;
  }
  const name = raw.replace(/\.mjs$/, "");
  if (!NAME_RE.test(name)) {
    console.error(`new: name must match ${NAME_RE} (lower-case, digits, dashes); got ${JSON.stringify(raw)}`);
    return 1;
  }
  const targets = [
    [join(PKG_ROOT, "templates", "guard.mjs"), join(PKG_HOOKS, `${name}.mjs`)],
    [join(PKG_ROOT, "templates", "guard.test.mjs"), join(PKG_HOOKS, `${name}.test.mjs`)],
  ];
  for (const [, dst] of targets)
    if (existsSync(dst)) {
      console.error(`new: refusing to overwrite ${dst}`);
      return 1;
    }
  for (const [src, dst] of targets) {
    writeFileSync(dst, readFileSync(src, "utf8").split("__NAME__").join(name));
    console.log(`create  ${dst}`);
  }
  console.log(
    `Next: put the incident (verbatim) and its legitimate twin into hooks/${name}.test.mjs, make ` +
      `decide() in hooks/${name}.mjs refuse the one and pass the other, then \`node hooks/${name}.test.mjs\`.`,
  );
  return 0;
}

// ── uninstall ────────────────────────────────────────────────────────────────────────────────────
// init merges into a settings.json that already has the user's own hooks, so "delete .claude/hooks
// and the hooks block" is not an uninstall — it takes their entries with ours. This removes ONLY
// what init added: settings entries whose path ends in a basename this package ships, and copied
// files still byte-identical to the shipped copy. A hook someone edited in place is theirs now.

/** Does a hook entry point at one of OUR files? Matched on the basename at the END of the path. */
function isShippedEntry(h, shipped) {
  const paths = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((s) => typeof s === "string");
  return paths.some((p) => shipped.some((b) => p === b || p.endsWith(`/${b}`) || p.endsWith(`\\${b}`)));
}

/** Strip our entries from settings.hooks in place. Returns how many were removed. */
function unmergeHooks(settings, shipped) {
  if (!settings.hooks || typeof settings.hooks !== "object") return 0;
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const kept = g.hooks.filter((h) => !isShippedEntry(h, shipped));
      removed += g.hooks.length - kept.length;
      g.hooks = kept;
    }
    // A group init created is empty now; a foreign group that was already empty is left as found.
    const remaining = groups.filter((g) => !(Array.isArray(g.hooks) && g.hooks.length === 0 && removed));
    if (remaining.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = remaining;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function uninstall(flags) {
  const dry = flags.has("--dry-run");
  const dir = targetDir(flags);
  const hooksDir = join(dir, "hooks");
  const settingsPath = join(dir, "settings.json");
  const say = (line) => console.log(`${dry ? "[dry-run] " : ""}${line}`);
  const shipped = packagedHookFiles();

  // 1. settings — entries first, so a hook file is never deleted while settings still name it.
  let removed = 0;
  if (existsSync(settingsPath)) {
    let settings;
    try {
      settings = readJson(settingsPath);
    } catch (e) {
      console.error(`refusing to touch ${settingsPath}: it is not valid JSON (${e.message}). Nothing was written.`);
      return 1;
    }
    removed = unmergeHooks(settings, shipped.filter((f) => !f.startsWith("_")));
    if (removed === 0) say(`settings reference none of the shipped hooks: ${settingsPath}`);
    else {
      const backup = `${settingsPath}.bak-${timestamp()}`;
      if (!dry) copyFileSync(settingsPath, backup);
      say(`backup  ${backup}`);
      if (!dry) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      say(`unmerge ${settingsPath}  (-${removed} hook entr${removed === 1 ? "y" : "ies"}; foreign entries kept)`);
    }
  } else say(`no settings.json at ${settingsPath}`);

  // 2. files — only a copy that still matches the shipped bytes is ours to delete.
  let deleted = 0;
  let kept = 0;
  for (const f of shipped) {
    const dst = join(hooksDir, f);
    if (!existsSync(dst)) continue;
    const same = readFileSync(dst, "utf8") === readFileSync(join(PKG_HOOKS, f), "utf8");
    if (!same) {
      kept++;
      say(`keep    ${dst}  (locally modified — not the shipped copy, so not ours to delete)`);
      continue;
    }
    if (!dry) rmSync(dst);
    say(`delete  ${dst}`);
    deleted++;
  }

  say(
    removed === 0 && deleted === 0 && kept === 0
      ? "nothing to do — not installed here."
      : `done: ${removed} hook entr${removed === 1 ? "y" : "ies"} ${dry ? "would be " : ""}removed, ` +
          `${deleted} file(s) ${dry ? "would be " : ""}deleted, ${kept} modified file(s) kept.`,
  );
  return 0;
}

// ── doctor ───────────────────────────────────────────────────────────────────────────────────────

function doctor(flags) {
  const dir = targetDir(flags);
  const hooksDir = join(dir, "hooks");
  const settingsPath = join(dir, "settings.json");
  let bad = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const fail = (m) => {
    bad++;
    console.log(`  FAIL  ${m}`);
  };

  console.log(`doctor: ${dir}`);
  const major = Number(process.versions.node.split(".")[0]);
  (major >= MIN_NODE_MAJOR ? ok : fail)(`node ${process.versions.node} (need >= ${MIN_NODE_MAJOR})`);

  const guards = guardFiles(hooksDir);
  if (guards.length === 0) fail(`no guard hooks found in ${hooksDir} — run init first`);

  // Each guard gets an event of its OWN type, with every common field a real session sends. An
  // earlier doctor sent one Bash event to all of them, so a Stop guard "passed" by ignoring an event
  // it never handles. Runs are tagged HOOK_CTX=test so a doctor pass never inflates the live
  // denominator.
  for (const f of guards) {
    const p = join(hooksDir, f);
    const parse = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (parse.status !== 0) {
      fail(`${f}: does not parse — ${parse.stderr.trim().split("\n")[0]}`);
      continue;
    }
    const benign = benignEventsFor(f);
    let broken = false;
    const answers = [];
    for (const ev of benign) {
      const r = runHook(p, ev);
      if (r.error) {
        fail(`${f}: ${r.error}`);
        broken = true;
        break;
      }
      if (r.status !== 0) {
        fail(`${f}: exit ${r.status} on a benign ${ev.hook_event_name} event (a guard must fail open)`);
        broken = true;
        break;
      }
      if (r.verdict === "deny" || r.verdict === "block") {
        fail(`${f}: ${r.verdict} on a benign ${ev.hook_event_name} event — ${r.reason.split("\n")[0]}`);
        broken = true;
        break;
      }
      if (r.verdict === "unparseable") {
        fail(`${f}: stdout is neither empty nor JSON: ${r.stdout.slice(0, 80)}`);
        broken = true;
        break;
      }
      answers.push(`${ev.hook_event_name}${ev.tool_name ? `/${ev.tool_name}` : ""}`);
    }
    if (broken) continue;
    // The incident. A hook truncated to `process.exit(0)` parses and allows everything, so "allows a
    // benign event" alone is a pass for a guard that no longer exists.
    const incident = INCIDENTS[f];
    if (!incident) {
      ok(`${f}: allows its benign event (${answers.join(", ")}); no incident on file to refuse`);
      continue;
    }
    const r = runHook(p, bashEvent(incident, "doctor"));
    if (r.verdict !== "deny") {
      fail(`${f}: allows its benign event but does NOT refuse its incident ${JSON.stringify(incident)} (got ${r.verdict})`);
      continue;
    }
    ok(`${f}: allows its benign event (${answers.join(", ")}), refuses its incident`);
  }

  // settings.json references
  if (!existsSync(settingsPath)) {
    fail(`${settingsPath} does not exist — run init`);
  } else {
    let settings;
    try {
      settings = readJson(settingsPath);
    } catch (e) {
      settings = null;
      fail(`${settingsPath}: not valid JSON (${e.message})`);
    }
    if (settings) {
      const referenced = new Set();
      for (const groups of Object.values(settings.hooks ?? {}))
        for (const g of groups)
          for (const h of g.hooks ?? [])
            for (const a of h.args ?? [])
              if (typeof a === "string" && a.endsWith(".mjs")) {
                const abs = a.startsWith(PROJECT_PREFIX)
                  ? join(process.cwd(), ".claude", "hooks", a.slice(PROJECT_PREFIX.length))
                  : resolve(a);
                referenced.add(basename(abs));
                (existsSync(abs) ? ok : fail)(`settings → ${a}${existsSync(abs) ? "" : " (missing)"}`);
              }
      const unreferenced = guards.filter((g) => !referenced.has(g));
      if (unreferenced.length)
        console.log(`  note  installed but not referenced in settings: ${unreferenced.join(", ")}`);
    }
  }

  console.log(bad ? `doctor: ${bad} problem(s)` : "doctor: all checks passed");
  return bad ? 1 : 0;
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────

async function report(flags) {
  const { readLog, projectKey } = await import(pathToFileURL(join(PKG_HOOKS, "_fire-log.mjs")).href);
  const all = flags.has("--all");
  const here = projectKey(process.cwd());
  const log = readLog();
  if (!log.path) {
    console.error("fire log: no path — set HOOK_FIRE_LOG or XDG_STATE_HOME/HOME.");
    return 2;
  }
  if (log.unreadable) {
    console.error(`fire log: could not read ${log.path} — this is a read failure, not an empty log.`);
    return 2;
  }
  if (log.runs.length === 0 && log.fires.length === 0) {
    console.log(`No runs recorded in ${log.path}.`);
    console.log(
      "The denominator is zero: no hook has run through this log yet, so no fire-rate can be stated.",
    );
    console.log('This is "never ran", not "never fired" — install the hooks and use a session first.');
    return 0;
  }

  // The log is one file for the whole machine. Without this filter, `report` in a fresh repo printed
  // the busiest OTHER project's counts as if they were this one's.
  const allRuns = log.runs;
  const allFires = log.fires;
  const others = new Map(); // project → line count, for the lines the filter hides
  const legacy = { runs: 0, fires: 0 }; // lines from before the project column existed
  const keep = (l) => {
    if (all) return true;
    if (l.project === here) return true;
    if (l.project === "-") return false;
    others.set(l.project, (others.get(l.project) ?? 0) + 1);
    return false;
  };
  log.runs = allRuns.filter(keep);
  log.fires = allFires.filter(keep);
  for (const l of allRuns) if (l.project === "-") legacy.runs++;
  for (const l of allFires) if (l.project === "-") legacy.fires++;

  if (all) {
    const projects = new Map();
    for (const l of [...allRuns, ...allFires]) projects.set(l.project, (projects.get(l.project) ?? 0) + 1);
    console.log(
      `Every project (--all): ${[...projects.entries()].map(([p, n]) => `${p} (${n})`).join(", ")}` +
        `${projects.has("-") ? " — \"-\" is lines written before the project column existed" : ""}`,
    );
  } else {
    console.log(`Project: ${here}  (${process.cwd()})`);
    const hidden = [...others.values()].reduce((a, b) => a + b, 0) + legacy.runs + legacy.fires;
    if (hidden) {
      const parts = [...others.entries()].map(([p, n]) => `${p} (${n})`);
      if (legacy.runs + legacy.fires) parts.push(`${legacy.runs + legacy.fires} line(s) with no project column`);
      console.log(`Hidden: ${parts.join(", ")} — \`report --all\` shows them.`);
    }
    if (log.runs.length === 0 && log.fires.length === 0) {
      console.log(`No runs recorded for THIS project in ${log.path} — ${hidden} line(s) belong to others.`);
      console.log('This is "never ran here", not "never fired" — use a session in this directory first.');
      return 0;
    }
  }

  const rows = new Map();
  const row = (h) => rows.get(h) ?? rows.set(h, { runs: 0, fires: 0, live: 0, test: 0, unknown: 0 }).get(h);
  for (const r of log.runs) {
    const x = row(r.hook);
    x.runs++;
    x[r.ctx in x ? r.ctx : "unknown"]++;
  }
  for (const f of log.fires) row(f.hook).fires++;
  for (const g of packagedHookFiles().filter((f) => !f.startsWith("_"))) row(g);

  const names = [...rows.keys()].sort();
  const w = Math.max(4, ...names.map((n) => n.length));
  const pad = (s, n) => String(s).padStart(n);
  console.log(`${"hook".padEnd(w)}  ${pad("runs", 6)}  ${pad("fires", 6)}  ${pad("rate", 7)}  ctx(live/test/?)  status`);
  for (const n of names) {
    const x = rows.get(n);
    let status;
    if (x.runs === 0 && x.fires === 0) status = "never ran";
    else if (x.fires === 0) status = "ran, never fired";
    else if (x.runs === 0) status = "fires without runs (log trimmed?)";
    else status = "fires";
    const rate = x.runs === 0 ? "n/a" : `${((100 * x.fires) / x.runs).toFixed(1)}%`;
    console.log(
      `${n.padEnd(w)}  ${pad(x.runs, 6)}  ${pad(x.fires, 6)}  ${pad(rate, 7)}  ${pad(`${x.live}/${x.test}/${x.unknown}`, 16)}  ${status}`,
    );
  }
  console.log(
    `\nDenominator: ${log.runs.length} run line(s) and ${log.fires.length} fire line(s) ` +
      `${all ? "read from" : `for ${here} in`} ${log.path}` +
      `${all ? "" : ` (${allRuns.length + allFires.length} in the whole file)`}.`,
  );
  console.log("rate = fires / runs for that hook only; a rolling log holds roughly the last 2 MB of lines.");
  return 0;
}

// ── demo ─────────────────────────────────────────────────────────────────────────────────────────

function demo() {
  const r = spawnSync(process.execPath, [join(PKG_ROOT, "demo.mjs")], { stdio: "inherit" });
  return r.status ?? 1;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv.slice(2));
const { flags, rest } = parsed;
const cmd = parsed.cmd ?? (flags.has("--help") || flags.has("-h") ? "help" : undefined);
let code;
switch (cmd) {
  case "init":
    code = init(flags);
    break;
  case "uninstall":
    code = uninstall(flags);
    break;
  case "doctor":
    code = doctor(flags);
    break;
  case "try":
    code = tryCommand(rest);
    break;
  case "new":
    code = scaffold(rest);
    break;
  case "report":
    code = await report(flags);
    break;
  case "demo":
    code = demo();
    break;
  case undefined:
  case "help":
  case "-h":
    console.log(USAGE);
    code = cmd ? 0 : 1;
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    console.error(USAGE);
    code = 1;
}
process.exitCode = code;
