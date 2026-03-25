# API Endpoints

## Authentication

All endpoints require a Bearer token in the Authorization header.

## Endpoint Reference

<!-- @comment{"id":"eval-13-c1","anchor":"| POST   | /users          | Create user       | No    |","text":"Creating a user should require authentication. Change Auth Required to Yes.","author":"Tech Lead","timestamp":"2026-03-19T09:00:00Z"} -->| Method | Path            | Description       | Auth Required |
|--------|-----------------|-------------------|------|
| GET    | /health         | Health check      | No    |
| POST   | /auth/login     | Authenticate      | No    |
| POST   | /users          | Create user       | No    |
| GET    | /users/:id      | Get user profile  | Yes   |
| PUT    | /users/:id      | Update user       | Yes   |
<!-- @comment{"id":"eval-13-c2","anchor":"| DELETE | /users/:id      | Delete user       | Yes   |","text":"Add a note that DELETE is a soft delete (sets deleted_at timestamp) and the row is permanently purged after 30 days.","author":"PM","timestamp":"2026-03-19T09:01:00Z"} -->| DELETE | /users/:id      | Delete user       | Yes   |

## Rate Limits

Each endpoint is rate-limited to 100 requests per minute per API key.

## Error Codes

| Code | Meaning              |
|------|----------------------|
| 400  | Bad request          |
| 401  | Unauthorized         |
| 404  | Not found            |
| 429  | Rate limit exceeded  |
| 500  | Internal server error|
