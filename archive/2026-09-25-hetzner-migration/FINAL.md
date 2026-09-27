# Migration completed — 26 September 2026

Final audit: 2026-09-26T08:37:42+00:00. All ten requested guests are running in Hetzner.

All ten Ukrainian copies are stopped, have `onboot=0`, and are locked for migration. All ten destination copies have `onboot=1`. Final snapshot GUIDs match across each source/target pair, with migration holds on both. Per-guest Mattermost completion notifications were delivered for all ten.

| ID | Guest | Source | Destination | Tailscale IP | Shutdown to validation |
| --- | --- | --- | --- | --- | --- |
| 128 | ct-echo-vllm-router | echo-mothership-01 | pve-hz-3-ziggy | 100.105.172.96 | 2m 4s |
| 127 | ct-echo-cbr-staging | echo-mothership-01 | pve-hz-1-ziggy | 100.64.63.98 | 1m 54s |
| 126 | ct-echo-cbr | echo-mothership-01 | pve-hz-3-ziggy | 100.83.31.43 | 6m 47s |
| 129 | srv-echo-ai-agent-vm | echo-mothership-01 | pve-hz-1-ziggy | 100.69.170.28 | 1m 49s |
| 647 | ct-oblik-os-vault | echo-mothership-02 | pve-hz-3-ziggy | 100.113.72.99 | 3m 33s |
| 650 | ct-kmz-converter | echo-mothership-02 | pve-hz-3-ziggy | 100.102.183.12 | 9m 6s |
| 421 | ct-mattermost-cbr | echo-mothership-02 | pve-hz-3-ziggy | 100.121.33.7 | 1m 46s |
| 420 | ct-gitlab-backup | echo-mothership-02 | pve-hz-1-ziggy | 100.120.137.40 | 2m 28s |
| 131 | ct-ci-neo | echo-mothership-02 | pve-hz-1-ziggy | 100.121.228.69 | 5m 48s |
| 405 | ct-signoz-echo | echo-mothership-02 | pve-hz-3-ziggy | 100.71.235.10 | 3m 54s |

Elapsed times include validation and, for KMZ, user reauthorization; they are upper bounds on service interruption. Every guest stayed within the 15-minute window.

## Validation and changes

- CBR production/staging: PostgreSQL, Redis, web, background/report workers, Python, vector, 10/13 Signal bots, all router pools and authenticated document-extractor readiness passed. ClickHouse counterparts remain in Ukraine; CBR configs have no analytics or replication dependency on them.
- Router: all three APIs and all three GPU workers passed. The separately hosted document extractor continues through Tailscale.
- VM 129: guest agent, Tailscale, internet, dispatcher and Incus storage passed. All 17 Incus instances retain their source stopped states. The destination installation ISO was detached.
- KMZ: reauthorized in the original tailnet; the user restored 100.102.183.12. A supported GPX-to-KML conversion returned HTTP 200 with verified geometry.
- CI: corrected an inherited Tailscale DNS resolver loop with explicit DNS settings; reboot persistence and signed APT repository metadata passed.
- Mattermost: PostgreSQL and local/external API health passed.
- Vault: destination auto-unseal uses loopback with verified TLS hostname and startup retries. Unseal succeeded after migration and a second guest reboot.
- GitLab backup: its separate /backup bind volume retained all 32 files and 12,538,081,280 bytes; final checksum/metadata audits passed at both transfer hops.
- SigNoz: API, database, collectors, liveness prober, PVE exporter and Mattermost bridge passed. A new log sent through external Tailscale OTLP was found in ClickHouse; production metrics were newer than target boot and 4.9 seconds old. No failed systemd units remained.
- Fifteen migration/backup safety tests passed. Private configuration, transfer, application, snapshot and audit evidence is retained in ignored .state/.

## Existing application issue

CBR production has three WhatsApp bots whose phone numbers are absent from the database. Their stopped source journals show the same errors and over 1.3 million restarts before migration. This remains a separate application configuration issue; the migration preserved the existing state.

## Destination capacity

| Host | Pool allocated | Available RAM | Cluster |
| --- | --- | --- | --- |
| pve-hz-1-ziggy | 82.0% | 104.7 GiB | Quorate |
| pve-hz-3-ziggy | 80.3% | 119.3 GiB | Quorate |

Both mirrored pools are ONLINE. CPU samples showed 49–55% idle on pve-hz-1 and 76–79% idle on pve-hz-3. Continue watching pool growth against the 85% migration threshold while retained snapshots accumulate changes.

## Backups and retention

Weekly backup coverage is enabled on both targets, with nightly checks at 01:00 UTC (hz1) and 04:00 UTC (hz3). CT 420 has a separate bind-volume backup checked at 02:00 UTC. First full jobs are running independently of this session.

KMZ and both Proxmox configuration backups have matching receiver snapshot GUIDs. Initial larger guest and CT 420 bind backups are still seeding; their completion is not yet claimed. See [README.md](README.md#backup-operation-after-migration) for service names, repository paths and verification guidance.

Retain all stopped source copies and held final snapshots until at least **3 October 2026, 09:00 UTC**, and until destination backups have been verified and accepted. Cleanup is a separate operation. After destination writes, restarting an old source requires first fencing the target and reconciling data.

See [CUTOVER.md](CUTOVER.md) for final guest state and [PROCESS.md](PROCESS.md) for the timestamped record.
