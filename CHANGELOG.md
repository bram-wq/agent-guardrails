# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- `doctor --strict`: checks complete shipped registrations, including event/matcher routing and
  handler options. Disconnected files, changed commands and asynchronous replacements refuse.
- Configuration-derived benchmark coverage and `--json` receipts with raw samples, configuration
  SHA256, environment and sample counts; each child has a bounded timeout.
- Offline packaged-install smoke test: pack, install, init, strict doctor and uninstall. CI exercises
  it on Linux/macOS/Windows with Node 20/22/24, using read-only repository permissions.

### Fixed

- Scratch allocation no longer sweeps old sibling directories. A live owner's directory can be old;
  a two-process regression test reproduces that deletion. Own-process cleanup remains automatic.
- Performance documentation labels the old seven-hook benchmark as historical; the installed Bash
  configuration has seven guards, not four. README protection and input-limit claims are bounded.
- goal-guard's proof ledger no longer erases stamps. It was bounded by read-trim-rewrite, so once it
  held 2,000 stamps, a stamp another session appended between that read and the rewrite was lost:
  28, 42 and 46 of 320 concurrent red stamps in three measured runs, each then reported as "has not
  been run". A full ledger is now moved aside into a segment (`hooks/_rotating-log.mjs`) and never
  rewritten; the verdict reads every segment and takes the newest stamp by timestamp, and a red and a
  green stamped in the same millisecond read red.
- The fire log uses the same rotation, so concurrent hooks no longer lose count lines at its bound.
- goal-guard's done-command allowlist no longer backtracks exponentially. An optional drive-letter
  group in front of a class that already accepts letters and `:` gave each `A:,`-shaped argument two
  parses: `npx vitest` followed by 24 of them took 0.6 s to refuse, and every two more quadrupled it
  (CodeQL js/redos). The class alone accepts the same arguments, drive paths included.
- `init` and `uninstall` read the settings file once. The backup holds exactly the bytes that were
  merged, and the new file replaces the old one through a temp file and a rename, never a partial write.

## [0.4.0] — 2026-09-12

### Added

- `hooks/adapters/codex.mjs`: the same guards under OpenAI Codex CLI's lifecycle hooks. Reads
  Codex's event, fans it out to the named guards, folds their answers into one Codex-shaped decision
  (any deny holds); `apply_patch` is split into one synthetic Write/Edit event per file so scope-,
  secret-write- and config-tamper-guard judge every path. Fails open on its own defects, fails closed
  on an oversize PreToolUse payload. 71 cases: every demo incident denied and every twin allowed
  through the adapter, garbage/oversize/unknown-event/unknown-tool, crashing and junk-printing guards.
- `init --agent codex` / `uninstall --agent codex`: `.codex/hooks/` and `.codex/hooks.json`, derived
  from the same `settings.example.json` (one entry per matcher group; `^Bash$`, `^apply_patch$`);
  merge, backup, idempotent, round-trips a foreign `hooks.json` byte-for-byte. `try --agent codex`
  prints the same verdict table through the adapter.
- `docs/CODEX.md`: the Codex contract, fact by fact with URL and read date; facts that could not be
  fetched are tagged NE and the adapter does not depend on them.
- `config-tamper-guard`: `.codex/hooks/`, `.codex/hooks.json` and `.codex/config.toml` join the
  control surface (five paired cases). Without it a Codex session could edit the adapter it is
  spawned through, in force on the next tool call.

### Changed

- Codex adapter: a non-empty `apply_patch` with no recognisable file header is denied with a reason
  naming the header form, not passed unjudged (the loss on a silent allow was the whole file-edit
  surface). `AGR_GUARDS_DIR` is honoured only under `HOOK_CTX=test`. A guard whose stdout overruns
  the 8 MiB spawn buffer is a deny on PreToolUse, never an allow.

### Fixed

- `uninstall` matched a shipped basename anywhere inside a foreign command string and could delete
  a user's own `node /opt/mine/scope-guard.mjs --strict` while printing "foreign entries kept"; the
  in-string match now applies only to the quoted adapter path. `uninstall --agent codex` on Windows
  left the adapter entry in `hooks.json` (backslash path vs `adapters/codex.mjs`); separators are
  folded before matching, with a Windows-shaped case that runs on every OS.

## [0.3.1] — 2026-09-12

### Fixed

- v0.3.0's tarball did not carry `hooks/rules/`, so `npx github:…#v0.3.0 init` installed
  `secret-write-guard` without its rules file and the guard failed open on every install; `doctor` on
  a clean machine was the only thing that noticed. `files` now includes the directory, and the installer
  suite asserts the packed list carries every file `init` copies.
