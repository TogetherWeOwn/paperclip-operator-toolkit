# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository ("Security" tab ->
"Report a vulnerability"). We aim to acknowledge reports within 5 business days.

## Scope

In scope: the scripts, plugins and CI gates in this repository.

Out of scope: any specific operator deployment. This tree ships with placeholder
hosts (`*.example.net`) and company IDs (`00000000-...`); a finding that depends
on a particular operator's hosts, credentials or data belongs with that operator.

## Handling secrets

This repository must never contain credentials, tokens, private keys or tenant
identifiers. CI and contributors should run `gitleaks` before pushing; tooling
here reads secrets from the environment or a credential broker, never from
arguments or committed files.
