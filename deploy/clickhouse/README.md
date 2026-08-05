# Echo optional ClickHouse analytics stack

This bundle installs one native, Docker-free analytics stack for one Echo
PostgreSQL instance. The analytics host is a Debian 13 systemd container
created by an operator. These scripts never create an Incus/LXC/Proxmox
container.

The source PostgreSQL database remains the system of record. PeerDB streams
logical changes through a private MinIO staging bucket into ClickHouse. A
local PostgreSQL 18 gateway uses `pg_clickhouse` to expose current-state
ClickHouse views with PostgreSQL syntax. Echo connects only to that gateway;
instances without an `[analytics]` section continue to use PostgreSQL only.

```text
Echo -> source PostgreSQL 18 (transactions and fallback)
  |                         |
  |                         +-- logical publication/slot
  |                                           |
  +-> PostgreSQL 18 gateway                  PeerDB
         + public compatibility views         |
         + private pg_clickhouse tables       |
                |                        MinIO staging
                +----------------------> ClickHouse
                                           echo_cdc raw tables
                                           echo_analytics current views
```

## Supported topology

- One optional Debian 13 analytics container per Echo source container.
- Native packages and systemd only; no Docker or Podman.
- `amd64` runtime.
- Source PostgreSQL 18 and local gateway PostgreSQL 18.
- Tailscale or an equally private routed network in both directions.
- The operator creates the container, DNS/IPs, storage, backups, and SSH
  access before using this bundle.

The first development pair is `ziggy-dev-echo-clickhouse` at Tailscale address
`100.104.2.38` and source `ziggy-dev-echo` at `100.69.44.87`. Treat these as
instance values, not global defaults; size each later pair from its source data,
WAL rate, retention target, and query workload.

The future staging host `100.85.35.99` is not a clean staging target. At the
user's request it retains copied Ziggy secrets and raw replicated Ziggy data
from the mistaken first deployment. Before reusing it for staging, wipe or
replace the container and rotate every Ziggy credential copied there; merely
stopping the services is not sanitization.

## Pinned components

All pins and downloadable checksums live in [versions.env](versions.env):

- ClickHouse `26.3.12.3` LTS from its signed apt repository.
- PeerDB `v0.37.1` at its release commit.
- `pg_clickhouse` `v0.3.2`, built specifically for PostgreSQL 18 from the
  temporary `agent/v0.3.2-analytics-backports` fork branch. The pinned commit
  includes the foreign-scan RTE fix from upstream PR #319, the concurrent
  binary-scan fix from upstream PR #296, local compatible `DISTINCT` pushdown,
  `UNION` plus grouped-set-operation pushdown from upstream PR #324, and
  upstream SubPlan pushdown for compatible correlated and uncorrelated
  subqueries. It also backports JSONB top-level existence (`?`) pushdown from
  upstream PR #325 for native ClickHouse JSON and String-backed compatibility
  views. The first prevents
  `cache lookup failed for foreign table 0` in affected pushed-down joins and
  uses PostgreSQL's executor-populated user and foreign-server metadata.
  The second gives simultaneously active scans separate native connections,
  preventing crossed result blocks and rescan memory corruption. The set
  operation support keeps compatible unions and their final aggregation inside
  ClickHouse instead of transferring each arm to PostgreSQL. SubPlan support
  keeps compatible tag-filter `EXISTS`, `NOT EXISTS`, and scalar subqueries in
  the same remote query. Return the source URL and commit pin to upstream after
  these changes are released.
- Temporal Server `1.31.2` with PostgreSQL persistence and Temporal CLI
  `1.8.0`.
- MinIO security release `RELEASE.2025-10-15T17-29-55Z`, built from its
  pinned commit because that release has no official Linux binary asset.
- MinIO client `RELEASE.2025-08-13T08-35-41Z` from its checksummed asset.
- Builder Go `1.26.5`, Rust `1.93.0`, and buf `1.60.0`.

Exact ClickHouse packages are held after installation. Upgrades are explicit:
update pins/checksums, rebuild artifacts, test in development, then staging.

## Network and ports

| Port | Bind/reachability | Purpose |
| --- | --- | --- |
| Source `5432` | analytics IP only in source HBA | PeerDB CDC |
| Gateway `5432` | loopback plus source Echo IP | application analytics SQL |
| `9000`, `8123` | loopback | ClickHouse native/HTTP |
| `7233` | loopback | Temporal |
| `9002`, `9003` | loopback | MinIO API/console |
| `9900` | loopback | PeerDB PostgreSQL-wire API |
| `8112`, `8113` | PeerDB binds broadly; nftables drops non-loopback | Flow gRPC/HTTP |

`echo-analytics-firewall.service` owns only a dedicated nftables table. It
drops non-loopback traffic to `8112/8113`, permits the paired Echo address to
the gateway, and drops other non-loopback gateway traffic. It does not change
the host's default firewall policy or SSH rules. ClickHouse listener addresses
are checked after configuration.

