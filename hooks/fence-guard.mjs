#!/usr/bin/env node
// PreToolUse fence-guard (Bash). DENIES the shell actions that are irreversible or outward-facing, so
// that a HUMAN presses them from their own terminal. This is "the fence".
//
// THE DEFECT CLASS. An agent session is a loop that is very good at finishing what it started. That is
// exactly the wrong property for a press that cannot be taken back: a push to `main`, a forge merge, a
// `pulumi up`, a `DROP TABLE`, an `rm -rf` at a root. Each of those has been typed by an agent that had
// read — and agreed with — a written rule saying not to. The rule was a sentence; the agent was mid-task;
// the sentence lost. One recorded instance: an infrastructure apply run from a PARKED CHECKOUT reverted a
// whole deployment plane, because "deploy from this tree" was a rule and not a mechanism.
//
// A fence is not a judgement call about whether THIS press is safe. It is a fixed list of shapes that
// are never the session's to make, plus a deny message that hands the operator the exact command. The
// cost of a false positive is one re-typed command in a human terminal; the cost of a miss is the
// incident above. So this guard leans towards firing — but ONLY on the listed shapes, and every listed
// shape ships with its legitimate twin pinned as a must-not-fire case, because a fence that blocks
// `git push origin feature/x` is switched off in a week and then protects nothing.
//
// ── NO KILL SWITCH, DELIBERATELY ─────────────────────────────────────────────────────────────────────
// Every other guard in this repo honours CLAUDE_HOOKS_QUIET=1 as an escape valve. This one does NOT.
// A fence that the fenced party can lift by setting an environment variable is a suggestion. Nothing
// settable inside a session lifts it: not an env var, not a flag, not a comment. The only lever is
// FENCE_ALLOW, which lives in the operator's settings (never in the session), and even that RECORDS
// the exemption so it is measurable. The test suite asserts the QUIET variable is ignored.
//
// ── WHY A NORMALISER, NOT A REGEX ────────────────────────────────────────────────────────────────────
// The fenced verbs hide in text. `git push origin main` is one string; so are `git pu\sh origin main`,
// `sh -c "git push origin main"`, `FOO=1 git push origin main`, `git -C /repo push origin main`, and
// `echo "$(git push origin main)"`. A regex over the raw command either misses those or fires on
// `git commit -m "docs: why pulumi up must never run"` — and the second failure gets the guard deleted.
// So the command is first NORMALISED into shell statements, in ONE left-to-right pass:
//   (a) a single-quoted string is a placeholder token — it is literal and never executes;
//   (b) a double-quoted string is a placeholder too, UNLESS it contains `$(` or a backtick, in which
//       case only that substitution span is kept — it executes — as its own statement;
//   (c) a `#` that starts a word drops the rest of the line;
//   (d) a heredoc with a quoted tag (<<'EOF') has a literal body and it is dropped; an unquoted tag
//       keeps only the `$(…)`/backtick spans of the body; the introducer line still executes. An
//       UNTERMINATED heredoc keeps everything — ambiguous text falls on the firing side;
//   (e) `\ ` joins a word (`pulumi\ up` is ONE word and runs nothing) while `p\ulumi` is `pulumi`;
//   (f) newlines, `;`, `&&`, `||`, `|`, `&`, `(`/`)` and `{`/`}` are statement boundaries, so a
//       multi-line block keeps its boundaries and `true && git push origin main` is seen;
//   (g) command words are lower-cased and whitespace is collapsed. Short flag clusters keep their
//       case: `git branch -D` and `-d` are different commands, and lower-casing them would either
//       fence the safe one or miss the destructive one;
//   (h) statement-leading wrappers are stripped so they cannot hide the verb: `sudo`, `command`,
//       `env`, `env FOO=1`, `FOO=1 BAR=2`, `time`, `nice`, `nohup`, `xargs`, `timeout N`; and
//       `sh -c "…"` / `bash -lc '…'` / `eval "…"` recursively normalise their string argument.
//       `git -C <dir>` / `git --git-dir=<x>` between `git` and its verb are skipped.
//
// ── THE SECOND PASS (SQL) ────────────────────────────────────────────────────────────────────────────
// Because of (a)/(b), SQL inside quotes is a placeholder — which is right for `grep -rn "DROP TABLE"`
// and `echo "truncate"` but would MISS `psql -c "DROP TABLE x"`. So rule 6 makes a second, narrower
// pass over the ORIGINAL text of the `-c` / `--command` / `-e` / `--execute` / `--eval` argument of the
// SQL clients (`psql`, `mysql`, `mariadb`, `sqlite3`, `mongosh`), and of sqlite3's positional SQL.
// Only those arguments; nothing else that is quoted is ever re-scanned.
//
// ── THE RULES, IN ORDER (first match wins) ───────────────────────────────────────────────────────────
//   1. git push to a PROTECTED branch (FENCE_PROTECTED_BRANCHES, default main,master), by any refspec
//      shape: `origin main`, `origin HEAD:main`, `origin x:main`, `--all`. `git push origin feature/x`
//      and `git push -u origin HEAD` are ALLOWED — the branch is not protected or not knowable here.
//      `git push --dry-run …` is ALLOWED and pinned: a dry run mutates nothing.
//   2. git push with --force / -f / --force-with-lease / --force-if-includes / --delete / -d /
//      --mirror / --prune / a `+refspec` / a `:branch` deletion, to ANY branch.
//   3. forge merges: `gh pr merge`, `glab mr merge`.
//   4. history destruction: `git branch -D`, `git reset --hard origin/…`, `git clean` with both f and
//      x, `git filter-branch`, `git filter-repo`, `git reflog expire`, `git gc --prune=now`,
//      `git update-ref -d`.
//   5. `rm` recursive+force at a ROOT: `/`, `~`, `$HOME`, `.`, `..`, `*`, `/*`, an absolute path of ≤ 2
//      segments (`/usr`, `/home/x` — scratch roots `/tmp/x`, `/var/tmp/x`, `/dev/shm/x` excepted), or
//      a BARE variable (`$DIR`, `${DIR}`, `$DIR/` — an empty variable is `/`). `rm -rf node_modules`,
//      `rm -rf ./dist`, `rm -rf /tmp/scratch-abc`, `rm -rf "$TMPDIR/build"` are ALLOWED.
//   6. destructive SQL as a statement: DROP TABLE|DATABASE|SCHEMA|INDEX, TRUNCATE, DELETE FROM with no
//      WHERE in the same statement, ALTER TABLE … DROP COLUMN — plus the second pass above.
//   7. infra mutation: `pulumi up|destroy|refresh|import|cancel`, `terraform|tofu apply|destroy`,
//      `kubectl delete|drain|cordon` (not with --dry-run), `kubectl apply --prune`, `helm uninstall|
//      delete`, `aws … delete-*|terminate-*|deregister-*|disable-*|update-service|update-function-code|
//      put-parameter|put-secret-value|create-secret|update-secret|delete-secret`, `gcloud … delete`,
//      `az … delete`, `fly|flyctl deploy|destroy`, `vercel --prod`, `wrangler publish|deploy`.
//   8. secret writes: `gh secret set`, `vault kv put|delete`, `op item create|edit` (the aws
//      secretsmanager / ssm shapes are already caught by rule 7).
//   9. publishing: `npm|pnpm|yarn publish`, `yarn npm publish`, `cargo publish`, `twine upload`,
//      `gem push`, `docker push`, `git push --tags`.
//  10. host destruction: `mkfs*`, `dd … of=/dev/…`, `> /dev/sd*`, `chmod -R 777 /|~`, `chown -R … /`,
//      the fork bomb, `crontab -r`, `shutdown|reboot|halt|poweroff`, `kill -9 -1`, `killall -9`,
//      `pkill -9 -f .`.
//
// Config (operator settings, never the session):
//   FENCE_PROTECTED_BRANCHES  comma list, default "main,master".
//   FENCE_EXTRA               regex source matched against the NORMALISED text; an invalid regex is
//                             ignored and recorded as a fire of kind "config-error" so it is measurable.
//   FENCE_ALLOW               regex source matched against the ORIGINAL command; on a match the fence
//                             stands down and records a fire of kind "exempted".
//
// FAIL-OPEN on the hook's own bugs (parse error → allow, exit 0). FAIL-CLOSED on input it cannot scan
// (over MAX_EVENT_BYTES → deny, naming the size). One stdout write, then a natural exit.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("fence-guard.mjs");

