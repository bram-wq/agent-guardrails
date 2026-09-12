#!/usr/bin/env node
// PreToolUse prose-guard (fail-open). REFUSES to run a "command" whose first word is not a real command.
//
// THE INCIDENT CLASS (three times in one session). English intended for the assistant reached the shell
// instead:
//   "notify the reviewer, that they should be unblocked now, and what to do"  -> notify: command not found
//   "- Reviewer round 6 (notes.md) - unsent. It tells them..."                 -> eval: - : invalid option
//   "yes for sure"                                                             -> `yes` ran until it filled the disk
//
// The first two were harmless noise. The third was not, because `yes` IS a real command — which is why
// this guard and runaway-guard are SEPARATE and both needed. This one asks "is the first word a program
// at all?"; runaway-guard asks "does this program ever stop?".
//
// THE TEST IS DETERMINISTIC, NOT A VIBE. Resolve the first token against PATH and the shell builtins. If
// it does not resolve, this is not a command — it is a sentence — so refuse and say so. No guessing about
// grammar, no word lists, no false confidence about what "looks like English".
//
// Deliberately NOT blocked, because each is a real invocation shape:
//   VAR=1 cmd …      leading assignments are skipped to find the verb
//   ./x.sh, /usr/bin/x, ../x, ~/x, $HOME/x   paths are checked on disk, relative to the EVENT's cwd
//   ( subshell, { group, if/for/while/case  shell grammar
//   npm run …, git …  ordinary programs resolve on PATH
//   # a comment       runs nothing; a leading comment line is skipped, the first statement is judged
//   2>/dev/null cmd, >out cmd   leading redirects are skipped
//   \ls              the alias escape is stripped
//
// Looked THROUGH, because each hands the rest of the line to the shell unchanged, so the incident
// shapes would otherwise pass behind them: `time`, `sudo`, `exec`, `command`, `env`, `eval`,
// `builtin`, `nohup`, and the grouping openers `(`, `{`, `!`. `time notify the reviewer` is judged
// on `notify`.
//
// WHAT THIS GUARD CANNOT SEE, BY DESIGN. The test is "does the first word resolve", and some English
// verbs ARE programs: `touch base with them` resolved, ran, and created three files named `base`,
// `with` and `them`; `make the reviewer aware` and `find the bug` pass the same way. Bash keywords
// used as English openers pass too — `done with the fix`, `let me know`, `wait for CI`, `read the
// file` — because `done`, `let`, `wait` and `read` are builtins, and refusing them refuses every
// real script that uses them. Closing that gap would mean guessing at grammar, which is exactly the
// false confidence the header above rules out; runaway-guard covers the one member of that class
// that costs something (`yes`). Those shapes are pinned as MUST-NOT-FIRE cases in the test so the
// limit stays documented rather than quietly "fixed" into a word list.
//
// FAIL-OPEN in the strongest sense: if PATH cannot be read, if `which` misbehaves, if anything throws —
// exit 0 and ALLOW. A guard that wrongly blocks a real command is worse than the noise it prevents.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { recordFire, recordInvocation } from "./_fire-log.mjs";

recordInvocation("prose-guard.mjs");

// POSIX + bash builtins and grammar keywords. A first token here is always legitimate.
const BUILTINS = new Set([
  "cd",
  "echo",
  "printf",
  "export",
  "set",
  "unset",
  "source",
  ".",
  "eval",
  "exec",
  "test",
  "[",
  "[[",
  "true",
  "false",
  "read",
  "shift",
  "return",
  "exit",
  "trap",
  "wait",
  "jobs",
  "kill",
  "umask",
  "alias",
  "unalias",
  "type",
  "command",
  "builtin",
  "local",
  "declare",
  "typeset",
  "readonly",
  "let",
  "pushd",
  "popd",
  "dirs",
  "hash",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "time",
  "coproc",
  "{",
  "(",
  "!",
]);

