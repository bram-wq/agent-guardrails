#!/usr/bin/env node
// PreToolUse config-tamper-guard (Write|Edit|MultiEdit|NotebookEdit and Bash) + SessionStart.
// DENIES any WRITE to the agent's own control surface — the files that decide which hooks run, what
// is permitted, and what scope applies — so that only a human, from their own terminal, changes them.
//
// THE INCIDENT (the shape; it is the first must-fire case, verbatim): mid-task, with a Stop hook
// refusing an unproven "done", the agent types
//   `sed -i 's/goal-guard/goal-guard.off/' .claude/settings.json`
// and every refusal after it is gone. Nothing in the transcript looks wrong: one small edit to one JSON
// file. Every guard in this repo is a sentence until the file that wires it is out of the agent's
// reach; this guard is that reach.
//
// THE TWIN: `cat .claude/settings.json`, `git diff .claude/`, `ls .git/hooks`,
// `node .claude/hooks/goal-guard.mjs --set … --done …` (an INVOCATION of a hook is how goals are armed),
// a Write to `.claude/skills/x/SKILL.md` or `.claude/commands/x.md` (prompts, not control), and a Write to
// `hooks/foo.mjs` at the ROOT of a repo that develops hooks — this one. Only `.claude/hooks/` is wired.
//
// ── THE CONTROL SURFACE (path classes) ───────────────────────────────────────────────────────────────
//   settings       <any dir>/.claude/settings.json · .claude/settings.local.json · ~/.claude/settings.json
//   hooks          anything under <any dir>/.claude/hooks/ (the directory itself included)
//   scope          any file named .agent-scope (scope-guard's contract)
//   mcp            any file named .mcp.json
//   global-config  ~/.claude.json ("Global config" keys apply only from it — settings reference)
//   git-hooks      .git/hooks/* · .githooks/* · `git config core.hooksPath`
//   git-config     .git/config (a direct write) · `git config --unset|--unset-all|--remove-section`
//   managed        /etc/claude-code/ · /Library/Application Support/ClaudeCode/ · C:\Program Files\ClaudeCode\
//                  (managed-settings.json, managed-settings.d/, managed-mcp.json — managed-settings page,
//                  read 2026-09-12; the legacy C:\ProgramData path is no longer read but still refused)
//   cli-config     `claude config set|add|remove|rm …`, `claude mcp add|add-json|remove …`,
//                  `claude --settings …` (the reference: "--settings … Takes precedence over
//                  ~/.claude/claude.json and managed settings" — a nested session with this session's
//                  hooks overridden). `claude config` subcommands are NOT in the CLI reference read
//                  2026-09-12; they are refused on shape because the binary still accepts them.
//
// ── HOW A WRITE IS RECOGNISED ────────────────────────────────────────────────────────────────────────
// Write / Edit / MultiEdit / NotebookEdit: `tool_input.file_path` (NotebookEdit: `notebook_path`).
// Bash: the command is lexed into statements (quotes, `$(…)`, backticks, `sh -c "…"`, `eval`, heredoc
// bodies skipped, `#` comments dropped) and each statement is judged by SHAPE:
//   redirection  `>` `>>` `>|` `&>` `N>` into a control path (fd dups like `2>&1` are not files)
//   tee          every non-flag argument
//   sed -i / perl -i (any flag cluster carrying `i`, or --in-place): every non-flag argument
//   cp / install / rsync / ln   the DESTINATION (last argument, or `-t DIR`)
//   mv                          source or destination
//   rm / unlink / shred / truncate / touch / mkdir / rmdir / chmod / chown / chattr   every argument
//   dd                          `of=…`
//   git config                  `core.hooksPath` (any case), `--unset`, `--unset-all`, `--remove-section`
//   claude                      the cli-config shapes above
// Reads are never judged: `cat`, `ls`, `git diff`, `node <hook> …`, `cp <control> /tmp/x` all pass.
// NOT covered, by design: a write hidden inside an interpreter (`node -e "fs.writeFileSync(…)"`,
// `python -c`) — those are not a shell shape, and a guard that scans program text fires on prose.
//
// ── PATH RESOLUTION ──────────────────────────────────────────────────────────────────────────────────
// A path is judged TWICE: as spelled (after `~`, `$HOME`, `${HOME}` expansion and `.`/`..` collapse,
// relative to the event `cwd`) and as canonicalised — the deepest EXISTING ancestor is realpath'd and
// the missing tail re-joined (mirrors goal-guard's canonicalPath; not imported, because importing a
// guard records an invocation it did not serve). Either spelling hitting a class is a finding, so a
// symlink INTO `.claude/hooks/` and a symlink OUT of it are both seen. A Windows-shaped path
// (`C:\x\.claude\settings.json`, a backslash anywhere) is judged on string shape on every platform.
// A path holding an unexpanded variable (`$X/.claude/settings.json`) is judged on its shape — ambiguous
// text falls on the firing side.
//
// ── THE ESCAPE HATCH ─────────────────────────────────────────────────────────────────────────────────
// CONFIG_GUARD_ALLOW=1 in the hook's OWN environment — set by the human in the shell that launched
// Claude Code — stands the guard down and records a fire of kind "exempted", so the exemption is
// measurable. A `CONFIG_GUARD_ALLOW=1 sed -i …` prefix INSIDE the Bash command does NOT count: leading
// `NAME=value` words (and `env NAME=value`) are stripped before the statement is judged, and the hook
// only ever reads its own process.env. CLAUDE_HOOKS_QUIET does not lift this guard either — a guard the
// guarded party can switch off from inside the session is a suggestion.
//
// ── SESSIONSTART ─────────────────────────────────────────────────────────────────────────────────────
// On `hook_event_name: "SessionStart"` the guard never blocks (the reference: SessionStart cannot
// block). It prints `additionalContext` with a sha256 fingerprint of `.claude/hooks/*` and
// `.claude/settings*.json` under `cwd` — sorted, content-hashed, one short hash per file plus one for
// the set — so a later fingerprint that differs is a visible diff, not a feeling. 0 files and an
// unreadable file print DIFFERENT lines.
//
// ── CONTRACT (https://code.claude.com/docs/en/hooks, read 2026-09-12) ────────────────────────────────
// Consumed: `hook_event_name`, `cwd`, `tool_name`, `tool_input.file_path` / `notebook_path` /
// `command`. Emitted on a finding: `hookSpecificOutput.permissionDecision: "deny"` +
// `permissionDecisionReason` (PreToolUse); `hookSpecificOutput.additionalContext` (SessionStart).
// "Exit 0 means success … Claude Code reads JSON output for structured control." Exit 0 on every path.
//
// FAIL DIRECTION. The harness fails OPEN (garbage stdin, missing field, any exception → exit 0, no
// output). The decision fails CLOSED: a payload over MAX_EVENT_BYTES is refused with a reason that says
// it was NOT scanned. ONE stdout write, natural exit — process.exit() after a write can truncate a deny
// into an allow.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("config-tamper-guard.mjs");

