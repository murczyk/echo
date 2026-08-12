# 2026-07-21: optional PeerDB and ClickHouse analytics

## Decision

Deploy one optional Debian 13 analytics container beside each participating
Echo instance. The operator creates the Proxmox/Incus container; the repository
installs native systemd services only. Small Echo installations remain fully
functional without the analytics container.

The selected stack is:

- source PostgreSQL as system of record;
- PeerDB logical CDC of an explicit table set;
- private MinIO transient staging;
- ClickHouse raw CDC tables plus deduplicated/deleted-row-filtered views;
- PostgreSQL 18 with `pg_clickhouse` as the application-facing gateway;
- Temporal Server with separate PostgreSQL default/visibility databases;
- application-level failure retry to PostgreSQL;
- a migrated heartbeat row whose source update must become visible through
  ClickHouse and `pg_clickhouse` before the gateway is considered fresh.

The first application candidate is `/api/rer/analysis/stats/count`. It counts
raw analytical data rather than the PostgreSQL five-minute aggregate tables.
Those aggregates and their other consumers remain in place until this path is
proven.

## Why these choices

- The `pg_clickhouse` extension is isolated from the transactional source.
- Same-name gateway compatibility views over private foreign tables allow
  existing PostgreSQL query syntax, while routing remains explicit in
  application code.
- The gateway restores JSON/JSONB, `tsvector`, and `bytea` behavior required by
  current analytical queries; PostGIS and enum fields remain text for now.
- Production Temporal persistence avoids a later migration away from
  start-dev SQLite.
- Local MinIO is required by the PeerDB OSS ClickHouse path and is rebuildable.
- A finite logical-slot WAL cap protects source availability. Losing the cap
  requires a snapshot resync rather than silently skipping changes.
- PeerDB keeps PostgreSQL JSON/JSONB string-backed in ClickHouse because
  ClickHouse native JSON rejects valid top-level arrays and scalars. The
  PostgreSQL gateway restores PostgreSQL-facing JSON types.
- `PEERDB_NULLABLE=true` preserves PostgreSQL nullability instead of allowing
  ClickHouse type defaults to replace `NULL` values.
- Published tables use `REPLICA IDENTITY FULL`, and PeerDB primary-key update
  handling is enabled, to preserve TOASTed values and key changes during CDC.
- All component/build versions are pinned; the runtime host contains no
  compilers.

## Development host findings

Analytics host:

- SSH/Tailscale: `echo@100.104.2.38`;
- Debian 13.6 `amd64`, glibc 2.41, systemd 257;
- hostname `ziggy-dev-echo-clickhouse`;
- 32 vCPUs, about 123 GiB RAM, no swap, and about 41 GiB root storage;
- initially bare except SSH/Tailscale/Postfix.

Source `ziggy-dev-echo`:

- Tailscale `100.69.44.87`;
- Ubuntu 22.04, PostgreSQL 18.4 database `wd`;
- 172 application tables, all with primary keys, plus the migrated
  `echo_analytics.heartbeat` singleton used by analytics health checks;
- JSONB, arrays, bytea, PostGIS, enums, and tsvector are present;
- initial `wal_level=replica`, no slots/publications/standbys;
- PostgreSQL initially listened on loopback only;
- about 44 GiB source disk free at audit time, so development slot cap is
  8 GiB rather than the originally considered 64 GiB.

Tailscale sharing initially allowed ICMP but not analytics-to-source TCP. The
share/ACL was corrected and bidirectional connectivity verified. PostgreSQL
was then changed to logical WAL with the intentional listener/HBA rules.

The first setup was mistakenly applied to the future staging analytics host
`100.85.35.99` (`ct-echo-staging-clickhouse`). Its mirror was dropped, the
source slot was verified removed, and its analytics target, ClickHouse, and
gateway PostgreSQL were stopped/disabled. At the user's explicit request, that
host still retains copied Ziggy secrets and raw replicated Ziggy data. It must
be wiped or replaced and every copied Ziggy credential must be rotated before
the host is reused for staging; stopped services are not sanitization. All
development validation below was then repeated on the corrected host
`100.104.2.38`.

## Artifact decision

