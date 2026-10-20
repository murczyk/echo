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
pub(crate) enum AdmissionOutcome {
    Queued,
    AlreadyActive,
    AlreadyCompleted,
    NotEligible,
}
