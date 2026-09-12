// Behavioural test for root-cause-guard.mjs — run: `node hooks/root-cause-guard.test.mjs`.
//
// ⚠ PLAIN NODE, AND REAL `assert` CALLS. Both halves are load-bearing:
//
//   · Hook suites are spawned with bare `node`. A hook must stay verifiable by `node <file>` alone,
//     because it runs in a hook context where no test framework exists.
//   · A test-strength gate counts `assert.` occurrences to ratchet assertion strength. A bespoke
//     `check()` helper with no real assertions reads as ZERO to such a gate — "this gate cannot
//     protect what it cannot count."
//
// CONTRACT under test: the guard PROMPTS — exit 0, ONE stdout JSON object of the shape
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":…},"systemMessage":…}
// and NOTHING on stderr — when a Bash commit/PR command's message quotes a runtime error and claims
// a fix while naming no locating evidence. It never blocks, and it never writes to stderr: stderr
// from a hook that exits 0 goes to the debug log only, which is how an earlier version fired,
// logged the fire, and reached nobody. Only a Bash event is judged; the message may live in a file
// named by -F/--file/--body-file, which is read (capped at 64 KB) and judged in the command's place.
//
// Every case below is modelled on a real message from the incident in the hook's header or its
// correction, so the guard is pinned against what actually happened rather than invented prose.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { verdict, TRIGGER_RE, messageFileOf, textToJudge, MESSAGE_FILE_CAP } from "./root-cause-guard.mjs";
import { scratchDir } from "./_scratch-dir.mjs";

const HOOK = fileURLToPath(new URL("./root-cause-guard.mjs", import.meta.url));
const FIXTURES = scratchDir("root-cause-guard");
/** Spawn the hook exactly as Claude Code does: the event on stdin, the decision on stdout. */
function spawnHook(event) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    cwd: FIXTURES,
    env: { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(FIXTURES, "fires.log") },
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const bash = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: FIXTURES, ...extra });
// The first wrong fix's message: a quoted crash, a plausible call site, no location.
const GUESS = `fix(dashboard): a numeric clientKey took the whole page down\nTypeError: 861014.startsWith is not a function\ncountOf() calls .startsWith on every message clientKey; a legacy row holds a NUMBER.`;
const LOCATED = `fix(dashboard): the bundler inlined a module id where a path belonged\nTypeError: 861014.startsWith is not a function\nPulled the running image and read chunk.js:1:15825 — the chunk contains if (861014..startsWith(a)).`;

let failures = 0;
let ran = 0;
function check(label, fn) {
  ran++;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${label}\n      ${error.message.split("\n")[0]}`);
  }
}

console.log("\nroot-cause-guard — MUST FIRE");

// The first wrong fix, trimmed. It read like a diagnosis and was a guess: the crash continued
// after it deployed, because it named a plausible call site rather than a located one.
check("quotes the crash, names only a source call site", () => {
  assert.equal(
    verdict(
      `git commit -m "fix(dashboard): a numeric clientKey took the whole page down
       TypeError: 861014.startsWith is not a function
       countOf() calls .startsWith on every message clientKey; a legacy row holds a NUMBER."`,
    ).fire,
    true,
  );
});

console.log(
  "\nroot-cause-guard — MUST NOT FIRE (each a different kind of locating evidence)",
);

check(
  "a bundle offset locates it (the message that was actually right)",
  () => {
    assert.equal(
      verdict(
        `git commit -m "fix(dashboard): the bundler inlined a module id where a path belonged
       TypeError: 861014.startsWith is not a function
       Pulled the running image and read chunk.js:1:15825 — the chunk contains if (861014..startsWith(a))."`,
      ).fire,
      false,
    );
  },
);

check("a classic `at file:line:col` frame counts, any extension", () => {
  assert.equal(
    verdict(
      `gh pr create --body "Cannot read properties of undefined — at renderRow (Table.tsx:88:12)"`,
    ).fire,
    false,
  );
});