export const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_FINGERPRINT_FILES = 256;
const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/i;

const FIX =
  "Edit it from your own terminal, or launch Claude Code with CONFIG_GUARD_ALLOW=1 in the shell " +
  "environment (a CONFIG_GUARD_ALLOW=1 prefix inside a Bash command does not count).";

// ── PATH CANONICALISATION (mirror of goal-guard's canonicalPath; deliberately not imported) ──────────

/** Realpath of the deepest existing ancestor, missing tail re-joined; case-folded on Windows. */
export function canonicalPath(p) {
  let head = resolve(p);
  const tail = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      tail.unshift(basename(head));
      head = parent;
    }
  }
  const out = tail.length ? join(head, ...tail) : head;
  return process.platform === "win32" ? out.toLowerCase() : out;
}

const WIN_SHAPE = /^[A-Za-z]:[\\/]|^\\\\|\\/;

/** `~`, `~/…`, `$HOME/…`, `${HOME}/…` → the home directory. */
function expandHome(w, home) {
  if (w === "~" || w.startsWith("~/") || w.startsWith("~\\")) return home + w.slice(1);
  return w.replace(/^\$\{HOME\}(?=[\\/]|$)|^\$HOME(?=[\\/]|$)/, home);
}

/**
 * Judge ONE `/`-joined spelling. `folded` is true when the comparison must be case-insensitive
 * (Windows-shaped input, or a win32 host).
 * @returns {string|null} the path class
 */
