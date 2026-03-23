# Permissions Model

## Overview

The application uses role-based access control (RBAC) to manage permissions.

## Roles

- **Admin**: Full access to all resources
- **Editor**: Can create and modify content
- **Viewer**: Read-only access

## Permission Checks

<!-- @comment{"id":"eval-07-c1","anchor":"Permission checks happen at the API layer","text":"Need more detail: how are permissions checked? Middleware? Per-handler? What happens on failure?","author":"PM","timestamp":"2026-03-19T10:00:00Z","resolved":false,"status":"open","replies":[{"id":"eval-07-r1","text":"Specifically, we need to know if this is a centralized middleware or scattered across handlers. The current wording doesn't tell an implementer what to build.","author":"PM","timestamp":"2026-03-19T10:15:00Z"},{"id":"eval-07-r2","text":"Also clarify the error response format — should it be a 403 with a JSON body explaining which permission was missing?","author":"Tech Lead","timestamp":"2026-03-19T11:00:00Z"}]} -->Permission checks happen at the API layer. Unauthorized requests are rejected.

## Audit Log

All permission-sensitive actions are logged with the user ID, action type, resource, and timestamp.
