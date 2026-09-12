# Doctrine: running coding agents you can trust

These are the rules behind the guards in this repository. They were written for a production engineering
operation where several model families (Claude, GPT, Codex) work in parallel git worktrees on one monorepo,
and where a fail-closed pre-merge pipeline, not a human, decides what lands on `main`.

## 1. If it can be a mechanism, it must not be a sentence

A rule in a prompt file is a request. A hook that exits non-zero is a fact. When a correction recurs, the
first question is whether a hook, a gate or a refusing script can make the wrong thing impossible. Only a
judgement call that genuinely needs a human stays as prose.

## 2. Every guard has a must-fire and a must-not-fire test

A guard that only proves it blocks the bad case will be switched off the first time it blocks a good one.
Each `*.test.mjs` here pins both sides: the incident verbatim, and the legitimate twin that must pass.
The guard is the distinction between them.

## 3. Fail open on your own bugs, fail closed on the world's

A parse error inside a guard exits 0 and allows: a guard bug must never block real work. A red check in
the merge pipeline refuses: an unproven change must never land. The two failure modes point in opposite
directions on purpose.

## 4. Silence is a defect, not an absence

`2>/dev/null` belongs only where failure is expected and handled. A probe that cannot fail proves nothing.
"Empty" and "could not find out" must never print the same sentence. A command whose exit code is the
answer must never be piped into `tail`.

## 5. Evidence, not claims

"Done", "fixed" and "works" are not verdicts. A completion claim carries the exact command and its output;
a UI change carries a screenshot. A Stop hook refuses the turn otherwise. Verdicts are one of five:
verified complete, verified with accepted limitations, blocked, failed verification, aborted.

## 6. Irreversible actions need a human press

Pushes to `main`, infrastructure applies, secret writes, destructive SQL and archive extraction are
refused deterministically inside a session, and nothing settable in a session lifts the refusal. The
plane presses; the human holds the switch.

## 7. Measure the system, research the world

For any fact about the codebase or the infrastructure, one command beats any amount of reasoning, and the
command is nearly free. Memory notes are leads, never answers.
