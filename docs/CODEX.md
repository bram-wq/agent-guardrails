# Codex CLI: the contract the adapter relies on

`hooks/adapters/codex.mjs` runs the shipped guards under OpenAI Codex CLI's lifecycle hooks, so a
team with a Claude Code lane and a Codex lane gets the same verdict for the same command. This file
records every fact the adapter and `init --agent codex` depend on, with the page it came from and
the date it was read. Nothing below is recalled.

**Reference pages**, read **2026-09-12**:

- `https://developers.openai.com/codex/hooks` — 308 → `https://learn.chatgpt.com/docs/hooks`
  (the served page; its own canonical URL is the `developers.openai.com` one). Called **the hooks
  reference** below.
- `https://developers.openai.com/codex/config-reference` — 308 →
  `https://learn.chatgpt.com/docs/config-file/config-reference`. Called **the config reference**.
- `https://github.com/openai/codex/blob/main/docs/hooks.md` and `…/docs/config.md` — **404** on the
  read date; not a source.
- `https://github.com/openai/codex/tree/main/codex-rs/apply-patch` — listing only (`src/`, `tests/`,
  `BUILD.bazel`, `Cargo.toml`), no grammar document rendered; the tool-instructions markdown at
  `codex-rs/apply-patch/apply_patch_tool_instructions.md` was **404**. Not a source.

Tags: **E** = established from a reference page, quoted. **NE** = not established: could not be
fetched from a primary source on the read date; the adapter does **not** depend on it.

## Facts

