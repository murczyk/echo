//! Builds the Landlock ruleset in the parent. The child only calls
//! `landlock_restrict_self` on the returned file descriptor.

use super::{unavailable, Network, Policy, SandboxMode};
use crate::error::{MediaError, Result};
use landlock::{
    make_bitflags, Access, AccessFs, AccessNet, BitFlags, CompatLevel,
    Compatible, NetPort, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreated, RulesetCreatedAttr, Scope, ABI,
};
use std::os::fd::OwnedFd;
use std::path::Path;

/// The newest ABI whose rights this crate requests. Raising it changes what
/// is denied by default, so do it deliberately and re-run the tests.
const BEST_EFFORT_ABI: ABI = ABI::V6;

const READ_FILE: BitFlags<AccessFs> = make_bitflags!(AccessFs::{ReadFile});
const READ_DIR: BitFlags<AccessFs> =
    make_bitflags!(AccessFs::{ReadFile | ReadDir});
const EXEC_FILE: BitFlags<AccessFs> =
    make_bitflags!(AccessFs::{ReadFile | Execute});
const WRITE_DIR: BitFlags<AccessFs> = make_bitflags!(AccessFs::{
    ReadFile | ReadDir | WriteFile | MakeReg | RemoveFile | Truncate
});

pub(super) fn build(
    policy: &Policy,
    mode: SandboxMode,
) -> Result<Option<OwnedFd>> {
    let ruleset = handled(mode).map_err(sandbox_error)?;
    let ruleset = ruleset.create().map_err(sandbox_error)?;
    let ruleset = add_fs_rules(ruleset, policy)?;
    let ruleset = add_net_rules(ruleset, &policy.network)?;
    let fd = Option::<OwnedFd>::from(ruleset);
    if fd.is_none() {
        unavailable(mode, "Landlock is not supported by this kernel")?;
    }
    Ok(fd)
}

/// ABI 1 filesystem rights are mandatory in `Enforce` mode (Ubuntu 22.04's
/// 5.15 kernel has them); newer rights, TCP and scoping are best effort.
fn handled(mode: SandboxMode) -> Result<Ruleset, landlock::RulesetError> {
    let required = match mode {
        SandboxMode::Enforce => CompatLevel::HardRequirement,
        SandboxMode::BestEffort => CompatLevel::BestEffort,
    };
    Ruleset::default()
        .set_compatibility(required)
        .handle_access(AccessFs::from_all(ABI::V1))?
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(BEST_EFFORT_ABI))?
        .handle_access(AccessNet::from_all(BEST_EFFORT_ABI))?
        .scope(Scope::from_all(BEST_EFFORT_ABI))
}

fn add_fs_rules(
    mut ruleset: RulesetCreated,
    policy: &Policy,
) -> Result<RulesetCreated> {
    for path in &policy.optional_read_dirs {
        ruleset = add_optional(ruleset, path, READ_DIR)?;
    }
    for path in &policy.optional_read_files {
        ruleset = add_optional(ruleset, path, READ_FILE)?;
    }
    for path in &policy.read_dirs {
        ruleset = add(ruleset, path, READ_DIR)?;
    }
    for path in &policy.read_files {
        ruleset = add(ruleset, path, READ_FILE)?;
    }
    for path in &policy.write_dirs {
        ruleset = add(ruleset, path, WRITE_DIR)?;
    }
    for path in &policy.exec_files {
        ruleset = add(ruleset, path, EXEC_FILE)?;
    }
    for path in &policy.optional_exec_files {
        ruleset = add_optional(ruleset, path, EXEC_FILE)?;
    }
    Ok(ruleset)
}

fn add_net_rules(
    mut ruleset: RulesetCreated,
    network: &Network,
) -> Result<RulesetCreated> {
    if let Network::TcpConnect(ports) = network {
        for port in ports {
            ruleset = ruleset
                .add_rule(NetPort::new(*port, AccessNet::ConnectTcp))
                .map_err(sandbox_error)?;
        }
    }
    Ok(ruleset)
}

fn add(
    ruleset: RulesetCreated,
    path: &Path,
    access: BitFlags<AccessFs>,
) -> Result<RulesetCreated> {
    let fd = PathFd::new(path).map_err(|error| {
        MediaError::rejected(format!("{}: {error}", path.display()))
    })?;
    ruleset
        .add_rule(PathBeneath::new(fd, access))
        .map_err(sandbox_error)
}

fn add_optional(
    ruleset: RulesetCreated,
    path: &Path,
    access: BitFlags<AccessFs>,
) -> Result<RulesetCreated> {
    if path.exists() {
        add(ruleset, path, access)
    } else {
        Ok(ruleset)
    }
}

fn sandbox_error(error: landlock::RulesetError) -> MediaError {
    MediaError::SandboxUnavailable(format!("Landlock: {error}"))
}