export const MAX_EVENT_BYTES = 64 * 1024;
export const DEFAULT_PROTECTED = "main,master";

/** Placeholder for a quoted run that never executes. Chosen so no rule can match inside it. */
const Q = "_q_";
/** Recursion cap for `$(…)`, backticks and `sh -c` bodies. Beyond it the inner text is dropped. */
const MAX_DEPTH = 6;

// ── NORMALISER ───────────────────────────────────────────────────────────────────────────────────────

/** Index just past the `)` that closes a `$(` opened at s[open] === "(". Quote-aware; -1 if unclosed. */
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      if (e === -1) return -1;
      i = e;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Index of the next unescaped backtick after `from`, or -1. */
function closeBacktick(s, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "`") return i;
  }
  return -1;
}

/**
 * Lex `s` into statements of tokens `{ t, raw }` — `t` is the normalised word, `raw` the original text
 * of the word with quotes removed (used ONLY by the rm target check, the SQL second pass, and the
 * `sh -c` recursion). Substitution spans become statements of their own via `extra`.
 *
 * ONE left-to-right pass; every inner scan (`closeParen`, heredoc terminator search) advances `i` past
 * what it consumed, so nothing is re-walked from more than a bounded number of start positions.
 *
 * @param {string} s
 * @param {number} depth
 * @returns {{t:string, raw:string}[][]}
 */
