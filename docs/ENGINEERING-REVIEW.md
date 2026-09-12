# Engineering review: evidence before confidence

This is a review of the repository, not a certification of agent safety. The initial reviewed
baseline was `38c87e7baf03263f5006d59bde34767e24e5bdb6` (v0.4.0 source).
The changes described below are unreleased until a tagged release includes them.

## Evaluate the project in five minutes

```sh
node demo.mjs
node scripts/bench.mjs --n 3 --json
npm run test:package
```

The demo exercises paired incident/legitimate actions. The small benchmark is a format/coverage
smoke check, not a statistically persuasive performance result. The package smoke consumes a real
tarball through an offline install, using a temporary npm cache and project. It reports tarball
integrity and the checks executed. For regression verification, run `npm test`; its population is
the enumerated test files, not a count copied into this document.

## Where the boundary actually sits

| Layer | What it establishes | What it does not establish |
|---|---|---|
| Guard tests | Specified inputs trigger expected decisions; legitimate twins pass | Universal shell understanding, zero false positives, or resistance to a malicious agent |
| Strict doctor | Installed files answer probes and all shipped registrations remain present | That an agent host loaded this configuration or honors the decision |
| Packaged-install smoke | The distributable contains enough files for installation and standalone checks | Actual Claude/Codex session behavior |
| Host invocation receipts | A named hook ran for a tool event, when observed | Tamper-proof auditing; these logs are writable by the same user |
| CI matrix | Results on each completed OS/Node job | Results for pending jobs, future hosts, or different installed bytes |

Read [THREAT-MODEL.md](THREAT-MODEL.md) before choosing hooks as an enforcement boundary.
Use sandboxing and separate credentials where the threat requires containment.

## Findings repaired in this revision

1. **A healthy file is not a wired hook.** Default doctor could allow an installation with an empty
   hooks block. Strict mode now detects missing registrations, wrong matchers, changed commands and
   asynchronous substitutions. Integration tests mutate an actual installation and restore it.
2. **Benchmark coverage had drifted.** A fixed list omitted three installed Bash guards. Coverage
   now comes from the shipped configuration, with raw samples and its SHA256 in JSON output. Historical
   measurements are retained and explicitly distinguished from the current configuration.
3. **Age is not ownership.** Scratch allocation could delete a live sibling's old directory. A
   two-process test reproduces that loss. Automatic allocation-time sweeping is removed; each process
   still cleans its own paths. Explicit maintenance requires a separate ownership decision.
4. **Source tests are not a package installation.** The release smoke packs and installs the actual
   artifact before running init, strict doctor and uninstall. No registry fetch or lifecycle script
   is needed. CI is configured across three operating systems and three Node versions.
5. **Documentation exceeded the evidence.** The README no longer promises unattended correctness,
   blanket fail-closed behavior, or a timeless test count. Stop-hook overflow and fail-open errors are
   named limitations rather than hidden exceptions.

## Next investments, in dependency order

- **Real-host compatibility fixtures:** record host version, exact installed bytes, invocation and
  observable refusal for Claude and Codex separately. Standalone adapter tests cannot close this gap.
- **Failure-policy observability:** distinguish allowed, denied and not inspected without logging
  command contents or secrets. Changing a host-facing failure policy needs explicit compatibility
  tests; a global fail-closed switch is not a substitute.
- **Adversarial corpus governance:** retain legitimate twins, classify intentional limits, and report
  mutation results separately from ordinary pass counts. Add syntax variants only when the parser
  can discriminate them from ordinary developer work.
- **Reproducible releases:** retain tagged package integrity, successful matrix receipts and benchmark
  context together. Never attribute an old result to a newer configuration or source tree.

These are acceptance criteria for future increments, not claims that those increments are built.
