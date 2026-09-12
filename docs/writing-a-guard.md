# Writing a guard

The contract end to end, as the seven shipped hooks implement it and as the Claude Code hooks
reference (read 2026-09-12) describes it. Scaffold: `agent-guardrails new <name>` writes
`templates/guard.mjs` and a paired `<name>.test.mjs` into `.claude/hooks/`; this page is what the
template's comments point at.

## 1. The event: JSON on stdin

Claude Code writes one JSON object to the hook's stdin and closes it. Read it with
`readFileSync(0)` — synchronous, so nothing keeps the event loop alive afterwards (that matters in §4).

Common fields on every event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.

| event | fields a guard consumes | used by |
|---|---|---|
| `PreToolUse` | `tool_name` (`"Bash"`, `"Edit"`, `"Write"`, `"NotebookEdit"`, …), `tool_input` (`command` for Bash; `file_path` / `notebook_path` for edits), `tool_use_id` | prose, runaway, piped-verdict, root-cause, scope |
| `Stop` | `last_assistant_message`, `stop_hook_active` (true when this Stop was produced by a previous block — return 0 or you loop) | ui-evidence, goal |
| `SessionStart` | `session_id`, `cwd` | goal (re-injection) |

Match on `tool_name` inside the hook even though settings has a `matcher`: a hook wired under
the wrong matcher must still allow, not crash.

## 2. The decision: one stdout shape per event

```jsonc
// PreToolUse — deny. Reason is fed back to the model.
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…the fix…"}}
// Stop — block. Top-level, not hookSpecificOutput.
{"decision":"block","reason":"…the exact missing artefact…"}
// SessionStart — context the model reads as plain text.
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
// Allow / no finding — print nothing.
```

The reference: `permissionDecision` is `"allow"`, `"deny"` or `"ask"`; PreToolUse also accepts
`additionalContext`, `updatedInput` and `systemMessage`. "For `PreToolUse` permission decisions,
the most restrictive answer applies, in the order `deny`, `defer`, `ask`, `allow`." A deny reason
must carry the *fix*, not just the refusal: piped-verdict-guard prints the rewritten command.

Warn-only guards (root-cause-guard) write to **stderr** and exit 0. Know what that buys: "Stderr
from a hook that exits 0 goes to the debug log only, never the transcript, and Claude never sees
it." A warning on stderr is for the operator reading `claude --debug`, not for the model. If the
model must see it, use `additionalContext` or `systemMessage`.

## 3. Exit codes

- **0** — the JSON on stdout decides; empty stdout means no decision.
- **2** — "blocks whether or not you print JSON: even a JSON `permissionDecision` of `"allow"`
  can't override it." Stderr becomes the model's feedback. The shipped guards do not use it: they
  want the structured reason, and exit 2 on SessionStart cannot block anyway.
- **anything else** — non-blocking error; the action proceeds with a `<hook> hook error` notice.

Every shipped guard exits 0 on every path. A guard that exits non-zero on its own bug is a guard
that has just become a random error generator.

## 4. Write stdout ONCE, then fall off the end

`process.stdout.write(json)` at most once, and **no `process.exit()` after it**. Pipes are
asynchronous on Windows (and can be elsewhere); `process.exit()` does not drain them, so a deny
payload written just before it can be truncated — and a truncated deny is an *allow*. scope-guard
and piped-verdict-guard carry the note in source. `readFileSync(0)` is synchronous, so once the
decision is written nothing holds the loop open and the process exits with 0 on its own.
(`process.exit(0)` *before* any write, as an early allow, is fine.)

## 5. Fail direction

- **The harness fails open.** Unparseable stdin, a missing field, any exception → exit 0, no
  output. Wrap the whole decision in one `try … catch {}`.
- **The decision fails closed on input you cannot scan.** piped-verdict-guard denies above
  64 KiB *before* parsing, with a reason that says the command was not scanned. The reference
  makes the alternative explicit: a hook that reaches its `timeout` has its output discarded and
  "renders no decision" — so a guard that can be pushed past its timeout is a guard that can be
  switched off with a long string. Put a byte cap in front of anything super-linear. Bound every
  walk (scope-guard: 64 directories).

"Empty" and "could not check" must never print the same thing.

## 6. Telemetry

```js
import { recordFire, recordInvocation } from "./_fire-log.mjs";
recordInvocation("my-guard.mjs");              // module scope: the denominator, per hook
recordFire("my-guard.mjs", "deny", "my-kind"); // right before the single stdout write
```

`kind` matches `/^[a-z0-9][a-z0-9-]{0,39}$/` and is a constant in source. Never pass the command
or the reason: the log lives on disk and a denied secret write would log the secret. Both calls
return `false` rather than throw — telemetry never breaks a guard.

## 7. Tests: must-fire and must-not-fire, in pairs

Plain Node, spawn the hook exactly as Claude Code does (JSON on stdin, decision from stdout), one
line per case, non-zero on the first miss. Copy `hooks/scope-guard.test.mjs`. Required cases:

1. **must-fire**: the incident, verbatim, denied with a reason.
2. **must-not-fire**: its closest legitimate twin (`yes | head -3` next to `yes`).
3. **must-not-fire: the guard's own remediation advice.** Whatever the deny reason tells the agent
   to type instead must pass. piped-verdict-guard's suite feeds its own `rc=${PIPESTATUS[0]}`
   rewrite back through the guard. A guard that refuses the command it recommends is the worst
   false positive available.
4. **harness fails open**: garbage stdin → exit 0, empty stdout.
5. **oversize input**: the cap fires (closed) or is documented as open, whichever the guard chose.
6. **wrong `tool_name`** → allow.

Strip `CLAUDE_HOOKS_QUIET` from the spawned env, and set `HOOK_CTX=test` so the fire log's live
count is not inflated by the suite.

## 8. Mutation testing, by hand

Before opening the PR: comment out the branch that produces the deny, run the suite, and confirm
it goes **red**. Then comment out the bound check (the `| head` exemption, the size cap) and
confirm it goes red the other way. A suite that stays green with the guard's decision removed is
not covering the guard — `scope-guard.test.mjs` gained three cases exactly this way. There is no
tool for this; it takes two minutes and it is the only proof that the tests test.

## 9. Ship

Wire it in `settings.example.json` (exec form: `"command": "node", "args": [path]`, a `timeout`
in seconds), add the README row and the CHANGELOG line, and update [COMPAT.md](COMPAT.md) — a PR
that changes a hook's stdin or stdout shape without touching COMPAT.md is not reviewable
(CONTRIBUTING.md, "docs contract").