export function lex(s, depth = 0) {
  const n = s.length;
  const stmts = [];
  const extra = [];
  let cur = [];
  let word = "";
  let raw = "";
  const sub = (inner) => {
    if (depth < MAX_DEPTH) extra.push(...lex(inner, depth + 1));
  };
  const endWord = () => {
    if (word !== "") cur.push({ t: word, raw });
    word = "";
    raw = "";
  };
  const endStmt = () => {
    endWord();
    if (cur.length) stmts.push(cur);
    cur = [];
  };
  /** @type {{tag:string, quoted:boolean, dash:boolean}[]} */
  let pending = [];

  /** Look for a heredoc terminator line at or after `from`; returns index past its newline, or -1. */
  const findTerminator = (from, tag, dash) => {
    let p = from;
    while (p <= n) {
      let e = s.indexOf("\n", p);
      if (e === -1) e = n;
      let line = s.slice(p, e);
      if (dash) line = line.replace(/^\t+/, "");
      if (line === tag) return e + 1;
      if (e >= n) return -1;
      p = e + 1;
    }
    return -1;
  };

  let i = 0;
  while (i < n) {
    const ch = s[i];

    if (ch === "\\") {
      const nx = s[i + 1];
      if (nx === undefined) {
        i++;
        continue;
      }
      if (nx === "\n") {
        // line continuation: the word may continue on the next line, but bash treats it as a join
        // only when there is no whitespace; a space after is a word break as usual.
        i += 2;
        continue;
      }
      if (nx === " " || nx === "\t") {
        word += "_"; // `pulumi\ up` is one word
        raw += nx;
      } else {
        word += nx; // `p\ulumi` is `pulumi`; `\$` is a literal `$` that opens no substitution
        raw += nx;
      }
      i += 2;
      continue;
    }

    if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      const end = e === -1 ? n : e;
      raw += s.slice(i + 1, end);
      word += Q;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$" && s[j + 1] === "(") {
          const c = closeParen(s, j + 1);
          const end = c === -1 ? n : c;
          sub(s.slice(j + 2, c === -1 ? n : c - 1));
          j = end;
          continue;
        }
        if (s[j] === "`") {
          const c = closeBacktick(s, j + 1);
          sub(s.slice(j + 1, c === -1 ? n : c));
          j = c === -1 ? n : c + 1;
          continue;
        }
        j++;
      }
      raw += s.slice(i + 1, Math.min(j, n));
      word += Q;
      i = Math.min(j + 1, n);
      continue;
    }

    if (ch === "`") {
      const c = closeBacktick(s, i + 1);
      sub(s.slice(i + 1, c === -1 ? n : c));
      raw += s.slice(i, c === -1 ? n : c + 1);
      i = c === -1 ? n : c + 1;
      continue;
    }

    if (ch === "$") {
      if (s[i + 1] === "(" && s[i + 2] === "(") {
        // arithmetic — find the closing `))` and drop it
        const c = closeParen(s, i + 1);
        word += "0";
        raw += s.slice(i, c === -1 ? n : c);
        i = c === -1 ? n : c;
        continue;
      }
      if (s[i + 1] === "(") {
        const c = closeParen(s, i + 1);
        sub(s.slice(i + 2, c === -1 ? n : c - 1));
        raw += s.slice(i, c === -1 ? n : c);
        i = c === -1 ? n : c;
        continue;
      }
      if (s[i + 1] === "{") {
        const e = s.indexOf("}", i + 2);
        const end = e === -1 ? n : e + 1;
        word += s.slice(i, end);
        raw += s.slice(i, end);
        i = end;
        continue;
      }
      word += ch;
      raw += ch;
      i++;
      continue;
    }

    if (ch === "#" && word === "") {
      let e = s.indexOf("\n", i);
      if (e === -1) e = n;
      i = e;
      continue;
    }

    if (ch === "\n") {
      endStmt();
      i++;
      if (pending.length) {
        for (const h of pending) {
          const after = findTerminator(i, h.tag, h.dash);
          if (after === -1) break; // unterminated: the body is scanned as ordinary text
          if (!h.quoted) {
            const body = s.slice(i, after);
            for (let k = 0; k < body.length; k++) {
              if (body[k] === "\\") {
                k++;
                continue;
              }
              if (body[k] === "$" && body[k + 1] === "(") {
                const c = closeParen(body, k + 1);
                sub(body.slice(k + 2, c === -1 ? body.length : c - 1));
                k = c === -1 ? body.length : c - 1;
              } else if (body[k] === "`") {
                const c = closeBacktick(body, k + 1);
                sub(body.slice(k + 1, c === -1 ? body.length : c));
                k = c === -1 ? body.length : c;
              }
            }
          }
          i = after;
        }
        pending = [];
      }
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
      let quoted = false;
      if (s[j] === "'" || s[j] === '"') {
        const qc = s[j];
        const e = s.indexOf(qc, j + 1);
        tag = s.slice(j + 1, e === -1 ? n : e);
        quoted = true;
        j = e === -1 ? n : e + 1;
      } else if (s[j] === "\\") {
        quoted = true;
        j++;
        const m = /^[^\s;|&<>]+/.exec(s.slice(j));
        tag = m ? m[0] : "";
        j += tag.length;
      } else {
        const m = /^[^\s;|&<>]+/.exec(s.slice(j));
        tag = m ? m[0] : "";
        j += tag.length;
      }
      endWord();
      if (tag) {
        const eol = s.indexOf("\n", j);
        if (eol !== -1 && findTerminator(eol + 1, tag, dash) !== -1)
          pending.push({ tag, quoted, dash });
        // else: unterminated → nothing registered, the body is ordinary text and can fire
      }
      i = j;
      continue;
    }

    if (ch === ";" || ch === "(" || ch === ")") {
      endStmt();
      i++;
      continue;
    }
    if ((ch === "{" || ch === "}") && word === "") {
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
        word += ch; // `&>f`, `2>&1` — redirects, not separators
        raw += ch;
        i++;
        continue;
      }
      endStmt();
      i++;
      continue;
    }
    if (ch === "|") {
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
    raw += ch;
    i++;
  }
  endStmt();
  return stmts.concat(extra);
}

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "env",
  "time",
  "nice",
  "ionice",
  "nohup",
  "exec",
  "xargs",
  "timeout",
  "stdbuf",
  "!",
]);
/** Wrapper flags that take a separate value (`sudo -u root`, `nice -n 10`, `xargs -n 1`). */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-n", "-g", "-C", "-S", "-P", "-I", "-L", "-c", "-d", "-o", "-e", "-i"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function base(t) {
  const b = t.split("/").pop() ?? "";
  return b;
}