| # | fact | tag | source text (verbatim) |
|---|---|---|---|
| F1 | Hooks are configured in `hooks.json` beside a config layer, or inline `[hooks]` tables in `config.toml`. | E | hooks reference: "Codex discovers hooks next to active config layers in either of these forms: `hooks.json` [or] inline `[hooks]` tables inside `config.toml`" |
| F2 | The four locations: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`. All matching sources load; a higher layer does not replace a lower one. | E | "In practice, the four most useful locations are: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`" · "If more than one hook source exists, Codex loads all matching hooks. Higher-precedence config layers don't replace lower-precedence hooks." |
| F3 | `hooks.json` shape: `{ "hooks": { "<Event>": [ { "matcher": "<regex>", "hooks": [ { "type": "command", "command": "<string>", "timeout": <s>, "statusMessage", "additionalContextLimit", "async" } ] } ] } }`; an optional top-level `description`. | E | the reference's example (`"description": "Optional lifecycle hooks for this workspace."`, `"hooks": { "SessionStart": [ { "matcher": "startup\|resume", "hooks": [ { "type": "command", "command": "python3 ~/.codex/hooks/session_start.py", … } ] } ], "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"", … } ] } ] }`) |
| F4 | A handler's `command` is one string. No `args` array / exec form is documented. | E (absence, denominator: the whole hooks reference) | every example is a `command` string; the field list names `type`, `command`, `timeout`, `statusMessage`, `additionalContextLimit`, `async` |
| F5 | Common stdin fields on every event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped events add `turn_id`. | E | hooks reference, event input tables |
| F6 | `PreToolUse` adds `tool_name`, `tool_use_id`, `tool_input`. | E | same |
| F7 | Shell commands arrive as `tool_name: "Bash"` with the command in `tool_input.command`; file edits arrive as `tool_name: "apply_patch"` with the patch in `tool_input.command`. A matcher may say `apply_patch`, `Edit` or `Write` for the edit tool, but the event still reports `apply_patch`. | E | "Bash and `apply_patch` use `tool_input.command`" · "For file edits through `apply_patch`, `matcher` values can use `apply_patch`, `Edit`, or `Write`; hook input still reports `tool_name: "apply_patch"`" |
| F8 | `Stop` adds `stop_hook_active` and `last_assistant_message`. `SessionStart` adds `source` (`startup`, `resume`, `clear`, `compact`). `PreCompact`'s matcher applies to `trigger` (`manual`, `auto`). | E | hooks reference: "`stop_hook_active` (boolean): Whether this turn was already continued by `Stop`" · "`PreCompact` runs before Codex compacts the chat. `matcher` is applied to `trigger`, whose values are `manual` and `auto`." |
| F9 | Event names: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`, `Interrupt`. | E | hooks reference, event list |
| F10 | `matcher` is a regex; `"*"`, `""` or omitting it matches everything. | E | "The `matcher` field is a regex string that filters when hooks fire. Use `"*"`, `""`, or omit `matcher` entirely to match every occurrence of a supported event." |
| F11 | Default `timeout` is 600 s for most hooks (1 s, max 3 s, for `SessionEnd` and `Interrupt`). | E | "If `timeout` is omitted, Codex uses `600` seconds for most hooks. `SessionEnd` and `Interrupt` use `1` second by default and support up to `3` seconds." |
| F12 | Project-local hooks load only in a trusted project; user and system hooks load regardless. | E | "Project-local hooks load only when the project `.codex/` layer is trusted. In untrusted projects, Codex still loads user and system hooks." · config reference: "Codex loads project-scoped config files only when you trust the project" |
| F13 | Commands run with the session `cwd` as the working directory. Which interpreter runs the string, and whether any variable is expanded in it, is **not documented**. | E for cwd; **NE** for interpreter and expansion | "Commands run with the session `cwd` as their working directory." — the reference's own example uses `"$(git rev-parse --show-toplevel)/…"`, which implies a POSIX shell, but that is an inference, so the installer writes an absolute quoted path and no variable |
| F14 | `PreToolUse` deny: exit 0 with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. `allow` (with `updatedInput`) exists; `ask` is "parsed but not supported yet". | E | the reference's deny example, verbatim: `"permissionDecision": "deny", "permissionDecisionReason": "Destructive command blocked by hook."` |
| F15 | Alternative deny channel: exit code `2` with the reason on stderr. | E | "You can also use exit code `2` and write the blocking reason to `stderr`." — not used: the guards' stdout JSON is the primary channel on both agents |
| F16 | `Stop` expects JSON on stdout when it exits 0; `{"decision":"block","reason":"…"}` continues the turn. Plain text is invalid on `Stop`. | E | "`Stop` expects JSON on `stdout` when it exits `0`. Plain text output is invalid for this event." · `{"decision": "block", "reason": "Run one more pass over the failing tests."}` |
| F17 | `SessionStart` context: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`, added as developer context; `PreToolUse` may also return `hookSpecificOutput.additionalContext` without blocking. Model-visible hook output is capped at roughly 2,500 tokens per message (`additionalContextLimit`). | E | "That `additionalContext` text is added as extra developer context." · "To add model-visible context without blocking, return `hookSpecificOutput.additionalContext`" · "By default, Codex limits each model-visible hook-output message to roughly 2,500 tokens" |
| F18 | Common output fields (`continue`, `stopReason`, `systemMessage`, `suppressOutput`) apply to `SessionStart`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`; on `PreToolUse` only `systemMessage` is supported. | E | hooks reference, common output fields |
| F19 | Exit 0 with no output is success. Matching command hooks for one event start concurrently; the reference does not say how their decisions combine. | E for the first two; **NE** for combination | "Exit `0` with no output is treated as success." · "multiple matching command hooks for the same event are launched concurrently, so one hook can't prevent another matching hook from starting." |
| F20 | Hooks are on by default; `[features] hooks = false` in `config.toml` turns them off; `requirements.toml` can force them and `allow_managed_hooks_only = true` ignores user/project hooks. | E | "To turn them off in `config.toml`, set: `[features] hooks = false`" · config reference: "Admins can set top-level `allow_managed_hooks_only = true` in `requirements.toml`" |
| F21 | The `apply_patch` grammar (`*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` / `@@` / `+`/`-` lines). | **NE** | the instructions document was 404 on the read date; the header shapes the adapter splits on are the ones Codex's own tool has used, but no primary page was fetched that states them |
| F22 | What Codex does with PreToolUse stdout that is neither empty nor JSON, and with a non-zero exit other than 2. | **NE** | not stated on the reference page |
| F23 | Whether Codex de-duplicates an identical handler declared in two config layers. | **NE** | F2 says all sources load; nothing says duplicates collapse — so `init` merges by command string and never writes the same entry twice into one file, and a user-level plus a project-level install may run each guard twice (same verdict, one extra Node start) |

## Event mapping

| ours (Claude Code) | Codex event · matcher written by `init` | adapter behaviour |
|---|---|---|
| PreToolUse · `Bash` | `PreToolUse` · `^Bash$` | pass-through: same field names (F5–F7); one entry spawns the seven Bash guards and folds their answers — any deny holds (the fold is done here because F19's combination rule is NE) |
| PreToolUse · `Edit\|MultiEdit\|Write\|NotebookEdit` | `PreToolUse` · `^apply_patch$` | the patch text (F7) is split into one synthetic `Write`/`Edit` event per `*** Add/Update/Delete File:` header, relative paths resolved against `cwd`; scope-guard, secret-write-guard and config-tamper-guard judge each file. A non-empty patch with no recognisable header yields no event and is **denied** with a reason naming the header form (F21 NE: the grammar is unconfirmed, so unjudgeable is refused, not allowed); an empty body is allowed |
| Stop | `Stop` (no matcher) | pass-through (F8); block shape identical (F16) |
| SessionStart | `SessionStart` (no matcher) | pass-through (F8); context shape identical (F17) |
| PreCompact | `PreCompact` (no matcher) | pass-through (F8); the handoff is a file, nothing is printed |
| — | any other event, any other tool (MCP tools, `PostToolUse`, …) | nothing spawned, empty stdout (allow) |

## What the adapter emits

| event | guards' answer | adapter's single stdout write | exit |
|---|---|---|---|
| PreToolUse | ≥ 1 deny | F14 deny shape, reasons joined with a blank line, `systemMessage` carried if any guard set one (F18) | 0 |
| PreToolUse | only `additionalContext` (root-cause-guard) | `hookSpecificOutput.additionalContext` (F17) | 0 |
| Stop | ≥ 1 block | F16 block shape, reasons joined | 0 |
| SessionStart | ≥ 1 context | F17 context shape | 0 |
| any | nothing / garbage stdin / unknown event or tool / a guard crashed or printed junk / adapter exception | nothing (fail open; the defect is named on stderr) | 0 |
| PreToolUse | payload over 8 MiB (the largest guard cap) | F14 deny naming the cap (fail closed, as every Bash guard does) | 0 |
| Stop / SessionStart / PreCompact | payload over 8 MiB | nothing (a Stop that blocks on oversize input would loop) | 0 |

Exit code 2 (F15) is never used, so a Codex reading of "non-zero = hook failure" (F22 NE) can never
turn a guard's deny into noise: the deny is always exit 0 + JSON, the channel F14 documents.

## Not covered, and why

- **`doctor --agent codex`** is refused with a pointer. `doctor` proves each hook answers *its own*
  event; under Codex the events are the same JSON, so a Claude `doctor` on the same checkout proves
  the guards, and `try --agent codex` proves the adapter path. A Codex-specific doctor would re-run
  the same processes with a different label.
- **A patch with no recognisable file header is refused, not allowed** (changed after review on
  2026-09-12). F21 is NE, so a body in a shape the splitter does not know (a unified diff, prose)
  cannot be mapped to a path and no file guard can judge it; the adapter denies with a reason that
  names the header form, the same fail direction as its oversize rule. An empty body is allowed:
  nothing was asked. If Codex adds a header shape, the deny is visible on the next patch, not silent.
- **`.codex/` IS part of `config-tamper-guard`'s surface** (same day): `.codex/hooks/` (the guards
  and the adapter, which is re-spawned on every tool call, so a one-line edit to it is in force on
  the next command), `.codex/hooks.json` and `.codex/config.toml` (the `[hooks]` table). Five paired
  cases in the guard's own suite; `.codex/prompts/`, `.codex-notes/`, `codex/` and an INVOCATION of
  the adapter stay allowed.
- **`AGR_GUARDS_DIR`** redirects the guards directory only under `HOOK_CTX=test` (the suite's fake
  guards). Set anywhere else it is ignored and said so on stderr, so a wrapper or `.envrc` cannot
  point every guard at an empty directory. A guard whose stdout overruns the 8 MiB buffer is a deny
  on PreToolUse, never a silent allow.
- **`init --agent codex` writes absolute paths** into a project-level `.codex/hooks.json` (F13: no
  expansion and no interpreter is documented, so `$(git rev-parse …)` or `${VAR}` would be a bet on
  one shell). A clone at another path re-runs `init`. `--user` writes `~/.codex/hooks.json`, which
  is path-stable per machine.
- **`if`-style filters**: Codex has none documented beyond `matcher`; none is written.
- **Exit-code-2 denies** (F15): not used, see above.
