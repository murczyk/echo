//! Linux-only isolation steps run by `child.rs`: parent-death signal,
//! network namespace, capability drop, `NO_NEW_PRIVS` and Landlock.
//! Same async-signal-safety rules as `child.rs`; `rustix` and `landlock`
//! make the syscalls directly, without allocating.

use super::{landlock, unavailable, Network, Policy, SandboxMode};
use crate::constants::*;
use crate::error::Result;
use ::landlock::RulesetCreated;
use rustix::io::Errno;
use rustix::process::{
    geteuid, getppid, set_parent_process_death_signal, Pid, Signal,
};
use rustix::thread::{
    capabilities, clear_ambient_capability_set,
    remove_capability_from_bounding_set, set_capabilities,
    set_capabilities_secure_bits, unshare_unsafe, CapabilitiesSecureBits,
    CapabilitySet, CapabilitySets, UnshareFlags,
};
use std::io;

/// `exec` can no longer grant capabilities to uid 0: no root or setuid
/// fixups, no ambient raise, and `KEEP_CAPS` locked off. Every bit is locked.
const SECURE_BITS: CapabilitiesSecureBits = CapabilitiesSecureBits::NO_ROOT
    .union(CapabilitiesSecureBits::NO_ROOT_LOCKED)
    .union(CapabilitiesSecureBits::NO_SETUID_FIXUP)
    .union(CapabilitiesSecureBits::NO_SETUID_FIXUP_LOCKED)
    .union(CapabilitiesSecureBits::KEEP_CAPS_LOCKED)
    .union(CapabilitiesSecureBits::NO_CAP_AMBIENT_RAISE)
    .union(CapabilitiesSecureBits::NO_CAP_AMBIENT_RAISE_LOCKED);

/// Highest capability number a `CapabilitySet` (u64) can hold.
const CAP_LAST_REPRESENTABLE: u32 = 63;

pub(super) struct Restrictions {
    /// Taken by the child; `restrict_self` consumes it.
    ruleset: Option<RulesetCreated>,
    parent: Option<Pid>,
    drop_bounding_set: bool,
    unshare_network: bool,
    cap_last: u32,
}

impl Restrictions {
    pub(super) fn new(policy: &Policy, mode: SandboxMode) -> Result<Self> {
        let ruleset = landlock::build(policy, mode)?;
        let effective = capabilities(None)
            .map_or(CapabilitySet::empty(), |sets| sets.effective);
        let can_unshare = effective.contains(CapabilitySet::SYS_ADMIN);
        let denied = policy.network == Network::Denied;
        if denied && !can_unshare && geteuid().is_root() {
            unavailable(
                mode,
                "root without CAP_SYS_ADMIN cannot isolate the network",
            )?;
        }
        Ok(Self {
            ruleset: Some(ruleset),
            parent: Pid::from_raw(std::process::id() as i32),
            drop_bounding_set: effective.contains(CapabilitySet::SETPCAP),
            unshare_network: denied && can_unshare,
            cap_last: cap_last(),
        })
    }

    /// Die with the parent; fail if it already exited during the fork.
    pub(super) fn bind_to_parent(&self) -> io::Result<()> {
        set_parent_process_death_signal(Some(Signal::KILL))?;
        if getppid() != self.parent {
            return Err(Errno::SRCH.into());
        }
        Ok(())
    }

    pub(super) fn isolate_network(&self) -> io::Result<()> {
        if self.unshare_network {
            // SAFETY: rustix marks unshare unsafe because of CLONE_FILES,
            // which can leave other threads with a different fd table. Only
            // the network and IPC namespaces are unshared here, in a
            // single-threaded forked child.
            unsafe {
                unshare_unsafe(UnshareFlags::NEWNET | UnshareFlags::NEWIPC)
            }?;
        }
        Ok(())
    }

    /// Drop capabilities, then set `NO_NEW_PRIVS` and enter the Landlock
    /// domain.
    pub(super) fn restrict(&mut self) -> io::Result<()> {
        self.drop_capabilities()?;
        self.restrict_filesystem()
    }

    fn drop_capabilities(&self) -> io::Result<()> {
        if self.drop_bounding_set {
            set_capabilities_secure_bits(SECURE_BITS)?;
            for capability in 0..=self.cap_last.min(CAP_LAST_REPRESENTABLE) {
                let capability =
                    CapabilitySet::from_bits_retain(1 << capability);
                match remove_capability_from_bounding_set(capability) {
                    // EINVAL: the kernel does not know this capability.
                    Ok(()) | Err(Errno::INVAL) => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        match clear_ambient_capability_set() {
            // EINVAL: the kernel has no ambient capabilities to clear.
            Ok(()) | Err(Errno::INVAL) => {}
            Err(error) => return Err(error.into()),
        }
        set_capabilities(
            None,
            CapabilitySets {
                effective: CapabilitySet::empty(),
                permitted: CapabilitySet::empty(),
                inheritable: CapabilitySet::empty(),
            },
        )?;
        Ok(())
    }

    /// `restrict_self` sets `NO_NEW_PRIVS` before entering the domain. When
    /// the kernel lacks Landlock (allowed only in `BestEffort`), it sets
    /// `NO_NEW_PRIVS` alone.
    fn restrict_filesystem(&mut self) -> io::Result<()> {
        let Some(ruleset) = self.ruleset.take() else {
            // The child runs this once; a second call is a bug.
            return Err(Errno::INVAL.into());
        };
        // The error holds the errno of the failed prctl or
        // landlock_restrict_self; read it back without allocating.
        ruleset
            .restrict_self()
            .map_err(|_| io::Error::last_os_error())?;
        Ok(())
    }
}

fn cap_last() -> u32 {
    std::fs::read_to_string(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_PATH)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_FALLBACK)
}