function classifyShape(p, folded) {
  const s = folded ? p.toLowerCase() : p;
  const segs = s.split("/").filter((x) => x !== "" && x !== ".");
  const last = segs[segs.length - 1] ?? "";
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (a === ".claude") {
      if (b === "hooks") return "hooks";
      if ((b === "settings.json" || b === "settings.local.json") && i + 2 === segs.length)
        return "settings";
    }
    if (a === ".git") {
      if (b === "hooks") return "git-hooks";
      if (b === "config" && i + 2 === segs.length) return "git-config";
    }
    if (a === ".githooks") return "git-hooks";
  }
  if (last === ".agent-scope") return "scope";
  if (last === ".mcp.json") return "mcp";
  // Managed system directories, on every OS, drive letter or not. Always case-folded: these
  // directories have ONE fixed spelling, so folding cannot manufacture a hit on a user path.
  const l = s.toLowerCase();
  const noDrive = l.replace(/^[a-z]:/, "");
  if (
    /^\/etc\/claude-code(\/|$)/.test(noDrive) ||
    /^\/library\/application support\/claudecode(\/|$)/.test(noDrive) ||
    /^\/program files\/claudecode(\/|$)/.test(noDrive) ||
    /^\/programdata\/claudecode(\/|$)/.test(noDrive)
  )
    return "managed";
  if (
    /^managed-(settings|mcp)\.json$/.test(last.toLowerCase()) &&
    l.split("/").some((x) => /^(claudecode|claude-code|managed-settings\.d)$/.test(x))
  )
    return "managed";
  return null;
}

/**
 * Classify a path as spelled by the tool. Returns `{ cls, path }` or null.
 * @param {string} word
 * @param {string} cwd
 */
export function classifyPath(word, cwd, home = homedir()) {
  let w = String(word ?? "").trim();
  if (!w) return null;
  w = expandHome(w, home);
  const win32 = process.platform === "win32";
  const winShape = WIN_SHAPE.test(w);
  // Folded = case-insensitive: a Windows-shaped path on any host, or any path on a win32 host.
  const folded = winShape || win32;
  const slash = (p) => p.split("\\").join("/");
  const homeFolded = slash(folded ? home.toLowerCase() : home);
  // ~/.claude.json is the one control file whose class depends on WHERE it sits.
  const isGlobal = (p) => {
    const q = folded ? p.toLowerCase() : p;
    return basename(q) === ".claude.json" && dirname(q) === homeFolded;
  };
  // ⚠ THE WINDOWS-SHAPED BRANCH USED TO SKIP BOTH THE GLOBAL-CONFIG CHECK AND CANONICALISATION.
  // `~/.claude.json` expands to `C:\Users\me/.claude.json` on a Windows host — a Windows shape — so it
  // was judged by string shape alone and allowed; a symlinked `.claude` under a drive path was never
  // realpath'd. Three must-fire cases went red on the CI matrix while Linux and macOS were green.
  const spelled = winShape
    ? posix.normalize(slash(w))
    : posix.normalize(isAbsolute(w) ? w : posix.join(slash(cwd), w));
  let cls = classifyShape(spelled, folded) ?? (isGlobal(spelled) ? "global-config" : null);
  // Canonicalise only when this host can resolve the path: a Windows shape on a posix host cannot be.
  if (!cls && (win32 || !winShape)) {
    let canon;
    try {
      canon = slash(canonicalPath(isAbsolute(w) ? w : join(cwd, w)));
    } catch {
      canon = null;
    }
    if (canon) cls = classifyShape(canon, folded) ?? (isGlobal(canon) ? "global-config" : null);
  }
  return cls ? { cls, path: w } : null;
}