/**
 * Strip statement-leading wrappers; return the surviving tokens, or `{ recurse }` with the shell text a
 * `sh -c` / `eval` would execute.
 */
function unwrap(tokens) {
  let toks = tokens.slice();
  for (let k = 0; k < 16 && toks.length; k++) {
    const t0 = toks[0].t;
    if (ASSIGN_RE.test(t0)) {
      toks.shift();
      continue;
    }
    const w = base(t0).toLowerCase();
    if (WRAPPERS.has(w)) {
      toks.shift();
      if (w === "timeout" && toks.length && !toks[0].t.startsWith("-")) toks.shift();
      while (toks.length && toks[0].t.startsWith("-")) {
        const f = toks.shift().t;
        if (WRAPPER_VALUE_FLAGS.has(f) && toks.length) toks.shift();
        if (w === "timeout" && toks.length && !toks[0].t.startsWith("-")) toks.shift();
      }
      continue;
    }
    if (SHELLS.has(w)) {
      let hasC = false;
      let j = 1;
      for (; j < toks.length && toks[j].t.startsWith("-"); j++)
        if (/^-[A-Za-z]*c/.test(toks[j].t) || toks[j].t === "--command") hasC = true;
      if (hasC && j < toks.length) return { recurse: toks[j].raw };
      return toks;
    }
    if (w === "eval") return { recurse: toks.slice(1).map((x) => x.raw).join(" ") };
    break;
  }
  return toks;
}

/**
 * Normalise a command into statements: each a token list with wrappers stripped, command words
 * lower-cased, short flag clusters case-preserved.
 * @param {string} cmd
 * @param {number} [depth]
 * @returns {{t:string, raw:string}[][]}
 */
export function normalise(cmd, depth = 0) {
  const out = [];
  for (const stmt of lex(cmd, depth)) {
    const lowered = stmt.map((x) => ({
      t: /^-[A-Za-z]+$/.test(x.t) ? x.t : x.t.toLowerCase(),
      raw: x.raw,
    }));
    const u = unwrap(lowered);
    if (Array.isArray(u)) {
      if (u.length) out.push(u);
    } else if (depth < MAX_DEPTH && u.recurse) {
      out.push(...normalise(u.recurse, depth + 1));
    }
  }
  return out;
}

/** The normalised text, statements joined with ` ; ` — what FENCE_EXTRA is matched against. */
export function normalisedText(cmd) {
  return normalise(cmd)
    .map((s) => s.map((x) => x.t).join(" "))
    .join(" ; ");
}