- `secret-write-guard` announces when it is OFF: a missing or malformed rules file still fails open, but
  the hook now prints a `systemMessage` naming the guard and the fix, so the outage is visible in the
  transcript rather than only as a fire of kind `error` in the log.

## [0.3.0] — 2026-09-12

Driven by a survey of the guardrail landscape (deterministic hook sets, sandboxes, policy files,
model-based validators) against this repo's threat model. Everything adopted is deterministic and
ships with paired tests; everything model-based was rejected, with the reasons in the README.

### Added

- `secret-write-guard`: refuses a Write/Edit/MultiEdit/NotebookEdit, or the writing parts of a Bash
  command, whose text carries a credential. 15 gitleaks-shaped rules in `hooks/rules/secrets.json`
  (extend or replace with `SECRET_GUARD_RULES`), Shannon-entropy floor on the generic rule, placeholder
  and fixture exemptions. The reason names the rule id and file:line, never the value. 143 cases, with
  an in-suite mutation that blanks one rule and proves its incident flips to allowed.
- `config-tamper-guard`: refuses any write to the agent's own control surface (settings, hooks,
  `.agent-scope`, `.mcp.json`, git hooks, `core.hooksPath`, managed-settings directories) through every
  Bash write shape; a SessionStart fingerprint makes tampering visible next start. Closes the two
  highest rows of `docs/THREAT-MODEL.md` for the accidental case; the same-user limit remains and is
  documented. 80 paired cases plus hatch, reason and fingerprint checks.