## Secrets

Keep two exact Bitwarden Secure Note names per source hostname:

- `echo-clickhouse-<source-hostname>`: contents matching
  [clickhouse.env.example](env/clickhouse.env.example).
- `echo-peerdb-<source-hostname>`: contents matching
  [peerdb.env.example](env/peerdb.env.example).

Deploy the notes without merging them:

```text
/etc/echo-analytics/clickhouse.env  root:echo-analytics 0640
/etc/echo-analytics/peerdb.env      root:echo-analytics 0640
```

Deploy non-secret [instance.env.example](env/instance.env.example) as
`/etc/echo-analytics/instance.env` with the same ownership/mode. Deploy both
notes with `just analytics-secrets-deploy --source-server <source>
--analytics-server <analytics>`; it uses the existing
`echo-install-utils bw-sync` integration. Never put rendered notes or mirror
SQL in Git.

Configuration files are parsed as literal `KEY=VALUE` data, not executed as
shell. Single or double quotes surrounding the complete value are removed;
shell interpolation and escape processing are intentionally unsupported.
Generate passwords with `openssl rand -hex 32` so notes remain portable, and
keep `PEERDB_ENC_KEYS` single-quoted as shown in the example.

PeerDB credentials stored in its catalog are encrypted. Generate a 32-byte
key with `openssl rand -base64 32`, put it in the JSON `PEERDB_ENC_KEYS`, and
set its ID in `PEERDB_CURRENT_ENC_KEY_ID`.

The source needs the replication password while it creates/rotates the role.
Deploy [source.env.example](env/source.env.example) as
`/etc/echo-peerdb/source.env`, owned by `root`, mode `0600`, and an exclusion
file as `/etc/echo-peerdb/tables-exclude.txt`. If the exclusion file is absent,
`source-configure.sh` installs the shipped
[default exclusions](env/tables-exclude.txt), which omit superseded
PostgreSQL aggregates, the highly mutable GOI knowledge table, and transient
worker queues, the PostgreSQL-only ORBIT unit catalog and force-grouping links,
and the short-lived `echo_automation_send_log` deduplication state. The
repository file is canonical; deploy it before the first snapshot with
`just setup-analytics-reconcile-tables`. The analytics copy of the same
password stays in `echo-peerdb-<source-hostname>`.
Exclusions may name optional tables that are absent on an instance; if such a
table is created later, it remains excluded automatically.

Durable normalized domain tables, including
`sigint_inbox_item_callsign`, are intentionally not excluded. The automatic
table reconciler adds them to PeerDB after the source migration; verify the raw
ClickHouse table and current-state gateway view before considering the
deployment complete.

The source monitor installer records its invoking Unix account in a systemd
drop-in. Automatic table reconciliation runs as that account so it can reuse
the same SSH identity and known-hosts file as manual reconciliation. Run the
installer from the normal Echo administration account, verify that account can
reach `ANALYTICS_SSH_TARGET` non-interactively, and override the selection with
`ECHO_PEERDB_AUTOMATION_USER` only when necessary.

## Build artifacts

The Debian runtime receives no compiler. Build on
`echo@echo-build-deb13-main.eagle-atria.ts.net`, a dedicated Debian 13
builder matching the analytics runtime's distribution and glibc. The artifact
install step still runs `ldd` and binary smoke tests, and the PostgreSQL 18
extension load test runs in `02-configure-analytics.sh`. Do not install a
compiler on the analytics host as a workaround.

Prepare and build on the builder:

```bash
deploy/clickhouse/bin/prepare-builder.sh
deploy/clickhouse/bin/build-artifacts.sh
```

Default output is `/srv/echo-clickhouse-build/v0.37.1/artifacts`. It contains
four archives plus `SHA256SUMS`:

```text
peerdb-v0.37.1-linux-amd64.tar.gz
pg_clickhouse-v0.3.2-pg18-linux-amd64.tar.gz
minio-RELEASE.2025-10-15T17-29-55Z-linux-amd64.tar.gz
mc-RELEASE.2025-08-13T08-35-41Z-linux-amd64.tar.gz
```

Pull and verify them locally with:

```bash
deploy/clickhouse/bin/copy-artifacts.sh
```

Then copy the complete `deploy/clickhouse` directory, including
`build/artifacts`, to the analytics host.

## Installation order

All mutating steps are explicit. Run read-only preflights first.

### 1. Source PostgreSQL

Before configuring logical replication, apply Echo migrations through
`m20260721_141920_echo_analytics_heartbeat`. It creates the mandatory singleton
`echo_analytics.heartbeat` table used by the end-to-end freshness probe. On a
checked-out source deployment, the normal command is:

```bash
just migrate-up
```

Then, on the Echo source host:

