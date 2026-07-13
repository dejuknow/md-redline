# API Design

## Conventions

All endpoints are versioned under `/v1` and return JSON. Errors use a consistent
`{ "error": { "code", "message" } }` envelope.

## Authentication

Requests authenticate with a bearer token in the `Authorization` header.

## Endpoints

### POST /v1/auth/login

Exchanges credentials for a session token.

### POST /v1/auth/refresh

Rotates an existing session token.
