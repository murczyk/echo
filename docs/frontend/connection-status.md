# Background connection status

The authenticated navbar shows a small disconnected icon with the tooltip
“Відновлення з’єднання…” when session keep-alive or event polling encounters a
network error, timeout, or HTTP 5xx response. It follows the navbar's visibility,
including fullscreen mode, and supports keyboard focus and screen readers.

Each connection tracks its own failure. A successful response clears only that
connection's status; the icon disappears when neither connection is interrupted.
Status survives navigation between pages sharing the navbar. Temporary failures
never add error toasts, even during a prolonged outage, and recovery is silent.
Existing retry intervals and event-poll backoff remain unchanged.

HTTP 401 still ends the session and stops background work. Other errors keep
normal reporting: keep-alive reports immediately, while event polling reports
once after at least six failed attempts in a streak. Suppressed temporary errors
do not consume that notification. A successful poll resets the streak.
Errors from user actions retain their existing notifications.

Coverage: `wdintel-web/tests/SessionExpiryTests.elm` and
`wdintel-web/tests/e2e/connection-status.spec.ts`.

Analysis filter requests also recover from network failures and HTTP 5xx responses.
Each section has at most one scheduled retry, starting at 2 seconds and doubling
up to a 25–30 second interval. Random spacing reduces simultaneous retries across
clients. Renders cannot bypass that delay, including when other sections fail.
Successful loads reset the delay; query invalidation and leaving the page cancel
pending retries. A failure streak reports its first error once. Other HTTP errors
remain blocked for the same filter request until the query is invalidated.

Regression: [#3658](https://github.com/echoua/echo/issues/3658), exercised by
`wdintel-web/tests/e2e/connection-status.spec.ts` for gateway and network failures.
