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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const HOOK = join(HERE, "prose-guard.mjs");

// CLAUDE_HOOKS_QUIET=1 lifts this guard and PROSE_GUARD_ALLOW exempts verbs. Inheriting either from
// the runner's shell would turn DENY cases into ALLOWs and the suite would go red — or, worse, an
// allowlist matching `.` would make every must-fire case pass having proved nothing. Both are
// stripped here and asserted on their own below. HOME is pinned so `~` fixtures resolve to THIS
// directory wherever the suite runs.
const BASE_ENV = (() => {
  const e = { ...process.env };
  delete e.CLAUDE_HOOKS_QUIET;
  delete e.PROSE_GUARD_ALLOW;
  e.HOME = HERE;
  return e;
})();

// Spawns the hook exactly as Claude Code does. `env` reaches the child through spawnSync — the only
// way an escape hatch can be exercised; `cwd` is where the HOOK PROCESS starts, `event` merges extra
// fields (e.g. the event's own `cwd`) into the stdin JSON.
function run(command, { tool = "Bash", env = BASE_ENV, cwd = HERE, event = {} } = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, ...event }),
    encoding: "utf8",
    env,
    cwd, // relative-path fixtures below resolve against this directory unless the event says otherwise
    timeout: 20000,
  });
  if (r.status !== 0) return { decision: `EXIT_${r.status}`, reason: "" };
  const out = r.stdout.trim();
  if (!out) return { decision: "allow", reason: "" };
  try {
    const h = JSON.parse(out).hookSpecificOutput;
    return { decision: h.permissionDecision, reason: h.permissionDecisionReason || "" };
  } catch {
    return { decision: `UNPARSEABLE:${out.slice(0, 40)}`, reason: "" };
  }
}
const decide = (command, opts) => run(command, opts).decision;

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
  decide("notify someone", { tool: "Read" }),
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

