# Security

## What the hooks record

The fire log (`_fire-log.mjs`) records, per event, only:

```
timestamp · run|fire · hook filename · verdict · kind · ctx
```

`kind` is a short constant authored in the hook's source and validated against
`/^[a-z0-9][a-z0-9-]{0,39}$/`; anything else is dropped rather than written. **The deny reason is
never recorded**, because a reason embeds the offending command, and a guard that refuses a secret
write would otherwise log the secret to disk. The log lives under `$XDG_STATE_HOME/claude-hooks/`
(or `HOOK_FIRE_LOG`), never in the repository.

The hooks make no network calls and read nothing outside the event JSON, the working tree they are
asked about, and their own log.

## Reporting a vulnerability

If you find a way to make a guard log a reason or command, to bypass a guard through its fail-open
path with a shape it should have refused, or to make a hook write outside its state directory,
please report it privately through
[GitHub private vulnerability reporting](https://github.com/bram-wq/agent-guardrails/security/advisories/new)
rather than in a public issue. Include the event JSON that reproduces it. You will get an
acknowledgement within a week, and a fix or an explanation before any public disclosure.

A guard bypass that is simply a shape the guard was never meant to cover is a
[guard proposal](.github/ISSUE_TEMPLATE/guard-proposal.md), not a vulnerability — open it publicly.