// ── RULES ────────────────────────────────────────────────────────────────────────────────────────────

const isFlag = (t) => t.startsWith("-") && t !== "-";
const nonFlags = (toks) => toks.filter((x) => !isFlag(x.t)).map((x) => x.t);
const hasFlag = (toks, ...names) => toks.some((x) => names.includes(x.t));
/** Every letter in every short cluster (`-fdx`, `-r -f`). Case preserved. */
const shortLetters = (toks) =>
  toks
    .filter((x) => /^-[A-Za-z]+$/.test(x.t))
    .map((x) => x.t.slice(1))
    .join("");

/** After `git`, skip global options and return { verb, args }. */
function gitVerb(toks) {
  const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k].t;
    if (!isFlag(t)) return { verb: t, args: toks.slice(k + 1) };
    if (GIT_VALUE.has(t)) k++;
  }
  return { verb: "", args: [] };
}

function ruleGitPush(args, protectedSet) {
  const PUSH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo", "--recurse-submodules"]);
  if (hasFlag(args, "--dry-run", "-n")) return null; // a dry run mutates nothing — allowed and pinned
  const refspecs = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].t;
    if (isFlag(t)) {
      if (PUSH_VALUE.has(t)) k++;
      continue;
    }
    refspecs.push(t);
  }
  const forceFlags = ["--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune"];
  const forced =
    args.some((x) => forceFlags.includes(x.t) || x.t.startsWith("--force-with-lease=")) ||
    /[fd]/.test(shortLetters(args)) ||
    refspecs.slice(1).some((r) => r.startsWith("+") || r.startsWith(":"));
  if (forced) return { kind: "git-push-force", why: "`git push` with a force, delete, mirror or prune flag rewrites or removes remote history" };
  if (hasFlag(args, "--tags")) return { kind: "publish", why: "`git push --tags` publishes tags, which are public and not un-publishable" };
  if (hasFlag(args, "--all")) return { kind: "git-push-protected", why: "`git push --all` pushes every branch, including the protected ones" };
  for (const r of refspecs.slice(1)) {
    const dst = (r.includes(":") ? r.slice(r.indexOf(":") + 1) : r).replace(/^refs\/heads\//, "");
    if (protectedSet.has(dst)) return { kind: "git-push-protected", why: `\`git push\` targets the protected branch \`${dst}\`` };
  }
  return null;
}

function ruleGit(toks, protectedSet) {
  const { verb, args } = gitVerb(toks);
  if (verb === "push") return ruleGitPush(args, protectedSet);
  if (verb === "branch") {
    const letters = shortLetters(args);
    if (letters.includes("D") || ((letters.includes("d") || hasFlag(args, "--delete")) && (letters.includes("f") || hasFlag(args, "--force"))))
      return { kind: "history-destruction", why: "`git branch -D` deletes a branch regardless of merge state" };
  }
  if (verb === "reset" && hasFlag(args, "--hard")) {
    const ref = nonFlags(args).find((t) => /^(?:refs\/remotes\/|remotes\/|origin\/|upstream\/)/.test(t));
    if (ref) return { kind: "history-destruction", why: `\`git reset --hard ${ref}\` discards local commits against a remote ref` };
  }
  if (verb === "clean") {
    const letters = shortLetters(args);
    if ((letters.includes("f") || hasFlag(args, "--force")) && letters.includes("x"))
      return { kind: "history-destruction", why: "`git clean` with -f and -x removes ignored files (env files, local config) too" };
  }
  if (verb === "filter-branch" || verb === "filter-repo")
    return { kind: "history-destruction", why: `\`git ${verb}\` rewrites the whole history` };
  if (verb === "reflog" && nonFlags(args)[0] === "expire")
    return { kind: "history-destruction", why: "`git reflog expire` removes the safety net for recovering lost commits" };
  if (verb === "gc" && args.some((x) => /^--prune=now/.test(x.t)))
    return { kind: "history-destruction", why: "`git gc --prune=now` deletes unreachable objects immediately" };
  if (verb === "update-ref" && shortLetters(args).includes("d"))
    return { kind: "history-destruction", why: "`git update-ref -d` deletes a ref" };
  return null;
}