// ── BASH LEXER ───────────────────────────────────────────────────────────────────────────────────────

/** Index past the `)` closing a `$(` whose `(` is at s[open]; quote-aware; -1 when unclosed. */
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const e = s.indexOf(ch, i + 1);
      if (e === -1) return -1;
      i = e;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Lex into statements of words `{ w, q, qs }` — `w` the word with quotes removed, `q` true when any
 * part was quoted, `qs` the index in `w` where the first quoted run starts (-1: none), so a quoted `>`
 * is data while `>"file"` is still a redirection. Substitution bodies become statements of their
 * own; heredoc bodies are skipped; `#` comments are dropped.
 * @returns {{w:string,q:boolean}[][]}
 */
export function lex(s, depth = 0) {
  const n = s.length;
  const stmts = [];
  const extra = [];
  let cur = [];
  let word = "";
  let quoted = false;
  let qs = -1;
  let pending = []; // heredoc tags awaiting the end of this line
  const sub = (inner) => {
    if (depth < MAX_DEPTH) extra.push(...lex(inner, depth + 1));
  };
  const markQuoted = () => {
    if (qs === -1) qs = word.length;
    quoted = true;
  };
  const endWord = () => {
    if (word !== "" || quoted) cur.push({ w: word, q: quoted, qs });
    word = "";
    quoted = false;
    qs = -1;
  };
  const endStmt = () => {
    endWord();
    if (cur.length) stmts.push(cur);
    cur = [];
  };
  const skipHeredocs = (from) => {
    let p = from;
    for (const h of pending) {
      for (;;) {
        if (p > n) return n;
        let e = s.indexOf("\n", p);
        if (e === -1) e = n;
        let line = s.slice(p, e);
        if (h.dash) line = line.replace(/^\t+/, "");
        p = e + 1;
        if (line === h.tag) break;
        if (e >= n) return n; // unterminated: the rest was body
      }
    }
    pending = [];
    return p;
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "\\") {
      const nx = s[i + 1];
      if (nx === undefined) break;
      if (nx === "\n") {
        i += 2;
        continue;
      }
      if (nx === " " || nx === "\t") markQuoted();
      word += nx;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      const end = e === -1 ? n : e;
      markQuoted();
      word += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let body = "";
      while (j < n && s[j] !== '"') {
        if (s[j] === "\\") {
          body += s[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (s[j] === "$" && s[j + 1] === "(") {
          const c = closeParen(s, j + 1);
          sub(s.slice(j + 2, c === -1 ? n : c - 1));
          j = c === -1 ? n : c;
          continue;
        }
        if (s[j] === "`") {
          const c = s.indexOf("`", j + 1);
          sub(s.slice(j + 1, c === -1 ? n : c));
          j = c === -1 ? n : c + 1;
          continue;
        }
        body += s[j++];
      }
      markQuoted();
      word += body;
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === "`") {
      const c = s.indexOf("`", i + 1);
      sub(s.slice(i + 1, c === -1 ? n : c));
      i = c === -1 ? n : c + 1;
      continue;
    }
    if (ch === "$" && s[i + 1] === "(") {
      const c = closeParen(s, i + 1);
      sub(s.slice(i + 2, c === -1 ? n : c - 1));
      i = c === -1 ? n : c;
      continue;
    }
    if (ch === "#" && word === "" && !quoted) {
      let e = s.indexOf("\n", i);
      if (e === -1) e = n;
      i = e;
      continue;
    }
    if (ch === "\n") {
      endStmt();
      i++;
      if (pending.length) i = skipHeredocs(i);
      continue;
    }
    if (ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      let j = i + 2;
      let dash = false;
      if (s[j] === "-") {
        dash = true;
        j++;
      }
      while (s[j] === " " || s[j] === "\t") j++;
      let tag = "";
      if (s[j] === "'" || s[j] === '"') {
        const e = s.indexOf(s[j], j + 1);
        tag = s.slice(j + 1, e === -1 ? n : e);
        j = e === -1 ? n : e + 1;
      } else {
        if (s[j] === "\\") j++;
        const m = /^[^\s;|&<>]+/.exec(s.slice(j));
        tag = m ? m[0] : "";
        j += tag.length;
      }
      endWord();
      if (tag) pending.push({ tag, dash });
      i = j;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      endStmt();
      i++;
      continue;
    }
    if ((ch === "{" || ch === "}") && word === "" && !quoted) {
      endStmt();
      i++;
      continue;
    }
    if (ch === "&") {
      if (s[i + 1] === "&") {
        endStmt();
        i += 2;
        continue;
      }
      if (s[i + 1] === ">" || s[i - 1] === ">") {
        word += ch;
        i++;
        continue;
      }
      endStmt();
      i++;
      continue;
    }
    if (ch === "|") {
      if (s[i - 1] === ">") {
        word += ch; // `>|` clobber
        i++;
        continue;
      }
      endStmt();
      i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
      continue;
    }
    word += ch;
    i++;
  }
  endStmt();
  return stmts.concat(extra);
}

// ── STATEMENT JUDGE ──────────────────────────────────────────────────────────────────────────────────

const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "env", "nohup", "time", "nice", "exec"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIR_RE = /^(\d*|&)>{1,2}\|?(.*)$/s;
const ALL_ARGS = new Set([
  "rm", "unlink", "shred", "truncate", "touch", "mkdir", "rmdir", "chmod", "chown", "chgrp", "chattr", "mv",
]);
const DEST_ARGS = new Set(["cp", "install", "rsync", "ln"]);

const base = (t) => (t.split(/[\\/]/).pop() ?? "").toLowerCase();

/** Strip leading assignments and wrappers (`CONFIG_GUARD_ALLOW=1 sed -i …` → `sed -i …`). */
function unwrap(toks) {
  let t = toks.slice();
  for (let k = 0; k < 16 && t.length; k++) {
    if (!t[0].q && ASSIGN_RE.test(t[0].w)) {
      t.shift();
      continue;
    }
    const b = base(t[0].w);
    if (WRAPPERS.has(b)) {
      t.shift();
      if (b === "sudo" || b === "doas") while (t.length && t[0].w.startsWith("-")) t.shift();
      continue;
    }
    if (SHELLS.has(b)) {
      let j = 1;
      let hasC = false;
      for (; j < t.length && t[j].w.startsWith("-"); j++) if (/^-[A-Za-z]*c/.test(t[j].w)) hasC = true;
      return hasC && j < t.length ? { recurse: t[j].w } : t;
    }
    if (b === "eval") return { recurse: t.slice(1).map((x) => x.w).join(" ") };
    break;
  }
  return t;
}

/**
 * Pure decider for a Bash command. `{ cls, path, what }` on a finding, else null.
 * @param {string} command
 * @param {string} cwd
 */
export function decideBash(command, cwd, depth = 0) {
  const cmd = String(command ?? "");
  if (!cmd) return null;
  for (const stmt of lex(cmd)) {
    // 1. redirections, anywhere in the statement
    for (let i = 0; i < stmt.length; i++) {
      const tok = stmt[i];
      const m = REDIR_RE.exec(tok.w);
      if (!m) continue;
      if (tok.qs !== -1 && tok.qs < m[0].length - m[2].length) continue; // the `>` itself was quoted
      const target = m[2] !== "" ? m[2] : stmt[i + 1]?.w;
      if (m[2] === "" && stmt[i + 1] && stmt[i + 1].qs === -1 && REDIR_RE.test(stmt[i + 1].w)) continue;
      if (!target || target.startsWith("&")) continue;
      const hit = classifyPath(target, cwd);
      if (hit) return { ...hit, what: "a shell redirection into" };
    }
    const u = unwrap(stmt);
    if (!Array.isArray(u)) {
      if (depth < MAX_DEPTH && u.recurse) {
        const r = decideBash(u.recurse, cwd, depth + 1);
        if (r) return r;
      }
      continue;
    }
    if (!u.length) continue;
    const verb = base(u[0].w);
    const args = u.slice(1).filter((t) => !REDIR_RE.test(t.w) || t.q);
    const paths = args.filter((t) => t.q || !t.w.startsWith("-"));
    const first = (list, what) => {
      for (const t of list) {
        const hit = classifyPath(t.w, cwd);
        if (hit) return { ...hit, what };
      }
      return null;
    };
    let r = null;
    if (verb === "tee") r = first(paths, "tee into");
    else if (verb === "sed" || verb === "perl") {
      const inPlace = args.some((t) => !t.q && (/^-[A-Za-z]*i/.test(t.w) || t.w.startsWith("--in-place")));
      if (inPlace) r = first(paths, `${verb} -i on`);
    } else if (ALL_ARGS.has(verb)) r = first(paths, `${verb} on`);
    else if (DEST_ARGS.has(verb)) {
      const ti = args.findIndex((t) => t.w === "-t" || t.w === "--target-directory");
      const eq = args.find((t) => t.w.startsWith("--target-directory="));
      const dest = ti !== -1 ? args[ti + 1] : eq ? { w: eq.w.slice(19) } : paths[paths.length - 1];
      if (dest && paths.length > (ti !== -1 || eq ? 0 : 1)) r = first([dest], `${verb} into`);
    } else if (verb === "dd") {
      r = first(
        args.filter((t) => t.w.startsWith("of=")).map((t) => ({ w: t.w.slice(3) })),
        "dd of= into",
      );
    } else if (verb === "git" && u[1] && u[1].w === "config") {
      const rest = args.slice(1).map((t) => t.w);
      if (rest.some((a) => a.toLowerCase() === "core.hookspath") && !rest.includes("--get"))
        r = { cls: "git-hooks", path: "core.hooksPath", what: "git config" };
      else if (rest.some((a) => /^--(unset|unset-all|remove-section)$/.test(a)))
        r = { cls: "git-config", path: rest.find((a) => a.startsWith("--unset") || a === "--remove-section"), what: "git config" };
    } else if (verb === "claude") {
      const rest = args.map((t) => t.w);
      if (rest[0] === "config" && /^(set|add|remove|rm)$/.test(rest[1] ?? ""))
        r = { cls: "cli-config", path: `claude config ${rest[1]}`, what: "" };
      else if (rest[0] === "mcp" && /^(add|add-json|remove)$/.test(rest[1] ?? ""))
        r = { cls: "cli-config", path: `claude mcp ${rest[1]}`, what: "" };
      else if (rest.some((a) => a === "--settings" || a.startsWith("--settings=")))
        r = { cls: "cli-config", path: "claude --settings", what: "" };
    }
    if (r) return r;
  }
  return null;
}

/** Pure decider for the edit tools. */
export function decideEdit(toolInput, cwd) {
  const fp = toolInput && (toolInput.file_path || toolInput.notebook_path);
  if (typeof fp !== "string" || !fp) return null;
  const hit = classifyPath(fp, cwd);
  return hit ? { ...hit, what: "a file write to" } : null;
}

const CLASS_NAMES = {
  settings: "a Claude Code settings file (hooks, permissions)",
  hooks: "the .claude/hooks/ directory (the guards themselves)",
  scope: ".agent-scope (scope-guard's contract)",
  mcp: ".mcp.json (MCP server wiring)",
  "global-config": "~/.claude.json (global config)",
  "git-hooks": "git hooks (.git/hooks, .githooks, core.hooksPath)",
  "git-config": ".git/config",
  managed: "the managed settings directory",
  "cli-config": "the claude CLI's own settings",
};

export function reasonFor(r) {
  const what = r.what ? `${r.what} ${r.path}` : r.path;
  return (
    `config-tamper-guard: ${what} changes ${CLASS_NAMES[r.cls] ?? r.cls} — the agent's own control ` +
    `surface, which no session edits. ${FIX}`
  );
}

// ── SESSIONSTART FINGERPRINT ─────────────────────────────────────────────────────────────────────────

/** Sorted, content-hashed listing of the control surface under `cwd`. */
export function fingerprint(cwd) {
  const dot = join(cwd, ".claude");
  const files = [];
  try {
    for (const name of readdirSync(join(dot, "hooks")).sort()) {
      if (files.length >= MAX_FINGERPRINT_FILES) break;
      const p = join(dot, "hooks", name);
      try {
        if (statSync(p).isFile()) files.push({ rel: `.claude/hooks/${name}`, p });
      } catch {
        files.push({ rel: `.claude/hooks/${name}`, p, unreadable: true });
      }
    }
  } catch {
    /* no hooks dir: not an error, just no files */
  }
  for (const name of ["settings.json", "settings.local.json"]) {
    const p = join(dot, name);
    try {
      if (statSync(p).isFile()) files.push({ rel: `.claude/${name}`, p });
    } catch {
      /* absent */
    }
  }
  const lines = [];
  const all = createHash("sha256");
  let unreadable = 0;
  for (const f of files) {
    let h;
    try {
      h = f.unreadable ? null : createHash("sha256").update(readFileSync(f.p)).digest("hex");
    } catch {
      h = null;
    }
    if (h === null) unreadable++;
    all.update(`${f.rel}\0${h ?? "UNREADABLE"}\n`);
    lines.push(`  ${h ? h.slice(0, 8) : "UNREADBL"}  ${f.rel}`);
  }
  return { files: files.length, unreadable, digest: all.digest("hex").slice(0, 12), lines };
}

// ── HARNESS ──────────────────────────────────────────────────────────────────────────────────────────

function deny(reason, kind) {
  recordFire("config-tamper-guard.mjs", "deny", kind);
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
  try {
    const input = readFileSync(0);
    if (input.length > MAX_EVENT_BYTES) {
      deny(
        `config-tamper-guard: the hook payload is ${input.length} bytes, over the ${MAX_EVENT_BYTES}-byte ` +
          `cap, so the tool input was NOT scanned. Write the large content to a file under the task's own ` +
          `tree and run a short command against it.`,
        "oversize",
      );
      return;
    }
    const ev = JSON.parse(input.toString("utf8"));
    if (!ev || typeof ev !== "object") return;
    const cwd = typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();
    if (ev.hook_event_name === "SessionStart") {
      const fp = fingerprint(cwd);
      const hatch = process.env.CONFIG_GUARD_ALLOW === "1";
      const head =
        fp.files === 0
          ? `▶ config-tamper-guard: no control surface under ${cwd} (0 files in .claude/hooks/, no .claude/settings*.json)`
          : `▶ config-tamper-guard: control-surface fingerprint ${fp.digest} over ${fp.files} file(s)` +
            (fp.unreadable ? ` — ${fp.unreadable} UNREADABLE (not "empty": could not hash)` : "") +
            ` under ${cwd}`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: [
              head,
              ...fp.lines,
              hatch
                ? "  CONFIG_GUARD_ALLOW=1 is set in the launch environment: control-surface writes are EXEMPTED this session (each one is recorded)."
                : "  Writes to .claude/settings*.json, .claude/hooks/, .agent-scope, .mcp.json, git hooks and managed settings are refused this session; a differing fingerprint next start means the surface changed.",
            ].join("\n"),
          },
        }),
      );
      return;
    }
    const tool = ev.tool_name;
    let r = null;
    if (tool === "Bash") r = decideBash(ev.tool_input && ev.tool_input.command, cwd);
    else if (EDIT_TOOLS.test(String(tool ?? ""))) r = decideEdit(ev.tool_input, cwd);
    if (!r) return;
    if (process.env.CONFIG_GUARD_ALLOW === "1") {
      recordFire("config-tamper-guard.mjs", "allow", "exempted");
      return;
    }
    deny(reasonFor(r), r.cls);
  } catch {
    /* fail-open */
  }
  // Exit NATURALLY so stdout drains.
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
