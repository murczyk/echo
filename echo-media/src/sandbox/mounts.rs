//! Filesystem isolation for kernels without Landlock (such as Proxmox's).
//!
//! The child enters a private mount namespace whose root is an empty,
//! read-only tmpfs. Only the policy's paths exist in it, bind-mounted from
//! the host at their real (symlink-free) locations, with the symlinks met on
//! the way recreated. Read paths are read-only, write directories are
//! `noexec`, and the standard program directories are covered with an empty
//! tmpfs so only the policy's executables can be run from them.
//!
//! The parent resolves every path and plans each step; the child replays
//! the plan with direct syscalls (same rules as `child.rs`: no allocation).
//!
//! Differences from Landlock: read directories (`/usr`, `/lib`) stay
//! executable because shared libraries are mapped executable, so programs
//! outside the masked directories (e.g. under `/usr/lib`) can still be run;
//! and submounts beneath a granted directory are not visible, except where
//! a user namespace forces a recursive bind (see `bind`), in which case they
//! keep their own mount flags.

use super::Policy;
use crate::constants::*;
use crate::error::{MediaError, Result};
use anyhow::Context;
use rustix::fs::{Mode, OFlags, StatVfsMountFlags};
use rustix::io::Errno;
use rustix::mount::{MountFlags, MountPropagationFlags, UnmountFlags};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString, OsString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileTypeExt;
use std::path::{Component, Path, PathBuf};

/// `ST_RELATIME` as `statvfs` reports it. rustix before 1.1.6 defines
/// `StatVfsMountFlags::RELATIME` as `MS_RELATIME` (`1 << 21`) instead, which
/// makes every relatime mount look strictatime; in a user namespace the
/// atime setting is locked, so remounting with the wrong one fails (`EPERM`).
const ST_RELATIME: StatVfsMountFlags =
    StatVfsMountFlags::from_bits_retain(0x1000);

/// Flags of the synthetic tmpfs mounts (the root and the masks).
const SYNTHETIC: MountFlags = MountFlags::NOSUID
    .union(MountFlags::NODEV)
    .union(MountFlags::NOEXEC);

/// What a bind mount allows besides reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Access {
    write: bool,
    exec: bool,
}

impl Access {
    const READ_FILE: Self = Self {
        write: false,
        exec: false,
    };
    /// Shared libraries are mapped executable, so read directories cannot
    /// be `noexec`.
    const READ_DIR: Self = Self {
        write: false,
        exec: true,
    };
    const EXEC_FILE: Self = Self {
        write: false,
        exec: true,
    };
    const WRITE_DIR: Self = Self {
        write: true,
        exec: false,
    };

    fn covers(self, other: Self) -> bool {
        (self.write || !other.write) && (self.exec || !other.exec)
    }

    fn union(self, other: Self) -> Self {
        Self {
            write: self.write || other.write,
            exec: self.exec || other.exec,
        }
    }
}

/// One host path to bind, keyed by its resolved location. Optional paths
/// that do not exist are left out when planning; every planned bind must
/// succeed, so a failure surfaces with its own errno.
struct Grant {
    access: Access,
}

/// The mount a path lives in.
enum Region {
    /// The root tmpfs or a mask: entries must be created.
    Synthetic(PathBuf),
    /// A bind mount: the host tree is visible as is.
    Bind(Access),
}

enum Op {
    Dir(CString),
    File(CString),
    Symlink {
        target: CString,
        path: CString,
    },
    Mask(CString),
    Bind {
        source: CString,
        target: CString,
        flags: MountFlags,
    },
}

/// Ordering within one path: create the mountpoint, then mount on it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Create,
    Mount,
}

pub(super) struct Mounts {
    /// Empty directory the root tmpfs is mounted on (in the child's
    /// namespace only). Removed when the job's `Command` is dropped, after
    /// the child has pivoted away from it.
    _dir: tempfile::TempDir,
    root: CString,
    ops: Vec<Op>,
    masks: Vec<CString>,
}

