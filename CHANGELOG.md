# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

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
