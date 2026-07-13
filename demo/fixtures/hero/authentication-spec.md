# User Authentication Spec

## Overview

This document defines how users sign up, sign in, and recover access across web
and mobile. It covers the email and password flow, OAuth providers, multi-factor
authentication, session handling, and the authorization model.

## Goals

- A single account works across every surface (web, iOS, Android).
- Sign-in takes under ten seconds for a returning user.
- Security defaults are safe without extra configuration.

## Non-Goals

- Enterprise SSO (SAML, SCIM) is out of scope for v1.
- Passwordless-only accounts are deferred to a later milestone.

## User Roles

### Anonymous

Unauthenticated visitors can browse public pages and start the sign-up flow.

### Member

A standard authenticated user with access to their own workspace and data.

### Admin

Elevated role that can manage members, billing, and workspace settings.

## Registration

### Email and Password

New users register with an email address, a display name, and a password.
Passwords must be <!-- @comment{"id":"c-pwreq","anchor":"at least 12 characters","text":"Should we also reject passwords that appear in known breach lists (HaveIBeenPwned)?","author":"Dennis","timestamp":"2026-07-12T14:30:00.000Z"} -->at least 12 characters with a mix of cases and one number or symbol.

### OAuth Providers

Users may instead continue with Google, GitHub, or Microsoft. On first sign-in
a local account is created and linked to the provider identity.

### Email Verification

A verification link is sent on sign-up. Unverified accounts can read but not
write until the address is confirmed.

## Authentication

### Login

Users authenticate with their email and password. The system compares the
submitted value against the stored bcrypt hash. After five consecutive failed
attempts the account is <!-- @comment{"id":"c-lockout","anchor":"locked for 15 minutes","text":"15 minutes feels long for a first offense. Consider exponential backoff instead of a flat lock.","author":"Dennis","timestamp":"2026-07-12T14:20:00.000Z"} -->locked for 15 minutes.

### Multi-Factor Authentication

Members may enable a second factor using <!-- @comment{"id":"c-mfa","anchor":"TOTP or WebAuthn","text":"Can WebAuthn make v1, or is it a fast-follow?","author":"Dennis","timestamp":"2026-07-12T14:15:00.000Z"} -->TOTP or WebAuthn. Admin accounts are required to enroll one.

### Session Management

Successful logins issue a session token stored in an HTTP-only, Secure,
SameSite=Strict cookie, valid for 30 days with sliding renewal.

## Password Management

### Password Requirements

Passwords are hashed with bcrypt (<!-- @comment{"id":"c-bcrypt","anchor":"cost factor 12","text":"bcrypt is fine, but should new installs default to argon2id?","author":"Dennis","timestamp":"2026-07-12T14:25:00.000Z","replies":[{"id":"r-bcrypt-1","author":"Claude","timestamp":"2026-07-12T14:41:00.000Z","text":"argon2id is the stronger default for new installs. I would keep verifying existing bcrypt hashes and re-hash them on the next successful login, so nobody is forced to reset."}]} -->cost factor 12) before storage. Plain-text
passwords are never logged or persisted, and rotation is never forced on a
fixed schedule.

### Password Reset

Users who forget their password can request a reset link by email. The system
generates a single-use reset token, <!-- @comment{"id":"c-reset","anchor":"valid for 1 hour","text":"Is this too short? Other suggestions?","author":"Dennis","timestamp":"2026-07-12T14:32:00.000Z","replies":[{"id":"r-reset-1","author":"Claude","timestamp":"2026-07-12T14:40:00.000Z","text":"1 hour is a reasonable default. It limits token exposure while giving users time to act. If you want a gentler UX, 2 to 4 hours is defensible, but I would keep 1 hour for a security-sensitive flow like this."}]} -->valid for 1 hour. All active sessions are invalidated once the password changes.

### Password Rotation

Rotation is user-initiated only. Compromised-credential detection can prompt a
reset, but time-based expiry is intentionally not required.

## Authorization

### Roles and Permissions

Permissions are grouped into roles. A member holds the default role; admins
inherit it and add management scopes.

### Token Scopes

API tokens carry explicit scopes. A request is rejected when the token lacks the
scope the endpoint requires.

## Security

### Rate Limiting

Auth endpoints are rate-limited per IP and per account to blunt credential
stuffing.

### Audit Logging

Sign-in, sign-out, password change, and role change events are written to an
append-only audit log.

### Data Protection

Personal data is encrypted at rest. Access is scoped to the owning workspace.

## Open Questions

- Do we need device-level "remember this browser" trust?
- Should admins be able to force-revoke another member's sessions?
