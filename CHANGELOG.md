# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [0.1.0] — 2026-09-12

First public release.

### Added

- Seven deterministic Claude Code guard hooks, each with a must-fire and a must-not-fire test:
  `prose-guard`, `runaway-guard`, `piped-verdict-guard`, `root-cause-guard`, `scope-guard`,
  `ui-evidence-guard`.
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
