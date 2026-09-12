#!/usr/bin/env node
// PreToolUse runaway-guard (fail-open). DENIES commands that generate output FOREVER by construction.
//
// THE INCIDENT CLASS. An operator answered a yes/no question with "yes for sure". It reached the shell,
// where `yes` is a real command that prints its argument until killed. It wrote gigabytes before the
// harness stopped it. Nothing was corrupted, but the disk churned, the answer never arrived, and the
// session spent a round recovering from a two-word confirmation.
//
// The lesson is NOT "type more carefully". A human confirming something should never be able to fill a
// disk, and the class is broader than one word: `yes`, `cat /dev/urandom`, `cat /dev/zero`, an endless
// `seq`, `while true` echoing — each produces infinite stdout with no natural stop.
//
// WHAT MAKES A GENERATOR SAFE: a BOUND. `yes | head -3`, `head -c 1M /dev/urandom`, `timeout 2 yes` are
// all fine and common — the consumer or the clock stops them. So this denies an unbounded generator ONLY
// when nothing in its OWN statement bounds it. That distinction is the whole guard; without it this would
// block `yes | apt-get install` and get switched off within a day, which is how a guard stops protecting.
//
// WHY THIS IS A PARSER AND NOT A REGEX. The first version anchored `yes` at `(^|[;&|]\s*)` and looked for
// a bound ANYWHERE in the string. An adversarial probe broke both halves in one sitting:
//   - `(yes)`, `$(yes)`, `env yes`, `nohup yes &`, `YES=1 yes`, `bash -c 'yes'` and a `yes` on its own
//     LINE all ran to the disk — the anchor never saw a command word behind a prefix or a newline.
//   - `yes | head -n 3 > f; yes` was ALLOWED: the `head` in statement one excused statement two.
//   - `yes | tail -n 5` was ALLOWED: `tail` was listed as a bound, but tail waits for EOF that never comes.
//   - `yes | apt-get install -y foo` was DENIED, the exact false positive the header above warns about.
// So the command is now split into statements (`;`, `&&`, `||`, `&`, newline), each statement into a
// pipeline, transparent prefixes are stripped, `sh -c '…'` / `(…)` / `$(…)` are recursed into, and
// INFINITE and BOUNDED are decided per pipeline: a generator is safe if something DOWNSTREAM IN ITS OWN
// PIPELINE (or a clock in front of it) stops it.
//
// WHAT COUNTS AS A BOUND. A clock (`timeout`), a self-capping reader (`head`, `head -c`, `sed …q`,
// `grep -m N`, `awk '…exit'`, `dd count=`), or ANY consumer that is not a pure pass-through filter. The
// last one is a deliberate choice: `apt-get`, `python3 -c`, `fsck`, `ssh` read what they need and exit,
// and denying them is how this guard would be switched off. Pass-through filters (`cat`, `tee`, `grep`
// without `-m`, `sort`, `uniq`, `wc`, `tail`, `sed` without `q`, `awk` without `exit`, `xargs`, `tr`,
// `while read`) never stop on infinite input, so `yes | wc -l` stays denied — `wc` counts forever.
//
// Scope is deliberately narrow. This is not a general "dangerous command" filter — a separate
// destructive-command guard owns that. It closes exactly one hole: infinite output from a shell that was
// handed prose.
//
// FAIL-OPEN: any parse error exits 0 and allows. A guard bug must never block real work.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("runaway-guard.mjs");

// ── PARSER — a small shell reader, just enough structure to know the command word of every statement ──
//
// list      = pipeline[]            statements split on ; && || & newline
// pipeline  = cmd[]                 split on |  |&
// cmd       = { words, redirs, groups, subs, procsubs }
//   groups   : lists from `( … )`, `{ … }` — their output flows to THIS pipeline's consumers
//   subs     : lists from `$( … )`, `` ` … ` `` — must run to completion, so no outer consumer helps
//   procsubs : lists from `<( … )`, `>( … )` — read by this command
// Quotes are unwrapped into the word so `'yes'`, `"yes"` and `$'yes'` all yield the command word `yes`.
// Heredoc bodies and `#` comments are skipped: the old regex would have denied `cat <<EOF\nyes\nEOF`.

const REDIR_RE = /^(\d*|&)(>>|>&|>\||<&|<>|<<<|<<|>|<)(.*)$/;

function newCmd() {
  return { words: [], redirs: [], groups: [], subs: [], procsubs: [] };
}

function isWs(c) {
  return c === " " || c === "\t" || c === "\r";
}