```bash
deploy/clickhouse/bin/source-preflight.sh
deploy/clickhouse/bin/source-configure.sh --yes
deploy/clickhouse/bin/wal-status.sh
```

`source-configure.sh` performs one PostgreSQL restart. It preserves larger
existing values for `max_replication_slots` and `max_wal_senders`, enables
logical WAL, installs a narrow HBA block, creates a `REPLICATION BYPASSRLS`
restricted role, grants selected table reads plus column-level updates only on
the heartbeat nonce/timestamp, and reconciles an explicit publication. It does
not use `FOR ALL TABLES`, so exclusions can be introduced
later, but `echo_analytics.heartbeat` is mandatory and cannot be excluded. Both
source preflight and configuration fail if its migration is missing or the table
is excluded. The managed HBA rules precede existing rules and explicitly reject
the replication role from other addresses. It also installs a one-minute
systemd WAL monitor and a one-minute table-selection reconciliation timer.
After a successful migration, `wdintel-rs-bgworker` also requests the same
reconciliation asynchronously. New non-excluded tables are therefore added to
the publication and existing PeerDB mirror without blocking Echo startup.
Replica-identity reconciliation alters only selected tables that are not
already `FULL` and uses a two-second DDL lock timeout, so a busy table is
retried later without queueing application reads behind an exclusive lock.
Changing the exclusion file remains the explicit day-two operation below;
rerunning only `source-configure.sh` does not update an existing PeerDB mirror
mapping.

When a Tailscale address is used in `listen_addresses`, order the PostgreSQL
unit after `tailscaled.service` on that host and verify the listener after a
reboot. PostgreSQL skips an address that is absent when it starts. A stable
private Proxmox address avoids that startup dependency in production.

Before continuing, verify from the analytics host that the source TCP port is
reachable and the replication credentials can run `SELECT 1`.

### 2. Analytics runtime and artifacts

Deploy `instance.env` before the read-only preflight. Then, on the Debian 13
analytics host from this directory:

```bash
bin/analytics-preflight.sh
bin/01-install-runtime.sh
bin/install-artifacts.sh build/artifacts
```

The runtime step installs signed, pinned ClickHouse packages, PostgreSQL 18,
its client required by PeerDB, Temporal binaries/schemas, and
runtime libraries including GEOS. The artifact step verifies all four archive
checksums and rejects absolute/parent-traversal members before installation.

#### Existing PostgreSQL 17 gateway upgrade

Hosts installed from the earlier bundle must preserve the PeerDB catalog,
Temporal databases, and gateway definitions rather than initialize an empty
PostgreSQL 18 cluster. First rebuild and copy the PostgreSQL 18
`pg_clickhouse` artifact, sync the updated bundle, then install the target
server and extension:

```bash
sudo apt-get update
sudo apt-get install postgresql-18 postgresql-client-18
bin/install-artifacts.sh build/artifacts
```

If package installation created `18/main`, inspect it before proceeding. The
upgrade command deliberately refuses to remove an existing target cluster.
Only after proving that cluster is the unused package-created default may an
operator remove it with `sudo pg_dropcluster --stop 18 main`.

For an active analytics host, run:

```bash
bin/upgrade-gateway-postgresql.sh 17 --yes
bin/02-configure-analytics.sh
bin/03-install-services.sh
bin/status.sh
```

The upgrade command stops analytics writers, creates a root-only full logical
backup under `/var/backups/echo-analytics`, verifies a clean PostgreSQL 17
shutdown, and uses Debian's safe dump/restore major-upgrade method. PostgreSQL
17 remains offline in `manual` startup mode on an alternate port for rollback;
do not drop it until the PostgreSQL 18 gateway, Temporal, PeerDB mirror, source
slot, table parity, and end-to-end heartbeat have passed a soak period. The
logical backup contains role passwords and must remain root-only.

For a parked host, use this order. The temporary PostgreSQL 18 start is only
for local catalog and extension validation; do not bootstrap or resume a
mirror:

```bash
sudo systemctl unmask postgresql@17-main.service
bin/upgrade-gateway-postgresql.sh 17 --no-start --yes

sudo systemctl start postgresql@18-main.service
sudo -u postgres /usr/lib/postgresql/18/bin/psql -X -d postgres \
  -c 'SHOW server_version' -c '\l'
sudo -u postgres /usr/lib/postgresql/18/bin/psql -X \
  -d echo_analytics_gateway -c 'SELECT pgch.pgch_version()'

bin/03-install-services.sh --no-start
sudo systemctl disable --now echo-analytics.target clickhouse-server.service
sudo pg_ctlcluster --mode fast 18 main stop
sudo systemctl mask \
  postgresql@17-main.service postgresql@18-main.service

pg_lsclusters
systemctl is-enabled echo-analytics.target clickhouse-server.service \
  postgresql@17-main.service postgresql@18-main.service
systemctl is-active echo-analytics.target clickhouse-server.service \
  postgresql@17-main.service postgresql@18-main.service
sudo env LC_ALL=C /usr/lib/postgresql/17/bin/pg_controldata \
  /var/lib/postgresql/17/main | grep 'Database cluster state.*shut down'
sudo env LC_ALL=C /usr/lib/postgresql/18/bin/pg_controldata \
  /var/lib/postgresql/18/main | grep 'Database cluster state.*shut down'
if ss -H -ltn \
  | grep -Eq ':(5432|5433|7233|8112|8113|8123|9000|9002|9003|9900)$'; then
  echo 'unexpected analytics listener remains' >&2
  exit 1
fi
```

