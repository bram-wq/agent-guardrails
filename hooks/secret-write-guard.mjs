#!/usr/bin/env node
// PreToolUse secret-write-guard (Write | Edit | MultiEdit | NotebookEdit | Bash). DENIES a write whose
// TEXT carries a credential, at the moment the text is about to land in a file.
//
// THE INCIDENT: an agent, asked to "get the deploy working", wrote a `.env` with a live AWS key it had
// read from a session log — `Write { file_path: ".env", content: "AWS_ACCESS_KEY_ID=AKIA…\n" }` — and
// the next turn committed it. A secret in a diff is an incident: rotation, a history rewrite, and a
// week of "is this the only copy". The rule ("secrets only via env / a secrets manager") was a
// sentence; the agent was mid-task; the sentence lost. This guard is the mechanism.
//
// THE TWIN: `.env.example` with `SECRET=changeme`, `AWS_ACCESS_KEY_ID=<your-key-here>`, a 40-hex git
// SHA, a UUID, the AWS docs' own `AKIAIOSFODNN7EXAMPLE`, a JWT inside a test fixture, `grep AKIA .env`
// (READING is not writing), and `git commit -m "…"` (a message is not a file). A secret guard that fires
// on the example file is switched off in a week, and then protects nothing.
//
// ── WHAT IS SCANNED ──────────────────────────────────────────────────────────────────────────────────
// The WRITTEN TEXT, never the file name. Per tool (field names from the Claude Code hooks reference,
// https://code.claude.com/docs/en/hooks, read 2026-09-12):
//   Write         tool_input.content                       path: tool_input.file_path
//   Edit          tool_input.new_string                    path: tool_input.file_path
//   MultiEdit     every tool_input.edits[].new_string      path: tool_input.file_path
//   NotebookEdit  tool_input.new_source                    path: tool_input.notebook_path
//   Bash          tool_input.command — only the parts of it that WRITE text:
//                   · every heredoc body (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`; an UNTERMINATED
//                     heredoc keeps the rest of the command — ambiguous text falls on the firing side);
//                   · a statement with a file redirect (`>` / `>>` / `&>` to anything but /dev/null,
//                     /dev/stdout, /dev/stderr; `2>&1` is not a file);
//                   · a pipeline that ends in `tee`;
//                   · a `sed -i` / `sed --in-place` payload;
//                   · the string handed to `sh -c` / `bash -c` / `eval` (its redirect hides in quotes).
//                 `grep AKIA .env`, `cat .env`, `aws configure list`, `git commit -m "…"` have no
//                 write shape and are not scanned at all. What the guard cannot see: `cp secret.pem
//                 ~/x` (the text is not in the command) — that is a different guard's job.
//
// ── THE RULES ────────────────────────────────────────────────────────────────────────────────────────
// hooks/rules/secrets.json (or SECRET_GUARD_RULES=<path>), gitleaks-shaped: id · description · regex ·
// optional entropy (Shannon bits/char over capture group 1, else the whole match) · optional keywords
// (case-insensitive pre-filter). Loaded ONCE per process. A rules file that is missing, unreadable, not
// JSON, not the shape, or carries a regex that does not compile ⇒ the guard FAILS OPEN and records a
// fire of kind "error" so the outage is measurable — a silent allow-all would be the worst outcome and
// a deny-all would brick every edit on a typo.
//
// Exempted IN CODE, not in the rules, so no rule edit can widen them by accident:
//   · placeholders — the matched span contains EXAMPLE / changeme / REDACTED / placeholder / dummy /
//     your-…-here / xxxx / `<…>` / `${…}` / `{{…}}` / `***` (case-insensitive);
//   · decoys — a bare 40- or 64-hex string (a git SHA) or a UUID as the value of the generic rule;
//   · paths — `**/fixtures/**`, `**/__fixtures__/**`, `**/testdata/**`, `**/*.test.*`, `**/*.spec.*`,
//     and the rules file itself; SECRET_GUARD_ALLOW_PATHS adds globs (comma list). Bash has no path.
//
// ── THE REASON NEVER CARRIES THE VALUE ───────────────────────────────────────────────────────────────
// The deny names the RULE ID and the FILE:LINE. Not the value, not a prefix of it, not its length. The
// reason is fed back into the transcript; the fire log records only a source constant (`kind`). A
// secret guard that echoes the secret has just made a second copy.
//
// ── FAIL DIRECTION ───────────────────────────────────────────────────────────────────────────────────
// Harness fails OPEN: garbage stdin, a missing field, any exception → exit 0, no output. Decision fails
// CLOSED on input it cannot scan: a payload over MAX_EVENT_BYTES (1 MB) is refused with a reason that
// says it was NOT scanned — a hook killed at its timeout renders no decision, and "could not check"
// must never print the same as "checked, fine". CLAUDE_HOOKS_QUIET=1 lifts the guard (a heads-down
// session with a fixture to write), as every guard here except the fence does. ONE stdout write, then a
// natural exit — process.exit() after a write can truncate a deny into an allow.
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

