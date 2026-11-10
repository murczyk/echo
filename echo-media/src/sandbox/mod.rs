//! Process sandbox applied in the forked child before `exec`.
//!
//! The parent prepares a Landlock ruleset and the resource limits; the child
//! only makes raw syscalls (see `child.rs`). Nothing here is ffmpeg-specific.
//!
//! Isolation (Landlock, capabilities, namespaces) is Linux-only. On other
//! platforms, such as macOS developer machines, processes still get the
//! cleared environment, a new session and rlimits, but no sandbox.

mod child;
#[cfg(target_os = "linux")]
mod landlock;
#[cfg(target_os = "linux")]
mod linux;

use crate::constants::*;
use crate::error::{MediaError, Result};
use std::path::{Path, PathBuf};

/// What to do when the platform cannot enforce the sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMode {
    /// Refuse to start the process. Default on Linux.
    Enforce,
    /// Log a warning and start with whatever the platform supports.
    /// Default elsewhere (macOS has no sandbox here); on Linux only for
    /// development hosts without Landlock.
    BestEffort,
}

impl Default for SandboxMode {
    fn default() -> Self {
        if cfg!(target_os = "linux") {
            Self::Enforce
        } else {
            Self::BestEffort
        }
    }
}

/// Network access granted to the sandboxed process.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Network {
    /// No network. Enforced with a new network namespace when running as
    /// root, and with Landlock TCP rules on kernels with Landlock ABI 4+.
    #[default]
    Denied,
    /// Outbound TCP to these ports (Landlock ABI 4+ only; best effort).
    TcpConnect(Vec<u16>),
}

/// Per-process resource limits. Core dumps are always disabled.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    /// `RLIMIT_FSIZE`: the largest file the process may write (`SIGXFSZ`).
    pub file_size: Option<u64>,
}

/// Filesystem, network and resource policy for one process.
///
/// Every path is resolved when the policy is applied; Landlock rules bind to
/// the inode found then, so later renames or symlink swaps do not widen it.
#[derive(Clone, Debug, Default)]
pub struct Policy {
    pub(crate) read_files: Vec<PathBuf>,
    pub(crate) read_dirs: Vec<PathBuf>,
    pub(crate) exec_files: Vec<PathBuf>,
    pub(crate) write_dirs: Vec<PathBuf>,
    pub(crate) optional_read_files: Vec<PathBuf>,
    pub(crate) optional_exec_files: Vec<PathBuf>,
    pub(crate) optional_read_dirs: Vec<PathBuf>,
    pub(crate) network: Network,
    pub(crate) limits: Limits,
}

impl Policy {
    /// A policy that can only load and run `programs` from the system.
    pub fn for_programs<P: AsRef<Path>>(programs: &[P]) -> Self {
        let mut policy = Self {
            optional_read_dirs: paths(ECHO_MEDIA_SANDBOX_SYSTEM_READ_DIRS),
            optional_read_files: paths(ECHO_MEDIA_SANDBOX_SYSTEM_READ_FILES),
            optional_exec_files: paths(ECHO_MEDIA_SANDBOX_DYNAMIC_LOADERS),
            ..Self::default()
        };
        for program in programs {
            policy = policy.exec_file(program);
        }
        policy
    }

    /// Allow running this binary. The common dynamic loader paths
    /// (`ECHO_MEDIA_SANDBOX_DYNAMIC_LOADERS`) are always executable.
    pub fn exec_file(mut self, path: impl AsRef<Path>) -> Self {
        self.exec_files.push(path.as_ref().to_path_buf());
        self
    }

    pub fn read_file(mut self, path: impl AsRef<Path>) -> Self {
        self.read_files.push(path.as_ref().to_path_buf());
        self
    }

    pub fn read_dir(mut self, path: impl AsRef<Path>) -> Self {
        self.read_dirs.push(path.as_ref().to_path_buf());
        self
    }

    /// Allow creating, writing, truncating and removing regular files
    /// beneath this directory.
    pub fn write_dir(mut self, path: impl AsRef<Path>) -> Self {
        self.write_dirs.push(path.as_ref().to_path_buf());
        self
    }

    /// Network access, plus the resolver and CA files TLS clients read.
    pub fn network(mut self, network: Network) -> Self {
        if matches!(network, Network::TcpConnect(_)) {
            self.optional_read_files
                .extend(paths(ECHO_MEDIA_SANDBOX_NETWORK_READ_FILES));
            self.optional_read_dirs
                .extend(paths(ECHO_MEDIA_SANDBOX_NETWORK_READ_DIRS));
        }
        self.network = network;
        self
    }

    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// Install the sandbox on `command`: clear the environment, and set up
    /// the child-side restrictions run between `fork` and `exec`.
    pub fn apply(
        &self,
        mode: SandboxMode,
        command: &mut tokio::process::Command,
    ) -> Result<()> {
        let prepared = self.prepare(mode)?;
        command.env_clear();
        for (name, value) in ECHO_MEDIA_CHILD_ENV {
            command.env(name, value);
        }
        command.current_dir(ECHO_MEDIA_CHILD_CWD);
        // SAFETY: the closure only makes async-signal-safe syscalls on data
        // prepared before the fork; it allocates nothing.
        unsafe {
            command.pre_exec(move || prepared.run());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn prepare(&self, mode: SandboxMode) -> Result<child::Prepared> {
        let restrictions = linux::Restrictions::new(self, mode)?;
        Ok(child::Prepared::new(self, restrictions))
    }

    #[cfg(not(target_os = "linux"))]
    fn prepare(&self, mode: SandboxMode) -> Result<child::Prepared> {
        static WARNED: std::sync::Once = std::sync::Once::new();
        match mode {
            SandboxMode::Enforce => {
                return Err(MediaError::SandboxUnavailable(
                    "process sandboxing is only implemented on Linux".into(),
                ))
            }
            SandboxMode::BestEffort => WARNED.call_once(|| {
                log::warn!(
                    "media processes run without a sandbox on this platform"
                )
            }),
        }
        Ok(child::Prepared::new(self))
    }
}

/// The Landlock ABI version of the running kernel, `None` when Landlock is
/// missing or disabled. For diagnostics and tests; the sandbox itself
/// negotiates rights through the `landlock` crate.
pub fn kernel_landlock_abi() -> Option<u32> {
    #[cfg(target_os = "linux")]
    return linux::landlock_abi();
    #[cfg(not(target_os = "linux"))]
    None
}

fn paths(values: &[&str]) -> Vec<PathBuf> {
    values.iter().map(PathBuf::from).collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn unavailable(
    mode: SandboxMode,
    reason: impl Into<String>,
) -> Result<()> {
    let reason = reason.into();
    match mode {
        SandboxMode::Enforce => Err(MediaError::SandboxUnavailable(reason)),
        SandboxMode::BestEffort => {
            log::warn!("media sandbox degraded: {reason}");
            Ok(())
        }
    }
}
