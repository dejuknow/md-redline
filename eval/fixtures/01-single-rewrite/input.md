# User Authentication

## Requirements

The system should handle user authentication in a secure manner. It needs to support multiple authentication methods and ensure proper session management.

## Login Flow

1. User navigates to the login page
2. User enters their email and password
3. <!-- @comment{"id":"eval-01-c1","anchor":"System validates the input and responds appropriately","text":"Rewrite: this is too vague. Specify what validation occurs (format check, credential lookup, rate limiting) and what the success/failure responses are.","author":"PM","timestamp":"2026-03-20T10:00:00Z"} -->System validates the input and responds appropriately
4. User is redirected to the dashboard

## Session Management

Sessions expire after 30 minutes of inactivity. Refresh tokens are used to extend active sessions without requiring re-authentication.