Both clusters must be down and cleanly shut down; the target and ClickHouse
must be disabled/inactive, both cluster units masked, and no analytics port
listening. `03-install-services.sh --no-start` only installs units—it does not
disable a target that was previously enabled.

### 3. Local databases and native services

After deploying the three configuration files:

```bash
bin/02-configure-analytics.sh
bin/03-install-services.sh
```

This creates separate local databases for the PeerDB catalog, Temporal,
Temporal visibility, and `echo_analytics_gateway`. Temporal runs as a real
server with PostgreSQL persistence; SQLite/start-dev is not used. The default
Temporal namespace (7-day retention) and PeerDB's `MirrorName` search
attribute are created idempotently. PeerDB Flow processes wait until that
namespace is queryable instead of racing Temporal startup.

The gateway application role owns nothing. It has only database connect,
public-schema usage, foreign-server usage, compatibility-view select, and
analytics-health-table select privileges. Its default 25-second PostgreSQL
`statement_timeout` stays below Echo's default 30-second whole-bundle timeout;
keep `ANALYTICS_GATEWAY_STATEMENT_TIMEOUT_MS` below the application's
`query_timeout_ms` when changing either value. `pg_clickhouse`
is installed in the `pgch` schema; imported foreign tables stay in the private
`echo_clickhouse_foreign` schema and `public` is reserved for same-name views.
The freshness probe runs as the local `postgres` OS user with an empty Linux
capability bounding set; its executable and library chain are root-owned.

### 4. Mirror, current views, and gateway

```bash
bin/04-bootstrap-mirror.sh
bin/status.sh
bin/table-status.sh
```

Bootstrap creates the dedicated MinIO bucket and a 14-day safety lifecycle,
enables WAL heartbeat and nullable-column preservation, keeps source JSON/JSONB
string-backed in ClickHouse, and submits an all-selected-tables initial snapshot.
The dedicated `echo_analytics.heartbeat` table is always selected and is exposed
through the gateway as `public.echo_analytics__heartbeat`.
Native ClickHouse JSON
is deliberately disabled because it rejects valid PostgreSQL JSON values such
as top-level arrays and scalars. Changing this mapping on an established
mirror requires rebuilding the raw tables with a full resync. Nullable
preservation is also mandatory: without it, ClickHouse substitutes type
defaults for PostgreSQL `NULL`, changing query semantics.
Published source tables use `REPLICA IDENTITY FULL` so updates cannot erase
unchanged TOAST values, and primary-key-update handling is enabled in PeerDB.
PostgreSQL 18 publications include stored generated columns; this is required
when a full replica identity contains one, otherwise PostgreSQL rejects updates
to that table before they reach PeerDB.
This increases WAL volume for updates and must be included when sizing the
slot cap.
The generated SQL contains passwords and exists only in a mode-0600 temporary
file that is deleted immediately. Its table mapping is derived from the
source publication, so the source exclusion file remains the only exclusion
source of truth.

Current-state ClickHouse views may be refreshed while snapshot tables appear:

```bash
bin/refresh-current-views.sh
```

Wait until `table-status.sh` reports no missing or unexpected raw tables,
refresh the current-state views once more, and only then publish the gateway
definitions. PeerDB's `_peerdb_*` internal tables are reported separately and
do not count as drift.

```bash
bin/refresh-current-views.sh
bin/refresh-gateway.sh
```

Current views use `FINAL`, exclude rows marked `_peerdb_is_deleted`, and hide
PeerDB metadata columns. The mirror explicitly creates `_peerdb_synced_at`,
`_peerdb_is_deleted`, and `_peerdb_version`. Gateway refresh replaces the
private foreign tables and public compatibility views in one PostgreSQL
transaction. It reads the source publication metadata and casts string-backed
JSON/JSONB and `tsvector` columns back to their PostgreSQL types, and imports
raw ClickHouse strings as `bytea` for source binary columns. A
source/view table or column mismatch aborts the transaction and preserves the
previous working gateway definitions.