const HOOK = "secret-write-guard.mjs";
recordInvocation(HOOK);

/** Above this the payload is refused unscanned rather than risking the hook's timeout. */
export const MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), "rules", "secrets.json");
export const DEFAULT_ALLOW_PATHS = [
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/testdata/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/rules/secrets.json",
];
const TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|Bash)$/i;
/** How many distinct (rule, line) findings the reason lists before "…and N more". */
const MAX_FINDINGS = 5;

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Load and compile the rules file. Returns `{ rules, path }` or `{ error, path }` — never throws.
 * @param {string} [path]
 */
export function loadRules(path = process.env.SECRET_GUARD_RULES || DEFAULT_RULES_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { error: `rules file ${path} unreadable: ${String(e?.message ?? e).split("\n")[0]}`, path };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `rules file ${path} is not JSON: ${String(e?.message ?? e).split("\n")[0]}`, path };
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rules) ? parsed.rules : null;
  if (!list) return { error: `rules file ${path} is not an array of rules (or {rules:[…]})`, path };
  const rules = [];
  for (const r of list) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.regex !== "string")
      return { error: `rules file ${path}: a rule lacks a string id or regex`, path };
    const flags = typeof r.flags === "string" ? r.flags : "g";
    let re;
    try {
      re = new RegExp(r.regex, flags.includes("g") ? flags : flags + "g");
    } catch (e) {
      return { error: `rules file ${path}: rule ${r.id} regex does not compile: ${String(e?.message ?? e)}`, path };
    }
    const entropy = typeof r.entropy === "number" ? r.entropy : null;
    const keywords = Array.isArray(r.keywords)
      ? r.keywords.filter((k) => typeof k === "string" && k).map((k) => k.toLowerCase())
      : [];
    rules.push({ id: r.id, re, entropy, keywords });
  }
  return { rules, path };
}

let cached = null;
function rules() {
  if (!cached) cached = loadRules();
  return cached;
}

/** Shannon entropy in bits per character. */
export function shannon(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER = /example|changeme|change[_-]me|redacted|placeholder|dummy|your[-_ ]?[a-z]*[-_ ]?(?:here|key|token|secret)|xxxx|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\*\*\*/i;
const DECOY = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Pure scanner: text in, findings out. A finding is `{ id, line }` — 1-based line within `text` plus
 * `lineOffset`. The VALUE is never part of a finding.
 * @param {string} text
 * @param {{id:string, re:RegExp, entropy:number|null, keywords:string[]}[]} ruleList
 * @param {number} [lineOffset]
 */
export function scan(text, ruleList, lineOffset = 0) {
  const findings = [];
  if (!text) return findings;
  const lower = text.toLowerCase();
  for (const r of ruleList) {
    if (r.keywords.length && !r.keywords.some((k) => lower.includes(k))) continue;
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text)) !== null) {
      if (m[0] === "") {
        r.re.lastIndex++; // a zero-width match must not loop forever
        continue;
      }
      const value = m[1] ?? m[0];
      if (PLACEHOLDER.test(m[0])) continue;
      if (m[1] !== undefined && DECOY.test(value)) continue;
      if (r.entropy !== null && shannon(value) < r.entropy) continue;
      let line = 1 + lineOffset;
      for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
      if (!findings.some((f) => f.id === r.id && f.line === line)) findings.push({ id: r.id, line });
    }
  }
  return findings;
}

