use super::{queue, settings};
use crate::{
    config::DEVICE_DOCUMENT_WORKER_SLEEP_SECS,
    h,
    types::{Env, ShortContext},
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) async fn run(
    env: Arc<Env>,
    cancel: CancellationToken,
    kind: &'static str,
) {
    if env.file_registry_db().is_err() {
        return;
    }
    loop {
        if cancel.is_cancelled() {
            break;
        }
        match step(&env, kind).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                crate::types::error!("device document {kind} worker: {error:#}")
            }
        }
        tokio::select! { _=cancel.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(DEVICE_DOCUMENT_WORKER_SLEEP_SECS))=>{} }
    }
}

async fn step(env: &Env, kind: &str) -> anyhow::Result<bool> {
    let settings = settings::load(env).await.c(h!())?;
    if !settings.enabled
        || kind == "summary" && !settings.summaries_enabled
        || kind == "positions" && !settings.positions_enabled
    {
        return Ok(false);
    }
    crate::system_settings::ensure_devices_section_enabled(&env.dbx)
        .await
        .c(h!())?;
    if kind == "extract" {
        queue::discover(env).await.c(h!())?;
    }
    let Some(job) = queue::claim(env, kind).await.c(h!())? else {
        return Ok(false);
    };
    let result = match kind {
        "extract" => super::extraction::extract(env, &job).await,
        "summary" => {
            super::enrich::summarize(
                env,
                &job,
                settings.ai_engine_id.as_deref(),
            )
            .await
        }
        "positions" => {
            super::enrich::positions(
                env,
                &job,
                settings.position_engine_id.as_deref(),
            )
            .await
        }
        "inspect" => super::inspection::process(env, &job).await,
        _ => unreachable!(),
    };
    queue::finish(env, &job, result).await.c(h!())?;
    Ok(true)
}
