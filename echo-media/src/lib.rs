//! Sandboxed media processing for Echo.
//!
//! Every ffmpeg and ffprobe process started through this crate:
//!
//! - gets `-protocol_whitelist` and `-format_whitelist` before each input,
//!   and reads local inputs through `file:` paths;
//! - runs from an absolute binary path (found once on `PATH`) with an empty
//!   environment;
//! - runs in a new session with resource limits and, on Linux, no
//!   capabilities, `NO_NEW_PRIVS` and a Landlock ruleset (or, without
//!   Landlock, a private mount namespace) that allows reading only system
//!   libraries and its input, and writing only a private job directory
//!   (other platforms, such as macOS, have no sandbox);
//! - is killed with its process group on timeout or when dropped.
//!
//! See `README.md` for the threat model and the residual risks.

pub mod constants;
pub mod error;
pub mod ffmpeg;
pub mod limits;
pub mod process;
pub mod sandbox;

pub use error::{MediaError, Result};
pub use ffmpeg::{Ffmpeg, Formats, Input, LocalFile, MediaConfig, RemoteUrl};
pub use sandbox::{FsIsolation, Limits, Network, Policy, SandboxMode};
