# Approved Gemma switch

On 2026-10-27 the user approved switching the callsign, settlement, and position
workers on `echo-skhid`, `echo-siversk`, `echo-pivnich`, and `echo-zp2` from
Luna to the existing Gemma engine after the government gateway continued
returning HTTP 429.

## Completed configuration

All twelve enabled worker settings now select:

| Field | Value |
| --- | --- |
| Engine | Gemma 4 26B — vLLM router |
| Engine ID on all four servers | `019fe0fc-e308-7a16-ab91-52dce5da3e78` |
| Backend | `google/gemma-4-26B-A4B-it` |
| Endpoint | `http://100.105.172.96:8000/v1` |

Each server committed one transaction updating the three worker engine IDs and
settings timestamps, with guards against concurrent configuration changes,
and notifying the settlement worker through its existing settings channel.
This switch did not clear queues again or reset attempts and retry timers.

| Server | Commit time UTC |
| --- | --- |
| echo-skhid | 15:21:44.322932 |
| echo-siversk | 15:21:45.323157 |
| echo-pivnich | 15:21:46.079969 |
| echo-zp2 | 15:21:46.974054 |

## Verification

Before switching, every server successfully read the router's model inventory
and confirmed the exact configured model. A small synthetic callsign request
from skhid completed successfully and returned both expected callsigns.

At approximately 15:22:30 UTC, all four servers had persisted new position
extractions carrying both the Gemma engine ID and the exact Gemma backend name.
This confirms actual worker inference and persistence, beyond selecting the
engine in settings.

Five zero-attempt, nonempty message jobs per worker per server were then
tracked through read-only queue checks. All sixty were no longer pending by
approximately 15:24:11 UTC, and fresh Gemma position results remained visible
on every server. Detailed observations are recorded in
[gemma-switch-evidence.json](gemma-switch-evidence.json).

Old HTTP 429 errors may remain on pending jobs until their existing retry
deadlines arrive. Those stored errors alone do not indicate that Gemma returned
the same error. Repeatedly clearing these recent jobs is not part of this
switch.

The short verification window establishes successful processing, not sustained
capacity or extraction accuracy across the complete workload. Queue-age and
success-rate monitoring and the original callsign disambiguation improvements
remain separate work.

Queue arrivals exceeded deletions on skhid and pivnich during the observed
interval, while siversk and zp2 were reducing their queues. This is a short
sample of load and throughput, not a sustained capacity estimate; the successful
switch should not be reported as proof that every queue is keeping up.
