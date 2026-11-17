use super::{
    admission::{Admission, SharedAdmission},
    queue::{self, JobOutcome},
    settings,
};
use crate::{
    devices::config::*,
    h,
    types::{Env, ShortContext},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(crate) fn shared_admission() -> SharedAdmission {
    Admission::shared()
}

pub(crate) async fn run(
    env: Arc<Env>,
    cancel: CancellationToken,
    kind: &'static str,
    admission: SharedAdmission,
) {
    if env.file_registry_db().is_err() {
        return;
    }
    let mut state = WorkerState::default();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let _loop_guard =
            crate::utils::worker_watch::loop_guard(kind_name(kind));
        let delay = match step(&env, kind, &admission, &mut state).await {
            Ok(delay) => delay,
            Err(error) => {
                state.errors += 1;
                crate::types::error!(
                    "device document {kind} worker: {error:#}"
                );
                Duration::from_secs(DEVICE_DOCUMENT_WORKER_SLEEP_SECS)
            }
        };
        state.log_if_due(kind);
        tokio::select! { _=cancel.cancelled()=>break, _=tokio::time::sleep(delay)=>{} }
    }
}

fn kind_name(kind: &str) -> &'static str {
    match kind {
        "extract" => "device_document_worker",
        "summary" => "device_document_summary_worker",
        "positions" => "device_document_position_worker",
        _ => "device_document_inspection_worker",
    }
}

pub(super) struct WorkerState {
    backfill_complete: bool,
    claims: u64,
    polls: u64,
    skipped_claims: u64,
    admission_deferrals: u64,
    errors: u64,
    claim_micros: u128,
    max_claim_micros: u128,
    logged_at: Instant,
}

impl Default for WorkerState {
    fn default() -> Self {
        Self {
            backfill_complete: false,
            claims: 0,
            polls: 0,
            skipped_claims: 0,
            admission_deferrals: 0,
            errors: 0,
            claim_micros: 0,
            max_claim_micros: 0,
            logged_at: Instant::now(),
        }
    }
}

impl WorkerState {
    fn log_if_due(&mut self, kind: &str) {
        if self.logged_at.elapsed().as_secs()
            < DEVICE_DOCUMENT_METRICS_INTERVAL_SECS
        {
            return;
        }
        crate::types::info!(target: "device_document_queue", "kind={kind} claims={} polls={} skipped_claims={} admission_deferrals={} errors={} claim_total_us={} claim_max_us={}", self.claims,self.polls,self.skipped_claims,self.admission_deferrals,self.errors,self.claim_micros,self.max_claim_micros);
        let complete = self.backfill_complete;
        *self = Self {
            backfill_complete: complete,
            ..Self::default()
        };
    }
}

pub(super) async fn step(
    env: &Env,
    kind: &str,
    admission: &SharedAdmission,
    state: &mut WorkerState,
) -> anyhow::Result<Duration> {
    let pause = Duration::from_secs(DEVICE_DOCUMENT_WORKER_SLEEP_SECS);
    let settings = settings::load(env).await.c(h!())?;
    if !settings.enabled
        || kind == "summary" && !settings.summaries_enabled
        || kind == "positions" && !settings.positions_enabled
    {
        return Ok(pause);
    }
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;
    let available = if matches!(kind, "extract" | "inspect") {
        admission.lock().await.available(env).await
    } else {
        true
    };
    if !available {
        state.skipped_claims += 1;
    }
    if kind == "extract" && available && !state.backfill_complete {
        state.backfill_complete = queue::discover(env).await.c(h!())?;
    }
    let started = Instant::now();
    let job = if available {
        queue::claim(env, kind).await
    } else {
        queue::claim_submitted(env, kind).await
    };
    let elapsed = started.elapsed().as_micros();
    state.claim_micros += elapsed;
    state.max_claim_micros = state.max_claim_micros.max(elapsed);
    let Some(job) = job.c(h!())? else {
        return Ok(pause);
    };
    if job.payload["extractorJobId"].is_string() {
        state.polls += 1;
    } else {
        state.claims += 1;
    }
    process_job(env, kind, &settings, admission, state, job)
        .await
        .c(h!())
}

async fn process_job(
    env: &Env,
    kind: &str,
    settings: &super::types::DeviceDocumentSettings,
    admission: &SharedAdmission,
    state: &mut WorkerState,
    job: queue::Job,
) -> anyhow::Result<Duration> {
    let pause = Duration::from_secs(DEVICE_DOCUMENT_WORKER_SLEEP_SECS);
    let result = match kind {
        "extract" => super::extraction::extract(env, &job).await,
        "summary" => super::enrich::summarize(
            env,
            &job,
            settings.ai_engine_id.as_deref(),
        )
        .await
        .map(JobOutcome::from),
        "positions" => super::enrich::positions(
            env,
            &job,
            settings.position_engine_id.as_deref(),
        )
        .await
        .map(JobOutcome::from),
        "inspect" => super::inspection::process(env, &job).await,
        _ => unreachable!(),
    };
    let delay = match &result {
        Ok(JobOutcome::Complete) => Duration::ZERO,
        Ok(JobOutcome::Deferred(delay)) => {
            state.admission_deferrals += 1;
            admission.lock().await.defer(*delay);
            pause
        }
        Ok(JobOutcome::Pending)
            if job.payload["extractorJobId"].as_str().is_none() =>
        {
            admission.lock().await.submission_succeeded();
            pause
        }
        Err(error) => {
            state.errors += 1;
            if matches!(kind, "extract" | "inspect")
                && error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
                    error.is_connect()
                        || error.is_timeout()
                        || error.is_request()
                })
            {
                admission.lock().await.submission_failed();
            }
            pause
        }
        _ => pause,
    };
    queue::finish(env, &job, result).await.c(h!())?;
    Ok(delay)
}
