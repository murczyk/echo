use super::super::DeviceAudioRuntime;
use super::{backfill_query as db, query, worker};
use crate::{config::read_config, devices::config::*, h, types::ShortContext};
use echo_gpu_client::EchoGpuClient;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) async fn run(
    mode: crate::types::Mode,
    options: crate::OneoffBackfillDeviceAudioTranscriberPs,
) -> anyhow::Result<i32> {
    let runtime = connect(mode).await.c(h!())?;
    preview(&runtime, &options).await.c(h!())?;
    if options.dry_run {
        println!("dry_run=true; no state changed");
        return Ok(0);
    }
    if !options.yes
        && !dialoguer::Confirm::with_theme(
            &dialoguer::theme::ColorfulTheme::default(),
        )
        .with_prompt("Transcribe this saved device audio scope?")
        .default(false)
        .interact()
        .c(h!())?
    {
        println!("Backfill cancelled; no state changed.");
        return Ok(0);
    }
    if !db::global_enabled(&runtime).await.c(h!())? {
        println!("paused: global_disabled");
        return Ok(3);
    }
    runtime.byte_store().c(h!())?;
    let client = EchoGpuClient::new(runtime.dbx.clone(), Default::default())
        .await
        .c(h!())?;
    let run = match options.resume {
        Some(run) => run,
        None => db::snapshot(&runtime, options.device_id).await.c(h!())?,
    };
    execute(runtime, client, run).await.c(h!())
}

async fn connect(
    mode: crate::types::Mode,
) -> anyhow::Result<Arc<DeviceAudioRuntime>> {
    let config = read_config(mode).c(h!())?;
    let main = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let files = crate::file_registry::connect_runtime(&config, mode)
        .await
        .c(h!())?;
    let (_, storage) = crate::server::build_runtime_storage(&config, mode);
    let runtime = super::super::build_runtime(
        &config,
        &main,
        files.as_ref(),
        storage.as_ref(),
        None,
    );
    runtime.file_database().c(h!())?;
    Ok(runtime)
}

async fn preview(
    runtime: &DeviceAudioRuntime,
    options: &crate::OneoffBackfillDeviceAudioTranscriberPs,
) -> anyhow::Result<()> {
    if let Some(run) = options.resume {
        println!("Resume run={run}");
        print_summary(runtime, run, "preview", std::time::Instant::now(), 0)
            .await
            .c(h!())?;
    } else {
        let preview = db::preview(runtime, options.device_id).await.c(h!())?;
        println!(
            "scope={} candidates={} eligible={} skipped_by_reason={}",
            options
                .device_id
                .map_or_else(|| "all devices".into(), |id| id.to_string()),
            preview.candidates,
            preview.eligible,
            serde_json::to_string(&preview.skipped_by_reason).c(h!())?
        );
    }
    println!(
        "main_database={} files_database={}",
        db::database_name(&runtime.dbx).await.c(h!())?,
        db::database_name(runtime.file_database().c(h!())?)
            .await
            .c(h!())?
    );
    Ok(())
}

async fn execute(
    runtime: Arc<DeviceAudioRuntime>,
    client: EchoGpuClient,
    run: Uuid,
) -> anyhow::Result<i32> {
    let owner = Uuid::new_v4();
    db::acquire(&runtime, run, owner).await.c(h!())?;
    let cancel = CancellationToken::new();
    let signal = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                cancel.cancel();
            }
        }
    });
    let started = std::time::Instant::now();
    let initial_checked = db::report(&runtime, run).await.c(h!())?.checked;
    print_summary(&runtime, run, "running", started, initial_checked)
        .await
        .c(h!())?;
    let result =
        drive_with_shutdown(&runtime, &client, run, owner, &cancel).await;
    signal.abort();
    let exit = result.as_ref().copied().unwrap_or(1);
    if exit == 130 {
        db::checkpoint(&runtime, run, owner).await.c(h!())?;
    }
    db::release(&runtime, run, owner, matches!(exit, 0 | 2))
        .await
        .c(h!())?;
    print_summary(
        &runtime,
        run,
        if matches!(exit, 0 | 2) {
            "completed"
        } else {
            "paused"
        },
        started,
        initial_checked,
    )
    .await
    .c(h!())?;
    result.c(h!())
}