// ── path allowlist: a segment walk, never a regex (bounded by segment counts) ───────────────────────

function segmentMatches(pat, str) {
  let p = 0, s = 0, starP = -1, starS = -1;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === str[s])) { p++; s++; continue; }
    if (p < pat.length && pat[p] === "*") { starP = p++; starS = s; continue; }
    if (starP >= 0) { p = starP + 1; s = ++starS; continue; }
    return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

export function globMatches(glob, path) {
  const gs = glob
    .split("/")
    .map((g) => (g === "**" ? g : g.replace(/\*\*+/g, "*")))
    .filter((g, i, a) => !(g === "**" && a[i - 1] === "**"));
  const ps = path.split("/");
  let g = 0, p = 0, starG = -1, starP = -1;
  while (p < ps.length) {
    if (g < gs.length && gs[g] === "**") { starG = g++; starP = p; continue; }
    if (g < gs.length && segmentMatches(gs[g], ps[p])) { g++; p++; continue; }
    if (starG >= 0) { g = starG + 1; p = ++starP; continue; }
    return false;
  }
  while (g < gs.length && gs[g] === "**") g++;
  return g === gs.length;
}

/** Is `filePath` exempt: a default glob, a SECRET_GUARD_ALLOW_PATHS glob, or the rules file itself. */
export function pathAllowed(filePath, cwd, env = process.env, rulesPath = rules().path) {
  if (!filePath) return false;
  const posix = String(filePath).split("\\").join("/");
  const extra = String(env.SECRET_GUARD_ALLOW_PATHS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const g of [...DEFAULT_ALLOW_PATHS, ...extra]) {
    if (g.length > 512) continue; // not a pattern anybody typed
    if (globMatches(g, posix)) return true;
  }
  try {
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd || process.cwd(), filePath);
    if (rulesPath && abs === resolve(rulesPath)) return true;
  } catch {
    /* an unresolvable path is not exempt */
  }
  return false;
}

// ── Bash: which parts of a command WRITE text ────────────────────────────────────────────────────────

