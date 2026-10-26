# Session Handling

## Cookies

<!-- @comment{"id":"eval-22-c1","anchor":"The session cookie is called sid","text":"Rename the cookie to session_id everywhere in this section, so it matches the API docs.","author":"PM","timestamp":"2026-10-20T09:00:00Z"} -->The session cookie is called sid and is set with the Secure and HttpOnly flags. Clients must send sid on every request to an authenticated endpoint.

## Expiry

Sessions expire after 12 hours of inactivity. Any authenticated request resets the timer.

## Refresh Tokens

<!-- @comment{"id":"eval-22-c2","anchor":"Refresh tokens are rotated on every use","text":"Add the refresh token lifetime here (30 days).","author":"PM","timestamp":"2026-10-19T09:00:00Z","status":"resolved","replies":[{"id":"eval-22-r1","text":"Should it be 30 days for every client, or shorter for the mobile app?","author":"Claude","timestamp":"2026-10-19T09:05:00Z","agent":true},{"id":"eval-22-r2","text":"Leave the number out for now. Security still has to sign off on it, so I'm resolving this.","author":"PM","timestamp":"2026-10-19T10:00:00Z"}]} -->Refresh tokens are rotated on every use. A reused refresh token revokes the whole session family.
