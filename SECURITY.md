# Security Policy

## Scope

ccalyze is a read-only local analyzer: it parses files under your own `~/.claude/`
directory and prints JSON/markdown to stdout. It makes no network calls, writes no
files, and has zero runtime dependencies. Reports about anything that violates those
properties are especially welcome.

## Reporting a Vulnerability

Please report vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/Optibus/ccalyze/security/advisories/new)
("Report a vulnerability" on the repo's Security tab). Please do not open a public
issue for security reports.

We will acknowledge your report within **5 business days** and aim to provide a fix
or a remediation plan within **30 days** of triage.

## Supported Versions

Only the latest release (the `main` branch / newest plugin version) is supported
with security fixes.
