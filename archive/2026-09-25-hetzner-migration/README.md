# 2026-09-25: Ukrainian Proxmox to Hetzner migration

**All ten guests migrated on 26 September.** See [FINAL.md](FINAL.md) for
validated results, remaining initial backup copies and retention requirements.

## Authorization

Move only the ten guests below. Stage 1 copies bases while sources run.
Stage 2 waits for the user's later “showtime”; no automatic cutover.
Maximum interruption: 15 minutes per guest. Retain stopped sources and final
migration snapshots for seven days.

The user requires source autostart disabled and destination autostart enabled.
Set source `onboot=0` before shutdown; set destination `onboot=1` only after
successful validation. Never run both copies of a Tailscale identity.

## Placement

| Source | ID | Guest | Target | Initial live data |
| --- | --- | --- | --- | --- |
| echo-mothership-01 | 127 | ct-echo-cbr-staging | pve-hz-1-ziggy | 51 GiB |
| echo-mothership-01 | 126 | ct-echo-cbr | pve-hz-3-ziggy | 44 GiB |
| echo-mothership-01 | 128 | ct-echo-vllm-router | pve-hz-3-ziggy | <1 GiB |
| echo-mothership-01 | 129 | srv-echo-ai-agent-vm | pve-hz-1-ziggy | 55 GiB |
| echo-mothership-02 | 131 | ct-ci-neo | pve-hz-1-ziggy | 55 GiB |
| echo-mothership-02 | 405 | ct-signoz-echo | pve-hz-3-ziggy | 183 GiB |
| echo-mothership-02 | 420 | ct-gitlab-backup | pve-hz-1-ziggy | 1 + 12 GiB |
| echo-mothership-02 | 421 | ct-mattermost-cbr | pve-hz-3-ziggy | 6 GiB |
| echo-mothership-02 | 647 | ct-oblik-os-vault | pve-hz-3-ziggy | <1 GiB |
| echo-mothership-02 | 650 | ct-kmz-converter | pve-hz-3-ziggy | 1.4 GiB |

Both targets have AMD EPYC 9454P CPUs (96 threads), 251 GiB RAM and healthy
1.73 TiB mirrored NVMe pools in the quorate `cl-hz` cluster. Observed daily CPU
averages: 38% / 22%. Initial ZFS available space: approximately 455 / 561 GiB.
Expected pool usage after base import: about 81% / 79%, before future growth.
Pause at 85% pool usage or below 32 GiB available target RAM.
Preserve thin provisioning and guest limits; aggregate RAM limits exceed
physical RAM, although observed working sets fit.

Source `pve-1` runs PVE 8.4 / ZFS 2.2.8; `pve-2` runs PVE 9.0 / ZFS 2.3.4.
Both targets run PVE 9.1 / ZFS 2.3.4. Selected IDs and datasets were free.

## Dependencies and exceptions

- Preserve guest Tailscale state, MACs, hostnames, SSH identities, unprivileged
  settings and `/dev/net/tun` access.
- Outer NICs use DHCP on `vnet0`. Hetzner uses host-local Simple SDN,
  `10.190.254.0/24`, gateway `.1`, NAT and registered DHCP mappings.
  Proxmox's LXC/QEMU startup hooks register preserved MACs.
  Do not transplant Ukrainian leases or host network configuration.
- CBR production is `100.83.31.43`; staging `100.64.63.98`. Neither configures
  analytics or has PostgreSQL replication slots. Existing ClickHouse pairs
  remain untouched.
- Router APIs bind to `100.105.172.96:8000–8002`; workers use Tailscale
  `100.92.119.117:8000`, `100.95.57.33:8000`, `100.113.47.83:8000`.
  Telemetry uses `100.71.235.10:4317`.
- The extractor already runs separately on the GPU host at
  `100.93.77.92:8000`; its endpoints and CBR allowlist use Tailscale.
  It is not moving. Router and extractor health checks passed from both CBRs.
- VM 129 has a sparse 564 GiB zvol (55 GiB allocated), CPU type
  `x86-64-v2-AES`, internal Incus LVM storage and `10.43.74.0/24` NAT.
  Preserve these; detach the installation ISO on the destination.
