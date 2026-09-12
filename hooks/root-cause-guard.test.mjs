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
// CONTRACT under test: the guard PROMPTS (stderr + exit 0) when a commit/PR message quotes a runtime
// error and claims a fix while naming no locating evidence. It never blocks.
//
// Every case below is modelled on a real message from the incident in the hook's header or its
// correction, so the guard is pinned against what actually happened rather than invented prose.
import assert from "node:assert/strict";
import { verdict } from "./root-cause-guard.mjs";

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
      `glab mr create --description "Cannot read properties of undefined — at renderRow (Table.tsx:88:12)"`,
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

console.log(
  `\n[root-cause-guard.test] ${ran - failures}/${ran} passed${failures ? `, ${failures} FAILED` : ""}.`,
);
if (failures) process.exit(1);
