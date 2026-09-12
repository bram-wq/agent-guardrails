#!/usr/bin/env node
// codex adapter — runs the shipped guards under OpenAI Codex CLI's lifecycle hooks, so a team with a
// Claude Code lane and a Codex lane gets ONE verdict per command instead of two policies.
//
//   node hooks/adapters/codex.mjs <guard>[,<guard>…]        (stdin: the Codex hook event JSON)
//
// Every fact about the Codex side that this file relies on is recorded, with its URL and the date it
// was read, in docs/CODEX.md. Anything tagged NE (not established) there is NOT depended on here.
//
// ── WHAT IS TRANSLATED, AND WHAT IS NOT ──────────────────────────────────────────────────────────
// Codex's hook contract is, field for field, the shape these guards already read: `hook_event_name`,
// `cwd`, `session_id`, `tool_name`, `tool_input.command`, `stop_hook_active`,
// `last_assistant_message`, `source`, `trigger` — and its deny shape is the same
// `hookSpecificOutput.permissionDecision: "deny"` / top-level `decision: "block"` the guards already
// write. So for a Bash command, a Stop, a SessionStart and a PreCompact this adapter is a fan-out:
// one Codex entry spawns N guards and folds their answers into ONE decision (any deny holds — the
// Codex reference says nothing about how concurrent hooks' answers combine, so the fold is done here
// where it is certain).
//
// The one real translation is file edits. Codex edits files through `apply_patch`, whose hook event
// carries the whole patch in `tool_input.command` and no `file_path`. The Edit guards (scope-guard,
// secret-write-guard, config-tamper-guard) judge `tool_input.file_path` and the written text, so the
// patch is split into one synthetic Write/Edit event per `*** Add File:` / `*** Update File:` /
// `*** Delete File:` header and every guard judges every file. A patch with no recognisable header
// yields NO synthetic event and is allowed — stated in docs/CODEX.md as the accepted limitation,
// because the patch grammar itself is NE (the reference documents only where the text lives).
//
// ── FAIL DIRECTION ───────────────────────────────────────────────────────────────────────────────
// The adapter's OWN defects fail open (garbage stdin, an exception, an unknown event, a guard that
// crashes): it prints nothing and exits 0, exactly like a guard. The guards' policy is preserved
// unchanged, including their fail-closed oversize behaviour — the adapter's own byte cap
// (MAX_EVENT_BYTES) denies on PreToolUse and allows on every other event, which is the direction each
// guard class already takes. One stdout write, natural exit (no process.exit after a write: a pipe
// write is asynchronous on Windows and process.exit() can truncate a deny into an allow).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const MAX_EVENT_BYTES = 8 * 1024 * 1024; // the largest cap any shipped guard uses (goal-guard)
const GUARD_TIMEOUT_MS = 15_000;
const GUARD_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.mjs)?$/;
const DEFAULT_GUARDS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The directory the guards live in: beside this adapter's parent by default, `AGR_GUARDS_DIR` for tests. */
export function guardsDir(env = process.env) {
  return env.AGR_GUARDS_DIR ? resolve(env.AGR_GUARDS_DIR) : DEFAULT_GUARDS_DIR;
}

/** Guard names from argv (comma- or space-separated), validated; anything else is dropped and named on stderr. */
export function parseGuardArgs(args) {
  const names = [];
  const rejected = [];
  for (const a of args)
    for (const piece of String(a).split(","))
      if (piece.trim() === "") continue;
      else if (GUARD_NAME_RE.test(piece.trim())) names.push(piece.trim().endsWith(".mjs") ? piece.trim() : `${piece.trim()}.mjs`);
      else rejected.push(piece);
  return { names: [...new Set(names)], rejected };
}

/**
 * Split an apply_patch body into the synthetic Edit/Write events the file guards understand.
 * Headers recognised: `*** Add File: <path>`, `*** Update File: <path>`, `*** Delete File: <path>`,
 * with an optional `*** Move to: <path>` after an Update. Relative paths resolve against `cwd`.
 * Returns [] when nothing in the text looks like a patch header.
 */