- CT 420's `/mount-lxc/420/backup` -> `/backup` bind mount contains 12 GiB
  outside its root dataset. Copy separately with numeric ownership, ACLs,
  xattrs and sparse-file preservation.
- CT 647 is unsealed, but its auto-unseal service timed out at the last boot.
  Its existing key file is present. After final receive, fix destination-only
  startup ordering/retries and verify guest reboot recovery. Never log keys.
- Source hosts perform weekly ZFS backups to the existing `echo-gpu-hammer`
  repository. No equivalent target job was found. Restore coverage for moved
  guests, including CT 420's additional dataset, before completion.

## Stage 1 operation

`stage.py` cannot start/stop guests or change autostart. It uses a hard-coded
allowlist. Private configs/state live in ignored `.state/`. Target configs
are staged under `/var/lib/echo-hz-migration/<run>/configs`, outside `/etc/pve`.

Fresh base snapshots are held and their GUIDs/estimated sizes recorded.
Streams use `zfs send -Lcp` and `zfs receive -s -u`. Received filesystems
remain read-only with `canmount=noauto`; the zvol has `readonly=on` and
`volmode=none`. Old snapshots are not copied. No forced receive, source
rollback, dataset destruction or automatic cleanup is performed.

A detached tmux job relays existing SSH connections: one worker per source,
each capped at 5 MiB/s. Interrupted streams resume from their receive tokens.
Completed snapshots require matching GUIDs and verified storage protection.

CT 420's bind data passes through a private local rsync staging copy, then
into a dedicated destination dataset mounted at the original host path.
This avoids spreading SSH keys or forwarding an agent. It is made read-only
and unmounted after copying. Repeat its final rsync with writers stopped.
The local privileged rsync preserves only the existing SSH agent socket
environment; authentication runs as the operator, without agent forwarding
to either remote host. Its ZFS dataset enables POSIX ACLs and SA xattrs.

Run from the repository root:

```bash
python3 archive/2026-09-25-hetzner-migration/stage.py prepare
tmux new-session -d -s echo-hz-base 'cd /home/ubuntu/workspace/echo && python3 -u archive/2026-09-25-hetzner-migration/stage.py seed >> archive/2026-09-25-hetzner-migration/.state/worker.log 2>&1'
python3 archive/2026-09-25-hetzner-migration/stage.py status
```

Create `.state/STOP` to pause safely. Remove it and rerun `seed` after
investigation; partial receives are retained. An exclusive local lock prevents
duplicate workers. `STATUS.md` shows progress; `PROCESS.md` records milestones.
A verified base sends a Mattermost notification for every guest, including
small guests. Completion of the whole stage sends another notification and
requests showtime. The existing repository hook URL is not saved here.
SIGINT, SIGTERM and SIGHUP request a persistent safe pause through the same
STOP control, allowing worker cleanup and pause notification before exit.

## Showtime

Order: **127, 650, 420, 131, 421, 647, 129, 128, 126, 405**.
Warm-sync first. Require estimated final transfer <= five minutes before
beginning each 15-minute outage window.

1. Recheck health, capacity, configs, IDs, work and latest common snapshot.
2. Drain work; set source `onboot=0`; exclude HA/automation restarts.
   Shut down gracefully and confirm stopped; failed shutdown aborts cutover.
3. Take/hold final snapshot, send incremental and verify GUID.
   Final-sync CT 420's bind mount with every writer stopped.
4. Register current destination config with `onboot=0`, remove obsolete
   snapshot metadata, detach VM 129 ISO and restore storage properties.
   Apply CT 647's destination-only unseal fix.
5. Confirm source stopped, then start and validate the destination.
6. Set target `onboot=1` and record both source/target states explicitly.

Validate original Tailscale identity, DNS/internet, CBR database/workers/bots
and authenticated OCR, all router pools, Mattermost, Vault unseal/reboot,
KMZ conversion, CI access, backup contents, VM Incus/dispatch, and fresh
SigNoz telemetry. Router interruption affects AI/OCR clients; SigNoz goes last.

