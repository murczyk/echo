//! Child-side setup, run between `fork` and `exec`.
//!
//! The process may be a fork of a multi-threaded parent, so `Prepared::run`
//! must stay async-signal-safe: raw syscalls on data prepared by the parent,
//! no allocation, no locks, no logging.
//!
//! The session, signal and rlimit steps are portable POSIX. The isolation
//! steps (capabilities, namespaces, Landlock) live in `linux.rs`.

use super::Policy;
use std::io;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
type Resource = libc::c_int;

const RLIMIT_SLOTS: usize = 2;

#[derive(Clone, Copy)]
struct Rlimit {
    resource: Resource,
    soft: libc::rlim_t,
    hard: libc::rlim_t,
}

pub(super) struct Prepared {
    rlimits: [Option<Rlimit>; RLIMIT_SLOTS],
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

    pub(super) fn run(&self) -> io::Result<()> {
        // SAFETY: setsid has no preconditions. A new session lets the runner
        // kill the whole process group.
        check(unsafe { libc::setsid() })?;
        #[cfg(target_os = "linux")]
        self.linux.bind_to_parent()?;
        reset_signal(libc::SIGXFSZ);
        #[cfg(target_os = "linux")]
        self.linux.isolate_network()?;
        self.set_limits()?;
        #[cfg(target_os = "linux")]
        self.linux.restrict()?;
        Ok(())
    }

    fn set_limits(&self) -> io::Result<()> {
        for limit in self.rlimits.iter().flatten() {
            let value = libc::rlimit {
                rlim_cur: limit.soft,
                rlim_max: limit.hard,
            };
            // SAFETY: `value` is a valid rlimit for the duration of the call.
            check(unsafe { libc::setrlimit(limit.resource, &value) })?;
        }
        Ok(())
    }
}

fn rlimits(policy: &Policy) -> [Option<Rlimit>; RLIMIT_SLOTS] {
    let limits = &policy.limits;
    let file_size = limits.file_size.map(|bytes| Rlimit {
        resource: libc::RLIMIT_FSIZE,
        soft: bytes,
        hard: bytes,
    });
    let core = Some(Rlimit {
        resource: libc::RLIMIT_CORE,
        soft: 0,
        hard: 0,
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

pub(super) fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}