The health timer automatically compares the source publication, raw
ClickHouse tables, current-state views, and gateway compatibility views after
each successful replication probe. Once PeerDB observes a post-DDL row change
and propagates a simple added column, it refreshes stale current and gateway
definitions without operator action. A quiet table therefore needs a reviewed,
safe row touch in the migration or a table/mirror resync; deployment tooling
must not issue generic no-op updates because tables may have mutating triggers.
Normal and local package deploys do not wait for this asynchronous step;
queries that use the new column fall back to PostgreSQL until analytics is
reconciled. Columns added with a PostgreSQL default still require an explicit
historical backfill or full mirror resync.

The same reconciliation installs versioned ClickHouse derived views and
exposes owner-owned compatibility views over private foreign tables in the
gateway:

- `echo_clickhouse_derived.message_callsign` exposes distinct active callsigns
  from `sigint_inbox_item_callsign`. During its online backfill, records above
  the replicated watermark without normalized rows fall back to the legacy JSON
  arrays.
- `echo_clickhouse_derived.message_aor_link` combines group and explicit
  network AOR links into message ID and AOR-bound rows.
- `echo_clickhouse_derived.message_network_link` exposes current network links
  ordered by message ID for bounded analytical joins.

The AOR relation lets analytical filters apply the resolved message-ID
envelope before joining the large group and network link tables. This avoids
correlated full-history scans while retaining the PostgreSQL overlap
semantics. The compatibility-view layout matches replicated gateway tables so
joins and distinct aggregation remain pushdown-safe.

The network and AOR compatibility relations read a derived
`ReplacingMergeTree` ordered by
`(sigint_inbox_item_id, id)`. A materialized view copies every PeerDB version
and deletion marker into it, so `FINAL` preserves current-state semantics
while the message-ID envelope prunes by the primary key. Reconciliation records
the PeerDB raw-table UUID and rebuilds the table plus ingestion view after a
mirror resync replaces that UUID.

The derived-schema reconciliation also owns the ClickHouse data-skipping
indexes used by time-bounded analytical queries. PeerDB does not copy
PostgreSQL indexes, and a mirror resync replaces raw tables, so the reconciler
checks the raw table UUID, adds the expected `minmax` definitions, and
materializes historical parts once per UUID. Its state is stored in
`<CLICKHOUSE_CURRENT_DB>_meta.query_index_reconciliation`; a replacement table
therefore automatically receives fresh indexes during gateway/health
reconciliation.

Every analysis facet and dedicated facet count first resolves one shared
minimum/maximum message-ID scope for its requested time interval. Concurrent
requests for the same unresolved range share that lookup, but completed
results are not cached. The timestamp predicate stays authoritative, while
the same ID bounds constrain `signal_message`, `sigint_inbox_item`, every
message-group relation, and tag, network, callsign, and AOR message links.
Group authorization, selected groups, and sender filtering use one bounded,
flat message-group join unless the joined group relation supplies the facet
dimension. An empty scope returns an empty facet or zero count without
scanning the large relations.

The envelope is only a pruning hint: timestamps and all access filters remain
authoritative. A range ending within the analytics freshness window uses only
the lower ID bound so newly replicated messages cannot be excluded between
the envelope query and the facet queries. Selected or denied unit filters stay
on PostgreSQL until they can be represented by one flat ClickHouse query.

Package deployments install the source and remote reconciliation scripts.
For checkout-based development, `just dev-back` runs the repository copy as a
bounded best-effort preflight when `/etc/echo-peerdb/source.env` exists; without
that file it does nothing. Operators can also run
`just analytics-reconcile-derived-schema` explicitly.

### 5. Echo configuration

Copy [app-analytics.toml.example](env/app-analytics.toml.example) into the
source Echo config, using `GATEWAY_PASSWORD`. Restart Echo only after an
operator compares PostgreSQL and gateway counts. The application initializes
analytics best-effort and retries each complete analytical operation through
PostgreSQL when analytics fails. Every 15–60 seconds, a native timer writes a fresh UUID
nonce to the migrated source table `echo_analytics.heartbeat`, waits for the
mirror slot, and queries `public.echo_analytics__heartbeat` through PostgreSQL
18 and `pg_clickhouse`. It records success only when that exact nonce is visible
from ClickHouse, making this an end-to-end data-plane probe rather than only a
WAL acknowledgement check. Echo requires that record to be healthy and newer than
`freshness_max_age_ms` before using analytical results, so a stalled but still
queryable ClickHouse also falls back. Failed attempts open a short per-process
cooldown instead of making every request wait for the unavailable gateway.
Keep `ANALYTICS_HEALTH_STALE_AFTER_SECONDS` and `freshness_max_age_ms` aligned;
the supplied values are 90 seconds.

Gateway refresh reads the published source schema and restores compatibility
types that ClickHouse cannot distinguish on its own, including JSON/JSONB,
bytea, tsvector, and `timestamp without time zone`. This keeps application
decoding and PostgreSQL query semantics consistent with the source database.