Before destination boot, rollback may restart the unchanged source after
fencing the destination. After destination boot, assume new writes: preserve
both copies and reconcile data before any source restart.
Retain stopped sources and final snapshots seven days; cleanup is separate
and follows verified target backups and acceptance.

References: [ZFS send](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-send.8.html),
[ZFS receive](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-receive.8.html).

## Showtime execution (26 September)

Showtime was authorized at 07:36 UTC. Live state is in [CUTOVER.md](CUTOVER.md).
`cutover.py warm <id>` sends a held incremental while the source runs;
`switch <id>` disables source autostart, shuts down, adds a migration lock,
sends/verifies the final incremental and boots the destination with onboot=0.
`validate_guest.py <id>` runs application/network checks; after recording
all additional guest-specific checks, `cutover.py confirm <id>` enables
target autostart and sends the per-guest Mattermost notification.

- KMZ needed Tailscale authorization despite byte-identical saved Tailscale
  state and machine-id. The user reauthorized it and restored its original
  100.102.183.12 address. Supported GPX-to-KML conversion was verified.
- CI inherited the target host's 100.100.100.100 resolver, causing a Tailscale
  DNS loop. Explicit PVE resolvers and a networkd DHCP-DNS override fixed it;
  a guest reboot verified persistence. Subsequent LXC configs lacking explicit
  resolvers receive 8.8.8.8 and 1.1.1.1 on the destination.
- No selected guest has a separate PVE firewall file, HA entry or replication job.
- Backup preparation uses the existing source backup executable, checksum
  verified after copying, with explicit migrated-guest allowlists and new
  pve-hz-1/pve-hz-3 repository namespaces. Dedicated host keys are restricted
  by source addresses and SSH `restrict`; the receiver host key is pinned
  through the existing trusted operator SSH connection.
- CT 420's host bind data has a separate resumable ZFS backup with GUID checks,
  one source / four receiver backup snapshots and a weekly interval checked
  by a nightly timer. Its retention filter excludes all migration snapshots.

- Vault's auto-unseal now uses loopback while retaining certificate hostname
  verification. The existing local key file is used without logging it.
  Unseal completed automatically after both migration boot and a guest reboot.
- After all other warm copies finished, SigNoz's resumable transfer was given
  the freed bandwidth: 10 MiB/s for the sole warm stream, the same aggregate
  cap as the original two 5 MiB/s source workers.
- CBR production's 10 Signal bots match the source baseline. Its three
  WhatsApp bots restart because their phone numbers are missing from the
  database. The stopped source's persistent journals confirm identical errors
  and over 1.3 million restarts before migration. No WhatsApp configuration
  was changed; this pre-existing issue needs separate application follow-up.

## Backup operation after migration

Both targets use `/etc/echo-hz-backup.toml` with explicit migrated-guest
allowlists and the existing `echo-gpu-hammer` repository. The weekly interval
retains one source and four repository backup snapshots. The nightly
`echo-hz-backup.timer` checks at 01:00 UTC on pve-hz-1 and 04:00 UTC on
pve-hz-3. CT 420's additional dataset is covered by the separate
`echo-hz-bind-backup.timer`, checked at 02:00 UTC on pve-hz-1.

Inspect `systemctl status echo-hz-backup.service` and
`journalctl -u echo-hz-backup.service` on either target. For CT 420's bind
volume, use `echo-hz-bind-backup.service` on pve-hz-1. A oneshot service
reported as `activating (start)` is copying; successful completion must be
confirmed from the journal and receiver snapshot GUID. Large initial copies
continue independently of this operator session. Do not treat an enabled
timer or a running copy as proof that every guest already has a new backup.

Repository roots are `hdd0/proxmox-backups/pve-hz-1` and
`hdd0/proxmox-backups/pve-hz-3`. CT 420's extra volume is under
`pve-hz-1/ct-gitlab-backup/bind-backup`. Keep stopped Ukrainian copies and
held final migration snapshots for at least seven days and until the new
backups are verified. Cleanup requires a separate operation.
