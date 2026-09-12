# Benchmark: what a guard costs per call

A PreToolUse guard is a fresh Node process on every matching tool call. The number that decides
whether it stays installed is its wall time on a **benign** event, which is nearly every event.
`scripts/bench.mjs` measures that: each hook, N=30 spawns with a benign event of its own type
(plus one discarded warm-up), against `node -e 0` as the floor. Runs are tagged `HOOK_CTX=test`
and pointed at a throwaway fire log and state dir, so a bench never inflates the live denominator.

```sh
node scripts/bench.mjs           # N=30
node scripts/bench.mjs --n 100
```

## Measured 2026-09-12

Both runs on the same machine (WSL2, Linux 6.6.87, x64), same commit, minutes apart. Everything
below is pasted from the script's stdout unedited.

### Node 24.19.0

```
command: node scripts/bench.mjs
date: 2026-09-12 · os: linux 6.6.87.2-microsoft-standard-WSL2 x64 · node: v24.19.0 · N=30 per row (+1 warm-up)

| hook | event | p50 ms | p95 ms | min | max | p50 − baseline |
|---|---|---:|---:|---:|---:|---:|
| node -e 0 (baseline) | — | 38.1 | 78.4 | 33.6 | 87.2 | — |
| prose-guard.mjs | PreToolUse·Bash | 40.9 | 46.9 | 36.5 | 48.7 | 2.9 |
| runaway-guard.mjs | PreToolUse·Bash | 39.1 | 42.9 | 35.9 | 43.0 | 1.1 |
| piped-verdict-guard.mjs | PreToolUse·Bash | 41.2 | 48.7 | 37.9 | 50.8 | 3.1 |
| root-cause-guard.mjs | PreToolUse·Bash | 39.1 | 47.1 | 37.1 | 47.1 | 1.1 |
| scope-guard.mjs | PreToolUse·Edit | 39.2 | 42.4 | 36.8 | 42.9 | 1.2 |
| ui-evidence-guard.mjs | Stop | 39.8 | 42.2 | 38.2 | 42.9 | 1.7 |
| goal-guard.mjs | Stop | 45.7 | 50.8 | 43.4 | 55.6 | 7.7 |

Bash tool call, sum of the 4 Bash-matched guards' p50 if run serially: 160.4 ms; Claude Code runs matching hooks in parallel, so the wall cost is nearer the slowest (41.2 ms) plus 4 Node starts of CPU.
```

### Node 20.18.1 (the CI floor; `/usr/local/bin/node scripts/bench.mjs`)

```
command: node scripts/bench.mjs
date: 2026-09-12 · os: linux 6.6.87.2-microsoft-standard-WSL2 x64 · node: v20.18.1 · N=30 per row (+1 warm-up)

| hook | event | p50 ms | p95 ms | min | max | p50 − baseline |
|---|---|---:|---:|---:|---:|---:|
| node -e 0 (baseline) | — | 75.7 | 104.6 | 73.4 | 106.1 | — |
| prose-guard.mjs | PreToolUse·Bash | 88.6 | 97.4 | 85.7 | 97.9 | 12.9 |
| runaway-guard.mjs | PreToolUse·Bash | 88.3 | 97.7 | 84.7 | 105.6 | 12.6 |
| piped-verdict-guard.mjs | PreToolUse·Bash | 102.0 | 126.7 | 90.6 | 140.3 | 26.2 |
| root-cause-guard.mjs | PreToolUse·Bash | 95.3 | 140.3 | 88.1 | 143.7 | 19.6 |
| scope-guard.mjs | PreToolUse·Edit | 87.2 | 91.7 | 85.4 | 93.3 | 11.5 |
| ui-evidence-guard.mjs | Stop | 89.4 | 95.3 | 87.5 | 97.1 | 13.7 |
| goal-guard.mjs | Stop | 91.8 | 115.6 | 88.6 | 131.0 | 16.1 |

Bash tool call, sum of the 4 Bash-matched guards' p50 if run serially: 374.3 ms; Claude Code runs matching hooks in parallel, so the wall cost is nearer the slowest (102.0 ms) plus 4 Node starts of CPU.
```

## Reading it

- **The guard is not the cost; Node startup is.** On Node 24 every guard is within 1–8 ms of a
  bare `node -e 0`. On Node 20 the same code sits 12–26 ms above a 76 ms floor — the floor itself
  doubled between the two binaries on this machine, and that dominates. Measure on the Node you
  actually run; the ratio is what carries across machines, not the milliseconds.
- **goal-guard is the slowest benign path** (it stats the per-worktree goal file and runs
  `git rev-parse` to key it). piped-verdict-guard is the largest module of the four Bash guards
  (436 lines, a quote-aware scanner) and shows it on Node 20; the scanner is linear and its own
  suite asserts a 2x budget on 60 KiB adversarial input.
- **p95 on the baseline (78 ms) exceeds p50 on every guard.** Scheduler noise on a shared machine is
  larger than any guard's own work. Do not read a 3 ms delta as a finding.

## The per-Bash-call cost

With the shipped `settings.example.json`, one Bash tool call spawns **four** Node processes
(prose, runaway, piped-verdict, root-cause) — five once a fence guard is added, as in production.
Claude Code runs the matching hooks in parallel, so wall time is roughly the slowest one
(~40 ms on Node 24, ~100 ms on Node 20 here), but CPU is four starts, and on a loaded machine the
parallel starts serialise.

Mitigations, cheapest first:

1. **`if` filter on the handler** (reference, 2026-09-12): `"if": "Bash(git *)"` on
   piped-verdict-guard means "the hook process only spawns when the tool call matches", removing
   one start from every non-git command. root-cause-guard could take `"Bash(git commit *)"`. Not
   adopted in `settings.example.json` yet — see [COMPAT.md](COMPAT.md) for why.
2. **A single runner process.** Production wires the Bash guards through one `node runner.mjs`
   that imports the guards and runs them in-process, so one start serves all of them and a deny
   from any one of them is the runner's stdout. The direct wiring shipped here is simpler and has
   no shared failure mode; it pays one start per guard for that.
3. **Drop a guard on counts.** `agent-guardrails report` shows runs and fires per hook. A guard
   that ran 4,000 times and never fired costs 4,000 starts for nothing measurable — but read
   `never ran` and `ran, never fired` as different sentences before deleting anything.

## What this bench does not measure

The incident path (a deny), which is rarer and slightly slower; Windows and macOS, where process
start is more expensive (CI runs the suites there, not this bench); and the harness's own overhead
around the spawn, which is Claude Code's and not visible from here.
