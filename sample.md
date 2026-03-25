# Product Specification: User Authentication System

## Overview

This document outlines the authentication system for the application. The system supports email/password login, OAuth 2.0 with Google and GitHub providers, and magic link authentication.

## User Stories

### US-001: Email R<!-- @comment{"id":"f4e71896-7bbc-4f47-aa7b-3813ade93de7","anchor":"egistration\nAs a new user, I want to register with my email and password so that I can access the application.\n\nAcceptance Criteria:","text":"asdf","author":"Dennis","timestamp":"2026-03-24T16:22:15.910Z","contextBefore":"entication.\nUser Stories\nUS-001: Email R","contextAfter":"\nUser provides email, password, and disp"} -->egistration

<!-- @comment{"id":"77f5164c-8e55-4313-aad1-83ebadb6d7f9","anchor":" register with my email and password so that I can access the application.","text":"asdf","author":"Dennis","timestamp":"2026-03-24T16:21:26.142Z","contextBefore":"User Stories\nUS-001: Email Registration\n","contextAfter":"\nAcceptance Criteria:\n\nUser provides ema","resolved":true,"status":"resolved"} -->As a new user, I want to register with my email and password so that I can access the application.

**Acceptance Criteria:**

- <!-- @comment{"id":"cd41c2e3-4a24-49f9-b61a-bfd3ec0465d3","anchor":"User provides email, password, and display name\nPassword must be at least","text":"qwert","author":"Dennis","timestamp":"2026-03-24T16:21:32.417Z","contextBefore":" the application.\nAcceptance Criteria:\n\n","contextAfter":" 8 characters with one uppercase, one nu"} -->User provides email, password, and display name
- Password must be at least 8 characters with one uppercase, one number, and one special character
- System sends verification email within 30 seconds
- User cannot access protected routes until email is verified

### US-002: OAuth Login

As a user, I want to sign in with my Google or GitHub account so that I can access the application without creating a new password.

**Acceptance Criteria:**

- "Sign in with Google" and "Sign in with GitHub" buttons are displayed on the login page
- First-time OAuth users have an account automatically created
- Returning OAuth users are matched to their existing account
- OAuth tokens are stored securely and refreshed automatically

### US-003: Magic Link Authentication

As a user, I want to sign in via a magic link sent to my email so that I can access the application without remembering a password.

**Acceptance Criteria:**

- User enters their email on the login page
- System sends a one-time login link valid for 15 minutes
- Clicking the link authenticates the user and redirects to the dashboard
- Each link can only be used once

## Technical Architecture

### Authentication Flow

1. User submits credentials (email/password, OAuth, or magic link request)
2. Server validates credentials against the user store
3. On success, server issues a JWT access token (15-minute expiry) and a refresh token (7-day expiry)
4. Access token is stored in memory; refresh token is stored in an HTTP-only cookie
5. Client includes the access token in the Authorization header for API requests

### Security Considerations

- All passwords are hashed with bcrypt (cost factor 12)
- Rate limiting: 5 failed login attempts per IP per 15-minute window
- CSRF protection via double-submit cookie pattern
- Session invalidation on password change

### Database Schema

The authentication system uses the following tables:

| Table | Description |
|-------|-------------|
| `users` | Core user records with email and hashed password |
| `oauth_accounts` | Linked OAuth provider accounts |
| `sessions` | Active refresh token sessions |
| `magic_links` | Pending magic link tokens |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Create new account |
| POST | `/auth/login` | Email/password login |
| POST | `/auth/oauth/:provider` | OAuth callback |
| POST | `/auth/magic-link` | Request magic link |
| GET | `/auth/verify/:token` | Verify magic link |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Invalidate session |

## Open Questions

- Should we support SAML/SSO for enterprise customers in v1?
- What is the session timeout policy for inactive users?
- Do we need to support account merging when a user signs up with email and later uses OAuth with the same email?
