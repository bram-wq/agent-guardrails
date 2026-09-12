---
name: Guard proposal
about: Propose a new guard, or a new case for an existing one
title: "guard: <one line — what it refuses>"
labels: guard-proposal
---

<!-- A guard starts from a measured incident, not from a category of thing that sounds risky.
     All four fields are required; a proposal missing one is parked until it has it. -->

## The incident, verbatim

<!-- The exact command or agent turn that went wrong, copied — not paraphrased — and what it cost
     (time, data, a false "landed"). This becomes the first must-fire test case. -->

```
```

## The legitimate twin

<!-- The closest command or turn that LOOKS the same and must keep working. This becomes the first
     must-not-fire case. If you cannot think of one, say so — that is useful information too. -->

```
```

## Proposed refusal

<!-- Event (PreToolUse / Stop), matcher (Bash, Edit|Write, …), the deterministic rule, and the
     reason text the agent should see. A reason carries the fix, not just the refusal. -->

## Denominator

<!-- How often would this guard RUN, and of those how often FIRE? A number from a transcript
     corpus, a fire log, or "unknown — here is how I would measure it". A guard that fires once in
     10,000 runs and a guard that fires in 4 of 10 need different designs. -->
