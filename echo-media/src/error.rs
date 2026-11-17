use std::time::Duration;

/// Errors returned by every public echo-media operation.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    /// Arguments were refused before any process started.
    #[error("rejected media request: {0}")]
    Rejected(String),
    /// The sandbox could not be set up in `SandboxMode::Enforce`.
    #[error("media sandbox is unavailable: {0}")]
    SandboxUnavailable(String),
    /// The decoder refused the input or produced an invalid result.
    #[error("invalid media: {reason}")]
    InvalidMedia { reason: String, stderr: String },
    /// The process ran longer than its wall-clock limit.
    #[error("media process timed out after {0:?}")]
    Timeout(Duration),
    /// The process stopped reporting progress on stdout.
    #[error("media process made no progress for {0:?}")]
    ProgressTimeout(Duration),
    /// The process wrote more than its output limit (`SIGXFSZ`).
    #[error("media process exceeded its output limit")]
    OutputLimit,
    /// The process died from another signal.
    #[error("media process was killed by signal {signal}")]
    Crashed { signal: i32, stderr: String },
    /// Spawning, I/O or another environment failure. Usually transient.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl MediaError {
    /// Whether retrying the same input is pointless.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Rejected(_)
                | Self::InvalidMedia { .. }
                | Self::OutputLimit
                | Self::Crashed { .. }
        )
    }

    pub(crate) fn invalid(reason: impl Into<String>) -> Self {
        Self::InvalidMedia {
            reason: reason.into(),
            stderr: String::new(),
        }
    }

    pub(crate) fn rejected(reason: impl Into<String>) -> Self {
        Self::Rejected(reason.into())
    }
}

pub type Result<T, E = MediaError> = std::result::Result<T, E>;
