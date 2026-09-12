# Independent adoption trial

Status: no independent adoption result is claimed by this document.

A qualifying trial is performed by a developer outside the maintainer's
organization, on their own installation. A maintainer, another agent, or a CI
runner is not an independent adopter. A failed installation is useful evidence.

Before publishing, obtain the participant's written consent to the exact public
record and attribution. Do not name or contact someone without permission.

Record:

1. Repository commit or package version; OS, Node and host CLI versions.
2. Exact installation and verification commands, exit codes and actual output.
3. What the developer intended to do, what worked, what failed, and time spent.
4. A benign command and a harmless protected-file refusal in a disposable project.
5. Any changes or maintainer assistance needed to complete the trial.
6. Consent to publication and whether attribution is public or anonymous.

Redaction rule: replace credentials, account identifiers, personal paths and
unrelated source content with named placeholders such as `[REDACTED_HOME]`.
Never publish raw authenticated host transcripts automatically. Preserve command
structure, exit codes, version strings and relevant decisions. Hash the redacted
receipt; describe what was removed. A hash provides integrity, not independent
identity verification or proof that an observation is true.

Use the adoption issue form only after reviewing the output for secrets. A
maintainer must verify independence and consent before counting a trial. CI
cannot establish either property.
