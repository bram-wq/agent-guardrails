# Threat model

**Not a security boundary; an accident guard.** Every hook in this repository runs as the same OS
user as the agent, from files the agent can edit, under a settings file the agent can edit. The
guards make a class of *mistakes* impossible to commit silently. They make no *adversary* unable to
do anything. If your threat is an agent that wants to bypass them, the answer is the permission
system, a sandbox, or a separate identity, not more hooks.

## What the guards protect against: agent ERROR

Each row is a failure that happened at least once in production and was measured before it was
turned into a refusal. The tests quote the incident.

| failure | what it cost | guard | event |
|---|---|---|---|
| Prose meant for the assistant reached the shell (`yes for sure`) | `yes` ran until the disk filled | prose-guard, runaway-guard | PreToolUse·Bash |
| A generator with no bound (`cat /dev/urandom`, `while true`) | disk churn, a lost round | runaway-guard | PreToolUse·Bash |
| `git push … \| grep -v … \| tail` masked a blocked push | an MR "ready" on a branch that did not exist | piped-verdict-guard | PreToolUse·Bash |
| A fix aimed by reading source while the crash lived in the bundle | two dead PRs, hours | root-cause-guard (warn only) | PreToolUse·Bash |
| An edit two lanes over, outside the task's declared paths | two sessions overwriting one file | scope-guard | PreToolUse·Edit/Write |
| "Done" on a UI branch with nothing rendered | dozens of defects found by a post-hoc walk | ui-evidence-guard | Stop |
| "Done" before the stopping command ever exited 0 | twelve tool calls on an inferred, wrong objective | goal-guard | SessionStart, Stop |
| Irreversible presses (push to main, infra apply, secret write) | see [DOCTRINE.md](DOCTRINE.md) §6 | fence-guard | PreToolUse·Bash |
| A live key read from a log, written into `.env`, committed next turn | rotation, a history rewrite, a week of "is this the only copy" | secret-write-guard | PreToolUse·Write/Edit/Bash |
| A hook switched off in `settings.json` mid-task "to get unblocked" | every guard below silently gone for the rest of the session | config-tamper-guard | PreToolUse·Write/Edit/Bash, SessionStart |

The common shape: the agent did the wrong thing *while believing it was the right thing*, and
the transcript read as clean. A guard's job is to make that turn read as red instead.

## What the guards do NOT protect against: agent MALICE

A command hook is a process Claude Code spawns as your OS user, with your environment, from a
path in a settings file you can edit. Everything below follows from that and from the settings
precedence order (managed > command line > project local > shared project > user).

| bypass | severity | why it is accepted |
|---|---|---|
| The agent edits `.claude/settings.local.json` (or `settings.json`) and removes a hook, or sets `"disableAllHooks": true`. The docs: "Claude Code reads the value left after settings precedence applies, so a project's settings file can override yours." | high → medium with `config-tamper-guard` | The same user owns both files. Only managed settings sit above them, and "Hooks configured in managed settings still run unless `disableAllHooks` is also set there" — put the hooks there if you need this closed. Since 0.3.0 `config-tamper-guard` refuses the *accidental* form of this through every tool and Bash write shape, and SessionStart prints a fingerprint of the surface; the deliberate form is unchanged. |
| The agent edits `.claude/hooks/*.mjs` itself, or `.agent-scope` (scope-guard allows editing its own scope file by design) | high → medium with `config-tamper-guard` | Same user, same tree. scope-guard is a lane-collision guard, not an access control; review is the control. `config-tamper-guard` refuses writes under `.claude/hooks/` and to `.agent-scope`; scope-guard still allows its own scope edit unless it widens itself. |
| `HOOK_STATE_DIR` / the goal-guard ledger is writable from the agent's Bash; a `--prove` can be faked by writing `exit=0` into `goal-ledger.log` | medium | goal-guard measures *forgetting*, not lying. `--prove` runs the real command so an honest agent cannot mis-record; a dishonest one has the transcript against it. |
| `CLAUDE_HOOKS_QUIET=1` lifts piped-verdict-guard entirely (`main()` returns before reading stdin) | medium | Deliberate escape valve for a heads-down session; the tests strip the variable so it can never hide a green. goal-guard and ui-evidence-guard do **not** honour it for blocking decisions. |
| A PreToolUse hook that times out does not block: "Claude Code cancels a command … hook that reaches its timeout, discarding the hook's output, so on most events a timed-out hook renders no decision" | medium | Fail-open is the doctrine (§3). piped-verdict-guard refuses oversize input *before* scanning so it cannot be pushed past its timeout; scope-guard bounds its directory walk at 64 for the same reason. |
| ui-evidence-guard exits 0 on stdin above 4 MB; goal-guard above 8 MB | low | A Stop payload that large is a harness fault, not an agent choice; blocking it would brick the session. Both caps are named in source. |
| The fire log (`HOOK_FIRE_LOG`) is appendable by anyone; `report` counts can be inflated or trimmed | low | It is telemetry for a *deletion* decision, never evidence for an incident. Reason text is never logged (SECURITY.md). |
| No network coverage, no secret-exfiltration coverage, no `curl … \| sh` guard | n/a | Out of scope. These guards read one command or one message; they never see what a command does. Use the permission system's deny rules and a sandbox. |
| A malformed-JSON hook event, or an exception inside a guard, allows (exit 0, no output) | by design | "A guard that bricks a session gets switched off, which is worse than no guard." The harness fails open; only the *decision* on oversize input fails closed. |
| The `if` filter, if adopted, is best-effort: "When Claude Code can't determine which commands the Bash input runs, it runs your hook regardless of the pattern" | n/a | Not used yet (see [COMPAT.md](COMPAT.md)); the failure direction is "runs more often", which is the safe one. |

## What "accepted" means

A bypass is accepted when the honest agent cannot hit it by accident and the dishonest agent
would leave the bypass in the transcript. Every row above meets that bar. None of them meets the
bar for "an attacker with the agent's shell cannot do X" — and no hook can, because the hook *is*
the agent's shell.

If you need a boundary, the docs' own advice applies: "Because the filter is best-effort, use the
permission system rather than a hook to enforce a hard allow or deny." Layer, in this order:
managed settings (cannot be edited by the project), permission deny rules, a sandbox with network
isolation, then these hooks for the mistakes that survive all three.

## Verified against

`https://code.claude.com/docs/en/hooks`, `…/hooks-guide`, `…/settings`, read 2026-09-12. The
quoted sentences are from those pages; re-read them before relying on any exit-code or timeout
claim here, because the semantics have changed before.
