# Event polling

`POST /api/event-stream/long-poll` requires a JSON `flavor` alongside the
existing session, cursor, and deployment-maintenance protocol fields.

| Flavor | Pages | Work |
| --- | --- | --- |
| `rer` | Classic Duty, Duty Neo, classic Analysis | Authenticated session housekeeping, interception changes, deployment state. |
| `analysis-neo` | Analysis Neo | Authenticated session housekeeping, interception changes, deployment state. |
| `generic-full` | Other pages, first request and at most once every 10 seconds | Authentication, session/stream heartbeat and expiry, activity recording, deployment state; immediate response without interception events. |
| `generic` | Other requests on those pages | Deployment state from memory; no authentication, session access, Redis calls, or activity writes. |

The browser keeps request starts at least two seconds apart, including retries
and page changes. The Units page retains its five-second pause after responses.
Changing between page flavors cancels the previous request and starts the new
flavor within this limit. Navigating between pages with the same flavor keeps
the existing request. Event cursors survive flavor changes.

Deployment-only requests are handled before session, identity, and activity
middleware. They expose only the current maintenance marker and its remaining
lifetime, without changing cookies. A single API-process worker refreshes the
shared in-memory state from Redis once per second. Cached markers expire using
their remaining Redis TTL, including when a refresh fails.

Interception flavors keep the existing two-second accumulation window and
50-second maximum wait. Unrelated catalog events advance the stream cursor
without completing the request. Interception events are delivered to the
active Duty/Analysis consumer without accumulating unused events or reloading
shared unit/network catalogs.

Missing or unknown flavors are rejected. Deploy the API and frontend together;
already-open tabs must reload to use the mandatory parameter.

Regressions: `wdintel-rs/src/event_stream/mod.rs`,
`wdintel-web/tests/e2e/event-polling-flavors.spec.ts`,
`wdintel-web/tests/e2e/units-polling.spec.ts`,
`wdintel-web/tests/e2e/rer-duty-polling.spec.ts`, and
`wdintel-web/tests/e2e/connection-status.spec.ts`.
