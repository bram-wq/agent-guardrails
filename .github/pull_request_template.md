<!-- Read CONTRIBUTING.md first. A PR that adds or changes a guard is not reviewable without both a
     must-fire and a must-not-fire case. Delete the sections that do not apply. -->

## What and why

<!-- One or two sentences. For a guard: the incident it refuses, quoted verbatim. -->

## Evidence

<!-- The commands you ran and their results. "Tests pass" is not evidence; the output line is. -->

```
node test.mjs
node demo.mjs
node bin/agent-guardrails.mjs init --dry-run
```

## Checklist

- [ ] The incident is quoted verbatim in a must-fire test, or in this PR if it cannot be in a test
- [ ] At least one must-fire and one must-not-fire case; the twin is the closest legitimate shape
- [ ] A mutation of the new branch makes a test go red
- [ ] Harness fails open on garbage stdin; the decision fails closed on oversize input
- [ ] `recordInvocation` at module scope, `recordFire` with a source-authored `kind`, no reason text logged
- [ ] No new dependency, no shell in `package.json`, paths built with `node:path`
- [ ] `settings.example.json`, the README table and `CHANGELOG.md` updated
- [ ] `docs/COMPAT.md` updated if a hook's stdin fields, stdout shape, exit code or size cap changed
- [ ] Not a guard change: none of the above apply, and the change is described under "What and why"