export function patchToEvents(patch, base) {
  const events = [];
  if (typeof patch !== "string") return events;
  const lines = patch.split(/\r?\n/);
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const abs = (p) => (isAbsolute(p) ? p : join(base.cwd ?? process.cwd(), p));
    if (cur.kind === "add")
      events.push({ ...base, tool_name: "Write", tool_input: { file_path: abs(cur.path), content: cur.added.join("\n") } });
    else if (cur.kind === "update") {
      events.push({
        ...base,
        tool_name: "Edit",
        tool_input: { file_path: abs(cur.path), old_string: cur.removed.join("\n"), new_string: cur.added.join("\n") },
      });
      if (cur.moveTo) events.push({ ...base, tool_name: "Write", tool_input: { file_path: abs(cur.moveTo), content: cur.added.join("\n") } });
    } else events.push({ ...base, tool_name: "Edit", tool_input: { file_path: abs(cur.path), old_string: "", new_string: "" } });
    cur = null;
  };
  for (const line of lines) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      flush();
      cur = { kind: m[1].toLowerCase(), path: m[2].trim(), added: [], removed: [], moveTo: null };
      continue;
    }
    if (!cur) continue;
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv) {
      cur.moveTo = mv[1].trim();
      continue;
    }
    if (line.startsWith("*** ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  flush();
  return events;
}

/**
 * Map one Codex event to the list of guard events it stands for. Bash, Stop, SessionStart and
 * PreCompact pass through untouched (same field names); apply_patch fans out per file; a tool
 * Codex might name Edit/Write directly passes through; anything else maps to nothing (allow).
 */
export function translate(ev) {
  if (!ev || typeof ev !== "object") return [];
  const event = ev.hook_event_name;
  if (event === "PreToolUse") {
    if (ev.tool_name === "Bash" || ev.tool_name === "Edit" || ev.tool_name === "Write") return [ev];
    if (ev.tool_name === "apply_patch") {
      const { tool_name, tool_input, ...base } = ev;
      return patchToEvents(tool_input?.command, base);
    }
    return [];
  }
  if (event === "Stop" || event === "SessionStart" || event === "PreCompact") return [ev];
  return [];
}

/** Spawn one guard on one event; classify its stdout. Never throws. */
export function runGuard(path, ev, env = process.env) {
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(ev), encoding: "utf8", timeout: GUARD_TIMEOUT_MS, env, cwd: ev.cwd && existsSync(ev.cwd) ? ev.cwd : undefined });
  const out = { deny: null, block: null, context: null, system: null, error: null };
  if (r.error) return { ...out, error: r.error.message };
  if (r.status !== 0) return { ...out, error: `exit ${r.status ?? r.signal}` };
  const stdout = (r.stdout ?? "").trim();
  if (!stdout) return out;
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ...out, error: "stdout is not JSON" };
  }
  const hso = j?.hookSpecificOutput ?? {};
  if (hso.permissionDecision === "deny") out.deny = String(hso.permissionDecisionReason ?? "");
  if (j?.decision === "block") out.block = String(j.reason ?? "");
  if (hso.additionalContext != null) out.context = String(hso.additionalContext);
  if (typeof j?.systemMessage === "string") out.system = j.systemMessage;
  return out;
}

/** Fold the guards' answers into ONE Codex decision for this event kind. Returns a JSON string or "". */
export function fold(event, answers) {
  const denies = answers.map((a) => a.deny).filter((s) => s != null);
  const blocks = answers.map((a) => a.block).filter((s) => s != null);
  const contexts = answers.map((a) => a.context).filter((s) => s != null);
  const systems = answers.map((a) => a.system).filter((s) => s != null);
  const withSystem = (o) => (systems.length ? { ...o, systemMessage: systems.join("\n") } : o);
  if (event === "PreToolUse") {
    if (denies.length)
      return JSON.stringify(withSystem({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denies.join("\n\n") } }));
    if (contexts.length || systems.length)
      return JSON.stringify(withSystem(contexts.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: contexts.join("\n\n") } } : {}));
    return "";
  }
  if (event === "Stop") return blocks.length ? JSON.stringify(withSystem({ decision: "block", reason: blocks.join("\n\n") })) : "";
  if (event === "SessionStart")
    return contexts.length ? JSON.stringify(withSystem({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: contexts.join("\n\n") } })) : "";
  return ""; // PreCompact writes a file; the reference gives it no context channel we rely on
}

function main() {
  const { names, rejected } = parseGuardArgs(process.argv.slice(2));
  for (const r of rejected) process.stderr.write(`codex adapter: ignoring guard name ${JSON.stringify(r)} (must match ${GUARD_NAME_RE})\n`);
  if (names.length === 0) {
    process.stderr.write("codex adapter: no guard named — usage: node codex.mjs <guard>[,<guard>…] < event.json\n");
    return "";
  }
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return "";
  }
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return ""; // garbage stdin: the adapter's problem, never the session's
  }
  if (!ev || typeof ev !== "object") return "";
  if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_BYTES) {
    if (ev.hook_event_name === "PreToolUse")
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `codex adapter: the hook payload is over the ${MAX_EVENT_BYTES}-byte cap, so no guard can judge it. Refused rather than passed unjudged.`,
        },
      });
    return ""; // a Stop that blocks on oversize input would loop; SessionStart/PreCompact have nothing to refuse
  }
  const events = translate(ev);
  if (events.length === 0) return "";
  const dir = guardsDir();
  const answers = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      process.stderr.write(`codex adapter: guard not found: ${path}\n`);
      continue;
    }
    for (const e of events) {
      const a = runGuard(path, e);
      if (a.error) process.stderr.write(`codex adapter: ${basename(path)} did not answer (${a.error}); treated as allow\n`);
      answers.push(a);
    }
  }
  return fold(ev.hook_event_name, answers);
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let out = "";
  try {
    out = main();
  } catch (e) {
    process.stderr.write(`codex adapter: internal error, failing open: ${e?.message ?? e}\n`);
    out = "";
  }
  if (out) process.stdout.write(out);
  process.exitCode = 0;
}
