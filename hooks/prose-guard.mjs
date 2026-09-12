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
//   ./x.sh, /usr/bin/x, ../x   paths are checked on disk
//   ( subshell, { group, if/for/while/case  shell grammar
//   npm run …, git …  ordinary programs resolve on PATH
//
// FAIL-OPEN in the strongest sense: if PATH cannot be read, if `which` misbehaves, if anything throws —
// exit 0 and ALLOW. A guard that wrongly blocks a real command is worse than the noise it prevents.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
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

function resolves(tok) {
  if (!tok) return true; // nothing to judge -> allow
  if (BUILTINS.has(tok)) return true;
  if (/[=(){}]/.test(tok)) return true; // assignment or grammar
  // A path is checked on disk rather than on PATH.
  if (tok.includes("/")) {
    // On Windows the Bash tool runs Git Bash, whose MSYS root maps /bin, /usr/bin and /dev onto
    // places Node's fs cannot see — `existsSync("/bin/echo")` is false while `/bin/echo hello` runs
    // fine. Node cannot tell here, and the header's own rule for that case is ALLOW.
    if (process.platform === "win32" && tok.startsWith("/")) return true;
    try {
      return existsSync(tok) && statSync(tok).isFile();
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

try {
  const ev = JSON.parse(readFileSync(0, "utf8"));
  if (ev.tool_name !== "Bash") process.exit(0);
  const raw = String((ev.tool_input && ev.tool_input.command) || "");
  const cmd = raw.trim();
  if (!cmd) process.exit(0);

  // Judge ONLY the first segment's verb. A later segment failing is an ordinary shell error, and parsing
  // a whole pipeline for verbs is where false positives come from.
  const first = cmd.split(/[\n;&|]/)[0].trim();
  // A token runs to the next WHITESPACE, with quoted spans carried along inside it. The earlier
  // `[^\s"']+|"[^"]*"|'[^']*'` split at the quote, so `TARGET="some-value"` became TWO tokens —
  // `TARGET=` and `"some-value"` — the assignment-skip consumed the first, and the guard judged the
  // quoted VALUE as the verb: `TARGET="my-topic-name"; …` was denied for the string. Keeping them one
  // token is what makes it an assignment again.
  let toks = first.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
  // Skip leading VAR=value assignments to find the actual verb.
  //
  // `VAR=$(cmd …)` and ``VAR=`cmd …` `` are NOT that shape. The verb lives INSIDE the substitution,
  // so blindly skipping the token and judging the next one judges an ARGUMENT: `T=$(git rev-parse …)`
  // would be denied for "rev-parse", and `T=$(grep -oP …)` for "-oP" — both real commands, both refused.
  // Reach into the substitution and judge its verb instead, which keeps the guard's protection rather
  // than waving the whole shape through.
  let substituted = false;
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) {
    // Strip the name and any opening quote: VAR="$(cmd  and  VAR=$(cmd  must read the same.
    const value = toks[0]
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
    if (value.startsWith("(")) process.exit(0);
    toks = toks.slice(1);
  }
  const verb = (toks[0] || "").replace(/^["']|["']$/g, "");
  if (!verb) process.exit(0);
  // A substitution verb that is itself a nested opener (`X=$((1+2))`, `X=$(<f)`) is arithmetic or a
  // redirect, not a program — nothing to judge.
  if (substituted && /^[($<]/.test(verb)) process.exit(0);

  if (!resolves(verb)) {
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
            `If "${verb}" really is a command, it is not installed or not on PATH.`,
        },
      }),
    );
    process.exit(0);
  }
} catch {
  /* fail-open */
}
process.exit(0);
