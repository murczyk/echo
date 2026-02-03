- You have a running Proxmox instance with both, VMs and containers on it
- Your main objective is to create a set of scripts which will help migrating some of the VMs into their respective container counterpartsf
- Both VM and container will have the same base OS, they both will be in a running state
- both should give you password-less sudo
- SSH into VM is possible via its pve instance (double-ssh)
- your job is to copy as much state as possible from the VM into the container
- it's not your job to install software, it should be installed already by the prep work, or will be installed later if missing
- however, it is your job to compare installed packages (we target only debian and ubuntu), so do read the lists on both machines and report the difference (we care about packages and major versions)
- also compare present users, warn if they don't match
- very important to copy the tailscale state, so that when VM is stopped and container will start it will start owning the tailscale IP/state
- very important to copy ssh keys (root and user if any)
- very important to copy postgresql data (esp for ubuntu 22.04 + postgresql 14)
- very important to not miss home directories for regular users
- very important to not miss nginx with configs
- very important to not miss certbot ssl certs
- see /usr, /etc and other similar directories
- gather overall plan if your findings and ask before procceeding
- deliver your work as python 3 script which runs SSH commands as it goes, gathers the overal migration plan with stats and directory list (but not too large) in current directory
- parameterize that script by reading the "Current task parameters" list
    - accept them via `--param=val` like arguments, use some popular arg parse library
- use uv for dependency management
- before procceeding with the copy, present the user with your plan and allow them to procceed or stop (default)
- feel free to manually ssh into both containers as you develop the script to see how to improve the script
- compare by comparing file size only, no need to read files or compute hashsum
- however if it makes sense you can use /var/tmp/ on pve itself and rsync or do other things if needed to temporary use storage for help in migration
- if you have questions about best implementation details, design consideration or other important details -- stop and ask before implementing
- keep .gitignore up to date, no need to keep migration specific data, only keep the code

Current task parameters:

- vm ssh like this:

```
$ ssh -J ziggy@echo-mothership-02 echo@10.190.254.45 'hostnamectl'
 Static hostname: echo-ci
       Icon name: computer-vm
         Chassis: vm
      Machine ID: 311477ee47c94731bbbb815031a51ae6
         Boot ID: 841b1bac9a114d749b733c3c7e5d54b8
  Virtualization: kvm
Operating System: Ubuntu 22.04.5 LTS
          Kernel: Linux 5.15.0-164-generic
    Architecture: x86-64
 Hardware Vendor: QEMU
  Hardware Model: Standard PC _i440FX + PIIX, 1996_
```

- container ssh via PVE instance:

```
➜  ~ ssh -A -J ziggy@echo-mothership-02 echo@10.190.254.46 'hostnamectl'
 Static hostname: ct-ci-neo
       Icon name: computer-container
         Chassis: container
      Machine ID: 25f22bc43307472abf6d29a688408250
         Boot ID: beda2d64e00047b9acf3cfe180273494
  Virtualization: lxc
Operating System: Ubuntu 22.04 LTS
          Kernel: Linux 6.14.8-2-pve
    Architecture: x86-64
```

## Q&A

> Should the script perform file transfer directly from the VM to the container via rsync over SSH (using ProxyJump from the local machine), or do you want me to stage through the PVE host (/var/tmp)?

I don't care as long as it works, check which one works

> For PostgreSQL data: do you want a file-level copy of the data directory, or should I use pg_dump/pg_basebackup?

File level

> Also, is it acceptable for the script to stop or restart PostgreSQL on the container during copy?

Yes but right after user agrees, stop all you want but not permanently so that it recovers upon reboot

> For tailscale state: is it acceptable for the script to stop tailscaled on the container before copying state, and then restart it?

Yes, it's acceptable

> Are service restarts (nginx, sshd, etc.) allowed during the migration step, or should the script avoid any service management unless you approve interactively?

Yes, all allowed, downtime is ok

## INTERNAL NOTES

- srv-ci to ct-ci-neo migration: `uv run python migrate_vm_to_ct.py --vm-target=echo@10.190.254.45 --ct-target=echo@10.190.254.46 --vm-jump=ziggy@echo-mothership-02 --ct-jump=ziggy@echo-mothership-02 --ssh-agent`

## ADDITIONAL: RSYNC ONLY POSTGRESQL

As a shortcut, if you've finished migration but want to sync db data, use this:

```
ssh -A -J ziggy@echo-mothership-02 echo@10.190.254.19 \
    'sudo -n env SSH_AUTH_SOCK=$SSH_AUTH_SOCK rsync -a --delete --chown=postgres:postgres \
       --rsync-path "sudo -n rsync" \
       -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -A -J ziggy@echo-mothership-02" \
       /var/lib/postgresql/14/main/ "echo@10.190.254.43:/var/lib/postgresql/14/main/"'
```
