# 2026-02-10 Hetzner ZFS Migration: srv-vault (VM 109)

Source: `pve-1` (aka `echo-mothership-01`)
Target: `pve-hz-1` (cluster node)

Migration method: ZFS pre-copy (online) + final incremental (after stop) + start on target.

## Where To Run Commands

All commands below are intended to be run on the source node `pve-1` as user `ziggy` (with `sudo` where needed). The commands use SSH to execute the remote parts on `pve-hz-1` as `root`.

## Readiness

- Source `pve-1`:
  - VM `109` (`srv-vault`) is `running`
  - `virtio0: local-zfs:vm-109-disk-0,size=<FILL>`
  - dataset: `rpool/data/vm-109-disk-0` (refquota=<FILL>)
- Target `pve-hz-1`:
  - VMID `109` is free
  - `local-zfs` is `rpool/data`
- Network caveat (downtime-related):
  - On `pve-1`, SDN `vnet0` is `10.190.254.0/24` (VM gets network from SDN/DHCP or static config)
  - On `pve-hz-1`, SDN `vnet0` is `10.190.254.0/24`.
  - After cutover, VM will likely get a new IP (plan DNS / reverse-proxy / allowlists update).

## Variables

```bash
VM=109
NAME=srv-vault
DS=rpool/data/vm-${VM}-disk-0
DST=root@pve-hz-1.eagle-atria.ts.net
MIG_DATE=2026-02-10
SNAP_PREFIX=mig${VM}
```

Optional sanity checks:

```bash
sudo qm status ${VM}
sudo zfs list -o name,used,avail,refer,mountpoint ${DS}
ssh ${DST} "qm status ${VM} || true"
ssh ${DST} "zfs list -o name,used,avail,refer,mountpoint ${DS} 2>/dev/null || true"
```

Optional preflight to avoid common failures:

```bash
echo "DST resolves:"
ssh -o BatchMode=yes -o ConnectTimeout=5 ${DST} "hostname"
```

## Step 1: Pre-copy (online)

Full send while VM is running:

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
sudo ps -eo pid,etimes,cmd | egrep "zfs send|ssh root@pve-hz-1\.eagle-atria\.ts\.net" | egrep -v egrep || true
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

Stop source VM, snapshot, send final incremental:

```bash
LAST=${SNAP_PREFIX}-pre2-${MIG_DATE}
FINAL=${SNAP_PREFIX}-final-${MIG_DATE}
sudo qm shutdown ${VM} --timeout 120 || sudo qm stop ${VM}
sudo zfs snapshot ${DS}@${FINAL}
sudo zfs send -p -c -i ${DS}@${LAST} ${DS}@${FINAL} | ssh ${DST} "zfs recv -F ${DS}"
```

If the final snapshot does not exist, recreate it first:

```bash
sudo zfs snapshot ${DS}@${FINAL}
sudo zfs send -p -c ${DS}@${FINAL} | ssh ${DST} "zfs recv -F ${DS}"
```

Copy VM config to the target (so Proxmox knows about VM `${VM}` and points it at the already-received dataset):

```bash
sudo cat /etc/pve/qemu-server/${VM}.conf | ssh ${DST} "cat > /etc/pve/qemu-server/${VM}.conf"
```

Start on target and check status:

```bash
ssh ${DST} "qm start ${VM}"
ssh ${DST} "qm status ${VM}"
```

Update DNS / reverse proxy upstream / allowlists as needed due to SDN subnet change.

## Rollback (fast)

If validation fails on target:

```bash
ssh ${DST} "qm stop ${VM} || true"
sudo qm start ${VM}
```

## FIX NETWORK

If the VM has no outbound connectivity after migration, the common blockers are:

1. Wrong gateway inside guest (10.192.254.1)

- If guest uses static config, ensure gateway matches this node subnet (`10.190.254.1` for `vnet0`)
- With wrong gateway, packets never leave the VM subnet.

2. Host forwarding disabled on target (`net.ipv4.ip_forward = 0`)

- Even with correct gateway, Proxmox SNAT path may still fail if host forwarding is off.
- Internet usually starts working after setting `ip_forward=1`.

### INSTRUCTION

Reuse the existing `VM` variable (or set it if running only this section):

```bash
VM=109
```

1. SSH to the node

```bash
ssh ${DST}
```

Note: `pve-hz-1-ziggy` may not resolve in DNS on every shell. Use `DST=root@pve-hz-1.eagle-atria.ts.net` from this doc to avoid confusion.

2. Check SDN subnet gateway for `vnet0`

```bash
sudo cat /etc/pve/sdn/subnets.cfg
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

4. Restart the VM to apply networking cleanly

```bash
sudo qm reboot ${VM}
```

5. Verify from inside the VM

Use your preferred guest access method (`ssh`, cloud-init network check, or monitoring endpoint):

```bash
# inside VM
ip -4 route
ping -c1 10.190.254.1
ping -c1 8.8.8.8
```
