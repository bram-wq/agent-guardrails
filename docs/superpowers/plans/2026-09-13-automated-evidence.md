# Automated Evidence Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Keep each evidence claim separate.

**Goal:** Automatically produce reproducible guardrail evaluation and safely collect host/adoption evidence.
**Architecture:** Independent credential-free evaluation, trusted-host proof, and human-consented intake.
**Tech Stack:** Node >=20, built-in modules, GitHub Actions; zero added runtime dependencies.
**Spec:** `docs/AUTOMATED-EVIDENCE-DESIGN.md`

## Global constraints

- Never execute corpus command strings; feed them as hook input.
- Unknown outcomes are failures of verification, not correct allowances.
- Never bypass host trust or grant untrusted PRs credentials.
- Human independence and consent are externally verified, not inferred by code.

## Task 1 — Versioned evaluation

Files: `eval/corpus.v1.json`, `scripts/evaluate.mjs`, `scripts/evaluate.test.mjs`.
- [x] Test the CLI first: `node scripts/evaluate.test.mjs`; missing evaluator failed.
- [x] Implement 24 fixed cases (12 attacks, 12 controls), per-guard metrics and six source mutants.
- [ ] Test malformed/crashed responses as unknown, unchanged mutants as not applicable, and restore source immutability.
- [x] Run `node scripts/evaluate.mjs --out <fresh-dir>`; zero baseline mismatches, six named killed mutants.

## Task 2 — Host evidence

Files: `scripts/host-{proof,observer,run}.mjs`, their tests, `docs/HOST-PROOF.md`.
- [x] Test receipt acceptance with a missing benign witness; require refusal.
- [x] Bind source/install hashes and CLI version; capture local host errors without publishing raw logs.
- [x] Exercise actual hosts: Claude observed both controls; Codex no events, not established.
- [x] Document initial trust/authentication as operator prerequisites; do not bypass them.

## Task 3 — Automation and human intake

Files: `.github/workflows/evidence.yml`, `.github/ISSUE_TEMPLATE/adoption.yml`, `docs/ADOPTION-TRIAL.md`.
- [ ] Wire evaluation and tarball smoke to PR/main/scheduled runs with immutable result artifacts.
- [ ] Provide a separately dispatched trusted-host path with explicit prerequisites.
- [ ] Collect written consent, outside-org declaration, revision, result and redaction details.
- [ ] Verify CI on the pushed SHA; report independent-human trial pending until a real participant submits.
