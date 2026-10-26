# Morning errors on Skhid, Pivnich and CBR — 26 October 2026

The morning workload exposed real failures after the short, quieter
[previous observation](../iteration10/findings.md). The evidence identifies
separate query, AI-provider and archive-client problems; it does not establish
the body trigram index as the primary cause. See
[measurements.json](measurements.json) for bounded windows and measurements.

## Deployment and index state

Skhid and Pivnich both run `0.1.1~rc.202610252223-1`, with no API/background/report
worker restarts since their October 25 deployment. CBR still runs
`0.1.1~rc.202610230946-1`, also without restarts.

The new body index is valid and ready on Skhid (6,954 MiB) and Pivnich
(4,974 MiB); neither has an active index build. During inspection its scan
counter stayed at 18 on Skhid and increased from 480 to 486 on Pivnich.
CBR has a much smaller 9,720-KiB index with the same definition and zero scans,
but no record of the October 25 migration. Its inbox has roughly 27,000 rows;
this catalog state must not be confused with the large new installation on
the other hosts.

In a 185-second source-statistics delta, completed inbox inserts averaged
1.605 ms across 319 calls on Skhid and 2.155 ms across 170 calls on Pivnich.
The observed failures include native joins and PostgreSQL frequency aggregation
without body predicates. These facts argue against attributing all failures
to index maintenance. They do not rule out write overhead, changed planner
choices after `ANALYZE`, the new custom-plan policy, or other release effects.
No controlled index removal or production benchmark was performed.

## Skhid: source timeouts and aggregate analytics memory pressure

Response events were deduplicated by request ID across the public, Tailscale
and direct-IP API hostnames. The equal 15-minute windows below are not a
controlled workload comparison; intentional long polls are excluded from
interactive latency conclusions.

| Skhid | 07:35–07:50 UTC | 07:50–08:05 UTC |
| --- | ---: | ---: |
| HTTP responses | 66,200 | 67,726 |
| HTTP 5xx / 503 | 23 / 6 | 5 / 5 |
| Inbox count p95 / maximum | 2,279 / 26,976 ms | 2,253 / 20,828 ms |
| Inbox page p95 / maximum | 2,880 / 27,943 ms | 1,991 / 8,980 ms |

The earlier window included **17 HTTP 500 responses from `/api/sigint/freqs`**
at approximately **50 seconds** and five tag-facet 503s. The later window still
had five 503s across frequency/group/tag counts, group facets and the frequency
summary table, with requests reaching **50–56 seconds**. The frequency-list
failure is a source aggregation over frequency/location and group access, not
a body-search index read. An independently sampled source post-count query
was still reading after 46 seconds, with no blocking PID reported.

Native ClickHouse logs contain 13 memory exceptions in 07:25–07:40 and two in
07:40–07:55. They include both the **2.2-GiB per-query cap** and the **8.8-GiB
aggregate gateway-user cap**. At 07:35 multiple concurrent requests were
selected as victims of aggregate user memory pressure. This is distinct from
total-server memory exhaustion. The query shapes include repeated group-access
semi joins and broad cursor pages without text predicates. A low-memory victim
does not mean that victim alone consumed the aggregate budget.

The source-statistics delta also showed costly source counts, network/message
batch reads, ID bounds and repeated attachment-job claims. Native success and
source fallback must be measured together; retaining a memory cap does not
make these broad query shapes cheap.

## Pivnich: bounds joins, page fallback and slow facets

| Pivnich | 07:35–07:50 UTC | 07:50–08:05 UTC |
| --- | ---: | ---: |
| HTTP responses | 62,012 | 65,261 |
| HTTP 5xx / 503 | 1 / 1 | 4 / 4 |
| Inbox count p95 / maximum | 285 / 10,887 ms | 272 / 9,432 ms |
| Inbox page p95 / maximum | 1,534 / 10,082 ms | 2,006 / 30,018 ms |

The later four 503s were two inbox pages and two tag facets. An earlier
07:40–07:55 sample also contained a unit-count request reaching 50.8 seconds;
that endpoint's p95 was 9.7 seconds across 69 requests.

The paired native windows 07:25–07:40 and 07:40–07:55 contain 12 and 11 query
memory exceptions respectively. **18 of the 23 exceptions** share an
effective-time ID-bounds shape:

```sql
SELECT min(inbox.id), max(inbox.id)
FROM inbox
JOIN message ON inbox.id = message.id
WHERE coalesce(inbox.datetime, message.timestamp, message.created_at)
      BETWEEN lower_time AND upper_time;
```

