# I let coding agents merge to main without me. Here is what it took.

*Bramantya Farid Prakoso · September 2026 · Companion repo: https://github.com/bram-wq/agent-guardrails · numbers measured 2026-09-12*

For the last nine months I have run product and engineering for an ed-tech platform with a small human
team and a fleet of coding agents: Claude, GPT and Codex, in parallel git worktrees, on one TypeScript
monorepo. The fleet has landed 2,276 merges. No human sits in the merge loop. The pipeline lands
76 merged changes a day on average, 125 on the peak day, at about USD 1.30 of CI each, and I can tell
you the cost of any single one.

None of that came from a better prompt. It came from refusing to let rules stay sentences.

## The first month was a disaster, in a specific way

Agents did not fail by writing bad code. They failed by *saying things that were not true*. "Done."
"Tests pass." "Deployed." Each claim was plausible, most were sincere, and a meaningful fraction were
wrong. The wrong ones were expensive because nobody was checking, which was the whole point of the fleet.

Three incidents shaped everything after:

- An agent answered a yes/no question with "yes for sure". The words reached the shell. `yes` is a real
  command. It wrote 5 GB before the harness killed it.
- An agent ran `git merge … 2>&1 | tail -5`, read tail's exit code as the merge's, and reported success on
  a failed merge. Twice in one session.
- A batch of UI branches merged green on tests alone. A rendered walk-through afterwards found dozens of
  visible defects. The tests were real. The claim "UI done" was not.

The common shape: an agent's claim was accepted as evidence. The fix was never "tell the agent to be
careful". The fix was to make the claim impossible to make without the evidence.

## Rule one: if it can be a mechanism, it must not be a sentence

Every rule in my CLAUDE.md that mattered eventually became a hook that exits non-zero. Today there are
50 of them, 48 with paired tests, and 340 gate scripts in CI behind them. The seven most portable are in
the repo linked above. What they refuse:

| Guard | Refuses |
|---|---|
| prose-guard | A "command" whose first word is not a program, builtin or file. A sentence that reached the shell. |
| runaway-guard | `yes`, `/dev/urandom`, `seq inf`, `while true` with nothing bounding them. `yes \| head -3` is fine. |
| piped-verdict-guard | `git push / merge / rebase` piped into `tail`, so the exit code you read is tail's. |
| scope-guard | Writes outside the paths a task reserved, so two lanes cannot silently overwrite each other. |
| root-cause-guard | A fix aimed at a named crash with no artefact (log, trace, failing test) naming the cause. |
| ui-evidence-guard | A Stop message claiming UI work is done while the diff touches UI and no screenshot exists. |
| goal-guard | Ending a task whose machine-checkable DONE command has not been proven to exit 0. |

Each one is a few hundred lines of plain Node, decides in milliseconds, and prints a reason that carries
the fix, not just the refusal.

## Rule two: every guard has a must-fire and a must-not-fire test

This is the rule I would keep if I could keep only one. A guard that only proves it blocks the bad case
will be switched off the first week it blocks a good one. So each test file pins both: the incident,
verbatim, and the legitimate twin that must pass.

The piped-verdict guard is the cautionary tale. The first version also refused `npm test | tail`. Telemetry
showed thousands of runs and a dozen fires, every fire a re-typed command. I narrowed it to the three git
verbs where the masked verdict had actually caused damage, and the must-not-fire cases now pin that
narrowing so it cannot silently widen again. A guard's fire count is a measurement with a denominator,
never a feeling.

## Rule three: evidence, not claims

"Done" is not a verdict. A completion claim carries the exact command and its output. A UI change carries
a screenshot. A Stop hook refuses the turn otherwise. Verdicts are one of five: verified complete, verified
with accepted limitations, blocked, failed verification, aborted. "Mostly done" is not on the list.

This one rule changed the texture of every agent report I read. The agents did not become more honest.
They became unable to be vague.

## Rule four: irreversible actions need a human press

Pushes to main, infrastructure applies, secret writes, destructive SQL and archive extraction are refused
deterministically inside any session, and nothing settable in a session lifts the refusal. The pipeline
presses. The human holds the switch and is informed on an alarm channel. Nobody waits on a human for
routine work, and no agent can do the one thing that cannot be undone.

## Rule five: measure the system, research the world

For any fact about our codebase or infrastructure, one command beats any amount of reasoning, and the
command is nearly free. The corollary hurt more: memory notes, docblocks and even locked decisions are
leads, never answers. Twice a guard blocked its own fix on a credential story in a comment that a live
check refuted in seconds.

## What it bought

- 2,276 merges landed by the pipeline, reviewed adversarially across model families, routed by blast
  radius so a docs change and a migration do not get the same scrutiny.
- CI cost attributed per merge: USD 101 a day at peak, USD 1.30 per merged change, and a report that
  says which 15 builds to cut first.
- A five-line brief format for every non-trivial task: goal, why, constraints, a machine-checkable DONE
  command, stakes. A Stop hook refuses to end a task whose DONE command has not run green.
- 53 architecture decision records, because a decision an agent cannot find is a decision it will remake.

## What I would tell someone starting

Start with the Stop hook that refuses "done" without a command and its output. It is fifty lines and it
changes everything downstream. Then write the must-not-fire test for every guard before the must-fire one,
because the false positive is what will get your guard deleted. Then measure fire counts, and prune on
counts, never on opinions.

The repo has the seven guards, their 377 paired tests, a one-command installer, a demo that runs in a
minute, and the doctrine on one page.

*Bramantya Farid Prakoso runs product and engineering at an ed-tech non-profit in Southeast Asia and
previously founded Managix, a Meta Ads automation company acquired by Evermos. He writes about running
coding agents unattended; the guards are at github.com/bram-wq/agent-guardrails.*