// Words the shell hands the rest of the line to, unchanged. The verb is the NEXT word.
const TRANSPARENT = new Set([
  "time",
  "sudo",
  "exec",
  "command",
  "env",
  "eval",
  "builtin",
  "nohup",
]);
// Options of those prefixes that consume the following token (`sudo -u bob cmd`, `env -u VAR cmd`).
// Only options that ALWAYS take one (`time -p` and `sudo -p prompt` disagree, so `-p` is not here).
const PREFIX_OPT_WITH_ARG = /^-(?:u|g|C|D|R|r|t|T|U)$/;

// Expand what the shell would expand in a PATH-LIKE token before it is checked on disk. Quotes and
// backslash-escapes are removed; `~` and `$HOME`/`${HOME}` come from the environment. Any other
// `$VAR` is left alone — the caller treats a token that still holds one as "cannot tell".
function expandPath(tok) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let p = tok.replace(/["']/g, "").replace(/\\(.)/g, "$1");
  if (home) {
    p = p.replace(/^~(?=\/|$)/, home).replace(/^\$(?:HOME\b|\{HOME\})/, home);
  }
  return p;
}

function resolves(tok, cwd) {
  if (!tok) return true; // nothing to judge -> allow
  if (BUILTINS.has(tok)) return true;
  if (/[=(){}]/.test(tok)) return true; // assignment or grammar
  // A path is checked on disk rather than on PATH.
  if (tok.includes("/") || tok.startsWith("~")) {
    const p = expandPath(tok);
    // `$OTHER/x` or `~user/x` — an expansion only the shell can do. Cannot tell -> allow.
    // ⚠ TILDE ONLY AT THE START. Bash expands `~` at the beginning of a word (and after `=`/`:` in
    // assignments, which never reach here as a verb); a `~` anywhere else is a literal character.
    // The first version tested `/[$~]/` and waved through EVERY path containing a tilde — on a
    // Windows runner the home directory spells as `RUNNER~1`, so a non-existent file under it was
    // judged "cannot tell" and allowed, which is the guard's whole failure mode wearing a short name.
    if (/\$/.test(p) || p.startsWith("~")) return true;
    // On Windows the Bash tool runs Git Bash, whose MSYS root maps /bin, /usr/bin and /dev onto
    // places Node's fs cannot see — `existsSync("/bin/echo")` is false while `/bin/echo hello` runs
    // fine. Node cannot tell here, and the header's own rule for that case is ALLOW.
    if (process.platform === "win32" && p.startsWith("/")) return true;
    try {
      // A relative path is relative to where the COMMAND runs — the event's cwd — not to where the
      // hook process happens to start. `node_modules/.bin/vitest run` from a package directory was
      // denied because the hook looked for it from the repo root.
      const full = resolve(cwd, p);
      return existsSync(full) && statSync(full).isFile();
    } catch {
      return true; // cannot tell -> allow
    }
  }
  // `:` is the POSIX separator. On Windows PATH is separated by `;` AND every entry contains a drive
  // colon, so splitting on `:` shredded each entry into fragments that resolve to nothing — the guard
  // then denied `git`, `npm`, `bash`, every real program it exists to let through. Nearly every red
  // case in this hook's first Windows run was that one line.
  const path = (process.env.PATH || "").split(delimiter).filter(Boolean);
  if (path.length === 0) return true; // no PATH to check against -> allow
  // Windows programs carry an extension: PATH holds `git.exe`/`npm.cmd`, never a bare `git`. Probing
  // the bare name alone is a second way to answer "not a program" about a program.
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [];
  // The command will be run by GIT BASH, not by cmd.exe — and Git Bash's /usr/bin (grep, sed, awk, ssh,
  // …) is deliberately kept OFF the Windows PATH. Judging `grep` against the Windows PATH alone answers
  // "not a program" about a program that is about to run. Derive that directory from whichever Git entry
  // IS on PATH rather than hardcoding an install location.
  const dirs = [...path];
  if (process.platform === "win32") {
    for (const dir of path) {
      const m = dir.match(
        /^(.*[\\/]Git)[\\/](?:cmd|bin|mingw(?:32|64)[\\/]bin)[\\/]?$/i,
      );
      if (m) dirs.push(join(m[1], "usr", "bin"));
    }
  }
  for (const dir of dirs) {
    try {
      if (existsSync(join(dir, tok))) return true;
      for (const ext of exts) if (existsSync(join(dir, tok + ext))) return true;
    } catch {}
  }
  return false;
}

// Two escape hatches, both measurable (an exemption records a fire of kind "exempted"):
//   PROSE_GUARD_ALLOW  a regex source; a first verb matching it is allowed even when it does not resolve.
//                      Shell FUNCTIONS and ALIASES from the user's profile run fine in the Bash tool but are
//                      not programs, builtins, or files, so the hook cannot see them — this is how you name
//                      them (`PROSE_GUARD_ALLOW='^(mkcd|deploy-preview)$'`).
//   CLAUDE_HOOKS_QUIET=1  lifts the guard for a heads-down session, as piped-verdict-guard already does.
// Without an escape hatch a guard that misfires once is switched off for good, which is worse.
export const MAX_EVENT_BYTES = 64 * 1024;
function main() {
  const input = readFileSync(0, "utf8");
  if (input.length > MAX_EVENT_BYTES) {
    // fail CLOSED on what it cannot scan: a payload this size is not a sentence that reached the shell,
    // but a guard that silently allows whatever is too big to read is a guard with a size-shaped hole.
    recordFire("prose-guard.mjs", "deny", "oversize-event");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `prose-guard: the hook payload is ${input.length} bytes, above the ${MAX_EVENT_BYTES}-byte ` +
            `scan limit. Split the command or write it to a script file and run that.`,
        },
      }),
    );
    return;
  }
  const ev = JSON.parse(input);
  if (ev.tool_name !== "Bash") return;
  if (process.env.CLAUDE_HOOKS_QUIET === "1") return;
  const raw = ev.tool_input && ev.tool_input.command;
  // A non-string `command` is a malformed event, not a sentence; judging `String(123)` as a verb
  // denies for "123". Nothing to scan -> allow.
  if (typeof raw !== "string") return;
  const cmd = raw.trim();
  if (!cmd) return;
  const cwd =
    typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();

  // Judge ONLY the first STATEMENT's verb. A later segment failing is an ordinary shell error, and
  // parsing a whole pipeline for verbs is where false positives come from. Comment lines (`# note`,
  // `#!/bin/bash`) run nothing and are skipped — a leading comment used to deny the whole call.
  const line = cmd
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) return; // only comments -> nothing runs
  const first = line.split(/[;&|]/)[0].trim();
  // A token runs to the next WHITESPACE, with quoted spans carried along inside it. The earlier
  // `[^\s"']+|"[^"]*"|'[^']*'` split at the quote, so `TARGET="some-value"` became TWO tokens —
  // `TARGET=` and `"some-value"` — the assignment-skip consumed the first, and the guard judged the
  // quoted VALUE as the verb: `TARGET="my-topic-name"; …` was denied for the string. Keeping them one
  // token is what makes it an assignment again.
  // A backslash-escaped character (`my\ dir/run.sh`) is carried along too, or the path splits at
  // the space and the verb becomes a directory that does not exist.
  let toks = first.match(/(?:\\.|[^\s"']|"[^"]*"|'[^']*')+/g) || [];
  // Skip leading VAR=value assignments to find the actual verb.
  //
  // `VAR=$(cmd …)` and ``VAR=`cmd …` `` are NOT that shape. The verb lives INSIDE the substitution,
  // so blindly skipping the token and judging the next one judges an ARGUMENT: `T=$(git rev-parse …)`
  // would be denied for "rev-parse", and `T=$(grep -oP …)` for "-oP" — both real commands, both refused.
  // Reach into the substitution and judge its verb instead, which keeps the guard's protection rather
  // than waving the whole shape through.
  //
  // The same loop strips everything else that stands BEFORE the verb without being it: grouping
  // openers, leading redirects, a bare substitution opener, and the transparent prefixes. Each of
  // those was a way for the incident shape to walk past the guard (`time notify …`, `(notify …)`),
  // or for a real command to be refused (`2>/dev/null ls`, `>out ls`).
  let substituted = false;
  while (toks.length) {
    const t = toks[0];
    // `( cmd`, `{ cmd`, `! cmd`, `(cmd` — grammar, the verb is what follows.
    if (/^[({!]+$/.test(t)) {
      toks = toks.slice(1);
      continue;
    }
    if (/^[({]/.test(t)) {
      toks = [t.replace(/^[({]+/, ""), ...toks.slice(1)];
      continue;
    }
    // `` `which node` -v `` / `$(which node) -v` — the verb is inside the substitution.
    if (/^(?:[$]\(|`)/.test(t)) {
      const inner = t.replace(/^(?:[$]\(|`)/, "");
      toks = inner ? [inner, ...toks.slice(1)] : toks.slice(1);
      substituted = true;
      continue;
    }
    // Leading redirects: `2>/dev/null cmd`, `>out cmd`, `&>log cmd`, `> out cmd` (target is the
    // next token), `2>&1 cmd`.
    if (/^(?:[0-9]*[<>]|&>)/.test(t)) {
      toks = /[<>]$/.test(t) ? toks.slice(2) : toks.slice(1);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      // Strip the name and any opening quote: VAR="$(cmd  and  VAR=$(cmd  must read the same.
      const value = t
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
        .replace(/^["']/, "");
      const sub = value.match(/^(?:[$]\(|`)(.*)$/); // $( … )  or  ` … `
      if (sub) {
        // The substitution's own first word is the verb. If the opener stands alone (`VAR=$( cmd`),
        // the verb is the next token.
        toks = sub[1] ? [sub[1], ...toks.slice(1)] : toks.slice(1);
        substituted = true;
        break;
      }
      // `VAR=(a b c)` is an array assignment, not a substitution — its elements are data, not a verb.
      if (value.startsWith("(")) return;
      toks = toks.slice(1);
      continue;
    }
    if (TRANSPARENT.has(t)) {
      // Drop the prefix and its options; `sudo -u bob cmd` must not judge `bob`.
      toks = toks.slice(1);
      while (toks.length && /^-/.test(toks[0])) {
        toks = PREFIX_OPT_WITH_ARG.test(toks[0]) ? toks.slice(2) : toks.slice(1);
      }
      continue;
    }
    break;
  }
  // `eval "notify the reviewer"` — the verb is the first word INSIDE the quotes.
  const verb = (toks[0] || "")
    .replace(/^["']|["']$/g, "")
    .split(/(?<!\\)\s+/)[0]
    // `\ls` bypasses an alias; the program is `ls`.
    .replace(/^\\(?=[^\s\\])/, "");
  if (!verb) return;
  // A substitution verb that is itself a nested opener (`X=$((1+2))`, `X=$(<f)`) is arithmetic or a
  // redirect, not a program — nothing to judge.
  if (substituted && /^[($<]/.test(verb)) return;

  const allowSrc = process.env.PROSE_GUARD_ALLOW;
  if (allowSrc) {
    let allowRe = null;
    try {
      allowRe = new RegExp(allowSrc);
    } catch {
      allowRe = null; // an invalid regex exempts nothing; it must not become a silent kill switch
    }
    if (allowRe && allowRe.test(verb)) {
      recordFire("prose-guard.mjs", "allow", "exempted");
      return;
    }
  }

  if (!resolves(verb, cwd)) {
    recordFire("prose-guard.mjs", "deny", "not-a-command");
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Not a command: "${verb}" is not a program, a builtin, or a file on disk — so this looks ` +
            `like a sentence that reached the shell rather than something to run.\n\n` +
            `This has happened three times in one session before ("notify the reviewer, that…", ` +
            `"- Reviewer round 6…", "yes for sure" — the last filled the disk before it was killed).\n\n` +
            `If you were talking to the assistant, send the words WITHOUT a leading \`!\`.\n` +
            `If "${verb}" really is a command, it is not installed or not on PATH.\n` +
            `If it is a shell function or alias from your profile, name it: PROSE_GUARD_ALLOW='^${verb}$'.`,
        },
      }),
    );
  }
}
try {
  main();
} catch {
  /* fail-open */
}
// exit naturally so the one stdout write flushes (pipes are asynchronous on Windows)
