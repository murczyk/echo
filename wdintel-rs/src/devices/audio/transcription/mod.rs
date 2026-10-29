//! Device-owned admission and local application of native transcription results.
mod admission;
pub(super) mod guards;
mod interactive;
mod reconcile;
mod settings;
mod status;
#[cfg(test)]
#[path = "../transcription_tests.rs"]
mod tests;
mod types;

pub(in crate::devices::audio) use admission::{
    publication_guard, publication_setting, publish,
};

pub(crate) use interactive::{open, retry};
pub(crate) async fn recover_oneoff(
    _mode: crate::types::Mode,
    _options: crate::OneoffRecoverDeviceAudioTranscriptionPs,
) -> Result<(), crate::error::AppError> {
    Err(crate::error::AppError::BL { msg: "Native transcription recovers stale attempts automatically; the legacy recovery command no longer mutates device jobs".into() })
}
pub(crate) use reconcile::run;
pub(crate) use settings::{set_settings, settings};
pub(crate) use status::status;
pub(crate) use types::*;