function parse(src) {
  const st = { s: src, i: 0, heredocs: [] };
  return parseList(st, null);
}

// Skips the bodies of every heredoc opened on the line that just ended.
function skipHeredocs(st) {
  while (st.heredocs.length) {
    const { delim, strip } = st.heredocs.shift();
    for (;;) {
      if (st.i >= st.s.length) return;
      let nl = st.s.indexOf("\n", st.i);
      if (nl === -1) nl = st.s.length;
      let line = st.s.slice(st.i, nl);
      if (strip) line = line.replace(/^\t+/, "");
      st.i = nl + 1;
      if (line === delim) break;
    }
  }
}

function parseList(st, closer) {
  const s = st.s;
  const list = [];
  let pipeline = [];
  let cmd = newCmd();
  let word = null; // string being accumulated, or null between words
  const endWord = () => {
    if (word !== null) {
      cmd.words.push(word);
      word = null;
    }
  };
  const endCmd = () => {
    endWord();
    if (cmd.words.length || cmd.groups.length || cmd.subs.length || cmd.procsubs.length) {
      finalizeRedirs(cmd);
      pipeline.push(cmd);
    }
    cmd = newCmd();
  };
  const endPipeline = () => {
    endCmd();
    if (pipeline.length) list.push(pipeline);
    pipeline = [];
  };
  const add = (t) => {
    word = word === null ? t : word + t;
  };

  while (st.i < s.length) {
    const c = s[st.i];
    const n = s[st.i + 1];
    const atWordStart = word === null;

    if (c === "\\") {
      if (n === "\n") st.i += 2; // line continuation — joins the two lines
      else {
        add(n === undefined ? "" : n);
        st.i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", st.i + 1);
      add(s.slice(st.i + 1, end === -1 ? s.length : end));
      st.i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === "$" && n === "'") {
      // ANSI-C quoting: like single quotes but backslash escapes the closing quote
      st.i += 2;
      let t = "";
      while (st.i < s.length && s[st.i] !== "'") {
        if (s[st.i] === "\\" && st.i + 1 < s.length) {
          t += s[st.i + 1];
          st.i += 2;
        } else t += s[st.i++];
      }
      st.i++;
      add(t);
      continue;
    }
    if (c === '"') {
      st.i++;
      let t = "";
      while (st.i < s.length && s[st.i] !== '"') {
        const d = s[st.i];
        const e = s[st.i + 1];
        if (d === "\\" && e !== undefined) {
          t += e;
          st.i += 2;
        } else if (d === "$" && e === "(" && s[st.i + 2] !== "(") {
          st.i += 2;
          cmd.subs.push(parseList(st, ")"));
          t += "$()";
        } else if (d === "`") {
          st.i++;
          cmd.subs.push(parseList(st, "`"));
          t += "``";
        } else {
          t += d;
          st.i++;
        }
      }
      st.i++;
      add(t);
      continue;
    }
    if (c === "`") {
      if (closer === "`") {
        st.i++;
        endPipeline();
        return list;
      }
      st.i++;
      cmd.subs.push(parseList(st, "`"));
      add("``");
      continue;
    }
    if (c === "$" && n === "(") {
      if (s[st.i + 2] === "(") {
        // arithmetic $(( … )) — one opaque word
        let end = s.indexOf("))", st.i + 3);
        if (end === -1) end = s.length - 2;
        add(s.slice(st.i, end + 2));
        st.i = end + 2;
      } else {
        st.i += 2;
        cmd.subs.push(parseList(st, ")"));
        add("$()");
      }
      continue;
    }
    if ((c === "<" || c === ">") && n === "(" && atWordStart) {
      st.i += 2;
      cmd.procsubs.push(parseList(st, ")"));
      add(c + "()");
      continue;
    }
    if (c === "(" && atWordStart) {
      if (n === "(") {
        let end = s.indexOf("))", st.i + 2);
        if (end === -1) end = s.length - 2;
        add(s.slice(st.i, end + 2));
        st.i = end + 2;
      } else {
        st.i++;
        cmd.groups.push(parseList(st, ")"));
      }
      continue;
    }
    if (c === ")" && closer === ")") {
      st.i++;
      endPipeline();
      return list;
    }
    if (c === "{" && atWordStart && (n === undefined || isWs(n) || n === "\n")) {
      st.i++;
      cmd.groups.push(parseList(st, "}"));
      continue;
    }
    if (
      c === "}" &&
      atWordStart &&
      closer === "}" &&
      (n === undefined || isWs(n) || n === "\n" || n === ";" || n === "|" || n === "&" || n === ")")
    ) {
      st.i++;
      endPipeline();
      return list;
    }
    if (c === "#" && atWordStart) {
      let nl = s.indexOf("\n", st.i);
      st.i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === "|") {
      if (n === "|") {
        endPipeline();
        st.i += 2;
      } else {
        endCmd();
        st.i += n === "&" ? 2 : 1;
      }
      continue;
    }
    if (c === "&") {
      if (n === "&") {
        endPipeline();
        st.i += 2;
        continue;
      }
      if (n === ">") {
        endWord();
        add("&");
        st.i++;
        continue; // `&>` — the `>` branch below completes the operator
      }
      endPipeline(); // background job
      st.i++;
      continue;
    }
    if (c === ";") {
      endPipeline();
      st.i++;
      continue;
    }
    if (c === "\n") {
      endPipeline();
      st.i++;
      skipHeredocs(st);
      continue;
    }
    if (isWs(c)) {
      endWord();
      st.i++;
      continue;
    }
    if (c === "<" && n === "<" && s[st.i + 2] !== "<") {
      // heredoc: remember the delimiter, skip the body at the end of this line
      endWord();
      st.i += 2;
      let strip = false;
      if (s[st.i] === "-") {
        strip = true;
        st.i++;
      }
      while (st.i < s.length && isWs(s[st.i])) st.i++;
      let delim = "";
      while (st.i < s.length && !isWs(s[st.i]) && s[st.i] !== "\n" && s[st.i] !== ";" && s[st.i] !== "|") {
        const d = s[st.i];
        if (d === "'" || d === '"') {
          const end = s.indexOf(d, st.i + 1);
          delim += s.slice(st.i + 1, end === -1 ? s.length : end);
          st.i = end === -1 ? s.length : end + 1;
        } else if (d === "\\") {
          delim += s[st.i + 1] ?? "";
          st.i += 2;
        } else {
          delim += d;
          st.i++;
        }
      }
      st.heredocs.push({ delim, strip });
      add("<<");
      endWord();
      continue;
    }
    if (c === "<" || c === ">") {
      // a redirect operator starts a new word unless glued to a fd number or `&`
      if (word !== null && !/^\d+$|^&$/.test(word)) endWord();
      let op = c;
      st.i++;
      while (st.i < s.length && (s[st.i] === ">" || s[st.i] === "&" || s[st.i] === "|" || s[st.i] === "<")) {
        op += s[st.i++];
        if (op.length >= 3) break;
      }
      add(op);
      continue;
    }
    add(c);
    st.i++;
  }
  endPipeline();
  return list;
}

// Moves `> f`, `2>&1`, `< /dev/urandom`, `<< EOF` out of the argument list into `redirs`.
function finalizeRedirs(cmd) {
  const words = cmd.words;
  const args = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = REDIR_RE.exec(w);
    if (!m) {
      args.push(w);
      continue;
    }
    const op = m[2];
    let target = m[3];
    if (target === "" && i + 1 < words.length) target = words[++i];
    cmd.redirs.push({ op, target });
  }
  cmd.words = args;
}