async fn drive_with_shutdown(
    runtime: &Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    run: Uuid,
    owner: Uuid,
    cancel: &CancellationToken,
) -> anyhow::Result<i32> {
    let work = drive(runtime, client, run, owner, cancel);
    tokio::pin!(work);
    let pulse = heartbeat(runtime, run, owner);
    tokio::pin!(pulse);
    tokio::select! {
        result = &mut pulse => result.c(h!()),
        result = &mut work => result.c(h!()),
        _ = cancel.cancelled() => {
            tokio::select! {
                result = &mut pulse => result.c(h!()),
                result = tokio::time::timeout(Duration::from_secs(DEVICE_AUDIO_ASR_SHUTDOWN_GRACE_SECS), &mut work) => {
                    match result {
                        Ok(result) => { result.c(h!())?; }
                        Err(_) => { query::abandon_owner(runtime, owner).await.c(h!())?; }
                    }
                    Ok(130)
                }
            }
        }
    }
}

async fn heartbeat(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<i32> {
    let started = std::time::Instant::now();
    let initial = db::report(runtime, run).await.c(h!())?.checked;
    loop {
        tokio::time::sleep(Duration::from_secs(
            DEVICE_AUDIO_ASR_HEARTBEAT_SECS,
        ))
        .await;
        db::heartbeat(runtime, run, owner).await.c(h!())?;
        print_summary(runtime, run, "running", started, initial)
            .await
            .c(h!())?;
    }
}

pub(super) async fn drive(
    runtime: &Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    run: Uuid,
    owner: Uuid,
    cancel: &CancellationToken,
) -> anyhow::Result<i32> {
    if worker::healthy_instance(client).await.c(h!())?.is_none() {
        println!("paused: provider_unavailable");
        return Ok(3);
    }
    loop {
        if cancel.is_cancelled() {
            return Ok(130);
        }
        query::recover_stale(runtime).await.c(h!())?;
        match db::step(runtime, run, owner).await.c(h!())? {
            db::Step::Finalized => continue,
            db::Step::RecoveryRequired => {
                println!("paused: recovery_required; verify the provider and old owner, then use oneoff-recover-device-audio-transcription with the exact attempt token");
                return Ok(3);
            }
            db::Step::Done => {
                let report = db::report(runtime, run).await.c(h!())?;
                return Ok(if report.recovery_required > 0 {
                    3
                } else if report.failed > 0 {
                    2
                } else {
                    0
                });
            }
            db::Step::Waiting => (),
        }
        if db::slot_requires_recovery(runtime).await.c(h!())? {
            println!("paused: shared_slot_recovery_required");
            return Ok(3);
        }
        if db::global_enabled(runtime).await.c(h!())?
            && worker::healthy_instance(client).await.c(h!())?.is_none()
        {
            println!("paused: provider_unavailable");
            return Ok(3);
        }
        match worker::iteration(runtime.clone(), client, owner, cancel)
            .await
            .c(h!())?
        {
            worker::Iteration::ProviderUnavailable => {
                println!("paused: provider_unavailable");
                return Ok(3);
            }
            worker::Iteration::Worked => (),
            worker::Iteration::Idle => tokio::select! {
                _ = cancel.cancelled() => return Ok(130),
                _ = runtime.asr_wake.notified() => (),
                _ = tokio::time::sleep(Duration::from_secs(DEVICE_AUDIO_ASR_IDLE_SECS)) => (),
            },
        }
    }
}

async fn print_summary(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    state: &str,
    started: std::time::Instant,
    initial: u64,
) -> anyhow::Result<()> {
    let report = db::report(runtime, run).await.c(h!())?;
    let rate = report.checked.saturating_sub(initial) as f64
        / started.elapsed().as_secs_f64().max(1.0);
    let summary = serde_json::json!({
        "run_id":run, "state":state, "checked":report.checked,
        "total": report.checked + report.unfinished, "succeeded":report.succeeded,
        "skipped":report.skipped, "skipped_by_reason":report.skipped_by_reason,
        "no_speech":report.no_speech, "failed":report.failed,
        "recovery_required":report.recovery_required, "unfinished":report.unfinished,
        "items_per_second":rate,
        "estimated_seconds": if rate > 0.0 { Some(report.unfinished as f64 / rate) } else { None },
    });
    println!("{summary}");
    Ok(())
}
