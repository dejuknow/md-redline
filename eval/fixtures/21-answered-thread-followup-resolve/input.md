# Webhook Delivery

## Overview

The platform sends an HTTP POST to each registered endpoint when a subscribed event occurs. Payloads are JSON and are capped at 256 KB.

## Signing

<!-- @comment{"id":"eval-21-c1","anchor":"Every delivery is signed with the endpoint secret","text":"Is the secret per endpoint or per account?","author":"PM","timestamp":"2026-10-12T09:00:00Z","replies":[{"id":"eval-21-r1","text":"Per endpoint. Each endpoint gets its own secret, shown once when the endpoint is created. The paragraph already says so, so I left it unchanged.","author":"Claude","timestamp":"2026-10-12T09:05:00Z","agent":true}]} -->Every delivery is signed with the endpoint secret. Receivers must verify the signature before processing the payload.

The signature is an HMAC-SHA256 of the raw request body, sent in the `X-Signature` header.

## Retries

<!-- @comment{"id":"eval-21-c2","anchor":"Failed deliveries are retried","text":"How many times do we retry a failed delivery?","author":"PM","timestamp":"2026-10-12T09:01:00Z","replies":[{"id":"eval-21-r2","text":"The spec does not say, so I have not changed the text. Do you want a fixed number of attempts or a backoff schedule?","author":"Claude","timestamp":"2026-10-12T09:06:00Z","agent":true},{"id":"eval-21-r3","text":"Backoff schedule please: retry up to 8 times over 24 hours, with the wait doubling after each attempt. Put that in the doc.","author":"PM","timestamp":"2026-10-12T10:30:00Z","agent":false}]} -->Failed deliveries are retried.

A delivery counts as failed when the endpoint returns a non-2xx status or does not respond within 10 seconds.

## Disabling endpoints

An endpoint that fails every delivery for 3 days is disabled and its owner is notified by email.