// ── EVALUATION ──────────────────────────────────────────────────────────────────────────────────

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Prefixes that run the next word as the command. Value: flags that take an argument, so the argument
// is not mistaken for the command word (`nice -n 10 yes`, `sudo -u root yes`).
const TRANSPARENT = new Map([
  ["env", ["-u", "-C", "-S", "--unset", "--chdir"]],
  ["command", []],
  ["exec", ["-a"]],
  ["nohup", []],
  ["time", []],
  ["nice", ["-n", "--adjustment"]],
  ["ionice", ["-c", "-n", "-p"]],
  ["setsid", []],
  ["sudo", ["-u", "-g", "-p", "-C", "-r", "-t", "-U", "-h"]],
  ["doas", ["-u", "-C"]],
  ["builtin", []],
  ["stdbuf", ["-i", "-o", "-e"]],
  ["unbuffer", []],
  ["chronic", []],
  ["caffeinate", ["-t", "-w"]],
  ["do", []],
  ["then", []],
  ["else", []],
  ["!", []],
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "busybox"]);
// Filters that never stop on their own when fed an infinite stream. A consumer NOT in this set is
// assumed to read a bounded amount and exit (`apt-get`, `python3 -c`, `fsck`, `ssh` …) — see header.
const PASSTHROUGH = new Set([
  "cat", "tee", "grep", "egrep", "fgrep", "rg", "sort", "uniq", "wc", "tr", "sed", "awk", "gawk", "mawk",
  "cut", "tail", "tac", "rev", "nl", "paste", "xargs", "base64", "base32", "xxd", "od", "hexdump",
  "strings", "gzip", "gunzip", "bzip2", "xz", "zstd", "lz4", "less", "more", "column", "fold", "fmt",
  "pv", "dd", "split", "cp", "while", "until", "for", "tail",
]);
const DEV_RE = /^\/dev\/(u?random|zero)$/;

