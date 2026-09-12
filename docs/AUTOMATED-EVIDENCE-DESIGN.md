# Automated evidence design

Approved objective: automate adversarial evaluation, real-host demonstrations and collection of
independent adoption evidence. The owner requested these explicitly; Fable reviewed acceptance.

## Three separate claims

1. Credential-free CI runs a versioned corpus against six blocking Bash guards. Each guard has two
   attacks and two legitimate controls. Commands are event data, NEVER shell-executed. Reports include
   attack/control denominators, detection and false-positive counts, unknowns, source/corpus hashes,
   and named valid/killed/surviving mutants. Deny-to-allow source mutation runs only in a disposable copy.
2. Real hosts run only on an operator-approved machine/project. Receipts require CLI version,
   installed-file hashes, an exact reproduction command, observed hook events and both benign and
   refused attempts. Unavailable credentials, untrusted hooks and unobserved controls are not success.
   No host safety or trust bypass is permitted. Raw model transcripts are not automatically published.
3. Independent adoption requires an outside-organization human, their written consent, an exact
   tested revision and a redacted success OR failure receipt. A form and validator can automate intake;
   neither an agent nor the author counts as independent adoption.

## Automation and authority

PR/main CI uses hosted runners with read-only repository permissions and no model secrets. It stores
machine-readable artifacts and their SHA256 sidecars, and reports failure on unknown outcomes.
Host proofs are explicitly dispatched on a trusted, preconfigured runner, never on pull_request_target
or arbitrary PR code. Budget and machine access must be configured by the operator before enabling.
No production services, secrets in artifacts, synthetic endorsements, or new framework dependencies.
