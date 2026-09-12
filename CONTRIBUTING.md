# Contributing

Thanks for looking. This repo is small on purpose: plain Node ≥ 20, zero dependencies, and every
guard verifiable by `node <file>` alone. Keep it that way.

## Ground rules

- **No dependencies.** Not dev, not peer. A hook runs where no `node_modules` exists.
- **No shell in scripts.** Everything in `package.json` and CI is `node <file>`, so it runs
  identically on Linux, macOS and Windows.
- **A guard decides from the event alone.** No LLM, no network, no state the agent can edit.
- **Fail open on your own bugs; fail closed on input you cannot scan.** See below.

## Adding a guard

### 1. Start from the incident, verbatim

Every guard here replaced a written rule that was read, agreed with, and broken anyway. Before
writing code, write down the exact command or turn that went wrong and what it cost. That text
becomes the first **must-fire** test case. If you cannot quote the incident, open a
[guard proposal](.github/ISSUE_TEMPLATE/guard-proposal.md) instead and we will look for one together.

### 2. Find the legitimate twin

The command that looks the same but is fine — `yes | head -3` next to `yes`; `npm test | tail` next
to `git push | tail`. That is the first **must-not-fire** case, and it is the harder half: a guard
with only must-fire cases gets switched off the first week it blocks real work. Include the guard's
own remediation advice as a must-not-fire case; a guard that refuses the command it recommends is
the worst false positive available.

### 3. The must-fire / must-not-fire rule

A PR that adds or changes a guard is not reviewable without both:

| | proves |
|---|---|
| must-fire | the incident is refused, with a reason that carries the fix |
| must-not-fire | the twin passes untouched |

Tests are plain Node: spawn the hook exactly as Claude Code does (event JSON on stdin), read the
decision from stdout, exit non-zero on the first miss, and print one summary line. Copy the style
of `hooks/scope-guard.test.mjs`. If a case can be deleted from the hook without a test going red,
the test is not covering it — run a quick mutation (comment the branch out) before you open the PR.

### 4. Fail direction

- **The harness fails open.** Unparseable stdin, a missing field, any exception → exit 0 with no
  output. A guard that bricks a session is worse than no guard.
- **The decision fails closed.** If the input is too large to scan within the hook's timeout,
  deny with a reason that says so. Never let "could not check" print the same as "checked, fine".
- Write stdout **once**, then let the process exit naturally. `process.exit()` after a write can
  truncate the deny payload into an accidental allow.

### 5. Record runs and fires

Import `recordInvocation` and `recordFire` from `hooks/_fire-log.mjs`:

```js
recordInvocation("my-guard.mjs");            // at module scope: the denominator
recordFire("my-guard.mjs", "deny", "kind");  // right before writing the deny
```

`kind` is a short constant you author in source (matches `/^[a-z0-9][a-z0-9-]{0,39}$/`). **Never pass
the command, the reason, or anything derived from user input** — the log is what makes "this guard
never fires" a measured claim, and a reason text would put the offending command (possibly a secret)
on disk. See `SECURITY.md`.

### 6. Wire and document

- Add the hook to `settings.example.json` under the right event and matcher.
- Add a row to the hooks table in `README.md` and a line to `CHANGELOG.md`.
- Run `node scripts/render-demo-svg.mjs` if you added a case to `demo.mjs`.

## PR checklist

- [ ] The incident is quoted verbatim in the must-fire test (or in the PR if it cannot be in a test)
- [ ] At least one must-fire and one must-not-fire case; the twin is the closest legitimate shape
- [ ] A mutation of the new branch makes a test go red
- [ ] Harness fails open (exit 0, no output) on garbage stdin; decision fails closed on oversize input
- [ ] `recordInvocation` at module scope, `recordFire` with a source-authored `kind`, no reason text logged
- [ ] `node test.mjs`, `node demo.mjs` and `node bin/agent-guardrails.mjs init --dry-run` pass locally
- [ ] No new dependency, no shell in `package.json`, paths built with `node:path`
- [ ] `settings.example.json`, README table and CHANGELOG updated