impl Mounts {
    /// Resolve the policy's paths and plan the namespace. Missing required
    /// paths are rejected, like Landlock rules for them.
    pub(super) fn plan(policy: &Policy) -> Result<Self> {
        let mut links = BTreeMap::new();
        let grants = grants(policy, &mut links)?;
        let mut mounts: BTreeMap<PathBuf, Region> = masks(&grants)
            .into_iter()
            .map(|mask| (mask.clone(), Region::Synthetic(mask)))
            .collect();
        let dir = tempfile::Builder::new()
            .prefix(ECHO_MEDIA_SANDBOX_ROOT_PREFIX)
            .tempdir()
            .context("create sandbox root")?;
        let mut plan = Plan {
            root: dir.path().to_path_buf(),
            ops: BTreeMap::new(),
        };
        for path in mounts.keys() {
            plan.push(path, Rank::Mount, Op::Mask(plan.target(path)?));
        }
        for (path, grant) in &grants {
            let region = region(&mounts, path);
            if matches!(region, Region::Bind(access) if access.covers(grant.access))
            {
                continue;
            }
            plan.bind(path, grant, &region)?;
            mounts.insert(path.clone(), Region::Bind(grant.access));
        }
        for (path, target) in &links {
            if let Region::Synthetic(base) = region(&mounts, path) {
                plan.parents(&base, path)?;
                let op = Op::Symlink {
                    target: c_path(target)?,
                    path: plan.target(path)?,
                };
                plan.push(path, Rank::Create, op);
            }
        }
        let masks = mounts
            .iter()
            .filter(|(_, region)| matches!(region, Region::Synthetic(_)))
            .map(|(path, _)| plan.target(path))
            .collect::<Result<_>>()?;
        Ok(Self {
            root: c_path(dir.path())?,
            _dir: dir,
            ops: plan.ops.into_values().collect(),
            masks,
        })
    }

    /// Child side, after `unshare(CLONE_NEWNS)`: build the root and pivot
    /// into it. The old root is detached, so nothing else stays reachable.
    pub(super) fn enter(&self) -> io::Result<()> {
        use rustix::mount::{mount_change, mount_remount, unmount};
        use rustix::process::{chdir, pivot_root};
        mount_change(
            c"/",
            MountPropagationFlags::REC | MountPropagationFlags::PRIVATE,
        )?;
        mount_tmpfs(&self.root)?;
        for op in &self.ops {
            op.apply()?;
        }
        let read_only = SYNTHETIC | MountFlags::RDONLY;
        for mask in &self.masks {
            mount_remount(mask.as_c_str(), read_only, c"")?;
        }
        mount_remount(self.root.as_c_str(), read_only, c"")?;
        chdir(self.root.as_c_str())?;
        pivot_root(c".", c".")?;
        unmount(c".", UnmountFlags::DETACH)?;
        chdir(c"/")?;
        Ok(())
    }
}

impl Op {
    fn apply(&self) -> io::Result<()> {
        use rustix::fs::{mkdir, open, symlink};
        match self {
            Self::Dir(path) => {
                let mode =
                    Mode::from_raw_mode(ECHO_MEDIA_SANDBOX_MOUNTPOINT_MODE);
                match mkdir(path.as_c_str(), mode) {
                    Ok(()) | Err(Errno::EXIST) => Ok(()),
                    Err(error) => Err(error.into()),
                }
            }
            Self::File(path) => {
                let flags = OFlags::CREATE
                    | OFlags::WRONLY
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC;
                let mode = Mode::from_raw_mode(0o600);
                open(path.as_c_str(), flags, mode).map(drop)?;
                Ok(())
            }
            Self::Symlink { target, path } => {
                symlink(target.as_c_str(), path.as_c_str())?;
                Ok(())
            }
            Self::Mask(path) => mount_tmpfs(path),
            Self::Bind {
                source,
                target,
                flags,
            } => bind(source, target, *flags),
        }
    }
}

fn mount_tmpfs(path: &CStr) -> io::Result<()> {
    rustix::mount::mount(
        c"tmpfs",
        path,
        c"tmpfs",
        SYNTHETIC,
        Some(ECHO_MEDIA_SANDBOX_TMPFS_OPTIONS),
    )?;
    Ok(())
}

