// Behavioural test for piped-verdict-guard.mjs — run: `node hooks/piped-verdict-guard.test.mjs`.
//
// CONTRACT: a verdict-bearing command piped into a PURE output filter, with the real status unrecovered,
// is DENIED (exit 0 + JSON permissionDecision on stdout — the same contract as runaway-guard, NOT an
// exit-2 block; a test asserting the wrong one passes silently).
//
// THE CONTROLS ARE THE POINT. This guard's survival depends on narrowness: piping is ubiquitous, and a
// guard that fires on `git log | head` is switched off within a day, taking the git-push protection with
// it. So the ALLOW block below is at least as important as the DENY block, and it contains three cases
// that a naive implementation gets wrong:
//   • THE HOOK'S OWN ADVICE must be allowed. A guard that refuses the command it tells you to run is the
//     worst possible false positive; both remediation forms printed by the deny message are asserted here.
//   • `grep -q` / `jq -e` OWN the verdict on purpose — they are not "pure filters" and must not fire.
//   • a `|` inside QUOTES must not fabricate a pipeline stage.
// And two that a naive EXEMPTION gets wrong, in the dangerous direction:
//   • `${PIPESTATUS[0]}` counts only in the statement IMMEDIATELY after the pipeline. Anywhere else and
//     bash has already clobbered it, so accepting it is a bypass anyone can type.
//   • `pipefail` must be SET, not merely mentioned, and `set +o pipefail` must cancel it.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "piped-verdict-guard.mjs",
);
// CLAUDE_HOOKS_QUIET=1 lifts this guard. Inheriting it would turn every DENY case into an ALLOW and the
// whole suite would go green having proved nothing — so it is stripped, and asserted separately below.
const BASE_ENV = (() => {
  const e = { ...process.env };
  delete e.CLAUDE_HOOKS_QUIET;
  return e;
})();

function decide(command, { tool = "Bash", env = BASE_ENV } = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
    env,
    timeout: 20000,
  });
  if (r.signal) return "KILLED";
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

// The measured incident, written in pieces so this file does not itself carry a copy of a command that
// other guards scan for.
const PUSH = "git pu" + "sh origin fix/some-branch";

