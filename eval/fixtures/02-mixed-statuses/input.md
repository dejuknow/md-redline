# API Rate Limiting

## Overview

<!-- @comment{"id":"eval-02-c1","anchor":"The API uses rate limiting to prevent abuse","text":"Rewrite this paragraph: specify the rate limits (requests per minute/hour) and whether they differ by endpoint or plan tier. Remove the vague 'All endpoints are protected' sentence.","author":"PM","timestamp":"2026-03-19T09:00:00Z","resolved":false,"status":"open"} -->The API uses rate limiting to prevent abuse. All endpoints are protected.

## Rate Limit Headers

Every response includes the following headers:

- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Requests remaining in current window
- <!-- @comment{"id":"eval-02-c2","anchor":"X-RateLimit-Reset: When the window resets","text":"Specify the format — is this a Unix timestamp or seconds remaining?","author":"PM","timestamp":"2026-03-18T14:00:00Z","resolved":true,"status":"accepted"} -->`X-RateLimit-Reset`: When the window resets

## Exceeded Limits

<!-- @comment{"id":"eval-02-c3","anchor":"When rate limits are exceeded the API returns an error","text":"Specify the HTTP status code (429) and the response body format.","author":"PM","timestamp":"2026-03-19T11:00:00Z","resolved":false,"status":"addressed"} -->When rate limits are exceeded the API returns an error. Clients should implement exponential backoff.
