# Data Model

## Users

The `users` table holds identity and profile fields, plus the bcrypt password
hash and verification state.

## Sessions

Each row in `sessions` links a user to an active token, its device, and expiry.

## Audit Log

An append-only `audit_events` table records security-relevant actions.