const HEREDOC_RE = /<<(-?)[ \t]*(?:(['"])([^'"\s]+)\2|\\?([^\s;|&<>]+))/g;

/**
 * Pieces of `command` that write text: `{ text, lineOffset }`. Heredoc bodies always; otherwise a
 * statement (split on newline / `;` / `&&` / `||`, quote-aware; a pipeline stays whole) that carries a
 * file redirect, ends in `tee`, or runs `sed -i`.
 * @param {string} command
 */
export function writtenText(command) {
  const s = String(command ?? "");
  const pieces = [];
  const lineAt = (idx) => {
    let l = 0;
    for (let i = 0; i < idx && i < s.length; i++) if (s.charCodeAt(i) === 10) l++;
    return l;
  };
  // 1. heredoc bodies — blanked out of the working copy so their lines cannot read as statements.
  let work = s;
  HEREDOC_RE.lastIndex = 0;
  let m;
  let consumedTo = -1;
  while ((m = HEREDOC_RE.exec(s)) !== null) {
    if (m.index < consumedTo) continue; // an introducer that sits inside an earlier body
    const dash = m[1] === "-";
    const tag = m[3] ?? m[4];
    const eol = s.indexOf("\n", m.index + m[0].length);
    if (eol === -1) break; // introducer with no body: nothing was written
    const bodyStart = eol + 1;
    let p = bodyStart;
    let bodyEnd = -1;
    let termEnd = s.length;
    while (p <= s.length) {
      let e = s.indexOf("\n", p);
      if (e === -1) e = s.length;
      let line = s.slice(p, e);
      if (dash) line = line.replace(/^\t+/, "");
      if (line === tag) {
        bodyEnd = p;
        termEnd = e;
        break;
      }
      if (e >= s.length) break;
      p = e + 1;
    }
    if (bodyEnd === -1) bodyEnd = s.length; // unterminated: the rest is the body (fires if it must)
    pieces.push({ text: s.slice(bodyStart, bodyEnd), lineOffset: lineAt(bodyStart) });
    work = work.slice(0, bodyStart) + work.slice(bodyStart, termEnd).replace(/[^\n]/g, " ") + work.slice(termEnd);
    consumedTo = termEnd;
    HEREDOC_RE.lastIndex = termEnd;
  }
  // 2. statements, quote-aware.
  const stmts = [];
  let start = 0;
  let q = null;
  for (let i = 0; i < work.length; i++) {
    const ch = work[i];
    if (ch === "\\" && q !== "'") {
      i++;
      continue;
    }
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    const two = work.slice(i, i + 2);
    if (ch === "\n" || ch === ";" || two === "&&" || two === "||") {
      stmts.push([start, i]);
      i += two === "&&" || two === "||" ? 1 : 0;
      start = i + 1;
    }
  }
  stmts.push([start, work.length]);
  for (const [a, b] of stmts) {
    const raw = work.slice(a, b);
    if (!raw.trim()) continue;
    const bare = raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "_q_");
    const writes =
      /(^|[^0-9<>])&?>{1,2}(?!&)\s*(?!\/dev\/(?:null|stdout|stderr)\b)\S/.test(bare) ||
      /(^|\|)\s*(?:sudo\s+)?tee\b/.test(bare) ||
      /(^|[|\s])sed\s+(?:-[a-zA-Z]*i|--in-place)/.test(bare) ||
      // `sh -c "echo … > .env"` / `eval "…"`: the redirect is inside the quotes, so the shell text is
      // scanned whole rather than parsed — the string is about to be executed, not merely printed.
      /(^|[|\s])(?:sh|bash|zsh|dash|ksh)\s+-[a-zA-Z]*c\b/.test(bare) ||
      /(^|[|\s])eval\s/.test(bare);
    if (writes) pieces.push({ text: raw, lineOffset: lineAt(a) });
  }
  return pieces;
}

// ── decision ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pure decider: the event in, a deny reason out, or null to allow. `rulesOverride` lets a test inject
 * rules; production reads them once from disk.
 * @param {object} ev
 * @param {{rules?:object[], error?:string, path?:string}} [loaded]
 * @returns {string|null}
 */
export function decide(ev, loaded = rules(), env = process.env) {
  if (!ev || !TOOLS.test(ev.tool_name || "")) return null;
  if (env.CLAUDE_HOOKS_QUIET === "1") return null;
  if (loaded.error) {
    recordFire(HOOK, "error", "error");
    return null; // fail open: a broken rules file must not brick every edit; the fire log shows it
  }
  const tool = String(ev.tool_name);
  const inp = ev.tool_input || {};
  /** @type {{text:string, lineOffset:number}[]} */
  let pieces = [];
  let where;
  if (/^Bash$/i.test(tool)) {
    pieces = writtenText(inp.command);
    where = "the Bash command";
  } else {
    const fp = inp.file_path || inp.notebook_path || "";
    if (pathAllowed(fp, ev.cwd, env, loaded.path)) return null;
    where = fp ? `${fp}` : "the edit";
    if (/^Write$/i.test(tool) && typeof inp.content === "string") pieces.push({ text: inp.content, lineOffset: 0 });
    if (/^Edit$/i.test(tool) && typeof inp.new_string === "string")
      pieces.push({ text: inp.new_string, lineOffset: 0 });
    if (/^MultiEdit$/i.test(tool) && Array.isArray(inp.edits))
      for (const e of inp.edits) if (e && typeof e.new_string === "string") pieces.push({ text: e.new_string, lineOffset: 0 });
    if (/^NotebookEdit$/i.test(tool) && typeof inp.new_source === "string")
      pieces.push({ text: inp.new_source, lineOffset: 0 });
  }
  const findings = [];
  for (const p of pieces) {
    for (const f of scan(p.text, loaded.rules, p.lineOffset))
      if (!findings.some((g) => g.id === f.id && g.line === f.line)) findings.push(f);
  }
  if (!findings.length) return null;
  const isBash = /^Bash$/i.test(tool);
  const lineWord = isBash ? "command line" : /^Write$/i.test(tool) ? "line" : "line of the new text";
  const shown = findings.slice(0, MAX_FINDINGS).map((f) => `\`${f.id}\` at ${where}, ${lineWord} ${f.line}`);
  const more = findings.length > MAX_FINDINGS ? ` (and ${findings.length - MAX_FINDINGS} more)` : "";
  return (
    `secret-write-guard: this ${tool} would put a credential on disk — rule ${shown.join("; ")}${more}. ` +
    `The value is deliberately not repeated here; a value that reached this session should be treated as exposed and rotated.\n\n` +
    `Fix: keep the value out of the tree. Read it at runtime from an environment variable or a secrets manager ` +
    `(e.g. \`process.env.MY_API_KEY\`) and write a placeholder in any example file (\`MY_API_KEY=<your-key-here>\` or ` +
    `\`SECRET=changeme\`). If this text is a deliberate test fixture, put it under \`fixtures/\` or \`testdata/\`, name the ` +
    `file \`*.test.*\`, or add its glob to SECRET_GUARD_ALLOW_PATHS (comma list). Rules: ${loaded.path}.`
  );
}

// ONE write, then fall off the end. `kind` is a source constant — never the rule id from a data file,
// never the value, never the reason.
function deny(reason, kind) {
  recordFire(HOOK, "deny", kind);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

function main() {
  let input;
  try {
    input = readFileSync(0);
  } catch {
    return; // fail-open: nothing to scan is not a finding
  }
  if (input.length > MAX_EVENT_BYTES) {
    deny(
      `secret-write-guard: the hook payload is ${input.length} bytes, over the ${MAX_EVENT_BYTES}-byte cap, so the ` +
        `written text was NOT scanned for credentials. Write the file in smaller pieces (under 1 MB each).`,
      "oversize",
    );
    return;
  }
  let ev;
  try {
    ev = JSON.parse(input.toString("utf8"));
  } catch {
    return; // fail-open: an unparseable event carries nothing to be wrong about
  }
  let reason = null;
  try {
    reason = decide(ev);
  } catch {
    reason = null; // fail-open: a bug in the decider must never block real work
  }
  if (reason) {
    deny(reason, "credential");
    return;
  }
  // A guard that is OFF must say so where the agent and the operator can read it. v0.3.0 shipped
  // without hooks/rules/ in the tarball: every install ran this hook with no rules, it failed open
  // with a fire of kind "error" that nobody was looking at, and `doctor` on a clean machine was the
  // only thing that noticed. The fail-open stays (a broken rules file must not brick every edit);
  // the silence does not.
  const loaded = rules();
  if (loaded.error && TOOLS.test(ev?.tool_name || "") && process.env.CLAUDE_HOOKS_QUIET !== "1") {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `secret-write-guard is OFF: its rules file could not be loaded (${loaded.error}). Restore hooks/rules/secrets.json or set SECRET_GUARD_RULES; until then nothing is scanned for credentials.`,
      }),
    );
  }
  // exit naturally so stdout drains
}

// basename, not a full-URL compare: on Windows argv[1] is a backslash path and the URL compare never
// matched, so the hook exited silently with no verdict.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
