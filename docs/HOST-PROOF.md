# Actual-host evidence

The corpus runner synthesizes hook events. It is not proof that Claude Code or
Codex loaded a hook. This launcher measures a separate claim: one harmless Bash
write is allowed and one write to a disposable `.agent-scope` file is refused.
It does not claim coverage of every guard or tool interface.

## Run on a trusted operator machine

Requires POSIX, Node 20+, git, and an authenticated `claude` or `codex` CLI. Each
fixture is single-use; unsuccessful attempts are preserved, not reset to green.

```sh
node scripts/host-run.mjs prepare codex /absolute/new-fixture
# Review the generated project and hooks through the host's normal trust UI.
HOST_PROOF_EXPECT_VERSION='codex-cli 0.149.0' node scripts/host-run.mjs run codex /absolute/new-fixture /absolute/new-receipts
```

Replace `codex` with `claude` for Claude Code. Preparation uses the real installer,
then wraps its Bash handler with an observer that forwards the original verdict.
This is explicitly **instrumented wiring**, not unchanged stock configuration.
Stock and instrumented hashes are recorded separately. The observer preserves
the installed invocation's arguments, expanding Claude's documented project-path
placeholder. Codex literal argv preserves quoting and flags; shell operators or
expansions refuse preparation rather than being evaluated or silently dropped.
The receipt hashes installed files, the configuration, observer, launcher,
assessment code and handler descriptor. It includes CLI version, invocation,
reproduction command, observed allow/deny events and resulting file contents as
booleans. Its `.sha256` sidecar hashes the receipt itself.

Set `HOST_PROOF_EXPECT_VERSION` to the exact CLI version you reviewed; an absent
pin or any mismatch refuses before the agent runs. Do not derive that pin from
the live CLI inside the job: that would accept an unreviewed upgrade silently.

Project-hook trust may require review of the exact definition; preparation does
not grant trust. No hook-trust, sandbox or safety bypass flag is used. Claude's
run has a $0.25 budget limit; both launches have a 120-second timeout. Operator
authentication and actual billing remain the operator's responsibility.

Exit 0 means both controls were observed and file outcomes agree; exit 1 means
the protected write was allowed or its file changed; exit 3 means **not
established**, including absent hook events, an unrun benign control or host
failure. Exit 2 is a launcher/precondition error, not host success.
Malformed event lines are retained as unknown observations and invalidate the
run while preserving a receipt. Observer timeouts use blocking exit 2, recorded
as unknown rather than a guard denial. Successful forwarding is unchanged;
timeout handling is an explicit instrumentation fail-closed policy.

Only the exact two separate command strings qualify. A model joining them with
`&&` or choosing another tool does not establish either control. The observer
currently recognizes `tool_input.command`; unsupported payload shapes record
keys only and cannot establish a control. A zero-event Codex run does not tell
us whether the cause is host startup, trust, environment or payload compatibility.

Raw authenticated transcripts are never uploaded. The receipt contains a hash
of their combined stdout/stderr only. Paths in reproduction commands may identify
the local operator: review/redact a copy before sharing it, then hash that copy.
Receipts are tamper-evident records, not tamper-proof attestations: a same-user
process can forge events. Do not use them as an adversarial security boundary.

## Automation boundary

`evidence.yml` runs the credential-free corpus on pull requests, main pushes,
weekly and manually. It preserves machine-readable results even when evaluation
fails. No credentials or paid model calls are needed.

`host-evidence.yml` is manual and main-only, on a **dedicated trusted runner**
labelled `agent-guardrails-host-proof`. Configure the protected `host-validation`
environment with required approval and `HOST_PROOF_PROJECT`, pointing to a fresh,
already reviewed fixture prepared from the exact checked-out source. It is not a
pull-request workflow. Do not run untrusted PR jobs on that authenticated runner.
Also set the environment's `HOST_PROOF_EXPECT_VERSION` to the reviewed CLI version.
The trusted-host workflow is **available but not provisioned**. This repository
does not provision a runner, credentials or hook trust. Those are owner-managed
prerequisites; the workflow file alone is not evidence of a working runner.
