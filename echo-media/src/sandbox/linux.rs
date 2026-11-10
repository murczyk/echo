//! Linux-only isolation steps run by `child.rs`: parent-death signal,
//! network namespace, capability drop, `NO_NEW_PRIVS` and Landlock.
//! Same async-signal-safety rules as `child.rs`.

use super::child::check;
use super::{landlock, unavailable, Network, Policy, SandboxMode};
use crate::constants::*;
use crate::error::Result;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

const CAP_SETPCAP: u32 = 8;
const CAP_SYS_ADMIN: u32 = 21;
const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
/// NOROOT, NO_SETUID_FIXUP, KEEP_CAPS and NO_CAP_AMBIENT_RAISE, each locked:
/// `exec` can no longer grant capabilities to uid 0.
const SECURE_BITS_LOCKED: libc::c_ulong = 0xef;

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

pub(super) struct Restrictions {
    ruleset: Option<OwnedFd>,
    parent: libc::pid_t,
    drop_bounding_set: bool,
    unshare_network: bool,
    cap_last: u32,
}

impl Restrictions {
    pub(super) fn new(policy: &Policy, mode: SandboxMode) -> Result<Self> {
        let ruleset = landlock::build(policy, mode)?;
        let effective = effective_capabilities();
        let can_unshare = effective & (1 << CAP_SYS_ADMIN) != 0;
        let denied = policy.network == Network::Denied;
        // SAFETY: geteuid has no preconditions.
        if denied && !can_unshare && unsafe { libc::geteuid() } == 0 {
            unavailable(
                mode,
                "root without CAP_SYS_ADMIN cannot isolate the network",
            )?;
        }
        Ok(Self {
            ruleset,
            parent: std::process::id() as libc::pid_t,
            drop_bounding_set: effective & (1 << CAP_SETPCAP) != 0,
            unshare_network: denied && can_unshare,
            cap_last: cap_last(),
        })
    }

    /// Die with the parent; fail if it already exited during the fork.
    pub(super) fn bind_to_parent(&self) -> io::Result<()> {
        // SAFETY: plain syscalls with integer arguments.
        unsafe {
            check(libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            ))?;
            if libc::getppid() != self.parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
        }
        Ok(())
    }

    pub(super) fn isolate_network(&self) -> io::Result<()> {
        if self.unshare_network {
            // SAFETY: unshare only changes this process's namespaces.
            check(unsafe {
                libc::unshare(libc::CLONE_NEWNET | libc::CLONE_NEWIPC)
            })?;
        }
        Ok(())
    }

    /// Drop capabilities, set `NO_NEW_PRIVS`, then enter the Landlock domain.
    pub(super) fn restrict(&self) -> io::Result<()> {
        self.drop_capabilities()?;
        // SAFETY: plain prctl with integer arguments.
        check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) })?;
        self.restrict_filesystem()
    }

    fn drop_capabilities(&self) -> io::Result<()> {
        // SAFETY: prctl and capset with valid arguments; failures are
        // reported through errno.
        unsafe {
            if self.drop_bounding_set {
                check(libc::prctl(
                    libc::PR_SET_SECUREBITS,
                    SECURE_BITS_LOCKED,
                    0,
                    0,
                    0,
                ))?;
                for capability in 0..=self.cap_last {
                    let dropped = libc::prctl(
                        libc::PR_CAPBSET_DROP,
                        capability as libc::c_ulong,
                        0,
                        0,
                        0,
                    );
                    if dropped != 0 && errno() != libc::EINVAL {
                        return Err(io::Error::last_os_error());
                    }
                }
            }
            // Kernels without ambient capabilities return EINVAL: nothing to clear.
            libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong,
                0,
                0,
                0,
            );
            let header = CapHeader {
                version: LINUX_CAPABILITY_VERSION_3,
                pid: 0,
            };
            let data = [CapData::default(); 2];
            check(libc::syscall(libc::SYS_capset, &header, data.as_ptr())
                as libc::c_int)?;
        }
        Ok(())
    }

    fn restrict_filesystem(&self) -> io::Result<()> {
        let Some(ruleset) = &self.ruleset else {
            return Ok(());
        };
        // SAFETY: the ruleset fd stays open until this process execs.
        check(unsafe {
            libc::syscall(
                libc::SYS_landlock_restrict_self,
                ruleset.as_raw_fd(),
                0u32,
            )
        } as libc::c_int)?;
        Ok(())
    }
}

/// The Landlock ABI version of the running kernel.
pub(super) fn landlock_abi() -> Option<u32> {
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    // SAFETY: a NULL attribute with size 0 only queries the ABI version.
    let version = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    u32::try_from(version).ok().filter(|version| *version > 0)
}

fn effective_capabilities() -> u64 {
    let mut header = CapHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapData::default(); 2];
    // SAFETY: header and data are valid for capget's v3 layout.
    let read = unsafe {
        libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr())
    };
    if read != 0 {
        return 0;
    }
    u64::from(data[0].effective) | (u64::from(data[1].effective) << 32)
}

fn cap_last() -> u32 {
    std::fs::read_to_string(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_PATH)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_FALLBACK)
}

fn errno() -> libc::c_int {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}
