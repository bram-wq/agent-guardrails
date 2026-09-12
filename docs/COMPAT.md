# Compatibility

What each guard consumes and emits, against which Claude Code contract, verified on which date.
A PR that changes a hook's stdin or stdout shape updates this file in the same commit
(CONTRIBUTING.md, "docs contract").

**Reference pages** — `https://code.claude.com/docs/en/hooks`, `…/hooks-guide`, `…/settings`.
**Verified**: 2026-09-12. The semantics quoted below are from that read; nothing here is recalled.

## Per guard

| guard | event · matcher | stdin fields consumed | stdout on a finding | exit | stdin cap |
|---|---|---|---|---|---|
| fence-guard | PreToolUse · `Bash` | `tool_name`, `tool_input.command` | `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` | 0 | 64 KiB, **deny** above (fails closed) |
| prose-guard | PreToolUse · `Bash` | `tool_name`, `tool_input.command`, `cwd` (relative paths resolve against it) | same deny shape | 0 | 64 KiB, **deny** above (fails closed) |
| runaway-guard | PreToolUse · `Bash` | `tool_name`, `tool_input.command` | same deny shape | 0 | 64 KiB, **deny** above (fails closed); statements evaluated per pipeline |
| piped-verdict-guard | PreToolUse · `Bash` | `tool_name`, `tool_input.command` | same deny shape | 0 | 64 KiB, **deny** above (fails closed) |
| root-cause-guard | PreToolUse · `Bash` | `tool_name`, `tool_input.command` (and the file named by `-F` / `--body-file`) | `hookSpecificOutput.additionalContext` + top-level `systemMessage`; never a deny | 0 | 64 KiB of message text |
| scope-guard | PreToolUse · `Edit\|MultiEdit\|Write\|NotebookEdit` | `tool_name`, `tool_input.file_path` / `notebook_path`, `cwd`; for an edit of `.agent-scope` itself: `tool_input.content` / `old_string` + `new_string` / `edits` | same deny shape | 0 | 8 MB, **deny** above; 64-directory walk bound; globs over 512 chars are a malformed scope (deny) |
| secret-write-guard | PreToolUse · `Write\|Edit\|MultiEdit\|NotebookEdit` and `Bash` | `tool_name`, `tool_input.content` / `new_string` / `edits[].new_string` / `new_source` / `command`, `tool_input.file_path` / `notebook_path` (allowlist only) | same deny shape; reason carries rule id + file:line, never the match | 0 | 1 MB, **deny** above (fails closed); a missing or malformed rules file fails **open** with a fire of kind `error` AND a top-level `systemMessage` saying the guard is OFF |
| config-tamper-guard | PreToolUse · `Write\|Edit\|MultiEdit\|NotebookEdit` and `Bash`; SessionStart | `hook_event_name`, `cwd`, `tool_name`, `tool_input.file_path` / `notebook_path` / `command` | PreToolUse: same deny shape; SessionStart: `hookSpecificOutput.additionalContext` (fingerprint), never a block | 0 | 1 MB, **deny** above (fails closed) |
| precompact-handoff | PreCompact (no matcher: `auto` and `manual`) | `hook_event_name`, `cwd`, `trigger`, `custom_instructions` (presence recorded, text never copied) | nothing: PreCompact discards `systemMessage` and has no `additionalContext`; the handoff is a file under `…/claude-hooks/handoff/<slug>.md` | 0 | 1 MB, allow above (never blocks) |
| ui-evidence-guard | Stop | `last_assistant_message`, `stop_hook_active` | top-level `{"decision":"block","reason"}` | 0 | 4 MB, **allow** above (fails open: a Stop block on oversize input would loop); screenshots must carry PNG/JPEG/GIF/WebP magic bytes; base ref `origin/main` → `origin/master` → `upstream/main` → `main`, none → stderr + allow |
| goal-guard | SessionStart, Stop | `hook_event_name`, `cwd`, `session_id`, `last_assistant_message` (non-string → allow), `stop_hook_active` | SessionStart: `hookSpecificOutput.additionalContext`; Stop: top-level `{"decision":"block","reason"}` | 0 | 8 MB, allow above |

Every guard: unparseable stdin or an internal exception → exit 0, empty stdout (fail open). A malformed
`.agent-scope` (wrong shape, or JSON that does not parse) is the world's defect, not the hook's, and scope-guard
denies on it naming the file. No
guard uses exit 2. No guard reads `transcript_path`. Fire telemetry goes to
`$XDG_STATE_HOME/claude-hooks/hook-fires.log` (`HOOK_FIRE_LOG` overrides); goal state to
`…/claude-hooks/goals/<worktree>/` (`HOOK_STATE_DIR` overrides).

## Codex CLI adapter (`hooks/adapters/codex.mjs`)

The same guards under OpenAI Codex CLI's hooks. Facts and their sources: [CODEX.md](CODEX.md)
(read 2026-09-12); anything tagged NE there is not depended on.