// Strips transparent prefixes and env assignments; reports a clock bound or a shell script to recurse into.
function strip(cmd) {
  const w = cmd.words;
  let i = 0;
  for (;;) {
    const t = w[i];
    if (t === undefined) return { word: null, args: [] };
    if (ASSIGN_RE.test(t)) {
      i++;
      continue;
    }
    if (t === "timeout") return { word: null, args: [], bounded: true };
    const argFlags = TRANSPARENT.get(t);
    if (argFlags === undefined) break;
    if (t === "command" && /^-[vV]/.test(w[i + 1] ?? "")) return { word: null, args: [] }; // `command -v yes` looks a command up
    i++;
    while (i < w.length && w[i].startsWith("-") && w[i] !== "-") {
      const f = w[i++];
      if (argFlags.includes(f)) i++;
    }
  }
  const word = w[i];
  const args = w.slice(i + 1);
  if (SHELLS.has(word)) {
    let j = 0;
    if (word === "busybox") j = 1; // `busybox sh -c …`
    for (; j < args.length; j++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[j]) && args[j + 1] !== undefined)
        return { word, args, script: args[j + 1] };
      if (!args[j].startsWith("-")) break;
    }
  }
  if (word === "eval") return { word, args, script: args.join(" ") };
  return { word, args };
}

function positional(args) {
  return args.filter((a) => !a.startsWith("-"));
}

// A command that caps its own input: it ends an infinite stream from a generator upstream, and it
// makes a /dev/urandom read finite.
function isBounder({ word, args, bounded }) {
  if (bounded) return true;
  switch (word) {
    case "head":
      return true;
    case "sed":
      return positional(args).some((a) => /(^|;|\s)(\/[^/]*\/|[0-9]+|\$)?\s*[qQ]\s*(;|$|\s)/.test(a));
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
      return args.some((a) => /^-[A-Za-z]*m\d*$|^--max-count(=|$)/.test(a));
    case "awk":
    case "gawk":
    case "mawk":
      return args.some((a) => /\bexit\b/.test(a));
    case "dd":
      return args.some((a) => /^count=/.test(a));
    default:
      return false;
  }
}

// Does anything downstream stop the stream? First bounder or first non-pass-through consumer wins.
function boundedBy(consumers) {
  for (const c of consumers) {
    if (c.groups.length && !c.words.length) return true; // `yes | (head -1)` — a grouped consumer reads and exits
    const info = strip(c);
    if (info.word === null) return info.bounded === true;
    if (isBounder(info)) return true;
    if (!PASSTHROUGH.has(info.word)) return true;
  }
  return false;
}

function generatorOf(info, cmd) {
  const { word, args } = info;
  if (word === null) return null;
  if (/^yes$/i.test(word)) return "`yes` prints forever until killed";
  if (word === "seq" && positional(args).some((a) => /^-?inf(inity)?$/i.test(a)))
    return "`seq … inf` counts up forever";
  if (word === "dd") {
    if (args.some((a) => /^if=\/dev\/(u?random|zero)$/.test(a)) && !args.some((a) => /^count=/.test(a)))
      return "`dd` from /dev/urandom|random|zero with no count= never reaches EOF";
    return null;
  }
  if (PASSTHROUGH.has(word) && !isBounder(info)) {
    const fromDev =
      args.some((a) => DEV_RE.test(a)) || cmd.redirs.some((r) => r.op === "<" && DEV_RE.test(r.target));
    if (fromDev) return "reading /dev/urandom|random|zero never reaches EOF";
  }
  return null;
}

const LOOP_COND_RE = /^(true|:|\[\s*1\s*\]|\[\[\s*1\s*\]\]|test\s+1|\[\s*1\s*(-eq|=|==)\s*1\s*\]|\(\(\s*;\s*;\s*\)\))$/;
function loopHeader(info) {
  const cond = info.args.join(" ");
  if (info.word === "while" && LOOP_COND_RE.test(cond)) return "an unconditional loop with no break";
  if (info.word === "until" && /^(false|\[\s*\]|\[\s*0\s*-eq\s*1\s*\])$/.test(cond))
    return "an `until false` loop with no break";
  if (info.word === "for" && LOOP_COND_RE.test(cond)) return "a `for ((;;))` loop with no break";
  return null;
}