This is an illustrative normalization of the captured native SQL, not an
executable diagnostic. The join has no preceding ID restriction and hits the
2.2-GiB cap while building its right side. Four more failures share the broad
timestamp-cursor/group-access page shape also seen on Skhid. These captured
failures do not have a body-text predicate.

Source fallback is not consistently fast: page/tag requests reach the
30-second source deadline, and unit facets remain expensive. Relevant next
work is to bound the effective-time join, its page/access joins and source
facet work; merely raising limits or removing the body index is unsupported
by this inspection.

## CBR: AI rate-limit spike and a separate confirmed S3 bug

Beginning around **07:55 UTC**, document summary/position jobs using
`glm-5.3` at `inference.ai.mod.gov.ua` received HTTP **429**, error **1015**,
at roughly **250–310 events per minute**. From 07:55 through 08:08:40 the
journal contained **3,735** such document-AI errors. At 08:08:38, stored job
state showed **558 terminal failures** and **324 retry-wait jobs** whose last
error contained `1015`. These are job counts, not distinct documents or all
historical failures. The ordinary five-attempt policy turns a provider outage
into terminal job failures; a shared provider cooldown and appropriate
outage-aware retry handling are needed.

CBR's main inbox database was mostly idle when sampled; its separate file
database and document queues are the relevant pipeline. It has a large existing
extraction backlog, separate from this new AI spike. Its lack of configured
Greptime activity export prevents an equivalent HTTP response-rate comparison;
zero matching telemetry must not be interpreted as zero failed requests.

Archive cleanup also emitted recurring **HTTP 400** warnings. A bounded,
authenticated, read-only multipart-listing probe reproduced the request with
empty `key-marker` and `upload-id-marker` parameters: **400 InvalidArgument**.
The otherwise identical GET with those empty pagination markers omitted
returned **200 ListMultipartUploadsResult**. This confirms an archive-client
request bug. No multipart upload or object was created, aborted or deleted.
The owning code is `wdintel-rs/src/devices/files/archive/storage.rs`, in
`Client::unfinished`; markers should be sent only when pagination requires
them. No code or deployment change was made for this bug.

Other CBR warnings include missing local audio-cache paths and busy-loop
detectors for Iggy/unit/network workers. They need separate fixes rather than
being treated as body-index symptoms. The older release also retains legacy
media-summary lease failures addressed by later application work.

## Containment and remaining state

The user explicitly approved a temporary CBR document-AI pause. One committed
update on **`echo-cbr`, database `wd`, `public.device_document_settings`, id 1**
set `summaries_enabled=false` and `positions_enabled=false`. Verification by
08:14:10 UTC found `enabled=true` and both AI flags false. Extraction remains
enabled; the existing workers load these flags before claiming another job.
No service restart was needed. Samples at 08:14:11 and 08:16:29 showed
unchanged position/summary attempt totals (14,776 / 18,848), zero running AI
jobs and no new document-AI errors after 08:14:15. The contained spike left
**882 terminal failures** (56 positions, 826 summaries) and **357 retry-wait
summary jobs** with stored error `1015`. Archive cleanup emitted 155 further
warnings during verification; pausing AI does not fix that separate bug.
This approval covers the two settings only;
resuming AI or requeueing terminal failures requires its own authorized scope.

Skhid and Pivnich analytics health was fresh and healthy and historical
attachment coverage complete. At 08:08:38 their source slots were active,
with roughly 7.5 MB and 1.3 MB unconsumed WAL. Active-source messenger queues
held three and two items respectively, both with zero retained retries and
two-second oldest ages. Skhid's 389 deleted-source historical rows are excluded.
This is not a sustained replication outage or ingestion backlog in those
samples.

Missing-AOR and ambiguous-unit warnings remain, alongside GOI integration
warnings. They are separate configuration/integration findings. Pivnich's
earlier local journal window had already expired; its empty result is not a
zero-error baseline. Its source-statistics deallocation counter also increased
by one, so matched-entry deltas cannot account for every source query.

No index, migration, release, service state, retry counter, analytics setting
or health metadata was changed. The only production mutation was the explicitly
approved CBR document-AI pause. Priority is to contain that provider outage,
fix archive listing, then address the captured analytics/source query paths;
#3780 still requires peak-load and correctness verification.

The local query changes on `3780-26oct`, measurements and delivery status are
recorded in [the implementation follow-up](implementation.md).
