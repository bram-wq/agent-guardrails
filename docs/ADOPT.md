# Adopting the guards on a repo that is not the author's

A walkthrough in four steps, each ending with a command whose output tells you whether it worked.
Assumes Node ≥ 20, git, and a project that already runs Claude Code.

## Day 0 — install, and prove it is wired

Pin the tag. `npx github:…` without a ref tracks the default branch, which is a moving target.

```sh
npx github:bram-wq/agent-guardrails#v0.5.0 init --dry-run   # the plan: files, settings keys, backup path
npx github:bram-wq/agent-guardrails#v0.5.0 init             # copies hooks and merges settings after a backup
npx github:bram-wq/agent-guardrails#v0.5.0 doctor           # standalone hook checks and settings paths
```

`init` never overwrites a hook you already have and never removes a settings key; add `--user`
to target `~/.claude` instead. In a Claude Code session, run `/hooks` and compare the loaded entries
against `settings.example.json` for the installed tag, including PreCompact. Doctor checks standalone
behavior; the host's loaded list and an actual benign/incident pair check runtime integration.
From v0.5.0, `doctor --strict` also checks that every shipped registration is present unchanged:
event, matcher, command and handler options.

Two guards are inert until you opt in: scope-guard (needs a `.agent-scope` file) and goal-guard
(needs `--set`). Other hooks depend on their registered lifecycle event, not necessarily the first tool call.

## Day 1 — read the first report

```sh
npx github:bram-wq/agent-guardrails#v0.5.0 report
```

The status column has two zero-states and they mean opposite things:

- **`never ran`** — no run line for that hook. It is not wired, or the settings file Claude Code
  loaded is not the one you edited. Go back to `/hooks`.
- **`ran, never fired`** — the denominator is there; the guard has seen traffic and found nothing.
  Good, and expected on day 1 for most of them.

A hook that shows `never ran` after a day of sessions is a defect in the install, not evidence
that the guard is unnecessary.

## Week 1 — tune

**ui-evidence-guard's notion of "user-visible".** It ships with a regex matching
`apps/web/(app|components|messages)/`, which is the author's layout. Set `UI_EVIDENCE_PATHS` in
the hook's environment (Claude Code's `env` settings block, or your shell) to a regex matching the
paths that render in *your* repo — `^src/(pages|components)/` for a typical Vite app. Too wide and
it demands screenshots for a README; too narrow and it is a ritual. Check the fire log after a
week of UI branches.

**goal-guard cadence.** Decide who runs `--set`: the operator at the start of each task, or the
agent as its first act (the production rule is the agent states `GOAL … DONE WHEN <command>` and
arms it). Either way the stopping command must be a read-only verification shape
(`npm test`, `npm run lint`, `node check.mjs`); the guard refuses `rm`, `git push --force` and
`DROP TABLE` at `--set`. `--clear` when the goal is met, or the next session inherits it as a
lead it must confirm.

**scope-guard.** Drop a `.agent-scope` into each agent worktree:
`{"allow":["src/billing/**"],"deny":["**/auth.ts"],"reason":"slice B"}`. No file, no enforcement.

**Prune on counts, not on feel.** Illustrative report after one week — every number below is
made up to show the shape of the decision, not measured:

| hook | runs | fires | rate | status | decision (illustrative) |
|---|---:|---:|---:|---|---|
| prose-guard | 3,120 | 4 | 0.1% | fires | keep: each fire was a sentence in the shell |
| runaway-guard | 3,120 | 0 | 0.0% | ran, never fired | keep: cheap, the incident is catastrophic |
| piped-verdict-guard | 3,120 | 2 | 0.1% | fires | keep; consider `if: "Bash(git *)"` |
| root-cause-guard | 3,120 | 11 | 0.4% | fires (warn) | read the 11 in `claude --debug`; if all were honest hardening, narrow the regex |
| scope-guard | 840 | 0 | — | never ran | not a prune candidate: no `.agent-scope` exists yet |
| ui-evidence-guard | 190 | 9 | 4.7% | fires | 9 blocks in a week is high: check `UI_EVIDENCE_PATHS` before trusting the rate |
| goal-guard | 190 | 1 | 0.5% | fires | keep |

The rule: a guard with a real denominator and a fire rate that is *all* false positives gets
narrowed or removed; a guard with zero fires against a catastrophic incident stays; a guard with
zero runs is a wiring bug.

## Rollback

```sh
npx github:bram-wq/agent-guardrails#v0.5.0 uninstall            # removes owned entries and unmodified copied hooks
```

`init` wrote a backup next to your settings before its first merge:
`.claude/settings.json.bak-<timestamp>`. Restoring it by hand is the same rollback without the
CLI. Hook state and telemetry live outside the repo (`$XDG_STATE_HOME/claude-hooks/`) and can be
deleted at any time; nothing in the working tree was touched, so `git status` is the proof.

To silence one guard for one session without uninstalling: `CLAUDE_HOOKS_QUIET=1` lifts
piped-verdict-guard only. The Stop guards do not honour it for a blocking decision, by design.
