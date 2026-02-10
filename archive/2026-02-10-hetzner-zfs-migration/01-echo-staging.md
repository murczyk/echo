# 2026-02-10 Hetzner ZFS Migration: echo-staging (CT 660)

Source: `pve-1` (aka `echo-mothership-01`)
Target: `pve-hz-1` (cluster node)

Migration method: ZFS pre-copy (online) + final incremental (after stop) + start on target.

## Where To Run Commands

All commands below are intended to be run on the source node `pve-1` as user `ziggy` (with `sudo` where needed). The commands use SSH to execute the remote parts on `pve-hz-1` as `root`.

## Readiness

- Source `pve-1`:
  - CT `660` is `running`
  - `rootfs: local-zfs:subvol-660-disk-0,size=150G`
  - dataset: `rpool/data/subvol-660-disk-0` (used ~23.6G, `refquota=150G`)
  - `unprivileged: 1`, `features: nesting=1`
  - extra bind mount: `/dev/net/tun`
- Target `pve-hz-1`:
  - CTID `660` is free
  - `local-zfs` is `rpool/data`
  - `/dev/net/tun` exists
  - `subuid/subgid` match (`root:100000:65536`)
- Network caveat (downtime-related):
  - On `pve-1`, SDN `vnet0` is `10.190.255.0/24` (CT uses DHCP).
  - On `pve-hz-1`, SDN `vnet0` is `10.190.254.0/24`.
  - After cutover, CT will likely get a new IP (plan DNS / reverse-proxy / allowlists update).

## Variables

```bash
CT=660
DS=rpool/data/subvol-660-disk-0
DST=root@pve-hz-1.eagle-atria.ts.net
```

Optional sanity checks:

```bash
sudo pct status ${CT}
sudo zfs list -o name,used,avail,refer,mountpoint ${DS}
ssh ${DST} "pct status ${CT} || true"
ssh ${DST} "zfs list -o name,used,avail,refer,mountpoint rpool/data/subvol-660-disk-0 2>/dev/null || true"
```

## Step 1: Pre-copy (online)

Full send while CT is running:

```bash
SNAP=mig660-pre1-2026-02-10
sudo zfs snapshot ${DS}@${SNAP}
sudo zfs send -p -c ${DS}@${SNAP} | ssh ${DST} "zfs recv -F rpool/data/subvol-660-disk-0"
```

## Monitoring

This transfer goes over Tailscale (typically `tailscale0`), so you may not see activity on public NIC graphs.

Expected size / transfer size estimates (run on `pve-1`):

```bash
# Rough expected on-disk size on the target (depends on compress/dedup; here dedup is off)
sudo zfs list -o name,used,refer,logicalused,compressratio,refquota rpool/data/subvol-660-disk-0

# Estimate full send stream size for a snapshot
SNAP=mig660-pre1-2026-02-10
sudo zfs send -n -v -p -c rpool/data/subvol-660-disk-0@${SNAP}

# Estimate incremental send stream size (diff)
FROM=mig660-pre1-2026-02-10
TO=mig660-pre2-2026-02-10
sudo zfs send -n -v -p -c -i rpool/data/subvol-660-disk-0@${FROM} rpool/data/subvol-660-disk-0@${TO}
```

On `pve-1` (source):

```bash
HZ_IP=$(getent hosts pve-hz-1.eagle-atria.ts.net | head -n1 | cut -d' ' -f1)
ip route get ${HZ_IP}
sudo ss -tpn dst ${HZ_IP}:22 || true
sudo ps -eo pid,etimes,cmd | egrep "zfs send|ssh root@pve-hz-1\\.eagle-atria\\.ts\\.net" | egrep -v egrep || true
sudo ip -s link show dev tailscale0 | sed -n '1,12p'
```

On `pve-hz-1` (target):

```bash
ps -eo pid,etimes,cmd | egrep "zfs recv -F rpool/data/subvol-660-disk-0" | egrep -v egrep || true
zfs get -H -o property,value used rpool/data/subvol-660-disk-0 || true
zpool iostat -v rpool 1
```

Recommended: one more incremental pre-copy (still online) to reduce final downtime:

```bash
FROM=mig660-pre1-2026-02-10
TO=mig660-pre2-2026-02-10
sudo zfs snapshot ${DS}@${TO}
sudo zfs send -p -c -i ${DS}@${FROM} ${DS}@${TO} | ssh ${DST} "zfs recv -F rpool/data/subvol-660-disk-0"
```

You can repeat more incrementals; always use `-i last_snap new_snap`.

## Step 2: Cutover (downtime window)

Stop source CT, snapshot, send final incremental:

```bash
LAST=mig660-pre2-2026-02-10
FINAL=mig660-final-2026-02-10
sudo pct shutdown ${CT} --timeout 120 || sudo pct stop ${CT}
sudo zfs snapshot ${DS}@${FINAL}
sudo zfs send -p -c -i ${DS}@${LAST} ${DS}@${FINAL} | ssh ${DST} "zfs recv -F rpool/data/subvol-660-disk-0"
```

Copy CT config to the target (so Proxmox knows about CT 660 and points it at the already-received dataset):

```bash
sudo cat /etc/pve/lxc/660.conf | ssh ${DST} "cat > /etc/pve/lxc/660.conf"
```

Start on target, then find the (new) IP:

```bash
ssh ${DST} "pct start 660"
ssh ${DST} "pct exec 660 -- ip -4 addr show dev eth0"
```

Update DNS / reverse proxy upstream / allowlists as needed due to SDN subnet change.

## Rollback (fast)

If validation fails on target:

```bash
ssh ${DST} "pct stop 660 || true"
sudo pct start 660
```