// ── A. FALSE POSITIVES on real command shapes (adversarial probe) — every one was DENIED. ─────────
// A temp fixture gives a path WITH A SPACE and a `node_modules/.bin` shim without touching the repo.
const TMP = mkdtempSync(join(tmpdir(), "prose-guard-"));
mkdirSync(join(TMP, "my dir"));
writeFileSync(join(TMP, "my dir", "run.sh"), "#!/bin/sh\n");
mkdirSync(join(TMP, "node_modules", ".bin"), { recursive: true });
writeFileSync(join(TMP, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
try {
  for (const [label, cmd] of [
    ["tilde path", "~/prose-guard.test.mjs"],
    ["$HOME path", "$HOME/prose-guard.test.mjs"],
    ["quoted $HOME path", '"$HOME"/prose-guard.test.mjs'],
    ["${HOME} path", "${HOME}/prose-guard.test.mjs"],
    ["path with a backslash-escaped space", `${TMP}/my\\ dir/run.sh`],
    ["alias escape", "\\ls -la"],
    ["leading stderr redirect", "2>/dev/null ls"],
    ["leading stdout redirect", ">out ls"],
    ["leading redirect with a space before the target", "> out ls"],
    ["leading &> redirect", "&>log ls"],
    ["backtick substitution as the verb", "`which node` -v"],
    ["$( ) substitution as the verb", "$(which node) -v"],
    ["a pure comment runs nothing", "# just a note"],
    ["a leading comment line then a real command", "# build first\nnpm run build"],
    ["a shebang line then a real command", "#!/bin/bash\nls"],
    ["blank lines then a real command", "\n\n  git status"],
    ["sudo with an option that takes an argument", "sudo -u nobody ls"],
    ["env with an assignment", "env FOO=1 node -v"],
    ["time with -p", "time -p git status"],
    ["exec of a real program", "exec node -v"],
    ["eval of a quoted real command", 'eval "git status"'],
    ["grouped real command", "{ git status; }"],
    ["negated real command", "! git status"],
    ["subshell without a space", "(git status)"],
  ])
    check(`ALLOW ${label}`, decide(cmd), "allow");

  // The hook resolved relative paths against ITS OWN cwd, never the event's. Same command, same
  // process cwd (the repo root, where no such file exists): the event's `cwd` decides.
  check(
    "ALLOW relative path resolved against the EVENT's cwd",
    decide("node_modules/.bin/vitest run", { cwd: ROOT, event: { cwd: TMP } }),
    "allow",
  );
  check(
    "FIRE  same relative path without an event cwd (positive control: the file is not at the process cwd)",
    decide("node_modules/.bin/vitest run", { cwd: ROOT }),
    "deny",
  );
  // The `~`/`$HOME` cases above pass BECAUSE the fixture exists at $HOME; prove the expansion is a
  // real lookup, not a blanket exemption for anything starting with `~` or `$`.
  check("FIRE  tilde path that does not exist", decide("~/no-such-file-here.sh"), "deny");
  check("FIRE  $HOME path that does not exist", decide("$HOME/no-such-file-here.sh"), "deny");
  check(
    "ALLOW a path under an unknown variable cannot be checked (fail-open)",
    decide("$SOME_OTHER_ROOT/run.sh"),
    "allow",
  );
  check("FIRE  path with a space that does not exist", decide(`${TMP}/my\\ dir/nope.sh`), "deny");
  // A tilde that is not at the start of the word is a literal character to bash, so it cannot be
  // an expansion the guard "cannot tell" about: judge the path.
  check("FIRE  path with a MID-WORD tilde that does not exist (Windows 8.3 names spell home as RUNNER~1)", decide(`${TMP}/RUNNER~1/nope.sh`), "deny");
  check("ALLOW `~user/…` is a real expansion the guard cannot perform", decide("~someone/bin/run.sh"), "allow");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
check("ALLOW a non-string command is a malformed event, not a verb", decide(123), "allow");
check("ALLOW a null command", decide(null), "allow");
check("FIRE  comment then prose (skipping comments is not skipping the check)", decide("# note\nnotify the reviewer"), "deny");

// ── B. FALSE NEGATIVES — the incident shape walked past the guard behind a transparent prefix. ───
for (const [label, cmd] of [
  ["time", "time notify the reviewer now"],
  ["sudo", "sudo notify the reviewer"],
  ["sudo with an option", "sudo -n notify the reviewer"],
  ["exec", "exec notify the reviewer"],
  ["command", "command notify the reviewer"],
  ["env", "env notify the reviewer"],
  ["env with an assignment", "env FOO=1 notify the reviewer"],
  ["eval", "eval notify the reviewer"],
  ["eval of a quoted sentence", 'eval "notify the reviewer"'],
  ["builtin", "builtin notify the reviewer"],
  ["nohup", "nohup notify the reviewer"],
  ["subshell", "(notify the reviewer)"],
  ["group", "{ notify the reviewer; }"],
  ["negation", "! notify the reviewer"],
  ["stacked prefixes", "time sudo env notify the reviewer"],
  ["leading redirect then prose", "2>/dev/null notify the reviewer"],
  ["alias escape on prose", "\\notify the reviewer"],
  ["substitution around prose", "$(notify the reviewer)"],
])
  check(`FIRE  prose behind ${label}`, decide(cmd), "deny");

// ── DOCUMENTED LIMIT — English verbs that ARE programs, and keywords used as English openers. ─────
// These are ALLOWED on purpose (see the hook header). `touch base with them` created three files and
// still passes: `touch` is a program, and the guard does not guess at grammar. Pinned so the limit is
// documented, not silently "fixed" into a word list that then blocks real scripts.
for (const [label, cmd] of [
  ["find is a program", "find the bug"],
  ["touch is a program", "touch base with them"],
  ["make is a program", "make the reviewer aware"],
  ["done is a keyword", "done with the fix"],
  ["let is a builtin", "let me know"],
  ["wait is a builtin", "wait for CI"],
  ["read is a builtin", "read the file"],
])
  check(`ALLOW documented limit: ${label}`, decide(cmd), "allow");

// ── ESCAPE HATCHES + SIZE CAP (main() additions). ─────────────────────────────────────────────────
check(
  "ALLOW PROSE_GUARD_ALLOW exempts a matching non-resolving verb (a profile function)",
  decide("mkcd new-dir", { env: { ...BASE_ENV, PROSE_GUARD_ALLOW: "^(mkcd|deploy-preview)$" } }),
  "allow",
);
check(
  "FIRE  PROSE_GUARD_ALLOW does not exempt a non-matching verb",
  decide("notify the reviewer", { env: { ...BASE_ENV, PROSE_GUARD_ALLOW: "^(mkcd|deploy-preview)$" } }),
  "deny",
);
check(
  "FIRE  an invalid PROSE_GUARD_ALLOW regex exempts nothing (no silent kill switch)",
  decide("mkcd new-dir", { env: { ...BASE_ENV, PROSE_GUARD_ALLOW: "^(mkcd" } }),
  "deny",
);
check(
  "FIRE  without the allowlist the same verb is denied (control for the exemption)",
  decide("mkcd new-dir"),
  "deny",
);
check(
  "ALLOW CLAUDE_HOOKS_QUIET=1 lifts the guard (the suite strips it, so it cannot hide a green)",
  decide("notify the reviewer", { env: { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "1" } }),
  "allow",
);
check(
  "FIRE  CLAUDE_HOOKS_QUIET=0 does not lift it",
  decide("notify the reviewer", { env: { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "0" } }),
  "deny",
);
{
  // 70 KB of a REAL command: the deny must come from the size cap, not from the verb, and the reason
  // must carry the measured size so "could not check" never reads like "checked, fine".
  const big = "git status " + "#".repeat(70 * 1024);
  const bytes = JSON.stringify({ tool_name: "Bash", tool_input: { command: big } }).length;
  const r = run(big);
  check("FIRE  a 70 KB payload is denied (fail closed on what cannot be scanned)", r.decision, "deny");
  check(
    "FIRE  …and the reason names the payload size and the cap",
    r.reason.includes(`${bytes} bytes`) && r.reason.includes("65536-byte"),
    true,
  );
  check(
    "ALLOW the same command shape under the cap passes (the size cap is not a verb check)",
    decide("git status " + "#".repeat(1024)),
    "allow",
  );
}

if (fails) {
  console.error(`\n[prose-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[prose-guard.test] all cases passed.");