function ruleRm(toks) {
  const letters = shortLetters(toks);
  const recursive = letters.includes("r") || letters.includes("R") || hasFlag(toks, "--recursive");
  const force = letters.includes("f") || hasFlag(toks, "--force");
  if (!(recursive && force)) return null;
  for (const x of toks.slice(1)) {
    if (isFlag(x.t)) continue;
    // Trailing slashes are dropped (`$DIR/` is the bare variable, `./` is `.`), except for `/` itself.
    let t = x.raw.toLowerCase();
    t = /^\/+$/.test(t) ? "/" : t.replace(/\/+$/, "");
    if (t === "") t = "/";
    if (["/", "~", "$home", "${home}", ".", "..", "*", "/*", "./*", "~/*"].includes(t))
      return { kind: "rm-root", why: `\`rm -rf ${x.raw}\` targets a root` };
    if (/^\$[a-z_][a-z0-9_]*$/.test(t) || /^\$\{[^}]*\}$/.test(t))
      return { kind: "rm-root", why: `\`rm -rf ${x.raw}\` has a bare variable target — an empty variable is \`/\`` };
    if (/^\/[^/]+(?:\/[^/]+)?$/.test(t) && !/^\/(?:tmp|var\/tmp|dev\/shm)\/[^/]+$/.test(t))
      return { kind: "rm-root", why: `\`rm -rf ${x.raw}\` targets an absolute path of two segments or fewer` };
  }
  return null;
}

const SQL_RULES = [
  [/^\s*drop\s+(?:table|database|schema|index)\b/i, "DROP"],
  [/^\s*truncate\b/i, "TRUNCATE"],
  [/^\s*delete\s+from\s+\S+(?![\s\S]*\bwhere\b)/i, "DELETE FROM without WHERE"],
  [/^\s*alter\s+table\b[\s\S]*\bdrop\s+column\b/i, "ALTER TABLE … DROP COLUMN"],
  [/\.(?:drop|dropdatabase|dropcollection)\(\s*\)|\.deletemany\(\s*\{\s*\}\s*\)/i, "a collection drop / unfiltered deleteMany"],
];
function sqlHit(text) {
  for (const stmt of String(text).split(";")) {
    for (const [re, label] of SQL_RULES) if (re.test(stmt)) return label;
  }
  return null;
}
const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo"]);
const SQL_ARG_FLAGS = new Set(["-c", "--command", "-e", "--execute", "--eval"]);

function ruleSql(toks, stmtText) {
  const hit = sqlHit(stmtText);
  if (hit) return { kind: "destructive-sql", why: `destructive SQL (${hit}) as a statement` };
  const cmd = base(toks[0].t);
  if (!SQL_CLIENTS.has(cmd)) return null;
  // Second pass: the ORIGINAL text of the client's command argument (quoted text is otherwise opaque).
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k].t;
    let sqlText = null;
    if (SQL_ARG_FLAGS.has(t) && toks[k + 1]) sqlText = toks[k + 1].raw;
    else {
      const m = /^(?:--command|--execute|--eval)=/.exec(toks[k].raw);
      if (m) sqlText = toks[k].raw.slice(m[0].length);
      else if (cmd === "sqlite3" && !isFlag(t) && t === Q) sqlText = toks[k].raw; // positional SQL
    }
    if (sqlText === null) continue;
    const h = sqlHit(sqlText);
    if (h) return { kind: "destructive-sql", why: `destructive SQL (${h}) passed to ${cmd}` };
  }
  return null;
}

const AWS_VALUE_FLAGS = new Set(["--profile", "--region", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout"]);
function ruleInfra(toks) {
  const cmd = base(toks[0].t);
  const rest = toks.slice(1);
  const nf = nonFlags(rest);
  const infra = (why) => ({ kind: "infra-mutation", why });
  if (cmd === "pulumi") {
    // `--stack x` / `-s x` / `--cwd x` / `-C x` sit between `pulumi` and its verb; they are flags.
    const PULUMI_VALUE = new Set(["--stack", "-s", "--cwd", "-C", "--color", "--profiling"]);
    let verb = "";
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k].t;
      if (isFlag(t)) {
        if (PULUMI_VALUE.has(t)) k++;
        continue;
      }
      verb = t;
      break;
    }
    if (["up", "destroy", "refresh", "import", "cancel"].includes(verb)) return infra(`\`pulumi ${verb}\` mutates live infrastructure`);
  }
  if (cmd === "terraform" || cmd === "tofu") {
    const verb = nf[0];
    if (verb === "apply" || verb === "destroy") return infra(`\`${cmd} ${verb}\` mutates live infrastructure`);
  }
  if (cmd === "kubectl" || cmd === "oc") {
    if (rest.some((x) => x.t.startsWith("--dry-run"))) return null;
    const verb = nf[0];
    if (["delete", "drain", "cordon"].includes(verb)) return infra(`\`kubectl ${verb}\` removes or evicts live workloads`);
    if (verb === "apply" && hasFlag(rest, "--prune")) return infra("`kubectl apply --prune` deletes resources not in the manifest");
  }
  if (cmd === "helm") {
    const verb = nf[0];
    if (["uninstall", "delete", "del"].includes(verb)) return infra(`\`helm ${verb}\` removes a live release`);
  }
  if (cmd === "aws") {
    const words = [];
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k].t;
      if (isFlag(t)) {
        if (AWS_VALUE_FLAGS.has(t)) k++;
        continue;
      }
      words.push(t);
    }
    const [service, op] = words;
    if (op && (/^(?:delete-|terminate-|deregister-|disable-)/.test(op) || ["update-service", "update-function-code", "put-parameter", "put-secret-value", "create-secret", "update-secret", "delete-secret"].includes(op)))
      return infra(`\`aws ${service} ${op}\` mutates a live AWS resource`);
  }
  if ((cmd === "gcloud" || cmd === "az") && nf.includes("delete")) return infra(`\`${cmd} … delete\` removes a live cloud resource`);
  if (cmd === "fly" || cmd === "flyctl") {
    const verb = nf[0];
    if (verb === "deploy" || verb === "destroy") return infra(`\`${cmd} ${verb}\` changes what is live`);
  }
  if (cmd === "vercel" && hasFlag(rest, "--prod")) return infra("`vercel --prod` deploys to production");
  if (cmd === "wrangler") {
    const verb = nf[0];
    if (verb === "publish" || verb === "deploy") return infra(`\`wrangler ${verb}\` deploys to the edge`);
  }
  return null;
}