The analysis result, facet, and dedicated facet-count endpoints use this path:

- `/api/rer-importer/get-inbox-count`
- `/api/rer/analysis/stats/count`
- `/api/rer/analysis/stats/{groups,senders,posts,freqs,callsigns,tags,units,locations,aors,networks}`
- `/api/rer/analysis/stats/{groups,senders,posts,freqs,callsigns,tags,units,locations,aors,networks}/count`

The expensive replicated-data reads for the interception, sender, posts, REO,
digest, RER, Sposob, active-network, network-frequency, 1.2.5, and 1.2.13
reports also prefer analytics. The messenger account/group timelines and the
historical portions of the user/admin report-history dashboards read raw
replicated data; live report progress, queue state, file operations, and
mutations stay on PostgreSQL. Small catalog lookups, report rendering, mutable
cache operations, PostGIS reports, and reports requiring a repeatable
PostgreSQL snapshot remain on PostgreSQL. An analytical operation is retried
from the beginning on PostgreSQL, so a failed attempt cannot mix partial
analytical and PostgreSQL result sets.

Existing five-minute aggregate generation remains intact. Count dimension totals use scalar
`COUNT(DISTINCT ...)` queries so the gateway receives aggregates rather than
message-ID sets. Selected-callsign filters use pushed-down JSONB top-level
existence predicates. Filter shapes without a verified ClickHouse pushdown,
such as free-text search, use PostgreSQL directly.

## WAL retention and recovery

A logical replication slot prevents PostgreSQL from deleting WAL PeerDB has
not acknowledged. If PeerDB, MinIO, the network, or ClickHouse stops, retained
WAL grows under the source data filesystem.

Without a finite cap, `pg_wal` can consume the disk and PostgreSQL writes may
stop. With `max_slot_wal_keep_size`, a checkpoint eventually removes WAL past
the cap and marks the slot `lost`; PostgreSQL stays writable, but ClickHouse
can no longer catch up incrementally.

Size the cap per instance:

```text
observed peak WAL/hour × tolerated outage hours + safety margin
```

Keep that result below disk space intentionally reserved for WAL. The 8 GiB
development example is chosen because the audited source had about 44 GiB
free; it is not a production default. `source-preflight.sh` reports average
WAL generation since `pg_stat_wal.stats_reset` and filesystem space.
`wal-status.sh` reports retained bytes, percentage of cap, `safe_wal_size`,
activity, `wal_status`, and `invalidation_reason`; defaults warn at 75% and
fail at 90%. `echo-peerdb-wal-monitor.timer` runs it every minute on the source;
alert on a failed `echo-peerdb-wal-monitor.service` unit.

`max_slot_wal_keep_size` and `idle_replication_slot_timeout` are PostgreSQL
cluster-wide settings, not per-mirror settings. Audit every existing slot
before changing them: the cap or timeout can invalidate unrelated replication
consumers on the same cluster.

Recovery rules:

- Valid slot: restore the failed component and allow PeerDB to catch up.
- Lost slot: repair the stack, then run `bin/resync.sh --yes`; this creates a
  fresh snapshot. Refresh current views/gateway after tables are ready.
- Never use `pg_replication_slot_advance()` to free space. It skips changes
  and silently makes analytics inconsistent.
- `idle_replication_slot_timeout=7d` invalidates abandoned slots on PostgreSQL
  18 at checkpoint. An intentional outage longer than that therefore requires
  resync.

## Why MinIO remains required

PeerDB's OSS ClickHouse connector batches snapshots and CDC records into an
S3-compatible stage before ClickHouse loads them. Removing MinIO means using a
different external S3 service or replacing PeerDB's connector; it is not an
optional cache in this design. Its data is transient and rebuildable, not a
backup. An outage stalls replication and consequently increases retained
source WAL.

## Day-two operations

```bash
bin/start.sh
bin/stop.sh
bin/status.sh
bin/logs.sh echo-peer-flow-worker.service
systemctl status echo-analytics-health.timer
systemctl status echo-peerdb-table-reconcile.timer
journalctl -u echo-peerdb-table-reconcile.service
bin/table-status.sh
bin/refresh-current-views.sh
bin/refresh-gateway.sh
bin/resync.sh --yes
bin/finish-resync.sh
```

### The correct day-two table-selection solution

[env/tables-exclude.txt](env/tables-exclude.txt) is the versioned source of
truth. After adding or removing entries, deploy the updated Echo package and
run this on the Echo source host:

```bash
/opt/echo-peerdb/bin/source-sync-exclusions.sh --yes
```

