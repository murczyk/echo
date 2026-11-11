//! Child-side setup, run between `fork` and `exec`.
//!
//! The process may be a fork of a multi-threaded parent, so `Prepared::run`
//! must stay async-signal-safe: direct syscalls (through `rustix`) on data
//! prepared by the parent, no allocation, no locks, no logging.
//!
//! The session, signal and rlimit steps are portable POSIX. The isolation
//! steps (capabilities, namespaces, Landlock, the mount-namespace root) live
//! in `linux.rs` and `mounts.rs`.

use super::Policy;
use rustix::process::{setrlimit, setsid, Resource, Rlimit};
use std::io;

const RLIMIT_SLOTS: usize = 2;

/// One rlimit, with the same soft and hard value.
#[derive(Clone, Copy)]
struct Limit {
    resource: Resource,
    value: u64,
}

pub(super) struct Prepared {
    rlimits: [Option<Limit>; RLIMIT_SLOTS],
    #[cfg(target_os = "linux")]
    linux: super::linux::Restrictions,
}

impl Prepared {
    #[cfg(target_os = "linux")]
    pub(super) fn new(
        policy: &Policy,
        linux: super::linux::Restrictions,
    ) -> Self {
        Self {
            rlimits: rlimits(policy),
            linux,
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn new(policy: &Policy) -> Self {
        Self {
            rlimits: rlimits(policy),
        }
    }

    pub(super) fn run(&mut self) -> io::Result<()> {
        // A new session lets the runner kill the whole process group.
        setsid()?;
        #[cfg(target_os = "linux")]
        self.linux.bind_to_parent()?;
        reset_signal(libc::SIGXFSZ);
        #[cfg(target_os = "linux")]
        self.linux.isolate()?;
        self.set_limits()?;
        #[cfg(target_os = "linux")]
        self.linux.restrict()?;
        Ok(())
    }

    fn set_limits(&self) -> io::Result<()> {
        for limit in self.rlimits.iter().flatten() {
            let value = Some(limit.value);
            setrlimit(
                limit.resource,
                Rlimit {
                    current: value,
                    maximum: value,
                },
            )?;
        }
        Ok(())
    }
}

fn rlimits(policy: &Policy) -> [Option<Limit>; RLIMIT_SLOTS] {
    let file_size = policy.limits.file_size.map(|bytes| Limit {
        resource: Resource::Fsize,
        value: bytes,
    });
    let core = Some(Limit {
        resource: Resource::Core,
        value: 0,
    });
    [file_size, core]
}

/// An ignored `SIGXFSZ` would survive `exec` and turn a limit hit
/// into `EFBIG` instead of terminating the process.
fn reset_signal(signal: libc::c_int) {
    // SAFETY: signal(2) with SIG_DFL is async-signal-safe.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
    }
}