function ruleSecrets(toks) {
  const cmd = base(toks[0].t);
  const nf = nonFlags(toks.slice(1));
  const sec = (why) => ({ kind: "secret-write", why });
  if (cmd === "gh" && nf[0] === "secret" && nf[1] === "set") return sec("`gh secret set` writes a repository secret");
  if (cmd === "vault" && nf[0] === "kv" && (nf[1] === "put" || nf[1] === "delete")) return sec(`\`vault kv ${nf[1]}\` changes a stored secret`);
  if (cmd === "op" && nf[0] === "item" && (nf[1] === "create" || nf[1] === "edit")) return sec(`\`op item ${nf[1]}\` writes to the vault`);
  return null;
}

function rulePublish(toks) {
  const cmd = base(toks[0].t);
  const nf = nonFlags(toks.slice(1));
  const pub = (what) => ({ kind: "publish", why: `\`${what}\` publishes to a registry other people pull from` });
  if ((cmd === "npm" || cmd === "pnpm") && nf[0] === "publish") return pub(`${cmd} publish`);
  if (cmd === "yarn" && (nf[0] === "publish" || (nf[0] === "npm" && nf[1] === "publish"))) return pub("yarn publish");
  if (cmd === "cargo" && nf[0] === "publish") return pub("cargo publish");
  if (cmd === "twine" && nf[0] === "upload") return pub("twine upload");
  if (cmd === "gem" && nf[0] === "push") return pub("gem push");
  if (cmd === "docker" && (nf[0] === "push" || (nf[0] === "image" && nf[1] === "push"))) return pub("docker push");
  return null;
}

