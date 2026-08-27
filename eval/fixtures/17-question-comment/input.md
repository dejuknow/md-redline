# Rate Limiting

## Defaults

<!-- @comment{"id":"eval-17-c1","anchor":"The rate limit is 100 requests per minute","text":"Is this per tenant or per API key? I can never remember which one we shipped.","author":"PM","timestamp":"2026-08-26T09:00:00Z"} -->The rate limit is 100 requests per minute.

## Burst behaviour

<!-- @comment{"id":"eval-17-c2","anchor":"Requests over the limit are dropped","text":"Say they get a 429 with a Retry-After header, rather than just 'dropped'.","author":"PM","timestamp":"2026-08-26T09:01:00Z"} -->Requests over the limit are dropped.
