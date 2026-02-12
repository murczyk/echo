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
DS=rpool/data/subvol-${CT}-disk-0
DST=root@pve-hz-1.eagle-atria.ts.net
MIG_DATE=2026-02-10
SNAP_PREFIX=mig${CT}
```

Optional sanity checks:

```bash
sudo pct status ${CT}
sudo zfs list -o name,used,avail,refer,mountpoint ${DS}
ssh ${DST} "pct status ${CT} || true"
ssh ${DST} "zfs list -o name,used,avail,refer,mountpoint ${DS} 2>/dev/null || true"
```

## Step 1: Pre-copy (online)

Full send while CT is running:

```bash
SNAP=${SNAP_PREFIX}-pre1-${MIG_DATE}
sudo zfs snapshot ${DS}@${SNAP}
sudo zfs send -p -c ${DS}@${SNAP} | ssh ${DST} "zfs recv -F ${DS}"
```

## Monitoring

This transfer goes over Tailscale (typically `tailscale0`), so you may not see activity on public NIC graphs.

Expected size / transfer size estimates (run on `pve-1`):

```bash
# Rough expected on-disk size on the target (depends on compress/dedup; here dedup is off)
sudo zfs list -o name,used,refer,logicalused,compressratio,refquota ${DS}

# Estimate full send stream size for a snapshot
SNAP=${SNAP_PREFIX}-pre1-${MIG_DATE}
sudo zfs send -n -v -p -c ${DS}@${SNAP}

# Estimate incremental send stream size (diff)
FROM=${SNAP_PREFIX}-pre1-${MIG_DATE}
TO=${SNAP_PREFIX}-pre2-${MIG_DATE}
sudo zfs send -n -v -p -c -i ${DS}@${FROM} ${DS}@${TO}
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
ps -eo pid,etimes,cmd | egrep "zfs recv -F ${DS}" | egrep -v egrep || true
zfs get -H -o property,value used ${DS} || true
zpool iostat -v rpool 1
```

Recommended: one more incremental pre-copy (still online) to reduce final downtime:

```bash
FROM=${SNAP_PREFIX}-pre1-${MIG_DATE}
TO=${SNAP_PREFIX}-pre2-${MIG_DATE}
sudo zfs snapshot ${DS}@${TO}
sudo zfs send -p -c -i ${DS}@${FROM} ${DS}@${TO} | ssh ${DST} "zfs recv -F ${DS}"
```

You can repeat more incrementals; always use `-i last_snap new_snap`.

## Step 2: Cutover (downtime window)

Stop source CT, snapshot, send final incremental:

```bash
LAST=${SNAP_PREFIX}-pre2-${MIG_DATE}
FINAL=${SNAP_PREFIX}-final-${MIG_DATE}
sudo pct shutdown ${CT} --timeout 120 || sudo pct stop ${CT}
sudo zfs snapshot ${DS}@${FINAL}
sudo zfs send -p -c -i ${DS}@${LAST} ${DS}@${FINAL} | ssh ${DST} "zfs recv -F ${DS}"
```

Copy CT config to the target (so Proxmox knows about CT `${CT}` and points it at the already-received dataset):

```bash
sudo cat /etc/pve/lxc/${CT}.conf | ssh ${DST} "cat > /etc/pve/lxc/${CT}.conf"
```

Start on target, then find the (new) IP:

```bash
ssh ${DST} "pct start ${CT}"
ssh ${DST} "pct exec ${CT} -- ip -4 addr show dev eth0"
```

Update DNS / reverse proxy upstream / allowlists as needed due to SDN subnet change.

## Rollback (fast)

If validation fails on target:

```bash
ssh ${DST} "pct stop ${CT} || true"
sudo pct start ${CT}
```

## FIX NETWORK

• Because there were two independent blockers, and either one is enough to make “no internet”:

  1. The CT’s default gateway was wrong (10.192.254.1)

  - CT network is 10.190.254.0/24 on vnet0, so the gateway must be 10.190.254.1 (as in /etc/pve/sdn/subnets.cfg).
  - With gw=10.192.254.1, the container tries to ARP for a gateway that doesn’t exist on that L2 segment, so it can’t even reach its first hop. That matches the “Destination Host Unreachable from 10.190.254.3” symptom.

  2. Host forwarding was disabled (net.ipv4.ip_forward = 0)

  - Even if you set a correct static IP/gateway inside the container, Proxmox SDN’s snat 1 needs the host to forward packets from vnet0 to vmbr0.
  - With ip_forward=0, the container can typically ping the gateway, but nothing gets routed/NATed out to the internet. In our test, internet started working only after setting ip_forward=1.

  So your “set static IP inside container didn’t help” is consistent with either:

  - you still had the wrong gateway (so traffic never left the CT), or
  - you fixed the gateway, but the host still wasn’t forwarding (so traffic left the CT but died on the host).

### INSTURCTION

Reuse the existing `CT` variable (or set it if running only this section):

```bash
CT=660
```

1. SSH to the node

```bash
ssh pve-hz-1-ziggy
```

2. Fix the container gateway (CT `${CT}`)

Check what SDN says the gateway is:

```bash
sudo cat /etc/pve/sdn/subnets.cfg
```

Edit CT config and set `gw=` to that gateway (for this node: `10.190.254.1`):

```bash
sudo cp -a /etc/pve/lxc/${CT}.conf /etc/pve/lxc/${CT}.conf.bak.$(date +%Y%m%d%H%M%S)
sudo nano /etc/pve/lxc/${CT}.conf
# fix the net0 line, e.g. gw=10.190.254.1
```

3. Enable IPv4 forwarding on the host (needed for SDN SNAT)

Enable now:

```bash
sudo sysctl -w net.ipv4.ip_forward=1
```

Persist across reboot:

```bash
printf '%s\n' 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-ipforward.conf >/dev/null
sudo sysctl --system
```

4. Restart the container to apply config cleanly

```bash
sudo pct reboot ${CT}
```

5. Verify from inside the container

```bash
sudo pct exec ${CT} -- ip -4 route
sudo pct exec ${CT} -- ping -c1 10.190.254.1
sudo pct exec ${CT} -- ping -c1 8.8.8.8
```
