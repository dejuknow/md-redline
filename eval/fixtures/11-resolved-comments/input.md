# Deployment Guide

## Prerequisites

<!-- @comment{"id":"eval-11-c1","anchor":"You need Docker installed","text":"Specify the minimum Docker version required (e.g., 24.0+) and mention Docker Compose v2.","author":"PM","timestamp":"2026-03-19T09:00:00Z"} -->You need Docker installed on your system.

## Configuration

<!-- @comment{"id":"eval-11-c2","anchor":"Copy the example config file and edit it","text":"This is fine as-is, no changes needed.","author":"PM","timestamp":"2026-03-19T09:01:00Z","status":"resolved"} -->Copy the example config file and edit it:

```bash
cp .env.example .env
```

## Running the Service

<!-- @comment{"id":"eval-11-c3","anchor":"Run the start command","text":"Add the specific docker compose command and mention that it runs in detached mode by default.","author":"PM","timestamp":"2026-03-19T09:02:00Z"} -->Run the start command to launch all services.

## Health Check

The service exposes a `/health` endpoint on port 8080. Verify the deployment by visiting this URL after startup.
