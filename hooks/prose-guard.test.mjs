// Behavioural test for prose-guard.mjs — run: `node hooks/prose-guard.test.mjs`.
//
// CONTRACT: a Bash command whose FIRST VERB does not resolve to a program, builtin, or file on disk is
// prose that reached the shell, and must be DENIED. Everything else must pass untouched.
//
// The must-NOT-fire half carries the weight here. A guard that blocks real commands gets switched off,
// and then it protects nothing — so the allow-cases are drawn from the shapes of real commands run in
// the session that motivated this hook, not from invented examples.
//
// Fixtures only use programs any dev box has (`git`, `node`, `npm`, `bash`, `grep`) and a relative path
// that exists in THIS directory, so the suite is deterministic wherever it runs.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "prose-guard.mjs");

function decide(command, tool = "Bash") {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
    cwd: HERE, // relative-path fixtures below resolve against this directory
  });
  if (r.status !== 0) return `EXIT_${r.status}`;
  const out = r.stdout.trim();
  if (!out) return "allow";
  try {
    return JSON.parse(out).hookSpecificOutput.permissionDecision;
  } catch {
    return `UNPARSEABLE:${out.slice(0, 40)}`;
  }
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};

// ── MUST FIRE — the three incident shapes, verbatim in structure ──────────────────────────────────
check(
  "FIRE  prose: 'notify the reviewer, that they should…'",
  decide(
    "notify the reviewer, that they should be unblocked now, and what to do",
  ),
  "deny",
);
check(
  "FIRE  prose: a pasted bullet starting with '-'",
  decide(
    "- Reviewer round 6 (notes.md) — unsent. It tells them C1 is resolved.",
  ),
  "deny",
);
// The example's FIRST word must not itself be a real program, or the guard resolves it and (by design)
// allows the sentence — `what`/`who`/`where`/`yes`/`time` are all binaries. `why` is not, so this stays a
// true prose case the deterministic PATH check catches.
check("FIRE  prose: a bare question", decide("why is this broken"), "deny");

// ── MUST NOT FIRE — real invocation shapes. ───────────────────────────────────────────────────────
for (const [label, cmd] of [
  ["a repo script", "bash scripts/release.sh 348"],
  ["git with flags", "git status --porcelain"],
  ["npm script", "npm run lint"],
  ["leading VAR= assignment", "NODE_ENV=production node server.js"],
  ["relative path", "./prose-guard.test.mjs"],
  ["compound with cd", "cd infra && npm run preview"],
  ["shell grammar", "if true; then echo hi; fi"],
  ["absolute path", "/bin/echo hello"],
  ["subshell", "( cd /tmp && ls )"],
  // ★ the regression: `VAR=$(cmd …)` had its token skipped as a plain assignment, so the guard
  // judged an ARGUMENT as the verb — a subcommand and a flag were both refused.
  ["assignment from command substitution", "T=$(git rev-parse --short HEAD)"],
  ["substitution whose arg is a flag", "T=$(grep -oP 'task=\\K\\w+' file)"],
  ["quoted substitution", 'T="$(git describe --tags)"'],
  ["backtick substitution", "T=`git branch --show-current`"],
  ["substitution with a space after the opener", "T=$( git status )"],
  ["substitution wrapping a builtin", "D=$(cd /tmp && pwd)"],
  [
    "assignment then substitution then pipe",
    "T=$(git remote -v | sed 's#.*/##')",
  ],
  ["bash array assignment", "FILES=(a.txt b.txt c.txt)"],
  ["arithmetic substitution", "N=$((1 + 2))"],
  [
    "two leading assignments then a substitution",
    "A=1 B=$(git rev-parse HEAD)",
  ],
  ["two leading assignments then a real verb", "A=1 B=2 git status"],
  // ★ the 3rd false positive of the day: the tokenizer split VAR="value" in two and judged the
  // quoted VALUE as the verb. Every one of these is an ordinary assignment.
  ["double-quoted assignment", 'TARGET="my-topic-name"'],
  ["single-quoted assignment", "TARGET='some-topic-name'"],
  ["quoted assignment with spaces", 'MSG="hello there world"'],
  ["quoted assignment then a verb", 'NAME="a b" git status'],
  ["quoted assignment then a second assignment", 'A="x y"; B=2'],
  ["echo with a quoted arg still resolves", 'echo "some-not-a-command-string"'],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST STILL FIRE — reaching into a substitution must not become a blanket exemption. ───────────
check(
  "FIRE  prose inside a substitution",
  decide("T=$(notify the reviewer about the thing)"),
  "deny",
);
check(
  "FIRE  prose after a plain leading assignment",
  decide("FOO=1 notify the reviewer about the thing"),
  "deny",
);

// ── SCOPE + FAIL-OPEN ─────────────────────────────────────────────────────────────────────────────
check(
  "ALLOW non-Bash tools are ignored",
  decide("notify someone", "Read"),
  "allow",
);
check("ALLOW empty command", decide(""), "allow");
{
  const r = spawnSync("node", [HOOK], { input: "not json{", encoding: "utf8" });
  check(
    "ALLOW malformed event → exit 0, no output",
    r.status === 0 && !r.stdout.trim(),
    true,
  );
}

if (fails) {
  console.error(`\n[prose-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[prose-guard.test] all cases passed.");
