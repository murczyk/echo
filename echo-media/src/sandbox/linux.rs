//! Linux-only isolation steps run by `child.rs`: parent-death signal,
//! network and mount namespaces, capability drop, `NO_NEW_PRIVS` and
//! Landlock.
//! Same async-signal-safety rules as `child.rs`; `rustix` and `landlock`
//! make the syscalls directly, without allocating.

use super::mounts::Mounts;
use super::{landlock, unavailable, FsIsolation, Network, Policy, SandboxMode};
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
    set_capabilities_secure_bits, set_no_new_privs, unshare_unsafe,
    CapabilitiesSecureBits, CapabilitySet, CapabilitySets, UnshareFlags,
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
    /// Taken by the child; `restrict_self` consumes it. `None` when the
    /// mount namespace replaces Landlock.
    ruleset: Option<RulesetCreated>,
    mounts: Option<Mounts>,
    parent: Option<Pid>,
    drop_bounding_set: bool,
    unshare: UnshareFlags,
    cap_last: u32,
    /// `false` for `SandboxMode::Disabled`: `restrict` does nothing.
    enabled: bool,
}

/// How the filesystem is restricted: exactly one of the two, or a Landlock
/// ruleset that only sets `NO_NEW_PRIVS` in `BestEffort` without Landlock.
struct Filesystem {
    ruleset: Option<RulesetCreated>,
    mounts: Option<Mounts>,
}

impl Restrictions {
    pub(super) fn new(policy: &Policy, mode: SandboxMode) -> Result<Self> {
        let effective = capabilities(None)
            .map_or(CapabilitySet::empty(), |sets| sets.effective);
        let can_unshare = effective.contains(CapabilitySet::SYS_ADMIN);
        let filesystem = filesystem(policy, mode, can_unshare)?;
        let denied = policy.network == Network::Denied;
        if denied && !can_unshare && geteuid().is_root() {
            unavailable(
                mode,
                "root without CAP_SYS_ADMIN cannot isolate the network",
            )?;
        }
        let mut unshare = UnshareFlags::empty();
        if denied && can_unshare {
            unshare |= UnshareFlags::NEWNET | UnshareFlags::NEWIPC;
        }
        if filesystem.mounts.is_some() {
            unshare |= UnshareFlags::NEWNS;
        }
        Ok(Self {
            ruleset: filesystem.ruleset,
            mounts: filesystem.mounts,
            parent: Pid::from_raw(std::process::id() as i32),
            drop_bounding_set: effective.contains(CapabilitySet::SETPCAP),
            unshare,
            cap_last: cap_last(),
            enabled: true,
        })
    }

    /// `SandboxMode::Disabled`: only the parent-death signal remains.
    pub(super) fn none() -> Self {
        Self {
            ruleset: None,
            mounts: None,
            parent: Pid::from_raw(std::process::id() as i32),
            drop_bounding_set: false,
            unshare: UnshareFlags::empty(),
            cap_last: 0,
            enabled: false,
        }
    }

    /// Die with the parent; fail if it already exited during the fork.
    pub(super) fn bind_to_parent(&self) -> io::Result<()> {
        set_parent_process_death_signal(Some(Signal::KILL))?;
        if getppid() != self.parent {
            return Err(Errno::SRCH.into());
        }
        Ok(())
    }

    /// Enter new network/IPC and mount namespaces as planned, and build the
    /// private root in the mount namespace. Needs `CAP_SYS_ADMIN`, so it
    /// runs before the capabilities are dropped.
    pub(super) fn isolate(&self) -> io::Result<()> {
        if !self.unshare.is_empty() {
            // SAFETY: rustix marks unshare unsafe because of CLONE_FILES,
            // which can leave other threads with a different fd table. Only
            // namespaces are unshared here, in a single-threaded forked
            // child.
            unsafe { unshare_unsafe(self.unshare) }?;
        }
        if let Some(mounts) = &self.mounts {
            mounts.enter()?;
        }
        Ok(())
    }

    /// Drop capabilities, then set `NO_NEW_PRIVS` and enter the Landlock
    /// domain.
    pub(super) fn restrict(&mut self) -> io::Result<()> {
        if !self.enabled {
            return Ok(());
        }
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
    /// `NO_NEW_PRIVS` alone. With the mount namespace instead of Landlock,
    /// `NO_NEW_PRIVS` is set directly.
    fn restrict_filesystem(&mut self) -> io::Result<()> {
        if self.mounts.is_some() {
            set_no_new_privs(true)?;
            return Ok(());
        }
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

/// Landlock when available (and not overridden), else the mount namespace
/// when the process may create one, else whatever `mode` allows.
fn filesystem(
    policy: &Policy,
    mode: SandboxMode,
    can_unshare: bool,
) -> Result<Filesystem> {
    let landlock = landlock::supported();
    let mounts = match policy.fs_isolation {
        FsIsolation::Auto => !landlock && can_unshare,
        FsIsolation::MountNamespace => can_unshare,
    };
    if mounts {
        if policy.fs_isolation == FsIsolation::Auto {
            warn_fallback_once();
        }
        return Ok(Filesystem {
            ruleset: None,
            mounts: Some(Mounts::plan(policy)?),
        });
    }
    if policy.fs_isolation == FsIsolation::MountNamespace {
        unavailable(mode, "a mount namespace needs CAP_SYS_ADMIN")?;
    } else if !landlock {
        unavailable(
            mode,
            "Landlock is not supported by this kernel, and the mount \
             namespace fallback needs CAP_SYS_ADMIN",
        )?;
    }
    Ok(Filesystem {
        ruleset: Some(landlock::build(policy, mode)?),
        mounts: None,
    })
}

fn warn_fallback_once() {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        log::warn!(
            "Landlock is not supported by this kernel; media processes are \
             isolated with a private mount namespace instead"
        )
    });
}

fn cap_last() -> u32 {
    std::fs::read_to_string(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_PATH)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(ECHO_MEDIA_SANDBOX_CAP_LAST_CAP_FALLBACK)
}