/// Bind, then remount with the planned flags. A bind whose flags cannot be
/// applied is removed again, so it is never left writable or executable.
fn bind(source: &CStr, target: &CStr, flags: MountFlags) -> io::Result<()> {
    use rustix::mount::{
        mount_bind, mount_bind_recursive, mount_remount, unmount,
    };
    match mount_bind(source, target) {
        // In a user namespace (LXC), a directory with mounts inherited from
        // the host beneath it (`/proc`, lxcfs under `/sys`) may only be
        // bound with them. They keep their own flags.
        Err(Errno::INVAL) => mount_bind_recursive(source, target)?,
        result => result?,
    }
    if let Err(error) = mount_remount(target, flags, c"") {
        let _ = unmount(target, UnmountFlags::DETACH);
        return Err(error.into());
    }
    Ok(())
}

/// The ordered steps, keyed by path so parents come before children.
struct Plan {
    root: PathBuf,
    ops: BTreeMap<(PathBuf, Rank), Op>,
}

impl Plan {
    fn push(&mut self, path: &Path, rank: Rank, op: Op) {
        self.ops.entry((path.to_path_buf(), rank)).or_insert(op);
    }

    /// `path` (absolute, on the host) inside the new root.
    fn target(&self, path: &Path) -> Result<CString> {
        let relative = path.strip_prefix("/").unwrap_or(path);
        c_path(&self.root.join(relative))
    }

    /// Directories between `base` (a synthetic mount) and `path`.
    fn parents(&mut self, base: &Path, path: &Path) -> Result<()> {
        for parent in path.ancestors().skip(1) {
            if parent == base || !parent.starts_with(base) {
                break;
            }
            let op = Op::Dir(self.target(parent)?);
            self.push(parent, Rank::Create, op);
        }
        Ok(())
    }

    fn bind(
        &mut self,
        path: &Path,
        grant: &Grant,
        region: &Region,
    ) -> Result<()> {
        let metadata = std::fs::metadata(path).map_err(|error| {
            MediaError::rejected(format!("{}: {error}", path.display()))
        })?;
        let target = self.target(path)?;
        if let Region::Synthetic(base) = region {
            self.parents(base, path)?;
            let mountpoint = if metadata.is_dir() {
                Op::Dir(target.clone())
            } else {
                Op::File(target.clone())
            };
            self.push(path, Rank::Create, mountpoint);
        }
        let file_type = metadata.file_type();
        let device = file_type.is_char_device() || file_type.is_block_device();
        let op = Op::Bind {
            source: c_path(path)?,
            target,
            flags: bind_flags(path, grant.access, device)?,
        };
        self.push(path, Rank::Mount, op);
        Ok(())
    }
}

/// Remount flags for a bind: read-only unless writable, `noexec` unless
/// executable, never setuid, no devices except on device nodes. Flags the
/// source mount already has are kept: in a user namespace (LXC) they are
/// locked, and dropping one fails with `EPERM`.
fn bind_flags(path: &Path, access: Access, device: bool) -> Result<MountFlags> {
    let source = rustix::fs::statvfs(path)
        .with_context(|| format!("statvfs {}", path.display()))?
        .f_flag;
    let kept = [
        (StatVfsMountFlags::RDONLY, MountFlags::RDONLY),
        (StatVfsMountFlags::NOSUID, MountFlags::NOSUID),
        (StatVfsMountFlags::NODEV, MountFlags::NODEV),
        (StatVfsMountFlags::NOEXEC, MountFlags::NOEXEC),
        (StatVfsMountFlags::NOATIME, MountFlags::NOATIME),
        (StatVfsMountFlags::NODIRATIME, MountFlags::NODIRATIME),
        (ST_RELATIME, MountFlags::RELATIME),
    ];
    let mut flags = MountFlags::BIND | MountFlags::NOSUID;
    for (statvfs, mount) in kept {
        if source.contains(statvfs) {
            flags |= mount;
        }
    }
    if !source.intersects(StatVfsMountFlags::NOATIME | ST_RELATIME) {
        flags |= MountFlags::STRICTATIME;
    }
    if !access.write {
        flags |= MountFlags::RDONLY;
    }
    if !access.exec {
        flags |= MountFlags::NOEXEC;
    }
    if !device {
        flags |= MountFlags::NODEV;
    }
    Ok(flags)
}