const FORK_BOMB = /(?:^|[\s;])(:|\w+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?=\s|;|$)/;
function ruleHost(toks, stmtText) {
  const cmd = base(toks[0].t);
  const rest = toks.slice(1);
  const nf = nonFlags(rest);
  const host = (why) => ({ kind: "host-destruction", why });
  if (/^mkfs(?:\.\w+)?$/.test(cmd)) return host("`mkfs` formats a filesystem");
  if (cmd === "dd" && rest.some((x) => /^of=\/dev\//.test(x.t))) return host("`dd … of=/dev/…` overwrites a device");
  if (/(?:^|\s)\d?>{1,2}\s*\/dev\/(?:sd|nvme|hd|vd|xvd|mmcblk|disk)/.test(stmtText)) return host("a redirect onto a block device overwrites it");
  if (cmd === "chmod" && /R/.test(shortLetters(rest)) && nf.includes("777") && nf.some((t) => ["/", "~", "$home"].includes(t)))
    return host("`chmod -R 777` on a root opens every file on the host");
  if (cmd === "chown" && /R/.test(shortLetters(rest)) && nf.includes("/")) return host("`chown -R … /` re-owns the whole host");
  if (["shutdown", "reboot", "halt", "poweroff"].includes(cmd)) return host(`\`${cmd}\` takes the host down`);
  if (cmd === "crontab" && shortLetters(rest).includes("r")) return host("`crontab -r` deletes every scheduled job without confirmation");
  if (cmd === "kill" && rest.some((x) => x.t === "-9" || x.t === "-KILL" || x.t === "-SIGKILL") && rest.some((x) => x.t === "-1"))
    return host("`kill -9 -1` kills every process the user owns");
  if (cmd === "killall" && rest.some((x) => x.t === "-9" || x.t === "-KILL" || x.t === "-SIGKILL")) return host("`killall -9` kills by name without cleanup");
  if (cmd === "pkill" && rest.some((x) => x.t === "-9" || x.t === "-KILL") && shortLetters(rest).includes("f") && nf.some((t) => t === "." || t === ".*"))
    return host("`pkill -9 -f .` matches every process");
  return null;
}

/**
 * Apply the rule table to one normalised statement. First match wins.
 * @returns {{kind:string, why:string}|null}
 */
function matchStatement(toks, protectedSet) {
  const cmd = base(toks[0].t);
  const stmtText = toks.map((x) => x.t).join(" ");
  const nf = nonFlags(toks.slice(1));
  // 1, 2 (and the git half of 4 and 9)
  if (cmd === "git") {
    const g = ruleGit(toks, protectedSet);
    if (g) return g;
  }
  // 3
  if ((cmd === "gh" && nf[0] === "pr" && nf[1] === "merge") || (cmd === "glab" && nf[0] === "mr" && nf[1] === "merge"))
    return { kind: "forge-merge", why: `\`${cmd} ${nf[0]} merge\` lands a change into the shared branch` };
  // 5
  if (cmd === "rm") {
    const r = ruleRm(toks);
    if (r) return r;
  }
  // 6
  const s = ruleSql(toks, stmtText);
  if (s) return s;
  // 7
  const i = ruleInfra(toks);
  if (i) return i;
  // 8
  const se = ruleSecrets(toks);
  if (se) return se;
  // 9
  const p = rulePublish(toks);
  if (p) return p;
  // 10
  const h = ruleHost(toks, stmtText);
  if (h) return h;
  return null;
}

/**
 * Pure decision.
 * @param {string} command
 * @param {{env?: Record<string,string|undefined>}} [opts]
 * @returns {{fire:boolean, why?:string, kind?:string, configError?:string}}
 */
export function decide(command, opts = {}) {
  const env = opts.env ?? process.env;
  const cmd = String(command ?? "");
  const result = { fire: false };
  if (!cmd.trim()) return result;

  const protectedSet = new Set(
    String(env.FENCE_PROTECTED_BRANCHES || DEFAULT_PROTECTED)
      .split(",")
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean),
  );

  let hit = null;
  if (FORK_BOMB.test(cmd)) hit = { kind: "host-destruction", why: "a fork bomb exhausts the process table" };
  const stmts = normalise(cmd);
  for (const toks of stmts) {
    if (hit) break;
    hit = matchStatement(toks, protectedSet);
  }
  if (!hit && env.FENCE_EXTRA) {
    let re = null;
    try {
      re = new RegExp(env.FENCE_EXTRA, "i");
    } catch {
      result.configError = "FENCE_EXTRA is not a valid regular expression and was ignored";
    }
    if (re) {
      const text = stmts.map((s) => s.map((x) => x.t).join(" ")).join(" ; ");
      if (re.test(text)) hit = { kind: "extra", why: "matches the operator's FENCE_EXTRA pattern" };
    }
  }
  if (!hit) return result;

  if (env.FENCE_ALLOW) {
    try {
      if (new RegExp(env.FENCE_ALLOW).test(cmd)) return { ...result, kind: "exempted", why: hit.why };
    } catch {
      result.configError = (result.configError ? result.configError + "; " : "") + "FENCE_ALLOW is not a valid regular expression and was ignored";
    }
  }
  return { ...result, fire: true, kind: hit.kind, why: hit.why };
}

function deny(reason, kind) {
  recordFire("fence-guard.mjs", "deny", kind);
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
    // NO CLAUDE_HOOKS_QUIET check here, on purpose — see the header.
    const input = readFileSync(0);
    if (input.length > MAX_EVENT_BYTES) {
      deny(
        `fence-guard: the hook payload is ${input.length} bytes, over the ${MAX_EVENT_BYTES}-byte cap, ` +
          `so the command was NOT scanned. A fence that cannot see the command refuses it rather than ` +
          `waving it through. Write the large content to a file and run a short command against it.`,
        "oversize",
      );
      return;
    }
    const ev = JSON.parse(input.toString("utf8"));
    if (ev.tool_name !== "Bash") return;
    const r = decide((ev.tool_input && ev.tool_input.command) || "");
    if (r.configError) recordFire("fence-guard.mjs", "warn", "config-error");
    if (r.kind === "exempted") {
      recordFire("fence-guard.mjs", "allow", "exempted");
      return;
    }
    if (!r.fire) return;
    deny(
      `FENCE (a human presses this): ${r.why}. Print the exact command for the operator to run in ` +
        `their own terminal, then stop. Nothing settable inside a session lifts this fence.`,
      r.kind,
    );
  } catch {
    /* fail-open */
  }
  // Exit NATURALLY so stdout drains; process.exit() can truncate the deny payload into an allow.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