| Codex event · matcher (written by `init --agent codex`) | stdin fields consumed | guards spawned | stdout on a finding | exit | stdin cap |
|---|---|---|---|---|---|
| PreToolUse · `^Bash$` | `hook_event_name`, `tool_name`, `tool_input.command`, `cwd` (passed through unchanged — same names as Claude Code) | fence, prose, runaway, piped-verdict, root-cause, secret-write, config-tamper | one `hookSpecificOutput.permissionDecision: "deny"` with every denying guard's reason joined; `additionalContext` when only root-cause-guard spoke | 0 | 8 MiB, **deny** above (fails closed) |
| PreToolUse · `^apply_patch$` | `tool_input.command` (the patch text) split into one synthetic `Write`/`Edit` event per `*** Add/Update/Delete File:` header, paths resolved against `cwd` | scope, secret-write, config-tamper — each on every file | same deny shape | 0 | 8 MiB, **deny** above; a patch with no recognisable header → allow (CODEX.md F21) |
| Stop (no matcher) | `stop_hook_active`, `last_assistant_message` (passed through) | ui-evidence, goal | top-level `{"decision":"block","reason"}` | 0 | 8 MiB, **allow** above (a block here would loop) |
| SessionStart (no matcher) | `source`, `cwd` (passed through) | goal, config-tamper | `hookSpecificOutput.additionalContext` | 0 | 8 MiB, allow above |
| PreCompact (no matcher) | `trigger`, `custom_instructions` (passed through) | precompact-handoff | nothing (the handoff is a file) | 0 | 8 MiB, allow above |

Adapter: unparseable stdin, an unknown event or tool, a guard that exits non-zero or prints
non-JSON, or an internal exception → exit 0, empty stdout, the cause on stderr (fail open). One
stdout write, natural exit, never exit 2. `try --agent codex` runs the Codex-shaped event through
the adapter one guard at a time and prints the same table as `try`.

## Contract semantics relied on

| semantic | reference text (2026-09-12) | relied on by |
|---|---|---|
| exit 0 + JSON decides | "Exit 0 means success, and is the intended exit code when you print JSON for structured control." | all |
| stderr on exit 0 is invisible to the model | "Stderr from a hook that exits 0 goes to the debug log only, never the transcript, and Claude never sees it." | root-cause-guard is therefore an operator prompt, not model feedback |
| PreToolUse deny fields | `permissionDecision`, `permissionDecisionReason`; also `additionalContext`, `updatedInput`, `systemMessage` | the five PreToolUse guards use the first two only |
| most restrictive wins | "the most restrictive answer applies, in the order `deny`, `defer`, `ask`, `allow`" | four Bash guards run in parallel; any deny holds |
| Stop block shape | "`PostToolUse` and `Stop` hooks use a top-level `decision: "block"` field" | ui-evidence-guard, goal-guard |
| `stop_hook_active` | set when Claude is already continuing from a Stop block | both Stop guards return 0 on it (loop safety) |
| SessionStart context | plain-text stdout or `additionalContext` "as context that Claude can see and act on" | goal-guard re-injection |
| timeout = no decision | "Claude Code cancels a command … hook that reaches its `timeout`, discarding the hook's output, so on most events a timed-out hook renders no decision." | why piped-verdict-guard caps input and scope-guard bounds its walk |
| exec form | "A command hook runs as exec form when `args` is set … spawns it directly with `args` as the argument vector." | `settings.example.json` uses `"command": "node", "args": [...]` — no shell, so the same entry works on Windows |
| dedup across settings files | "If you define the same handler in more than one settings file, it runs once." | `init` merges by command+args, so a user-level and project-level install do not double-run |
| `${CLAUDE_PROJECT_DIR}` | expanded by Claude Code in hook args | project installs; `--user` installs rewrite to absolute paths |

## Runtime matrix (CI: `.github/workflows/test.yml`)

| | Node 20 | Node 22 |
|---|---|---|
| ubuntu-latest | `node test.mjs`, `node demo.mjs`, `init --dry-run` | same |
| macos-latest | same (goal-guard keys by `realpath` for the `/private/tmp` symlink) | same |
| windows-latest | same (hooks detect direct invocation by `basename`; no shell anywhere) | same |

Node 24 is not in CI; the benchmark in [BENCH.md](BENCH.md) was additionally run on it locally.
`engines.node` is `>=20`.

## Newer handler fields: not used yet

The reference now documents `if`, `once`, `async` and `statusMessage` on every handler. None of the
shipped hooks or `settings.example.json` use them, for these reasons:

- **`if`** — "uses permission rule syntax to filter hooks by tool name and arguments together, so
  the hook process only spawns when the tool call matches." `"if": "Bash(git *)"` on
  piped-verdict-guard would skip the Node spawn on every non-git command (its scope is `git push`
  / `merge` / `rebase` only), removing one process start from most Bash calls. Not adopted yet
  because it is best-effort by the docs' own account — "When Claude Code can't determine which
  commands the Bash input runs, it runs your hook regardless of the pattern" — which is the safe
  direction, but a matcher a hook's correctness depends on needs a must-fire test through the real
  harness first. `if` "only works on tool events"; on Stop or SessionStart it prevents the hook
  from running.
- **`once`** — "Only honored for hooks declared in skill frontmatter; ignored in settings files."
  No use here.
- **`async`** — a background hook cannot deny; every guard here exists to deny or block.
- **`statusMessage`** — cosmetic; a 40 ms hook has no spinner worth naming.

When `if` is adopted, the table above gains a column and the Bash-call cost in BENCH.md drops by
one Node start for most commands.
