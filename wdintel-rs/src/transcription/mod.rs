pub mod service;

pub mod executor;
mod executor_session;
#[cfg(test)]
mod executor_tests;
#[cfg(test)]
mod migration_tests;
#[cfg(test)]
mod provider_tests;
#[cfg(test)]
mod queue_tests;
pub mod worker;
#[cfg(test)]
mod worker_tests;

pub(crate) const ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH: u64 = 100;