- `precompact-handoff`: a PreCompact hook that writes a durable handoff (goal, DONE command, proven or
  not, last ten refusals) before the context is summarised. The hooks reference gives PreCompact no
  context-injection channel, so the goal returns through goal-guard's SessionStart on `source:
  "compact"`; the header quotes the reference. 48 cases.
- `managed-settings.example.json`: a permissions deny floor for the fence class, verified key by key
  against the settings reference, documented as the layer above the hooks.
- README "Why this and not another hook set": a grounded comparison with the other hook sets and with
  the sandbox, and the reasons no model-based guard is included.
- `init` and `uninstall` ship and remove `hooks/rules/*.json` alongside the hooks; `doctor` on a fresh
  install proved a hook without its data file fails open at the install site.

### Changed

- `init` keeps an `if` field on any hook entry an operator narrowed, and never adds one itself: the
  permissions page lists `/usr/bin/git` and `sh -c` as shapes a Bash rule does not match, and every
  shipped Bash guard sees through those on purpose. The per-hook reasoning sits beside
  `exampleHooksFor` in the CLI.

### Fixed

- `init` deduplicated hook entries by command per event, so a guard wired under both the Bash and the
  Edit matchers of PreToolUse lost its second entry and silently never ran on edits. Presence is now
  keyed by matcher too. `init` also skips, and names, an example entry whose hook file does not ship.
- The repo carried a tracked fire log under `hooks/.local/` written by a test run with `HOME` pointed
  at `hooks/`; removed and ignored.

## [0.2.0] — 2026-09-12

Driven by a three-lens review (first-time user, partner evaluator, adversarial tester) and a check of
every stdin/stdout assumption against the current Claude Code hooks reference.

### Added

- `fence-guard`: irreversible or outward-facing actions (protected-branch and force pushes, forge
  merges, history rewrites, `rm -rf` at a root, destructive SQL statements, infra applies, secret
  writes, publishing, host destruction) are refused so a human presses them. Sees through quotes,
  heredocs, `$(…)`, `sh -c`, `sudo` and env prefixes. `FENCE_PROTECTED_BRANCHES`, `FENCE_EXTRA`,
  `FENCE_ALLOW` (exemptions are logged). No kill switch.
- CLI: `uninstall` (removes only what `init` added, keeps and names a modified hook), `try '<cmd>'`
  (one command through every Bash guard, verdict per guard), `new <name>` (scaffold a guard and its
  paired tests from `templates/`), `doctor` now also feeds each Bash guard its incident and asserts the
  refusal, `report` is scoped to the current project (`--all` for the machine).
- `test.mjs` prints the case total; the README quotes that number, not a typed one.
- `demo.mjs` covers every guard.
- Docs: `THREAT-MODEL.md` (what the guards do not catch, with the accepted bypasses), `writing-a-guard.md`,
  `COMPAT.md` (events, fields and stdout shapes per guard, verified against the reference on
  2026-09-12), `BENCH.md` (p50/p95 per hook from `scripts/bench.mjs`), `ADOPT.md`.

### Fixed

- goal-guard: the off-tree check canonicalises both the worktree and the argument through the deepest existing ancestor (`realpathSync.native`), so a symlinked tmpdir (macOS `/var` → `/private/var`) or a Windows 8.3 short name (`RUNNER~1`) no longer refuses a verification that lives inside the tree. Paired symlink cases added; the matrix caught it, Linux alone would not have.

- `root-cause-guard` wrote its warning to stderr and exited 0. Per the hooks reference that reaches the
  debug log only; Claude never saw it. It now emits `additionalContext` and a `systemMessage`. Also gated
  on `tool_name === "Bash"`, and reads `-F <file>` / `--body-file` messages.
- `scope-guard`: glob compilation was exponential on deep paths (a 25-star scope took minutes; the hook
  timed out and the write was allowed); symlinks inside an allowed directory escaped the scope; a
  malformed `.agent-scope` was allow-all; a scoped agent could widen its own scope in one edit; `MultiEdit`
  was not matched. All five now fail closed with a reason. An `.agent-scope` that does not parse now also
  denies (a deliberate contract change: a corrupt config is the world's defect, not the hook's).
- `runaway-guard`: generators behind `(…)`, `$(…)`, `env`, `command`, `exec`, `nohup`, `time`, `nice`,
  env-assignment prefixes, newlines and `sh -c` were missed; one bound anywhere in the string excused
  every later generator; `tail` was accepted as a bound. Now evaluated per statement.
- `piped-verdict-guard`: a newline after `|` ended the statement early; `echo PIPESTATUS` satisfied the
  recovery check; `for`/`if`/`{ }`/`env`/`VAR=` wrappers and glued redirects hid the verb;
  `set -e -o pipefail` was not recognised.
- `prose-guard`: `~`, `$HOME`, leading redirects, backtick verbs, comment lines and relative paths
  resolved against the wrong `cwd` were false positives; transparent prefixes (`time`, `sudo`, `exec`,
  `env`, `eval`, `(…)`) hid the incident shapes. Added `PROSE_GUARD_ALLOW` for shell functions and
  aliases the hook cannot see, `CLAUDE_HOOKS_QUIET`, and a size cap.
- `goal-guard`: `--done "npm test --prefix /tmp/x"` ran out-of-repo code and proved the goal (escape flags,
  `..` and off-tree absolute paths are now refused); `GOAL_GUARD_ALLOW_NPM_RE` could widen the allowlist into
  `npm run deploy` (replaced by `GOAL_GUARD_ALLOW_NPM_SCRIPTS`, a literal list; the denylist still applies); the objective validator refused `support 3 locales`;
  common completion shapes (`Done!`, `**Done.**`, `Finished.`) were not detected. `process.exit` after
  the stdout write removed.
- `ui-evidence-guard`: a 6 KB file of random bytes named `.png` counted as evidence (magic bytes now
  checked); negated claims (`not done yet`) blocked; `Deployed to staging.` did not; a repo without
  `origin/main` made the guard permanently silent; one `git log` per screenshot (9 s on 1,740 shots)
  replaced by a single walk. UI paths configurable via `UI_EVIDENCE_PATHS`.
- Size caps (fail closed) on every PreToolUse guard; natural exit after the single stdout write everywhere.
- README: "Codex" removed from the tagline (nothing here runs under Codex CLI); test count corrected.

[0.2.0]: https://github.com/bram-wq/agent-guardrails/releases/tag/v0.2.0

## [0.1.0] — 2026-09-12

First public release.

### Added

- Seven deterministic Claude Code guard hooks, each with a must-fire and a must-not-fire test:
  `prose-guard`, `runaway-guard`, `piped-verdict-guard`, `root-cause-guard`, `scope-guard`,
  `ui-evidence-guard`, `goal-guard` (SessionStart re-injects the armed goal; Stop refuses a
  completion claim until the DONE command has been proven with exit 0).
- `_fire-log.mjs`: per-hook run/fire telemetry with a byte-bounded log and a never-trimmed
  last-seen ledger; records a source-authored `kind`, never the reason text.
- `_scratch-dir.mjs`: self-reaping temp directories for the tests.
- `bin/agent-guardrails.mjs` CLI — `init` (copy hooks, merge `settings.json` with a timestamped
  backup, `--user`, `--dry-run`), `doctor`, `report`, `demo`; runnable as
  `npx github:bram-wq/agent-guardrails <command>`.
- `test.mjs` runner (plain Node, sequential, stops on first red) and a CI matrix across
  ubuntu / macos / windows × Node 20 / 22.
- `demo.mjs` and a generated `assets/demo.svg` of its output.
- `docs/DOCTRINE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a guard-proposal
  issue template.

[0.1.0]: https://github.com/bram-wq/agent-guardrails/releases/tag/v0.1.0
