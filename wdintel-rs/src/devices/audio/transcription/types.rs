use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) struct AudioTarget {
    pub device_id: Uuid,
    pub audio_id: Uuid,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ActorAudioCommand {
    pub actor_id: Uuid,
    pub target: AudioTarget,
}

pub(crate) struct StatusCommand {
    pub audio: ActorAudioCommand,
    pub known_version: Option<Uuid>,
}

pub(crate) struct SettingsCommand {
    pub actor_id: Uuid,
    pub device_id: Uuid,
}

pub(crate) struct SetSettingsCommand {
    pub scope: SettingsCommand,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum PublicationAdmission {
    Enabled,
    Suppressed,
    PolicyPending,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AdmissionOutcome {
    Queued,
    AlreadyActive,
    AlreadyCompleted,
    NotEligible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum JobState {
    Suppressed,
    PolicyPending,
    Queued,
    Preparing,
    Running,
    RetryWait,
    Succeeded,
    NoSpeech,
    Failed,
    OutcomeUnknown,
    Cancelled,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Trigger {
    Interactive,
    Background,
    Backfill,
}

#[derive(Clone)]
pub(super) struct AttemptToken {
    pub generation: Uuid,
    pub attempt_id: Uuid,
    pub owner_id: Uuid,
}

#[derive(Clone)]
pub(super) struct SourceFingerprint {
    pub ingest_id: Uuid,
    pub size_bytes: i64,
    pub sha256: [u8; 32],
}

// Only transcription can create or inspect a claim; callers pass it back to execute.
#[derive(Clone)]
pub(crate) struct Claim {
    pub(super) target: AudioTarget,
    pub(super) token: AttemptToken,
    pub(super) source: SourceFingerprint,
}

pub(super) struct Dispatch {
    pub token: AttemptToken,
    pub instance_id: Uuid,
    pub remote_audio_id: Uuid,
    pub dispatched_at: DateTime<Utc>,
}

pub(crate) enum ExecutionOutcome {
    Completed,
    RetryScheduled,
    RecoveryRequired,
    Cancelled,
    Fenced,
}

pub(crate) struct StartBackfillCommand {
    pub device_id: Option<Uuid>,
}

pub(crate) struct BackfillPreview {
    pub candidates: u64,
    pub eligible: u64,
    pub skipped_by_reason: std::collections::BTreeMap<String, u64>,
}

pub(crate) struct ResumeBackfillCommand {
    pub run_id: Uuid,
    pub owner_id: Uuid,
}

#[derive(Default)]
pub(crate) struct BackfillCounts {
    pub checked: u64,
    pub succeeded: u64,
    pub skipped: u64,
    pub no_speech: u64,
    pub failed: u64,
    pub recovery_required: u64,
    pub unfinished: u64,
}

pub(crate) enum BackfillState {
    Ready,
    Running,
    Paused,
    Completed,
}

pub(crate) struct BackfillProgress {
    pub run_id: Uuid,
    pub state: BackfillState,
    pub counts: BackfillCounts,
}

pub(crate) struct RecoveryCommand {
    pub audio_id: Uuid,
    pub expected_attempt_id: Uuid,
    pub verification_note: String,
    pub operator: String,
}

pub(crate) enum RecoveryOutcome {
    Recovered,
    TokenMismatch,
    NotUnknown,
}

// Operator-only inspection; never register this type in browser bindings.
pub(crate) struct RecoveryInspection {
    pub audio_id: Uuid,
    pub attempt_id: Uuid,
    pub instance_id: Uuid,
    pub remote_audio_id: Uuid,
    pub dispatched_at: DateTime<Utc>,
}