function loopWord(pipeline) {
  const w = pipeline.length ? strip(pipeline[0]).word : null;
  return w === "while" || w === "until" || w === "for" ? "open" : w === "done" ? "close" : null;
}

function bodyExits(list) {
  for (const p of list)
    for (const c of p) {
      const w = strip(c).word;
      if (w === "break" || w === "exit" || w === "return") return true;
      if (c.groups.some(bodyExits)) return true;
    }
  return false;
}

// Returns the first unbounded generator's description, or null.
function evalList(list, outer) {
  for (let k = 0; k < list.length; k++) {
    const pipeline = list[k];
    const head = strip(pipeline[0]);
    const loop = loopHeader(head);
    if (loop) {
      // find the matching `done`; the body is everything between, the consumers hang off `done`
      let depth = 0;
      let j = k + 1;
      for (; j < list.length; j++) {
        const lw = loopWord(list[j]);
        if (lw === "open") depth++;
        else if (lw === "close" && depth-- === 0) break;
      }
      const body = list.slice(k + 1, j);
      const donePipeline = list[j] ?? [];
      const consumers = donePipeline.slice(1).concat(outer);
      if (!bodyExits(body) && !boundedBy(consumers)) return loop;
    }
    const hit = evalPipeline(pipeline, outer);
    if (hit) return hit;
  }
  return null;
}

function evalPipeline(pipeline, outer) {
  for (let c = 0; c < pipeline.length; c++) {
    const cmd = pipeline[c];
    const consumers = pipeline.slice(c + 1).concat(outer);
    for (const sub of cmd.subs) {
      const hit = evalList(sub, []); // a substitution must finish before its command even starts
      if (hit) return hit;
    }
    for (const ps of cmd.procsubs) {
      const hit = evalList(ps, [cmd]);
      if (hit) return hit;
    }
    const info = strip(cmd);
    if (info.bounded) continue; // `timeout N …` clocks everything behind it, groups included
    for (const g of cmd.groups) {
      const hit = evalList(g, consumers);
      if (hit) return hit;
    }
    if (info.script !== undefined) {
      const hit = evalList(parse(info.script), consumers);
      if (hit) return hit;
      continue;
    }
    const what = generatorOf(info, cmd);
    if (what && !boundedBy(consumers)) return what;
  }
  return null;
}

// Exported for the in-process latency test: a 60 KiB command must decide well inside the hook timeout.
export function findRunaway(command) {
  return evalList(parse(command), []);
}

function deny(reason) {
  recordFire("runaway-guard.mjs", "deny", "runaway");
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

export const MAX_EVENT_BYTES = 64 * 1024;
function main() {
  const input = readFileSync(0, "utf8");
  if (input.length > MAX_EVENT_BYTES) {
    // fail CLOSED on what it cannot scan — a regex over megabytes is how a 10 s hook timeout turns
    // into a silent allow (a timed-out PreToolUse hook does not block the call).
    deny(
      `Runaway output: the hook payload is ${input.length} bytes, above the ${MAX_EVENT_BYTES}-byte scan ` +
        `limit, so nothing checked it for unbounded generators. Write it to a script file and run that.`,
    );
    return;
  }
  const ev = JSON.parse(input);
  if (ev.tool_name !== "Bash") return;
  const cmd = String((ev.tool_input && ev.tool_input.command) || "");
  if (!cmd) return;

  const what = findRunaway(cmd);
  if (!what) return;

  deny(
    `Runaway output: ${what}, and nothing in its statement bounds it. A two-word answer like ` +
      `"yes for sure" has reached the shell this way before and wrote gigabytes before it was killed.\n\n` +
      `If you meant to run it, add a bound IN THE SAME PIPELINE — \`| head -n 20\`, \`head -c 1M\`, or ` +
      `\`timeout 5 …\`. A bound in another statement does not count.\n` +
      `If you were answering a question rather than running a command, just send the words without the ` +
      `leading \`!\`.`,
  );
}
// main() runs only when this file is the entry point, so the test can import findRunaway() in-process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    /* fail-open */
  }
}
// exit naturally so the one stdout write flushes (pipes are asynchronous on Windows)
