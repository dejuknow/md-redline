# Security Policy

## Supported versions

Security fixes will be made against the latest `main` branch.

## Reporting a vulnerability

Please do not open a public GitHub issue for security-sensitive reports.

Instead, contact the maintainer privately with:

- a description of the issue
- reproduction steps or a proof of concept
- impact assessment
- any suggested mitigation

I will acknowledge receipt as soon as possible and work with you on a fix and disclosure plan.

## Local file access model

`md-redline` is a local tool. The server can read and write markdown files inside:

- the current working directory
- the current user's home directory
- any initial file or directory passed at startup

That access model is intentional for usability, but it also means the app should only be run in environments you trust.
