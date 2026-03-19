# Product Specification: User Authentication System

## Overview

This document outlines the authentication system for the application. The system supports email/pass<!-- @comment{"id":"d5e1665b-c403-455b-8201-2a2f32edc64e","anchor":"view\nThis document outlines the authentication system for the application. The system supports email/pass","text":"asdg","author":"User","timestamp":"2026-03-19T02:51:26.857Z","resolved":false} -->word login, OAuth 2.0 with Google and GitHub providers, and magic link authentication.

## User Stories

### US-00<!-- @comment{"id":"2f014501-b7fd-45ef-be43-05491ae7bcf3","anchor":"ories\nUS-00","text":"sdg","author":"User","timestamp":"2026-03-19T02:51:29.849Z","resolved":false} -->1: Email Registration

As a new user, I want to register with my email and password so that I can access the application.

**Acceptance Criteria:**

- User provides email, password, and display name
- Password must be at least 8 characters with one uppercase, one number, and one special character<!-- @comment{"id":"68ed46b8-6c8c-4c8f-a947-ef459a9f2d81","anchor":"stration\nAs a new user, I want to register with my email and password so that I can access the application.\n\nAcceptance Criteria:\n\nUser provides email, password, and display name\nPassword must be at least 8 characters with one uppercase, one number, and one special character","text":"sdg","author":"User","timestamp":"2026-03-19T02:51:32.549Z","resolved":false} -->
- System sends verification email within 30 seconds
- User cannot access protected routes until email is verified

### US-002: O<!-- @comment{"id":"3f886dc3-b992-44d2-900f-4de8b36d07b2","anchor":"ends verification email within 30 seconds\nUser cannot access protected routes until email is verified\nUS-002: O","text":"sdag","author":"User","timestamp":"2026-03-19T02:51:35.524Z","resolved":false} -->Auth Login

As a user, I want to sign in with my Google or GitHub account so that I can access the application without creating a new password.

**Acceptance Criteria:**

- "Sign in with Google" and "Sign in with GitHub" buttons are displayed on the login page
- First-ti<!-- @comment{"id":"3993a00f-4fc4-4206-930c-fbaa361e48d1","anchor":"ce Criteria:\n\n\"Sign in with Google\" and \"Sign in with GitHub\" buttons are displayed on the login page\nFirst-ti","text":"sdag","author":"User","timestamp":"2026-03-19T02:51:38.499Z","resolved":false} -->me OAuth users have an account automatically created
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
