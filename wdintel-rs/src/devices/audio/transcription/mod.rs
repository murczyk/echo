//! Contract for the shared API/oneoff executor. Implementations own all files
//! transactions, provider calls and source paths. New-audio admission is written
//! inside the publication transaction, never by a post-commit queue insertion.
//!
//! Lock order: main active settings (claim/dispatch), main device shared guard,
//! files scheduler (slot changes), setting, audio/job. Retain main guards through
//! files commit; no remote I/O under guards. Backfill accounting is separate.

mod admission;
mod backfill;
mod backfill_query;
mod backfill_recovery;
mod guards;
mod interactive;
mod query;
mod recovery;
mod settings;
mod source;
mod status;
#[allow(dead_code)]
// Commands for the subsequent interactive/settings/backfill phases.
mod types;
mod worker;

#[cfg(test)]
#[path = "../transcription_tests.rs"]
mod tests;

pub(in crate::devices::audio) use admission::{
    publication_guard, publication_setting, publish,
};

pub(crate) use backfill::run as backfill_oneoff;
pub(crate) use interactive::{open, retry};
pub(crate) use recovery::run as recover_oneoff;
pub(crate) use settings::{set_settings, settings};
pub(crate) use status::status;
pub(crate) use types::*;
pub(crate) use worker::run;

#[derive(Clone, Copy)]
pub(super) enum Failure {
    Safe(&'static str),
    Overloaded { retry_after_secs: Option<u64> },
    Unknown,
}