From an Echo checkout, `just setup-analytics-reconcile-tables` performs the
same operation directly from the working tree. The command installs the
versioned file as
`/etc/echo-peerdb/tables-exclude.txt`, pauses the existing mirror, reconciles
the restricted source role and custom PostgreSQL publication, and asks PeerDB
to edit its table mappings.
Newly included tables receive their own initial snapshot; existing selected
tables are not resnapshotted. Newly excluded tables stop receiving CDC, their
raw and current ClickHouse objects are dropped, and the gateway compatibility
views are rebuilt. Source PostgreSQL tables and their data are never dropped.
After PeerDB confirms the change, excluded tables no longer needed by this
mirror are returned from `REPLICA IDENTITY FULL` to the PostgreSQL default.

Do not implement a day-two exclusion by editing the file and running only
`source-configure.sh`, `refresh-current-views.sh`, or `RESYNC MIRROR`. The first
changes only the custom publication, the refresh scripts do not edit PeerDB's
mapping, and a resync retains the mirror's existing table settings. The
coordinated command uses PeerDB's
[supported paused-mirror edit API](https://docs.peerdb.io/peerdb-api/endpoints/change-mirror-state)
and then reconciles ClickHouse and the PostgreSQL gateway.

While the mirror is paused or snapshotting a newly included table, its logical
slot retains WAL. If reconciliation fails, the command deliberately leaves the
mirror paused instead of resuming a mismatched mapping. Fix the reported error
and rerun the same command promptly. If the slot becomes `lost`, use the full
`resync.sh --yes` recovery path instead.

`just analytics-reconcile-tables` is the lower-level repair command. It applies
whatever file is already installed under `/etc/echo-peerdb` without replacing
it from the repository.

Table creation does not require that explicit command. The source timer
compares all current non-excluded PostgreSQL tables with the publication and a
fingerprint recorded after the last complete reconciliation. A mismatch runs
the same locked, coordinated operation. The bgworker merely requests the
oneshot after migrations and never waits for PeerDB or ClickHouse. If the
analytics container is unavailable, Echo starts normally and analytical
requests fall back to PostgreSQL; the timer retries every minute. A failed
reconciliation does not update the fingerprint, so it cannot be mistaken for
success.

The timer uses the already deployed `/etc/echo-peerdb/tables-exclude.txt` and
does not copy the packaged file on its own. Rerun
`deploy/clickhouse/bin/install-source-monitor.sh --yes` once on an existing
source to install this automation. Its invoking account must have passwordless
sudo and working non-interactive SSH to the paired analytics host.

The standard `just deploy` and `just deploy-from-local` workflows install the
packaged exclusion file before migrations when its selected table set differs
from `/etc/echo-peerdb/tables-exclude.txt`. They then run migrations once while
workers are stopped and require the source reconciliation plus end-to-end
analytics health check to succeed after service startup. The default health
deadline is 300 seconds and can be changed with
`ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS` in `source.env`. A direct
`wdintel-rs migrate` refuses to run while the packaged and deployed exclusion
sets differ; use `source-sync-exclusions-if-needed.sh --yes` first.

Migration pull requests are checked against
`migration-impact.json`. New tables declare `excluded` or
`replicated_snapshot`; additive replicated columns declare `cdc_backfill` with
reviewed post-DDL DML or `mirror_resync`. Drops, renames, and type changes use
`mirror_resync` until a narrower path has been validated. Dependency revision
changes for `echo-im` and `echo-gpu` must also declare whether they contain
schema changes. Deployment never starts a full mirror resync implicitly.

```json
{
  "migrations": {
    "echo:m20260801_120000_example": {
      "changes": [
        { "table": "public.example", "strategy": "cdc_backfill" }
      ]
    }
  },
  "dependencies": {
    "echo-im:<commit>": { "changes": [] }
  }
}
```

### Replacing a development source database

`just copy-db --server <source>` downloads a dump and prints a pasteable block
selected from the local configuration. Without `/etc/echo-peerdb/source.env`,
it prints the original PostgreSQL commands. With PeerDB configured, it prints
the non-interactive coordinated restore command; do not manually drop and
restore `wd` while PeerDB is attached:

```bash
deploy/restore-copied-db.sh --yes /var/tmp/wd-<timestamp>.pgrestore
```

For a separately entered command that retains confirmation, use
`just restore-copied-db --dump /var/tmp/wd-<timestamp>.pgrestore`.

`deploy/restore-copied-db.sh` checks for `/etc/echo-peerdb/source.env`. When it
is absent, it performs a PostgreSQL-only restore and current Echo/echo-im
migrations. When present, it verifies SSH and every required recovery script
before confirmation or mutation. It then pauses automatic table reconciliation
under the shared lock, stops the paired analytics stack, and waits for its
logical slot to become inactive. It restores and migrates `wd`, reconciles the
source role/publication, starts analytics, requests a clean PeerDB resync, and
finally re-enables the table timer. It waits for the replacement snapshot,
refreshes both view layers, and runs the end-to-end replication health check
before returning.
Echo continues through PostgreSQL fallback while the command waits. The default
resync timeout is two hours; override it with `MIRROR_RESYNC_TIMEOUT_SECONDS` in
the analytics instance configuration. Transient freshness failures are retried
three times. `resync.sh` also waits for PeerDB to leave the previous `RUNNING`
state before the completion waiter starts, because `RESYNC MIRROR` is accepted
asynchronously. Set `ANALYTICS_SSH_TARGET` in
`source.env` only when
`echo@<ANALYTICS_ADDRESS>` is not the correct SSH destination.

Before confirmation or any service/database mutation, the helper compares the
dump's applied Echo migrations with the migration files in the checkout. It
fails early when the copied server is newer; fetch/update the checkout and run
the printed command again. Never delete unknown rows from
`seaql_migrations` to bypass that compatibility check.

After adding/removing an exclusion, run the explicit setup reconciliation
above. `RESYNC MIRROR` only snapshots the existing mapping; it does not add or
remove tables. `table-status.sh` reports drift and never mutates the mirror.
Added columns continue through PeerDB schema propagation and the analytics
health timer refreshes stale current and gateway definitions. New tables are
handled by the source reconciliation timer.

### Credential rotation

`just analytics-secrets-deploy` reconciles local PostgreSQL and ClickHouse
users and restarts the native services, but it cannot atomically rotate every
external consumer:

- After changing `GATEWAY_PASSWORD`, deploy the matching Echo application
  configuration before restarting Echo.
- After changing `CLICKHOUSE_GATEWAY_PASSWORD`, run
  `refresh-gateway.sh`; its foreign-server user mapping contains that secret.
- `CREATE PEER IF NOT EXISTS` does not update credentials already encrypted in
  the PeerDB catalog. A `SOURCE_PASSWORD` or
  `CLICKHOUSE_PEERDB_PASSWORD` rotation therefore needs a maintenance window,
  a reviewed PeerDB peer update/recreate procedure, and a resync if the mirror
  cannot continue. Simply rerunning bootstrap is insufficient.
- When rotating `PEERDB_ENC_KEYS`, add the new key and make it current first.
  Retain every old key until all catalog secrets have been re-encrypted and a
  restart has proved they remain readable.

Monitor source slot WAL, ClickHouse/MinIO disk, systemd service health,
Temporal workflows, mirror status, `echo_analytics_health` age, fallback
count, and query latency. The gateway preloads `pg_stat_statements`, and
`bin/query-performance-report.sh [minutes] [limit]` prints read-only summaries
of normalized gateway parent queries and ClickHouse fragments. It flags a
shape above 100 remote executions per minute, a fragment returning more than
100,000 rows to the gateway, and a bounded facet reading more than 10 million
rows. The report never resets either statistics source.

`status.sh` exits nonzero when the freshness record is unhealthy or older than
the configured threshold. When analytics is configured,
`wdintel-rs-bgworker` also checks this record immediately at startup and once
per minute. It logs an error with the health detail and age while unhealthy,
and one informational recovery message after health returns.

Roll out facet changes one pair at a time in this order:
`echo-kharkiv2`, `echo-siversk`, then `echo-zp2`. After every deployment,
confirm health/freshness, compare PostgreSQL and ClickHouse results, replay the
representative facet requests, and inspect the performance report before
continuing.

## Consistency and type limits

The target is eventually consistent; 5–60 seconds of lag is acceptable for
analytical counters, facets, and reports. `FINAL` produces current rows but is more expensive than
querying raw MergeTree parts. Validate pushdown with PostgreSQL `EXPLAIN
(VERBOSE)` before routing each report. PostgreSQL-side JSON and `tsvector`
conversion prevents those expressions from being pushed into ClickHouse, so
measure those filters separately; ordinary relational filters and aggregates
can still be pushed down.

The dedicated `wdintel-rs-report-worker` uses the same freshness-gated
gateway for supported report candidate scans. Babak scans page by
`(datetime, id)` in 5,000-row batches; any gateway error discards the partial
candidate list and reruns the complete scan on PostgreSQL. Message bodies,
comments, tags, and authoritative message-network unit links are enriched from
PostgreSQL in bounded batches rather than transferred through the gateway.

The initial publication includes sensitive, binary, spatial, JSONB, array,
enum, tsvector, and audit data. Network and filesystem access must therefore
be treated like production database access. Replication support and
PostgreSQL→ClickHouse→`pg_clickhouse` round-tripping are separate questions:
test every type used by an analytical query before routing it. Do not route
generic SeaORM entity loads through this gateway. PostGIS and PostgreSQL enum
columns remain ClickHouse/PostgreSQL text in this first implementation.

## Rollback

Remove or disable `[analytics]` in Echo and restart it. PostgreSQL operation is
unchanged. Stop the analytics target afterward if desired. Keep the source
slot only while planning to resume; otherwise deliberately drop the mirror
and verify the slot is gone so WAL is no longer retained.