check("a query result WITH A COUNT is evidence", () => {
  assert.equal(
    verdict(
      `git commit -m "fix: drop the orphan rows
       TypeError: x is not a function came from these; the query returned 4 rows with a numeric key."`,
    ).fire,
    false,
  );
});

check("honest defensive hardening, said out loud", () => {
  assert.equal(
    verdict(
      `git commit -m "harden: String()-guard the key comparison
       Does not claim to fix the TypeError: 861014.startsWith is not a function — defensive
       hardening at a second call site; the crash site is not located yet."`,
    ).fire,
    false,
  );
});

check("an ordinary commit quoting no runtime error", () => {
  assert.equal(
    verdict(`git commit -m "feat(release): hold the pipeline for the release window"`)
      .fire,
    false,
  );
});

console.log("\nroot-cause-guard — the reason string is part of the contract");

// An operator who sees the prompt must learn WHICH of the three exits applied, not merely that
// something fired; a guard that cannot say why gets dismissed as noise.
check("the no-error case says so in its reason", () => {
  assert.equal(
    verdict(`git commit -m "chore: tidy"`).why,
    "no quoted runtime error",
  );
});

console.log("\nroot-cause-guard — the stdout contract, through the real hook");

check("★ MUST FIRE: a Bash commit that guesses prints ONE stdout JSON prompt, exit 0, stderr EMPTY", () => {
  const r = spawnHook(bash(`git commit -m "${GUESS}"`));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "", "stderr from a 0-exit hook reaches nobody — the prompt must not go there");
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /ROOT-CAUSE EVIDENCE MISSING/);
  assert.equal(typeof out.systemMessage, "string");
  assert.match(out.systemMessage, /ROOT-CAUSE EVIDENCE MISSING/);
  assert.equal("decision" in out, false, "a prompt, never a block");
});
check("☑ MUST NOT FIRE: a located fix prints nothing", () => {
  const r = spawnHook(bash(`git commit -m "${LOCATED}"`));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});
check("☑ MUST NOT FIRE: garbage stdin fails open", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "{not json", encoding: "utf8", cwd: FIXTURES });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

console.log("\nroot-cause-guard — only a Bash command commits");