/// Every policy path by resolved location, recording the symlinks met.
fn grants(
    policy: &Policy,
    links: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<BTreeMap<PathBuf, Grant>> {
    let symlink_dirs = ECHO_MEDIA_SANDBOX_SYMLINK_DIRS
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let lists = [
        (&symlink_dirs, Access::READ_FILE, true),
        (&policy.optional_read_dirs, Access::READ_DIR, true),
        (&policy.optional_read_files, Access::READ_FILE, true),
        (&policy.read_dirs, Access::READ_DIR, false),
        (&policy.read_files, Access::READ_FILE, false),
        (&policy.write_dirs, Access::WRITE_DIR, false),
        (&policy.exec_files, Access::EXEC_FILE, false),
        (&policy.optional_exec_files, Access::EXEC_FILE, true),
    ];
    let mut grants: BTreeMap<PathBuf, Grant> = BTreeMap::new();
    for (paths, access, optional) in lists {
        for path in paths {
            let mut found = Vec::new();
            let resolved = match resolve(path, &mut found) {
                Ok(resolved) => resolved,
                Err(_) if optional => continue,
                Err(error) => {
                    return Err(MediaError::rejected(format!(
                        "{}: {error}",
                        path.display()
                    )))
                }
            };
            links.extend(found);
            grants
                .entry(resolved)
                .and_modify(|grant| grant.access = grant.access.union(access))
                .or_insert(Grant { access });
        }
    }
    Ok(grants)
}

/// Program directories to cover: existing ones inside a read-only grant
/// that are not granted themselves.
fn masks(grants: &BTreeMap<PathBuf, Grant>) -> BTreeSet<PathBuf> {
    ECHO_MEDIA_SANDBOX_MASKED_DIRS
        .iter()
        .filter_map(|dir| std::fs::canonicalize(dir).ok())
        .filter(|dir| dir.is_dir() && !grants.contains_key(dir))
        .filter(|dir| {
            dir.ancestors()
                .skip(1)
                .find_map(|parent| grants.get(parent))
                .is_some_and(|grant| !grant.access.write)
        })
        .collect()
}

/// The nearest mount strictly above `path`; the root tmpfs if none.
fn region(mounts: &BTreeMap<PathBuf, Region>, path: &Path) -> Region {
    for parent in path.ancestors().skip(1) {
        match mounts.get(parent) {
            Some(Region::Bind(access)) => return Region::Bind(*access),
            Some(Region::Synthetic(base)) => {
                return Region::Synthetic(base.clone())
            }
            None => {}
        }
    }
    Region::Synthetic(PathBuf::from("/"))
}

/// Resolve `path` like the kernel does, recording each symlink met (its
/// location and contents) so the namespace can recreate it.
fn resolve(
    path: &Path,
    links: &mut Vec<(PathBuf, PathBuf)>,
) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be absolute",
        ));
    }
    let mut resolved = PathBuf::from("/");
    let mut pending = Vec::new();
    push_components(&mut pending, path);
    let mut hops = 0;
    while let Some(part) = pending.pop() {
        if part == ".." {
            resolved.pop();
            continue;
        }
        let next = resolved.join(&part);
        if !std::fs::symlink_metadata(&next)?.is_symlink() {
            resolved = next;
            continue;
        }
        hops += 1;
        if hops > ECHO_MEDIA_SANDBOX_MAX_SYMLINKS {
            return Err(io::Error::from_raw_os_error(libc::ELOOP));
        }
        let target = std::fs::read_link(&next)?;
        if target.is_absolute() {
            resolved = PathBuf::from("/");
        }
        push_components(&mut pending, &target);
        links.push((next, target));
    }
    if resolved == Path::new("/") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the root directory cannot be granted",
        ));
    }
    Ok(resolved)
}

