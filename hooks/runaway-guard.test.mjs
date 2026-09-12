// Behavioural test for runaway-guard.mjs — run: `node hooks/runaway-guard.test.mjs`.
//
// CONTRACT: a command containing a generator that never stops (`yes`, /dev/urandom, an unconditional
// loop) is DENIED **unless something bounds it** — a bounding consumer (`| head`), a byte/line cap, or a
// clock (`timeout`). The bound is the entire distinction; without it this would block `yes | apt install`
// and be switched off within a day.
//
// This hook is separate from prose-guard on purpose: `yes` IS a real command, so prose-guard allows it.
// That gap is exactly what once filled a disk, and the first case below is that incident verbatim.
//
// The bound is PER PIPELINE. An adversarial probe (2026-09-12) showed the first version read the whole
// string: `yes | head -n 3 > f; yes` was allowed because statement one had a `head`, and `(yes)`,
// `env yes`, `nohup yes &`, a `yes` on its own line and `bash -c 'yes'` all slipped past the anchor.
// Each of those is a case below, next to the twin that must keep passing.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRunaway, MAX_EVENT_BYTES } from "./runaway-guard.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "runaway-guard.mjs");

function decide(command, tool = "Bash") {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
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

// ── MUST FIRE — unbounded generators ──────────────────────────────────────────────────────────────
check(
  "FIRE  ★ the disk-filling incident: 'yes for sure'",
  decide("yes for sure"),
  "deny",
);
check("FIRE  bare yes", decide("yes"), "deny");
check(
  "FIRE  cat /dev/urandom to a file",
  decide("cat /dev/urandom > f"),
  "deny",
);
check(
  "FIRE  unconditional loop",
  decide("while true; do echo x; done"),
  "deny",
);
check("FIRE  yes after a separator", decide("cd /tmp && yes"), "deny");
// `seq` had NO case here in either direction, which is how a backwards rule shipped: it denied the
// FINITE `seq 5` and let the genuinely infinite `seq inf` straight through. Verified against
// coreutils — `inf`, `infinity`, `1 inf` and `1 2 inf` all count up forever.
for (const [label, cmd] of [
  ["seq inf", "seq inf"],
  ["seq infinity", "seq infinity"],
  ["seq with an inf end value", "seq 1 inf"],
  ["seq with a step and inf", "seq 1 2 inf"],
  ["seq with a flag before inf", "seq -w 1 inf"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── MUST NOT FIRE — the SAME generators, bounded. These are legitimate and common. ─────────────────
for (const [label, cmd] of [
  ["yes piped into head", "yes | head -3"],
  ["yes under timeout", "timeout 2 yes"],
  ["urandom with a byte cap", "head -c 1M /dev/urandom > f"],
  ["dd with count=", "dd if=/dev/zero of=f count=10"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── MUST NOT FIRE — the word appears but is not the command ───────────────────────────────────────
for (const [label, cmd] of [
  ["yes inside a grep pattern", "git log --grep=yes"],
  ["yes inside a script name", "npm run yes-man"],
  ["unrelated command", "git status --porcelain"],
  // ★ the regression: every one of these terminates on its own. The old rule denied the first.
  ["seq N is finite — counts 1..5 and exits", "seq 5"],
  ["seq with an explicit range", "seq 1 100"],
  ["seq with a step", "seq 0 2 10"],
  ["seq inf bounded by head", "seq inf | head -5"],
  ["inf only in a redirect target", "seq 1 5 > inf.txt"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── A. MUST FIRE — the anchor `(^|[;&|]\s*)` missed every one of these (probe 2026-09-12) ─────────
for (const [label, cmd] of [
  ["yes in a subshell", "(yes)"],
  ["yes in a command substitution", "echo $(yes)"],
  ["yes in a double-quoted substitution", 'echo "$(yes)"'],
  ["yes in backticks", "echo `yes`"],
  ["yes in a brace group", "{ yes; }"],
  ["leading whitespace", " yes"],
  ["yes on its own line after a newline", "echo hi\nyes"],
  ["yes behind env", "env yes"],
  ["yes behind env with an assignment", "env FOO=1 yes"],
  ["yes behind command", "command yes"],
  ["yes behind exec", "exec yes"],
  ["yes behind nohup, backgrounded", "nohup yes &"],
  ["yes behind time", "time yes"],
  ["yes behind nice", "nice yes"],
  ["yes behind nice -n N", "nice -n 10 yes"],
  ["yes behind sudo -u", "sudo -u root yes"],
  ["yes behind an env-assignment prefix", "YES=1 yes"],
  ["yes single-quoted", "'yes'"],
  ["yes double-quoted", '"yes"'],
  ["Yes capitalised — a case-insensitive filesystem runs it", "Yes for sure"],
  ["yes inside bash -c", "bash -c 'yes'"],
  ["yes inside bash -lc", "bash -lc 'yes'"],
  ["yes inside sh -c with double quotes", 'sh -c "yes"'],
  ["yes inside eval", "eval 'yes'"],
  ["an unconditional loop inside sh -c", 'sh -c "while true; do echo; done"'],
  ["while [ 1 ]", "while [ 1 ]; do echo x; done"],
  ["while :", "while :; do echo x; done"],
  ["until false", "until false; do echo x; done"],
  ["for ((;;))", "for ((;;)); do echo x; done"],
  ["a loop whose done is on its own line", "while true\ndo\n  echo x\ndone"],
  ["a loop feeding a pass-through", "while true; do echo x; done | cat"],
  ["tr reading /dev/urandom via a redirect", "tr -dc a-z < /dev/urandom"],
  ["xxd on /dev/urandom", "xxd /dev/urandom"],
  ["od on /dev/random", "od /dev/random"],
  ["base64 on /dev/zero", "base64 /dev/zero > f"],
  ["cp of /dev/zero", "cp /dev/zero f"],
  ["dd from /dev/urandom without count=", "dd if=/dev/urandom of=f bs=1M"],
  ["seq INF upper-case", "seq INF"],
  ["seq 1 Inf mixed case", "seq 1 Inf"],
  ["seq inf in a for-loop substitution", "for i in $(seq inf); do echo $i; done"],
  ["yes as the second of two backgrounded jobs", "sleep 1 & yes"],
  ["yes after a pipe of an earlier statement", "ls | wc -l; yes"],
  ["yes ANSI-C quoted", "$'yes'"],
  ["yes behind stdbuf", "stdbuf -oL yes"],
  ["yes inside busybox sh -c", "busybox sh -c 'yes'"],
  ["yes with a merged redirect", "yes &> f"],
  ["yes after an arithmetic expansion", "echo $((1+2)); yes"],
  ["yes in a process substitution read by cat", "cat <(yes)"],
  ["yes into dd without count= — dd passes through forever", "yes | dd of=f"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── A. MUST NOT FIRE — the same shapes, bounded, or the word where it is not the command ──────────
for (const [label, cmd] of [
  ["subshell bounded inside", "(yes | head -1)"],
  ["subshell bounded outside — the group's output flows to head", "(yes) | head -1"],
  ["brace group bounded outside", "{ yes; } | head -1"],
  ["substitution bounded inside", "echo $(yes | head -1)"],
  ["backticks bounded inside", "echo `yes | head -1`"],
  ["env yes bounded", "env yes | head -1"],
  ["command -v looks yes up, does not run it", "command -v yes"],
  ["nohup yes bounded, backgrounded", "nohup yes | head -1 &"],
  ["time on a bounded pipeline", "time yes | head -1"],
  ["nice on a bounded pipeline", "nice -n 10 yes | head -1"],
  ["env-assignment prefix on a bounded pipeline", "YES=1 yes | head -1"],
  ["bash -c bounded inside the script", "bash -c 'yes | head -1'"],
  ["bash -c bounded outside the script", "bash -c 'yes' | head -1"],
  ["bash -c under timeout", "timeout 5 bash -c 'yes'"],
  ["bash running a script file, not -c", "bash yes.sh"],
  ["sh -c loop with a break", 'sh -c "while true; do echo; break; done"'],
  ["while [ 1 ] with a break", "while [ 1 ]; do break; done"],
  ["until false with a break", "until false; do echo x; break; done"],
  ["a loop bounded by head on its done", "while true; do echo x; done | head -3"],
  ["a loop with a conditional exit", "while true; do sleep 1; test -f x && exit 0; done"],
  ["a loop whose condition can fail", "while read -r l; do echo $l; done < f"],
  ["while true with the loop word inside a string", "echo 'while true; do echo; done'"],
  ["tr from /dev/urandom bounded by head -c", "tr -dc a-z < /dev/urandom | head -c 20"],
  ["xxd on /dev/urandom bounded", "xxd /dev/urandom | head -3"],
  ["ls of /dev/urandom — not a stream reader", "ls -l /dev/urandom"],
  ["head reading /dev/urandom via a redirect", "head -c 16 < /dev/urandom"],
  ["dd from /dev/urandom with count=", "dd if=/dev/urandom of=f bs=1M count=1"],
  ["seq INF bounded", "seq INF | head -3"],
  ["yes as an argument", "echo yes"],
  ["yes as a value in an assignment", "ANSWER=yes"],
  ["yes as a redirect target", "echo hi > yes"],
  ["a separator inside a comment does not start a statement", "true # ok; yes"],
  ["yes inside a heredoc body", "cat <<EOF\nyes\nEOF"],
  ["yes inside a quoted heredoc body", "cat <<'EOF'\nyes\nEOF"],
  ["a substitution whose word happens to start with yes", "./yesod --serve"],
  ["yes as a function name argument", "git commit -m 'say yes'"],
  ["yes with stderr merged into a bounded pipe", "yes 2>&1 | head -1"],
  ["yes piped with |& into head", "yes |& head -1"],
  ["an arithmetic expansion alone", "echo $((1+2))"],
  ["yes in a process substitution read by head", "head -1 <(yes)"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── B. THE BOUND IS PER STATEMENT — a bound in one statement never excuses the next ──────────────
for (const [label, cmd] of [
  ["★ the probe: bounded yes, then bare yes", "yes | head -n 3 > f; yes"],
  ["★ the probe: timeout on one statement, urandom on the next", "timeout 1 true; cat /dev/urandom > f"],
  ["bounded first, unbounded after &&", "yes | head -1 && yes"],
  ["bounded first, unbounded on the next line", "yes | head -1\nyes"],
  ["yes into tail — tail waits for an EOF that never comes", "yes | tail -n 5"],
  ["yes into tail -f", "yes | tail -f"],
  ["urandom into tail", "cat /dev/urandom | tail -c 10"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");
for (const [label, cmd] of [
  ["the bounded half of the probe on its own", "yes | head -n 3 > f"],
  ["two bounded statements", "yes | head -1; yes | head -1"],
  ["timeout on each statement", "timeout 1 yes; timeout 1 cat /dev/urandom > f"],
  ["tail on a finite producer", "seq 100 | tail -n 5"],
  ["tail after a bound", "yes | head -100 | tail -n 5"],
  ["grep -m N is a bound", "yes | grep -m 1 y"],
  ["grep --max-count is a bound", "yes | grep --max-count=1 y"],
  ["sed Nq is a bound", "yes | sed 1q"],
  ["sed -n …q is a bound", "yes | sed -n '3p;3q'"],
  ["awk exit is a bound", "yes | awk 'NR>3{exit} {print}'"],
  ["dd count= as a consumer is a bound", "yes | dd count=1"],
  ["a clock on the consumer is a bound", "yes | timeout 2 cat"],
  ["a bounded subshell consumer", "yes | (head -1)"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");

// ── C. CONSUMERS THAT READ WHAT THEY NEED AND EXIT — the header's own promise ─────────────────────
// `yes |` into anything that is NOT a pass-through filter is allowed: apt-get, python3, fsck and ssh
// stop reading on their own. Pass-through filters (cat, tee, grep, sort, uniq, wc, tr, sed, awk, xargs,
// while read) never do, so those stay denied — `wc` counts forever and is kept in the denied set.
for (const [label, cmd] of [
  ["★ yes into apt-get — the header's example", "yes | apt-get install -y foo"],
  ["yes into sed 1q", "yes | sed 1q"],
  ["yes into python3 -c", "yes | python3 -c 'import sys; print(sys.stdin.readline())'"],
  ["yes into fsck", "yes | fsck /dev/sda1"],
  ["yes into ssh", "yes | ssh host cmd"],
  ["yes into read", "yes | read -r first"],
  ["yes into a script", "yes | ./install.sh"],
  ["★ a poll loop whose break sits inside a nested if", "while true; do sleep 1; if test -f x; then break; fi; done"],
  ["a poll loop that exits from a nested if", "while true; do if curl -sf localhost; then exit 0; fi; sleep 1; done"],
  ["a loop with break inside a brace group", "while true; do { break; }; done"],
  ["a loop with || break", "while true; do cmd || break; done"],
])
  check(`ALLOW ${label}`, decide(cmd), "allow");
for (const [label, cmd] of [
  ["yes into cat", "yes | cat"],
  ["yes into tee", "yes | tee f"],
  ["yes into grep without -m", "yes | grep y"],
  ["yes into grep -c — counts forever", "yes | grep -c y"],
  ["yes into sort", "yes | sort"],
  ["yes into uniq", "yes | uniq"],
  ["yes into wc — decided: wc never terminates on infinite input", "yes | wc -l"],
  ["yes into sed without q", "yes | sed 's/y/n/'"],
  ["yes into awk without exit", "yes | awk '{print}'"],
  ["yes into xargs", "yes | xargs -n1 echo"],
  ["yes into a while-read loop", "yes | while read -r l; do echo $l; done"],
  ["yes into cat then a pass-through", "yes | cat | tr a-z A-Z"],
  ["the same poll loop without its break", "while true; do sleep 1; if test -f x; then echo found; fi; done"],
])
  check(`FIRE  ${label}`, decide(cmd), "deny");

// ── LATENCY — a 60 KiB command must decide inside the hook timeout, not time out into a silent allow ─
{
  const big = "echo x; ".repeat(7600) + "yes"; // ≈ 60 KiB, generator at the very end
  const t0 = performance.now();
  const what = findRunaway(big);
  const ms = performance.now() - t0;
  check(`FIRE  60 KiB command with yes at the end (${big.length} bytes)`, what !== null, true);
  check(`      … decided in-process in ${ms.toFixed(1)} ms (< 200)`, ms < 200, true);
  check("FIRE  60 KiB command with yes at the end, through the hook process", decide(big), "deny");
  const bigOk = "echo x; ".repeat(7600) + "yes | head -1";
  check("ALLOW 60 KiB command with a bounded yes at the end", decide(bigOk), "allow");
}

// ── SCOPE + FAIL-OPEN ─────────────────────────────────────────────────────────────────────────────
{
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo " + "x".repeat(MAX_EVENT_BYTES) } }),
    encoding: "utf8",
  });
  check(
    "FIRE  payload over MAX_EVENT_BYTES is denied unscanned (fail closed)",
    r.status === 0 && r.stdout.includes('"deny"') && r.stdout.includes("scan"),
    true,
  );
}
check("ALLOW unbalanced quote does not crash the parser", decide("echo 'oops"), "allow");
check("FIRE  unbalanced quote around a real generator still decides", decide("yes 'oops"), "deny");
check("ALLOW unbalanced paren does not crash the parser", decide("echo (oops"), "allow");
check("ALLOW non-Bash tools are ignored", decide("yes", "Read"), "allow");
{
  const r = spawnSync("node", [HOOK], { input: "not json{", encoding: "utf8" });
  check(
    "ALLOW malformed event → exit 0, no output",
    r.status === 0 && !r.stdout.trim(),
    true,
  );
}

if (fails) {
  console.error(`\n[runaway-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[runaway-guard.test] all cases passed.");