`echo-build-deb13-main` is the dedicated Debian 13/glibc 2.41 builder and
matches the analytics runtime distribution. PeerDB v0.37.1 uses upstream CI's
Go 1.26.5 plus Rust 1.93. `pg_clickhouse` is built against the exact gateway
PostgreSQL major (18). Runtime ABI smoke checks remain mandatory; toolchains
are never installed on analytics hosts.

On 2026-07-22 the pinned artifacts were rebuilt successfully on
`echo-build-deb13-main` with Debian 13, glibc 2.41, and PostgreSQL 18.4. The
builder and the locally retrieved artifact set both passed `SHA256SUMS`
verification.

The development database-copy workflow now uses
`deploy/restore-copied-db.sh`. It remains PostgreSQL-only when no source-side
PeerDB configuration exists, and otherwise pauses the paired analytics stack,
restores the database, waits for a clean resync, refreshes the gateway, and
verifies end-to-end health. Analytics SSH and recovery scripts are checked
before the source database is touched. The resync helper waits for PeerDB to
leave its previous `RUNNING` state before accepting a later `RUNNING` result.
`just copy-db` prints the original pasteable PostgreSQL block when PeerDB is
absent and a non-interactive coordinated block when it is configured.

The workflow was exercised end to end with an `echo-staging` dump. Its
migration preflight caught three migrations that had reached staging before
the local remote refs were refreshed; the exact files were then imported from
`origin/main`. PostgreSQL restore, current migrations, source publication
reconciliation, PeerDB's replacement snapshot, gateway refresh, and the
end-to-end heartbeat check all completed successfully.

## Security boundaries

- ClickHouse, Temporal, MinIO, and PeerDB administrative APIs are local-only.
- A dedicated nftables table blocks externally reachable PeerDB Flow ports.
- The PostgreSQL gateway accepts only the paired Echo Tailscale address.
- The application gateway role is read-only, owns no database objects, and
  cannot access the private foreign-table schema directly.
- The freshness probe runs as the local `postgres` OS user without Linux
  capabilities, from a root-owned executable/library chain.
- ClickHouse separates admin, PeerDB writer, and gateway reader users.
- PeerDB catalog secrets use a 32-byte application encryption key.
- Bitwarden notes remain split as `echo-clickhouse-<source>` and
  `echo-peerdb-<source>`.

## Rollout

1. Development source/container pair.
2. `echo-staging` plus `echo-staging-clickhouse`.
3. For the bounded-facet rollout: `echo-kharkiv2`, `echo-siversk`, then
   `echo-zp2`, one pair at a time and with verification after every deploy.
4. Schedule the remaining production pairs separately after those three are
   healthy.

For every stage: snapshot, compare PostgreSQL/ClickHouse counts, verify query
pushdown, test service/network failure and fallback, then enable the optional
Echo configuration. Rollback is configuration-only.

All ClickHouse facet routes now share one date-range message-ID scope per
request. The same envelope bounds every large message and message-link
relation, while timestamps remain authoritative. Group authorization,
selected groups, and sender filtering are combined into one bounded, flat
message-group join unless the joined group relation supplies the facet
dimension. Empty scopes short-circuit, and selected/denied unit filters remain
on PostgreSQL until their analytics query is flat.

The gateway enables `pg_stat_statements`, and the bundle includes a read-only
normalized query report for correlating parent gateway shapes with ClickHouse
fragments. Rollout checks flag more than 100 remote executions per minute,
more than 100,000 rows returned by one fragment, or more than 10 million rows
read by a bounded facet.

The reusable implementation and full operating procedure are in
[`deploy/clickhouse/README.md`](../../deploy/clickhouse/README.md).

## Development validation

Migration `m20260721_141920_echo_analytics_heartbeat` was applied before the
final mirror rebuild. The development stack was installed with native systemd
services and reached PeerDB `RUNNING` after a complete 173-table snapshot: 172
application tables plus `echo_analytics.heartbeat`. Source and gateway row
counts matched for every table. The source slot was active and `reserved`,
with zero-byte flush lag and only hundreds of bytes retained at final audit.
All 173 published tables use `REPLICA IDENTITY FULL`.