check("☑ MUST NOT FIRE: an Edit event whose tool_input happens to carry `command` is not a commit", () => {
  // Measured: an Edit event with tool_input.command warned. A file edit is never a commit.
  const r = spawnHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x.md", command: `git commit -m "${GUESS}"` } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
check("☑ MUST NOT FIRE: no tool_name at all", () => {
  assert.equal(spawnHook({ hook_event_name: "PreToolUse", tool_input: { command: `git commit -m "${GUESS}"` } }).stdout, "");
});
check("★ MUST FIRE: the same command under tool_name Bash does (the twin of the Edit case)", () => {
  assert.match(spawnHook(bash(`git commit -m "${GUESS}"`)).stdout, /ROOT-CAUSE/);
});

console.log("\nroot-cause-guard — git global options before the verb");

check("★ MUST FIRE: `git -C repo commit -m …`", () => {
  assert.equal(TRIGGER_RE.test(`git -C repo commit -m "${GUESS}"`), true);
  assert.match(spawnHook(bash(`git -C repo commit -m "${GUESS}"`)).stdout, /ROOT-CAUSE/);
});
check("★ MUST FIRE: `git -c k=v commit -m …`", () => {
  assert.equal(TRIGGER_RE.test(`git -c commit.gpgsign=false commit -m "${GUESS}"`), true);
  assert.match(spawnHook(bash(`git -c commit.gpgsign=false commit -m "${GUESS}"`)).stdout, /ROOT-CAUSE/);
});
check("★ MUST FIRE: `git --no-pager -C a -c k=v commit`, stacked", () => {
  assert.equal(TRIGGER_RE.test(`git --no-pager -C a -c k=v commit -m "${GUESS}"`), true);
});
check("★ MUST FIRE: `gh pr create --body …` and `glab mr create --description …` still trigger", () => {
  assert.equal(TRIGGER_RE.test(`gh pr create --body "${GUESS}"`), true);
  assert.equal(TRIGGER_RE.test(`glab mr create --description "${GUESS}"`), true);
});
check("☑ MUST NOT FIRE: `git log`, `git commit-tree`, a string mentioning commit, and `git -C x status`", () => {
  for (const c of [`git log --oneline`, `git commit-tree HEAD^{tree}`, `echo "we should commit to this"`, `git -C x status`, `git diff --stat`])
    assert.equal(TRIGGER_RE.test(c), false, c);
});

console.log("\nroot-cause-guard — a message that lives in a file");

mkdirSync(join(FIXTURES, "repo"), { recursive: true });
writeFileSync(join(FIXTURES, "guess.txt"), GUESS);
writeFileSync(join(FIXTURES, "located.txt"), LOCATED);
writeFileSync(join(FIXTURES, "repo", "msg.txt"), GUESS);

check("messageFileOf sees every spelling", () => {
  assert.equal(messageFileOf("git commit -F msg.txt"), "msg.txt");
  assert.equal(messageFileOf("git commit -Fmsg.txt"), "msg.txt");
  assert.equal(messageFileOf("git commit --file msg.txt"), "msg.txt");
  assert.equal(messageFileOf("git commit --file=msg.txt"), "msg.txt");
  assert.equal(messageFileOf('gh pr create --body-file "notes/pr body.md"'.replace(" body", "-body")), "notes/pr-body.md");
  assert.equal(messageFileOf("gh pr create --body-file=f.md"), "f.md");
  assert.equal(messageFileOf('git commit -m "x"'), null);
});
check("★ MUST FIRE: `git commit -F guess.txt` — the guess is judged from the FILE", () => {
  const r = spawnHook(bash("git commit -F guess.txt"));
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /ROOT-CAUSE/);
});
check("★ MUST FIRE: `gh pr create --body-file guess.txt`", () => {
  assert.match(spawnHook(bash("gh pr create --title t --body-file guess.txt")).stdout, /ROOT-CAUSE/);
});
check("★ MUST FIRE: `git -C repo commit -F msg.txt` resolves the file against -C's directory", () => {
  assert.match(spawnHook(bash("git -C repo commit -F msg.txt")).stdout, /ROOT-CAUSE/);
});
check("★ MUST FIRE: the payload's cwd is where a relative file resolves", () => {
  const elsewhere = scratchDir("root-cause-guard-cwd");
  writeFileSync(join(elsewhere, "m.txt"), GUESS);
  assert.match(spawnHook(bash("git commit -F m.txt", { cwd: elsewhere })).stdout, /ROOT-CAUSE/);
});
check("☑ MUST NOT FIRE: `git commit -F located.txt` — the file carries a bundle offset", () => {
  const r = spawnHook(bash("git commit -F located.txt"));
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});
check("☑ MUST NOT FIRE: an UNREADABLE message file ⇒ nothing to judge ⇒ allow", () => {
  const r = spawnHook(bash("git commit -F does-not-exist.txt"));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  assert.equal(textToJudge("git commit -F does-not-exist.txt", FIXTURES), null);
});
check("the file is read CAPPED at 64 KB — an error past the cap is not seen, and that is the documented limit", () => {
  const big = join(FIXTURES, "big.txt");
  writeFileSync(big, "x".repeat(MESSAGE_FILE_CAP + 10) + "\n" + GUESS);
  const text = textToJudge(`git commit -F ${big}`, FIXTURES);
  assert.ok(text.length <= MESSAGE_FILE_CAP + `git commit -F ${big}`.length + 1);
  assert.equal(verdict(text).fire, false, "the quoted error sits past the cap");
  const small = join(FIXTURES, "small.txt");
  writeFileSync(small, GUESS);
  assert.equal(verdict(textToJudge(`git commit -F ${small}`, FIXTURES)).fire, true, "…and within it, it is seen");
});

console.log(
  `\n[root-cause-guard.test] ${ran - failures}/${ran} passed${failures ? `, ${failures} FAILED` : ""}.`,
);
if (failures) process.exit(1);
