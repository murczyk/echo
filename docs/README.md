# Echo architecture

Echo is a SIGINT analytical web application deployed as one application
container per installation. PostgreSQL 18 is the system of record, Redis owns
sessions and transient coordination, and separate API, background-worker, and
report-worker processes isolate interactive traffic from long-running work.

Quick intelligence-report suggestions are a synchronous, optional API path
that makes exactly one structured vLLM request. It reads only the selected
message and already-completed transcription/summary records. Historical style
examples come only from preceding accessible human `intel_product` links and
`sigint_comment` rows. The feature is disabled by default and does not persist
or log source text or prompts. Validated suggestions and bounded model replies
are retained in the administrator review journal. See
[Quick intelligence-report suggestions](AI_INTELLIGENCE_REPORT_SUGGESTIONS.md)
for access boundaries, limits, telemetry, evaluation, and rollout.

## Core topology

```mermaid
flowchart LR
    browser["Analyst browser"] -->|HTTPS| web["nginx + wdintel-web"]
    web --> api["wdintel-rs API"]

    subgraph echo_lxc["Echo application LXC · required"]
        api
        bg["wdintel-rs-bgworker"]
        reports["wdintel-rs-report-worker"]
        nlp["wdintel-py · NLP"]
        postgres[("PostgreSQL · wd")]
        redis[("Redis")]
        vector["Vector · optional"]

        api --> postgres
        bg --> postgres
        bg -->|readiness + NLP requests| nlp
        reports --> postgres
        api --> redis
        bg --> redis
        api -.-> vector
        bg -.-> vector
    end

    api -.-> integrations["Optional integrations\nVault · GOI · AI · Iggy"]
    bg -.-> integrations
    postgres ==>|logical CDC| analytics["Optional analytics LXC\nPeerDB · ClickHouse · PostgreSQL gateway"]
    vector -.-> observability["Optional observability\nSigNoz"]
```

The application container uses native systemd services; deployment tooling
does not create its LXC container. Optional analytics runs in a separate
container and stores only derived data. PostgreSQL remains authoritative, and
supported analytical reads fall back to PostgreSQL when analytics is stale or
unavailable. The optional `wd_files` database stores device file metadata
independently from the main `wd` database.

Analytics control scripts and units are deployed as one content-addressed
release to both the application and its paired analytics container. Source
operations refuse to cross a release mismatch. A dedicated serialized
analytics reconciler owns schema repair, while the frequent health service is
read-only apart from its replication heartbeat and only reports drift.

## Messenger processing

Messenger receipt and processing are separate. Receipt persists snapshots in
PostgreSQL even while NLP is unavailable. The queue processor waits for
`wdintel-py` readiness, then catches up automatically; failed rows use durable
backoff so they cannot block newer messages.

## Background worker ownership

`wdintel-rs-bgworker` owns `inbox_settlement_worker`. Inbox parsing and edits
reconcile its PostgreSQL queue in the same transaction as `location_v2`;
workers claim rows with `FOR UPDATE SKIP LOCKED` and rank settlement candidates
against the active Battle Line or the item's AOR segments. Battle Line uploads
apply only to newly queued data, while AOR changes retain their existing
behavior of requeueing affected links. Attempted misses remain available for
administrator review.

## Statistics storage

`wdintel-rs-bgworker` derives recent and daily group statistics from
PostgreSQL into Redis. Legacy location facets remain text values split from
`sigint_inbox_item.location_v2`; settlement facets are stored separately as
canonical IDs from `sigint_inbox_item_settlement.settlement_id`. The
`oneoff-calculate-historic-stats` command can rebuild only settlement buckets
with `--only settlement`.

### Initial Battle Line import from Delta KML

The stored Delta KML and Battle Line are independent modules. The latest Delta
KML is available as a separately toggleable layer on the analysis map, but
later Delta uploads do not update Battle Line. To inspect the approved initial
source without changing data, run:

```sh
sudo /usr/bin/wdintel-rs --mode=live oneoff-import-battle-line-from-delta-kml --source-id 5 --dry-run
```

Remove `--dry-run` to create BattleLine v0 when no active version exists. If an
active Battle Line prevents the import, the oneoff logs why it was skipped and
suggests `--force`. Supplying `--force` always imports the Delta source as a new
version and retires the active version, including when the same Delta source was
imported previously. Neither the oneoff nor later admin uploads requeue
historical settlement links.

## Focused documentation

- [Deployment and server operations](../deploy/server.md)
- [Optional analytics stack](../deploy/clickhouse/README.md)
- [Monitoring](MONITORING.md)
- [AI routing](../echo-vllm-router/README.md) and [document extraction](../echo-document-extractor/README.md)
- [GOI](../goi/README.md), [messengers](MESSENGERS.md), and [ORBIT](ORBIT.md)

The previous accumulated architecture and rollout notes are preserved in the
[architecture notes archive](../archive/2026-08-18-architecture-notes.md).
