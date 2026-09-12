#!/usr/bin/env node
// agent-guardrails — install, check, and measure the guard hooks.
//
//   npx github:bram-wq/agent-guardrails init [--user] [--dry-run]
//   npx github:bram-wq/agent-guardrails doctor [--user]
//   npx github:bram-wq/agent-guardrails report
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

  init      copy the hooks into .claude/hooks/ and merge the hooks block into .claude/settings.json
            --user      target ~/.claude instead of ./.claude
            --dry-run   print what would change; write nothing
  doctor    check node version, that each installed hook parses and answers the stdin contract,
            and that every hook settings.json references exists (--user for ~/.claude)
  report    per-hook runs / fires / fire-rate from the fire log, with the denominator
  demo      run demo.mjs (each guard fed the incident and its legitimate twin)
`;

// ── shared ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
  }
  return { cmd: positional[0], flags };
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

  // A benign event: every guard must exit 0 and print either nothing (allow) or JSON. Runs are
  // tagged HOOK_CTX=test so a doctor pass never inflates the live denominator.
  const event = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "node --version" },
    cwd: process.cwd(),
  });
  for (const f of guards) {
    const p = join(hooksDir, f);
    const parse = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (parse.status !== 0) {
      fail(`${f}: does not parse — ${parse.stderr.trim().split("\n")[0]}`);
      continue;
    }
    const r = spawnSync(process.execPath, [p], {
      input: event,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, HOOK_CTX: "test" },
    });
    if (r.error) {
      fail(`${f}: ${r.error.message}`);
      continue;
    }
    if (r.status !== 0) {
      fail(`${f}: exit ${r.status} on a benign event (a guard must fail open)`);
      continue;
    }
    const out = r.stdout.trim();
    if (out === "") {
      ok(`${f}: parses, allows a benign event`);
      continue;
    }
    try {
      const j = JSON.parse(out);
      const d = j.hookSpecificOutput?.permissionDecision ?? (j.decision ? j.decision : "json");
      ok(`${f}: parses, answers "${d}"`);
    } catch {
      fail(`${f}: stdout is neither empty nor JSON: ${out.slice(0, 80)}`);
    }
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

async function report() {
  const { readLog } = await import(pathToFileURL(join(PKG_HOOKS, "_fire-log.mjs")).href);
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
    `\nDenominator: ${log.runs.length} run line(s) and ${log.fires.length} fire line(s) read from ${log.path}.`,
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
const { flags } = parsed;
const cmd = parsed.cmd ?? (flags.has("--help") || flags.has("-h") ? "help" : undefined);
let code;
switch (cmd) {
  case "init":
    code = init(flags);
    break;
  case "doctor":
    code = doctor(flags);
    break;
  case "report":
    code = await report();
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