PostgreSQL-facing JSONB arrays, null counts, `tsvector`, and bytea column types
were validated. This dataset had no nonempty bytea value, so a nonempty binary
round-trip remains a rollout check. A normal filtered `count(*)` was confirmed
as a ClickHouse remote aggregate through `pg_clickhouse`; JSON/tsvector
expressions remain local gateway work and require per-query performance tests.
Application validation later exposed a pg_clickhouse v0.3.2 execution bug for
a pushed-down four-table mixed join: planning produced valid remote SQL, but
execution selected a synthetic join RTE with relation OID zero. The pinned
artifact now builds the documented foreign-RTE selection fix directly from a
temporary fork commit based on v0.3.2.

The upstream-ready change and generic regression test are published from the
fork branch `agent/fix-foreign-scan-join-rte`. Runtime builds deliberately use
the separate `agent/v0.3.2-foreign-scan-rte` backport branch so adopting the
fix does not also adopt unreleased pg_clickhouse 0.4 changes. The exact runtime
commit is pinned in `deploy/clickhouse/versions.env`; no local source patch is
applied during artifact builds.

All analytics services and the firewall were active, source/gateway Tailscale
connectivity worked in both directions, and only gateway port 5432 was exposed
to the paired source. The source WAL monitor runs every minute and fails its
systemd check at the configured critical threshold. The analytics health timer
periodically updates the nonce in the migrated `echo_analytics.heartbeat` row
and succeeds only after that nonce is visible from
`public.echo_analytics__heartbeat` through ClickHouse and `pg_clickhouse`.
Echo rejects an unhealthy or older-than-90-second gateway record and uses
PostgreSQL during a short retry cooldown.

Development activation was completed by adding the matching gateway settings
to the ignored `deploy/config.toml` and restarting `just dev-back`. Echo
connected its optional analytics pool and retained PostgreSQL fallback.
The generated secret files still need to be stored in Bitwarden under
`echo-clickhouse-ziggy-dev-echo` and `echo-peerdb-ziggy-dev-echo` before this
configuration is treated as the repeatable source of truth.

## PostgreSQL 18 gateway alignment

Both analytics hosts were moved from the original PostgreSQL 17 gateway to
PostgreSQL 18.4, matching the source major/minor available from PGDG. The
`pg_clickhouse` artifact was rebuilt against PostgreSQL 18.4 from the same
pinned `v0.3.2` source with the foreign-RTE fix, now represented by a fork
commit rather than a build-time patch. Debian's dump/restore
`pg_upgradecluster` method was used because each local cluster was small; it
enabled data checksums in the new PostgreSQL 18 clusters and retained
PostgreSQL 17 offline on port 5433 in manual startup mode.

On `100.104.2.38`, the upgraded gateway retained all local roles/databases,
Temporal schema versions 1.19/1.14, the running PeerDB flow, and 173 foreign
tables plus 173 compatibility views. The PostgreSQL 18 stack passed the
end-to-end nonce probe and source publication drift check after restart. Its
root-only logical rollback backup is under
`/var/backups/echo-analytics/postgresql-17-20260721T162649Z`; the old cluster
must remain until the PostgreSQL 18 stack has completed its soak period.

On parked `100.85.35.99`, the earlier unclean PostgreSQL 17 shutdown was first
recovered, then migrated with `--no-start`. Its retained pre-heartbeat gateway
has 172 foreign tables/views and loads `pg_clickhouse 0.3.2` on PostgreSQL 18.
The backup is under
`/var/backups/echo-analytics/postgresql-17-20260721T163203Z`. Both PostgreSQL
cluster units are masked, both clusters are cleanly shut down, and the
analytics target, ClickHouse, PeerDB, Temporal, MinIO, health timer, and all
analytics listeners remain disabled/inactive.

The original direct tar install path preserved the builder UID and
group-writable directory modes on shared `/usr` parents. The condition was
discovered during the PostgreSQL 18 work and immediately repaired on both
hosts; a scoped ownership/write audit found no remaining hits. The build now
normalizes archive ownership/modes, and installation preserves existing
directory metadata and fails closed on insecure extension paths.