/// Push the components of `path` so the first one is popped first.
fn push_components(pending: &mut Vec<OsString>, path: &Path) {
    let parts = path.components().filter_map(|component| match component {
        Component::Normal(name) => Some(name.to_os_string()),
        Component::ParentDir => Some(OsString::from("..")),
        Component::RootDir | Component::CurDir | Component::Prefix(_) => None,
    });
    let parts: Vec<_> = parts.collect();
    pending.extend(parts.into_iter().rev());
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        MediaError::rejected(format!("{} contains a NUL byte", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_records_every_symlink_on_the_way() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        std::fs::create_dir(dir.join("real")).unwrap();
        std::fs::write(dir.join("real/file"), b"").unwrap();
        std::os::unix::fs::symlink("real", dir.join("alias")).unwrap();
        std::os::unix::fs::symlink(dir.join("alias/file"), dir.join("link"))
            .unwrap();
        let mut links = Vec::new();
        let resolved = resolve(&dir.join("link"), &mut links).unwrap();
        assert_eq!(resolved, dir.join("real/file"));
        assert_eq!(
            links,
            vec![
                (dir.join("link"), dir.join("alias/file")),
                (dir.join("alias"), PathBuf::from("real")),
            ]
        );
    }

    #[test]
    fn resolve_rejects_loops_relative_paths_and_root() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("loop");
        std::os::unix::fs::symlink(&link, &link).unwrap();
        assert!(resolve(&link, &mut Vec::new()).is_err());
        assert!(resolve(Path::new("relative"), &mut Vec::new()).is_err());
        assert!(resolve(Path::new("/usr/.."), &mut Vec::new()).is_err());
    }

    #[test]
    fn bind_flags_keep_the_source_atime_mode() {
        let raw = rustix::fs::statvfs("/").unwrap().f_flag.bits();
        let flags =
            bind_flags(Path::new("/"), Access::READ_DIR, false).unwrap();
        assert_eq!(flags.contains(MountFlags::RELATIME), raw & 0x1000 != 0);
        assert_eq!(flags.contains(MountFlags::NOATIME), raw & 0x0400 != 0);
        assert_eq!(
            flags.contains(MountFlags::STRICTATIME),
            raw & (0x1000 | 0x0400) == 0
        );
        assert!(flags.contains(MountFlags::RDONLY | MountFlags::NODEV));
        assert!(!flags.contains(MountFlags::NOEXEC));
    }

    #[test]
    fn access_coverage() {
        assert!(Access::READ_DIR.covers(Access::READ_FILE));
        assert!(Access::READ_DIR.covers(Access::EXEC_FILE));
        assert!(Access::WRITE_DIR.covers(Access::READ_FILE));
        assert!(!Access::WRITE_DIR.covers(Access::EXEC_FILE));
        assert!(!Access::READ_DIR.covers(Access::WRITE_DIR));
    }

    #[test]
    fn plan_masks_program_dirs_and_binds_listed_programs() {
        let sh = std::fs::canonicalize("/bin/sh").unwrap();
        let input = tempfile::NamedTempFile::new().unwrap();
        let input = input.path().canonicalize().unwrap();
        let policy = Policy::for_programs(&["/bin/sh"]).read_file(&input);
        let mut links = BTreeMap::new();
        let grants = grants(&policy, &mut links).unwrap();
        assert!(grants.contains_key(&sh));
        assert!(grants.contains_key(&input));
        let masks = masks(&grants);
        assert!(masks.contains(sh.parent().unwrap()), "{masks:?}");
        let mounts = Mounts::plan(&policy).unwrap();
        let binds: Vec<_> = mounts
            .ops
            .iter()
            .filter_map(|op| match op {
                Op::Bind { source, .. } => Some(source.to_str().unwrap()),
                _ => None,
            })
            .collect();
        assert!(binds.contains(&sh.to_str().unwrap()), "{binds:?}");
        assert!(binds.contains(&input.to_str().unwrap()), "{binds:?}");
        assert!(binds.contains(&"/usr"), "{binds:?}");
        if Path::new("/etc/alternatives").is_dir() {
            assert!(binds.contains(&"/etc/alternatives"), "{binds:?}");
        }
    }
}