// ── MUST FIRE ──────────────────────────────────────────────────────────────────────────────────────
check(
  "FIRE  ★ THE INCIDENT: a push whose failure is grep -v'd away and then truncated",
  decide(
    `${PUSH} 2>&1 | grep -viE "post-quantum|store now|upgraded" | tail -2`,
  ),
  "deny",
);
check(
  "FIRE  ★ 2>&1 must NOT be read as a statement separator (this is what makes the above work)",
  decide(`${PUSH} 2>&1 | tail -8`),
  "deny",
);
check("FIRE  the simplest form", decide(`${PUSH} | tail -1`), "deny");
for (const [label, cmd] of [
  ["merge into a branch", "git merge --no-ff --no-edit topic 2>&1 | tail -5"],
  ["rebase", "git rebase origin/main 2>&1 | tail -6"],
  ["merge through the |& pipe", "git merge topic |& tail -3"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── MUST NOT FIRE — LOCAL verdicts, deliberately out of scope. Every one of these was a FIRE case in an
// earlier, wider rule. They are local verdicts CI re-judges before anything merges; live telemetry on the
// wider rule showed thousands of runs for a dozen fires, each one a re-typed command. Only the masked
// push/merge/rebase — the measured origin defect — still denies. These cases pin the narrowing so it
// cannot silently widen.
for (const [label, cmd] of [
  ["cherry-pick", "git cherry-pick 54b7a07 2>&1 | tail -4"],
  ["git am", "git am /tmp/p.patch 2>&1 | tail -3"],
  [
    "a gate script",
    "node scripts/gates/check-migration-order.mjs 2>&1 | tail -2 | sed 's/^/ /'",
  ],
  ["the whole gate chain", "npm run ci:gates 2>&1 | tail -30"],
  [
    "a single gate with flags",
    "npm run -s lint:hooks 2>&1 | grep -E 'PASS|FAIL'",
  ],
  ["bare npm test", "npm test 2>&1 | tail -5"],
  ["npm run typecheck", "npm run typecheck 2>&1 | tail -8"],
  ["direct vitest", "npx vitest run apps/web/lib/x.test.ts 2>&1 | tail -14"],
  ["npm exec vitest", "npm exec vitest run 2>&1 | tail -3"],
  [
    "a gate runner script",
    'bash scripts/run-gates.sh HEAD 2>&1 | grep -E "GATE VERDICT|FAIL" | tail -3',
  ],
  ["a release script", "bash scripts/release.sh 42 2>&1 | tail -4"],
  ["a db query script", 'bash scripts/staging-sql.sh "select 1" | head -20'],
  ["a ship script", "bash scripts/ship.sh 2>&1 | tail -20"],
])
  check(`ALLOW (local verdict, out of scope) ${label}`, decide(cmd), "allow");

// Statement boundaries: the pipeline is reached through every separator an agent actually types.
for (const [label, cmd] of [
  ["after &&", `cd /tmp && ${PUSH} | tail -2`],
  ["after a NEWLINE", `cd /tmp\n${PUSH} 2>&1 | tail -2`],
  ["after ;", `echo start; ${PUSH} | tail -2`],
  ["inside a command substitution", `X=$(${PUSH} | tail -1)`],
  ["inside a subshell", `(${PUSH} | tail -1)`],
  [
    "through an absolute path to git",
    "/usr/bin/git pu" + "sh origin x | tail -1",
  ],
  ["through the |& pipe", `${PUSH} |& tail -1`],
  [
    "with a leading env assignment",
    `GIT_TERMINAL_PROMPT=0 ${PUSH} 2>&1 | tail -3`,
  ],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── MUST FIRE — the EXEMPTIONS must not be forgeable ───────────────────────────────────────────────
// Every one of these was ALLOWED by the first draft, which tested `cmd.includes("PIPESTATUS")` and
// `/\bpipefail\b/` against the WHOLE command. Each is a bypass anyone could type by accident.
check(
  "FIRE  ★ PIPESTATUS one statement too late — bash has already clobbered it",
  decide(`${PUSH} | tail -1; echo hi; echo \${PIPESTATUS[0]}`),
  "deny",
);
check(
  "FIRE  ★ PIPESTATUS belonging to a LATER pipeline does not cover this one",
  decide(`${PUSH} | tail -1; echo ok; ls | wc -l; echo \${PIPESTATUS[0]}`),
  "deny",
);
check(
  "FIRE  ★ merely MENTIONING pipefail is not setting it",
  decide(`echo pipefail; ${PUSH} | tail -1`),
  "deny",
);
check(
  "FIRE  ★ set +o pipefail cancels an earlier set -o pipefail",
  decide(`set -o pipefail; set +o pipefail; ${PUSH} | tail -1`),
  "deny",
);
check(
  "FIRE  ★ pipefail set AFTER the pipeline does not protect it",
  decide(`${PUSH} | tail -1; set -o pipefail`),
  "deny",
);

// ── MUST NOT FIRE — the hook's OWN advice ──────────────────────────────────────────────────────────
// A guard that refuses the command it tells you to run is the worst false positive there is. These are
// the exact two forms the deny message prints, plus the pipefail form it names.
check(
  "ALLOW ★ the redirect-then-check form the hook recommends",
  decide(
    `${PUSH} > /tmp/x.log 2>&1; rc=$?; tail -8 /tmp/x.log; echo "EXIT=$rc"`,
  ),
  "allow",
);
check(
  "ALLOW ★ the PIPESTATUS form the hook recommends",
  decide(`${PUSH} | tail -8; rc=\${PIPESTATUS[0]}; echo "EXIT=$rc"`),
  "allow",
);
check(
  "ALLOW ★ set -o pipefail in front of the pipeline",
  decide(`set -o pipefail; ${PUSH} | tail -8`),
  "allow",
);
check(
  "ALLOW  set -euo pipefail counts too",
  decide(`set -euo pipefail\n${PUSH} | tail -8`),
  "allow",
);

// ── MUST NOT FIRE — reads, where the OUTPUT is the answer ──────────────────────────────────────────
for (const [label, cmd] of [
  ["git log piped to head (the canonical control)", "git log --oneline | head -3"],
  ["git status counted", "git status --porcelain | wc -l"],
  ["git diff", "git diff --name-only | head -20"],
  ["a plain listing", "ls -la | wc -l"],
  ["ripgrep", "rg -n 'TODO' packages | head -20"],
  ["a push with NO pipe at all", `${PUSH}`],
  ["git merge-base is not git merge", "git merge-base main HEAD | head -1"],
  ["the words appear inside a quoted string only", `echo "${PUSH} | tail -1"`],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST NOT FIRE — deliberately out of scope, each family measured in the corpus ──────────────────
for (const [label, cmd] of [
  [
    "cloud-CLI reads (the biggest deliberate exclusion)",
    "aws ecs describe-tasks --cluster c --tasks t --output json 2>&1 | head -40",
  ],
  ["generic npx is not a verdict", "npx prettier --check . | head -5"],
  [
    "generic bash scripts/* is not a verdict",
    "bash scripts/agent-worktree.sh feat/x 2>&1 | tail -8",
  ],
  ["a non-verdict npm script", "npm run board | head -30"],
  ["a forge CLI read", "gh pr list | head -5"],
  [
    "a node script that is not a gate",
    "node scripts/deploy-status.mjs | tail -5",
  ],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST NOT FIRE — the last stage OWNS the verdict rather than discarding it ──────────────────────
for (const [label, cmd] of [
  ["grep -q makes grep the intended verdict", `${PUSH} | grep -q 'up-to-date'`],
  ["--quiet spelled out", `${PUSH} | grep --quiet 'up-to-date'`],
  ["a short-flag cluster containing q", `${PUSH} | grep -sq 'up-to-date'`],
  ["jq -e sets the exit status deliberately", `${PUSH} | jq -e '.ok'`],
  ["sed with a numbered quit", `${PUSH} | sed '/rejected/q1'`],
  ["awk choosing its own exit", `${PUSH} | awk '/rejected/ { exit 1 }'`],
  [
    "a last stage that is not a filter at all",
    `${PUSH} | mail -s subject me@example.com`,
  ],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST NOT FIRE — quoting and heredocs must not fabricate a pipeline stage ───────────────────────
check(
  "ALLOW ★ a `|` inside DOUBLE quotes is not a pipe (a naive split makes `tail` the last stage)",
  decide(`${PUSH} -o "a|tail -1"`),
  "allow",
);
check(
  "ALLOW  a `|` inside SINGLE quotes is not a pipe",
  decide(`${PUSH} -o 'a|tail -1'`),
  "allow",
);
check(
  "ALLOW  a heredoc BODY containing a pipe belongs to no statement of its own",
  decide(`${PUSH} <<'EOF'\nsome text | tail\nEOF`),
  "allow",
);

// ── GAPS CLOSED 2026-09-12 — each false negative/positive from the adversarial probe, with its twin ──
// Scope is unchanged (push/merge/rebase only); these are the SAME command reached through a different
// shell spelling. Every FIRE below was an ALLOW before the fix, and both pipefail ALLOWs were DENYs.

// 1. newline continuation after `|`
check(
  "FIRE  ★ a newline right after `|` continues the pipeline (the splitter used to end the statement)",
  decide(`${PUSH} 2>&1 |\n tail -3`),
  "deny",
);
check(
  "FIRE  backslash-newline after the pipe is a line continuation (the escape rule used to keep the backslash as the filter word)",
  decide(`${PUSH} origin x | \\\n  tail -3`),
  "deny",
);
check(
  "ALLOW  a newline after `|` on a READ is still a read",
  decide(`git log --oneline |\n head -3`),
  "allow",
);
check(
  "ALLOW  a newline WITHOUT a trailing pipe still separates statements (the push is unpiped)",
  decide(`${PUSH}\ntail -3 /tmp/x.log`),
  "allow",
);

// 2. PIPESTATUS must be READ, not mentioned
check(
  "FIRE  ★ `echo PIPESTATUS` in the next statement reads nothing",
  decide(`${PUSH} | tail -1; echo PIPESTATUS`),
  "deny",
);
check(
  "FIRE  ★ `: PIPESTATUS` in the next statement reads nothing",
  decide(`${PUSH} | tail -1; : PIPESTATUS`),
  "deny",
);
check(
  "ALLOW ★ rc=\${PIPESTATUS[0]} in the next statement is the read the hook asks for",
  decide(`${PUSH} | tail -1; rc=\${PIPESTATUS[0]}`),
  "allow",
);
check(
  "ALLOW  the whole array, quoted, is a read too",
  decide(`${PUSH} | tail -1; echo "\${PIPESTATUS[@]}"`),
  "allow",
);
check(
  "ALLOW  bare $PIPESTATUS expands to element 0 in bash",
  decide(`${PUSH} | tail -1; echo $PIPESTATUS`),
  "allow",
);

// 3. compound / wrapped heads
for (const [label, cmd] of [
  ["inside a for loop body", `for b in a b; do ${PUSH} origin $b | tail -1; done`],
  ["as an if condition", `if ${PUSH} | tail -1; then echo ok; fi`],
  ["in an else branch", `if false; then :; else ${PUSH} | tail -1; fi`],
  ["a brace group piped to tail", `{ ${PUSH}; } | tail`],
  ["a brace group whose LAST command is the push", `{ echo start; ${PUSH}; } | tail -2`],
  ["a subshell piped to tail", `(${PUSH}) | tail`],
  ["behind env with an assignment", `env GIT_X=1 ${PUSH} | tail`],
  ["behind a bare VAR=val", `VAR=1 ${PUSH} | tail`],
  ["git --work-tree DIR (space form)", `git --work-tree /x pu` + `sh | tail`],
  ["git --git-dir DIR (space form)", `git --git-dir /x/.git pu` + `sh | tail`],
  ["git -C DIR", `git -C dir pu` + `sh | tail`],
  ["git -c k=v", `git -c core.x=1 pu` + `sh | tail`],
  ["a redirect glued to the verb", `${PUSH}>log 2>&1 | tail`],
  ["inside bash -c '…'", `bash -c '${PUSH} origin x | tail -1'`],
  ["inside sh -c \"…\"", `sh -c "${PUSH} origin x | tail -1"`],
  ["inside bash -lc after a cd", `bash -lc 'cd /x && ${PUSH} | tail -1'`],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");
for (const [label, cmd] of [
  ["a for loop body that is a read", "for b in a b; do git log -1 $b | head -1; done"],
  ["an if condition where grep -q owns the verdict", `if ${PUSH} | grep -q rejected; then echo no; fi`],
  ["a loop body that reads PIPESTATUS in the next statement", `for b in a b; do ${PUSH} $b | tail -1; rc=\${PIPESTATUS[0]}; done`],
  ["a brace group of reads", "{ git log -1; git status; } | head -5"],
  ["a brace group with a push that ends BEFORE the piped group", `{ ${PUSH}; }; { echo x; } | tail`],
  ["a subshell of reads", "(git log -1) | head -1"],
  ["env in front of a read", "env GIT_PAGER=cat git log | head -3"],
  ["git --work-tree DIR with a read subcommand", "git --work-tree /x status | head"],
  ["a redirect glued to a read", "git log>log 2>&1 | tail"],
  ["bash -c with a read inside", "bash -c 'git log --oneline | head -3'"],
  ["bash -c whose body recovers the status", `bash -c '${PUSH} | tail -1; rc=\${PIPESTATUS[0]}'`],
  ["bash -c with an unquoted argument (no pipe possible)", "bash -c true | tail -1"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// 4. pipefail spelled as separate `set` options
check(
  "ALLOW ★ set -o errexit -o pipefail enables pipefail (was a false positive)",
  decide(`set -o errexit -o pipefail; ${PUSH} | tail`),
  "allow",
);
check(
  "ALLOW ★ set -e -o pipefail enables pipefail (was a false positive)",
  decide(`set -e -o pipefail; ${PUSH} | tail`),
  "allow",
);
check(
  "FIRE  set -e -o pipefail later undone by set +o pipefail (pins the existing cancel behaviour)",
  decide(`set -e -o pipefail; set +o pipefail; ${PUSH} | tail -1`),
  "deny",
);
check(
  "FIRE  set -o errexit alone is not pipefail",
  decide(`set -o errexit; ${PUSH} | tail -1`),
  "deny",
);
check(
  "FIRE  `pipefail` as a set argument that is not an -o option",
  decide(`set -- pipefail; ${PUSH} | tail -1`),
  "deny",
);

// ── SCOPE, FAIL-OPEN, ESCAPE VALVE ────────────────────────────────────────────────────────────────
check(
  "ALLOW non-Bash tools are ignored",
  decide(`${PUSH} | tail -1`, { tool: "Read" }),
  "allow",
);
{
  const r = spawnSync("node", [HOOK], {
    input: "not json{",
    encoding: "utf8",
    env: BASE_ENV,
  });
  check(
    "ALLOW malformed event → fail-open, exit 0, no output",
    r.status === 0 && !r.stdout.trim(),
    true,
  );
}
check(
  "ALLOW CLAUDE_HOOKS_QUIET=1 lifts the guard (and the test runners strip it, so it cannot hide a green)",
  decide(`${PUSH} | tail -1`, {
    env: { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "1" },
  }),
  "allow",
);

// ── THE DENY MESSAGE MUST CARRY THE FIX ───────────────────────────────────────────────────────────
// Half the contract, and the half a naive test misses: a deny with no usable replacement is a guard
// that just gets in the way.
{
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `${PUSH} 2>&1 | tail -8` },
    }),
    encoding: "utf8",
    env: BASE_ENV,
  });
  let reason = "";
  try {
    reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  } catch {
    reason = "";
  }
  for (const [what, needle] of [
    ["names the verdict command", "git pu" + "sh"],
    ["names the filter that ate it", "`tail`"],
    ["prints the redirect-then-check form", "rc=$?; tail -8 /tmp/x.log"],
    ["prints the PIPESTATUS form", "${PIPESTATUS[0]}"],
    ["prints the pipefail form", "set -o pipefail"],
    [
      "warns PIPESTATUS is only valid in the NEXT statement",
      "IMMEDIATELY after the pipeline",
    ],
    ["quotes the offending statement back", "statement: "],
  ])
    check(`REASON ${what}`, reason.includes(needle), true);
}

// ── SIZE CAP ── above MAX_EVENT_BYTES the hook must DENY rather than scan. It is the backstop for a
// superlinear path nobody has found yet: it converts an undiscovered blow-up from a silent no-guard
// into a visible refusal. BOTH directions are asserted — a cap that denied everything would be as
// broken as one that denied nothing, and only the pair tells them apart.
check(
  "SIZE CAP a 60KB command is still scanned normally",
  decide("echo " + "x".repeat(60000)),
  "allow",
);
check(
  "SIZE CAP an oversize command is DENIED, not waved through",
  decide("echo " + "x".repeat(70000)),
  "deny",
);

// ── COMPLEXITY BUDGET ── this hook runs behind a 10s timeout, and a hook killed by that timeout is
// treated as a PASS, i.e. no guard at all. A pinned string proves nothing: what has to hold is a
// SHAPE — doubling the input must not square the time.
//
// TWO traps, both real here:
//   1. the payload must END in a command that really DENIES, or a regression is a slow allow rather
//      than a proven bypass;
//   2. an ABSOLUTE ms ceiling is the wrong assertion — node startup (~90ms) dominates at these sizes,
//      so a ceiling loose enough to be stable on CI is loose enough to pass a quadratic. Time a BENIGN
//      command of the SAME byte length instead and assert a RATIO; startup cancels out.
{
  // ⚠ ONE TIMING SAMPLE IS NOT A MEASUREMENT, and a hard threshold over it is flaky BY CONSTRUCTION.
  // This assertion once failed CI at 2.2x on a branch that touched nothing this hook reads; on an idle
  // box the same test measured 0.9x-1.2x across 25 samples, so the code is linear and the 2.2x was
  // scheduler contention.
  //
  // THE FIX IS THE STATISTIC, NOT THE THRESHOLD. Under contention noise only ever ADDS time, so the
  // MINIMUM of k runs is the closest estimate of the real cost — and it does not weaken the guard:
  // a genuinely quadratic path is slower in EVERY sample, so its minimum still blows past 2.0.
  // Loosening 2.0 instead would have bought stability by making a real regression passable.
  const SAMPLES = 5;
  const timeFor = (command) => {
    let best = null;
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
        env: BASE_ENV,
        timeout: 20000,
      });
      const ms = Math.max(1, Date.now() - t0);
      // A KILLED run is kept as a result rather than discarded: a timeout is the failure this whole
      // budget exists to catch, and quietly dropping it would hide it behind the faster samples.
      if (r.signal) return { ms, killed: true, out: r.stdout, samples: i + 1 };
      if (best === null || ms < best.ms)
        best = { ms, killed: false, out: r.stdout };
    }
    return { ...best, samples: SAMPLES };
  };
  const TAIL = ` ; ${PUSH} | tail -1`;
  const FAMILIES = [
    ["many pipeline stages", "echo a | ".repeat(6000) + "cat" + TAIL],
    [
      "long flag run before the subcommand",
      "git " + "-x ".repeat(15000) + "status" + TAIL,
    ],
    ["many single-quoted runs", "echo 'a b' ; ".repeat(5000) + TAIL],
    ["many double-quoted runs", 'x="a b" ; '.repeat(5000) + TAIL],
    ["many statements", "true ; ".repeat(8000) + TAIL],
  ];
  for (const [label, payload] of FAMILIES) {
    const benign = timeFor("echo " + "x".repeat(payload.length - 5));
    const adv = timeFor(payload);
    const verdict = adv.killed
      ? "KILLED"
      : adv.out.includes('"deny"')
        ? "deny"
        : "allow";
    check(
      `COMPLEXITY ${label} (${(payload.length / 1024).toFixed(0)}KiB) still DENIES`,
      verdict,
      "deny",
    );
    const ratio = adv.ms / benign.ms;
    check(
      `COMPLEXITY ${label} scan cost is linear (${ratio.toFixed(1)}x a same-size benign command, best of ${SAMPLES})`,
      ratio < 2.0 ? "linear" : `SUPERLINEAR (${ratio.toFixed(1)}x)`,
      "linear",
    );
  }
}

if (fails) {
  console.error(`\n[piped-verdict-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[piped-verdict-guard.test] all cases passed.");
