# User Authentication Spec

## Overview

This document specifies the authentication system for the application,
supporting email/password, OAuth, and magic link sign-in methods.

## Email & Password Authentication

### Registration

Users create an account by providing an email address and a password.
The system validates the email format and checks for duplicates before
creating the account.

### Password Requirements

Passwords must meet the following strength criteria:

- Minimum 8 characters
- At least one uppercase letter
- At least one number or special character

Passwords are hashed with bcrypt (cost factor 12) before storage.
Plain-text passwords are never persisted or logged.

### Login

Users authenticate with their email and password. The system compares
the provided password against the stored bcrypt hash. After five
consecutive failed attempts, the account is locked for 15 minutes.

## OAuth Integration

The system supports Google, GitHub, and Microsoft OAuth providers.
On first OAuth login, a local account is created and linked to the
OAuth identity. Users who registered with email can link OAuth
providers from their account settings.

## Magic Links

Users can request a one-time login link sent to their email. The link
contains a cryptographically random token that expires after 15 minutes.
Clicking the link authenticates the user and invalidates the token.

## Password Reset

Users who forget their password can request a reset link via email.
The reset flow works as follows:

1. User submits their email address.
2. The system generates a reset token and sends it via email.
3. Password reset via email with expiring tokens (valid 1 hour).
4. User clicks the link and sets a new password.
5. All existing sessions are invalidated after the password change.

## Session Management

Sessions are stored server-side with a 30-day expiration. Session
tokens are delivered via HTTP-only, Secure, SameSite=Strict cookies.
Users can view and revoke active sessions from their account settings.
