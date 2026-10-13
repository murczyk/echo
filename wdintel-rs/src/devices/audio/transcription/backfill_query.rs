use super::super::DeviceAudioRuntime;
use super::{
    admission, guards::MainGuard, query, AudioTarget, BackfillPreview,
};
use crate::devices::config::*;
use crate::file_registry::entities::{
    device_audio as audio, device_audio_asr_backfill as runs,
    device_audio_asr_backfill_item as items, device_audio_asr_job as job,
    device_audio_asr_setting as settings,
};
use crate::{h, types::ShortContext};
use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::{
    sea_query::{Expr, ExprTrait},
    ActiveModelTrait, ColumnTrait, DatabaseTransaction, EntityTrait,
    IntoActiveModel, IsolationLevel, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub(super) type Cursor = (DateTime<FixedOffset>, Uuid);
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Waiting,
    Finalized,
    RecoveryRequired,
    Done,
}

fn candidates(
    device: Option<Uuid>,
    cursor: Option<Cursor>,
) -> sea_orm::Select<audio::Entity> {
    use audio::Column as A;
    let mut select =
        audio::Entity::find().filter(A::AutomaticTranscription.is_null());
    if let Some(device) = device {
        select = select.filter(A::DeviceId.eq(device));
    }
    if let Some((at, id)) = cursor {
        select = select.filter(
            Expr::tuple([Expr::col(A::CreatedAt), Expr::col(A::Id)])
                .gt(Expr::tuple([Expr::value(at), Expr::value(id)])),
        );
    }
    select
        .order_by_asc(A::CreatedAt)
        .order_by_asc(A::Id)
        .limit(DEVICE_AUDIO_ASR_BACKFILL_BATCH_SIZE)
}

pub(super) async fn begin_snapshot(
    runtime: &DeviceAudioRuntime,
    device: Option<Uuid>,
) -> anyhow::Result<(DatabaseTransaction, Uuid)> {
    let files = runtime
        .file_database()
        .c(h!())?
        .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
        .await
        .c(h!())?;
    let run = Uuid::new_v4();
    runs::ActiveModel {
        run_id: Set(run),
        state: Set("ready".into()),
        started_at: Set(Utc::now().fixed_offset()),
        device_id: Set(device),
        ..Default::default()
    }
    .insert(&files)
    .await
    .c(h!())?;
    Ok((files, run))
}

pub(super) async fn snapshot_page(
    files: &DatabaseTransaction,
    run: Uuid,
    device: Option<Uuid>,
    cursor: Option<Cursor>,
) -> anyhow::Result<Option<Cursor>> {
    let page = candidates(device, cursor)
        .select_only()
        .columns([audio::Column::CreatedAt, audio::Column::Id])
        .into_tuple::<Cursor>()
        .all(files)
        .await
        .c(h!())?;
    let upper = page.last().copied();
    if !page.is_empty() {
        items::Entity::insert_many(page.into_iter().map(|(at, id)| {
            items::ActiveModel {
                run_id: Set(run),
                audio_id: Set(id),
                audio_created_at: Set(at),
                ..Default::default()
            }
        }))
        .exec(files)
        .await
        .c(h!())?;
    }
    Ok(upper)
}

pub(super) async fn seal_snapshot(
    files: DatabaseTransaction,
    run: Uuid,
    upper: Option<Cursor>,
) -> anyhow::Result<()> {
    runs::Entity::update_many()
        .col_expr(
            runs::Column::SnapshotUpperCreatedAt,
            Expr::value(upper.map(|value| value.0)),
        )
        .col_expr(
            runs::Column::SnapshotUpperId,
            Expr::value(upper.map(|value| value.1)),
        )
        .filter(runs::Column::RunId.eq(run))
        .exec(&files)
        .await
        .c(h!())?;
    files.commit().await.c(h!())
}

pub(super) async fn snapshot(
    runtime: &DeviceAudioRuntime,
    device: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    let (files, run) = begin_snapshot(runtime, device).await.c(h!())?;
    let mut cursor = None;
    while let Some(next) =
        snapshot_page(&files, run, device, cursor).await.c(h!())?
    {
        cursor = Some(next);
    }
    seal_snapshot(files, run, cursor).await.c(h!())?;
    Ok(run)
}

pub(super) async fn global_enabled(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<bool> {
    use crate::entities::system_settings::{Column as S, Entity};
    Ok(Entity::find()
        .filter(S::Deleted.eq(false))
        .order_by_desc(S::UpdatedAt)
        .select_only()
        .columns([S::EnableAudioTranscription, S::DevicesSectionEnabled])
        .into_tuple::<(bool, bool)>()
        .one(&runtime.dbx)
        .await
        .c(h!())?
        .is_some_and(|(asr, devices)| asr && devices))
}

pub(super) async fn preview(
    runtime: &DeviceAudioRuntime,
    device: Option<Uuid>,
) -> anyhow::Result<BackfillPreview> {
    let enabled = global_enabled(runtime).await.c(h!())?;
    let files = runtime
        .file_database()
        .c(h!())?
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(sea_orm::AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let mut preview = BackfillPreview {
        candidates: 0,
        eligible: 0,
        skipped_by_reason: BTreeMap::new(),
    };
    let mut cursor = None;
    loop {
        let page = candidates(device, cursor)
            .select_only()
            .columns([
                audio::Column::CreatedAt,
                audio::Column::Id,
                audio::Column::DeviceId,
            ])
            .into_tuple::<(DateTime<FixedOffset>, Uuid, Uuid)>()
            .all(&files)
            .await
            .c(h!())?;
        if page.is_empty() {
            break;
        }
        cursor = page.last().map(|row| (row.0, row.1));
        let devices: Vec<_> = page.iter().map(|row| row.2).collect();
        use crate::entities::device::{Column as D, Entity};
        let active: HashMap<Uuid, bool> = Entity::find()
            .select_only()
            .columns([D::Id, D::Archived])
            .filter(D::Id.is_in(devices.clone()))
            .into_tuple()
            .all(&runtime.dbx)
            .await
            .c(h!())?
            .into_iter()
            .collect();
        let settings: HashMap<Uuid, bool> = settings::Entity::find()
            .select_only()
            .columns([settings::Column::DeviceId, settings::Column::Enabled])
            .filter(settings::Column::DeviceId.is_in(devices))
            .into_tuple()
            .all(&files)
            .await
            .c(h!())?
            .into_iter()
            .collect();
        for (_, _, device) in page {
            preview.candidates += 1;
            let reason = if !enabled {
                Some("global_disabled")
            } else if active.get(&device) != Some(&false) {
                Some("device_archived_or_missing")
            } else if settings.get(&device) == Some(&false) {
                Some("device_disabled")
            } else {
                None
            };
            if let Some(reason) = reason {
                *preview.skipped_by_reason.entry(reason.into()).or_default() +=
                    1;
            } else {
                preview.eligible += 1;
            }
        }
    }
    Ok(preview)
}

async fn locked_run(
    files: &DatabaseTransaction,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<runs::Model> {
    let record = runs::Entity::find_by_id(run)
        .lock_exclusive()
        .one(files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("backfill run missing"))
        .c(h!())?;
    anyhow::ensure!(
        record.owner_id == Some(owner) && record.state == "running",
        "backfill ownership changed"
    );
    Ok(record)
}

pub(super) async fn acquire(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<()> {
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let record = runs::Entity::find_by_id(run)
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("backfill run missing"))
        .c(h!())?;
    anyhow::ensure!(
        record.owner_id.is_none()
            || record
                .heartbeat_at
                .is_some_and(|at| (Utc::now() - at.with_timezone(&Utc))
                    .num_seconds()
                    >= DEVICE_AUDIO_ASR_STALE_SECS),
        "backfill run already owned; wait for its heartbeat lease"
    );
    let mut record = record.into_active_model();
    record.state = Set("running".into());
    record.owner_id = Set(Some(owner));
    record.heartbeat_at = Set(Some(Utc::now().fixed_offset()));
    record.completed_at = Set(None);
    record.update(&files).await.c(h!())?;
    reopen_recovered(&files, run).await.c(h!())?;
    files.commit().await.c(h!())
}

async fn reopen_recovered(
    files: &DatabaseTransaction,
    run: Uuid,
) -> anyhow::Result<()> {
    let pending = items::Entity::find()
        .filter(items::Column::RunId.eq(run))
        .filter(items::Column::Outcome.eq("recovery_required"))
        .limit(DEVICE_AUDIO_ASR_BACKFILL_BATCH_SIZE)
        .all(files)
        .await
        .c(h!())?;
    for item in pending {
        let resolution = super::backfill_recovery::resolution(&item).c(h!())?;
        let retry = resolution.as_ref().is_some_and(|resolution| {
            resolution.outcome == super::backfill_recovery::Outcome::Retry
        });
        if let Some(resolution) = resolution.filter(|_| !retry) {
            super::backfill_recovery::finalize(files, item, resolution)
                .await
                .c(h!())?;
            continue;
        }
        let current = job::Entity::find_by_id(item.audio_id)
            .select_only()
            .columns([
                job::Column::Generation,
                job::Column::State,
                job::Column::RecoveredAttemptId,
                job::Column::RecoveryVerifiedAt,
            ])
            .into_tuple::<(
                Uuid,
                String,
                Option<Uuid>,
                Option<DateTime<FixedOffset>>,
            )>()
            .one(files)
            .await
            .c(h!())?;
        let audited = item
            .reason_code
            .as_deref()
            .is_some_and(|reason| reason.starts_with("verified:"))
            || current.as_ref().is_some_and(|(_, _, attempt, verified)| {
                attempt.map(|id| format!("attempt:{id}")) == item.reason_code
                    && verified.is_some()
            });
        let definite = retry
            || current.as_ref().is_some_and(|(generation, state, _, _)| {
                Some(*generation) == item.observed_generation
                    && matches!(state.as_str(), "succeeded" | "no_speech")
            });
        if !audited && !definite {
            continue;
        }
        let mut item = item.into_active_model();
        item.outcome = Set(None);
        item.finished_at = Set(None);
        item.reason_code = Set(None);
        if audited {
            item.observed_generation = Set(None);
        }
        item.update(files).await.c(h!())?;
        runs::Entity::update_many()
            .col_expr(
                runs::Column::Checked,
                Expr::col(runs::Column::Checked).sub(1),
            )
            .col_expr(
                runs::Column::RecoveryRequired,
                Expr::col(runs::Column::RecoveryRequired).sub(1),
            )
            .filter(runs::Column::RunId.eq(run))
            .exec(files)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub(super) async fn heartbeat(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<()> {
    let changed = runs::Entity::update_many()
        .col_expr(
            runs::Column::HeartbeatAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(runs::Column::RunId.eq(run))
        .filter(runs::Column::OwnerId.eq(owner))
        .filter(runs::Column::State.eq("running"))
        .exec(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    anyhow::ensure!(changed.rows_affected == 1, "backfill ownership lost");
    Ok(())
}

pub(super) async fn release(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
    complete: bool,
) -> anyhow::Result<()> {
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let record = locked_run(&files, run, owner).await.c(h!())?;
    let mut record = record.into_active_model();
    record.state = Set(if complete { "completed" } else { "paused" }.into());
    record.completed_at = Set(complete.then(|| Utc::now().fixed_offset()));
    record.owner_id = Set(None);
    record.heartbeat_at = Set(None);
    record.update(&files).await.c(h!())?;
    files.commit().await.c(h!())
}

pub(super) async fn step(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<Step> {
    step_inner(runtime, run, owner, true).await.c(h!())
}

pub(super) async fn checkpoint(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
) -> anyhow::Result<Step> {
    step_inner(runtime, run, owner, false).await.c(h!())
}

async fn step_inner(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
    owner: Uuid,
    admit: bool,
) -> anyhow::Result<Step> {
    let db = runtime.file_database().c(h!())?;
    let item = items::Entity::find()
        .filter(items::Column::RunId.eq(run))
        .filter(items::Column::Outcome.is_null())
        .order_by_asc(items::Column::AudioCreatedAt)
        .order_by_asc(items::Column::AudioId)
        .one(db)
        .await
        .c(h!())?;
    let device = if let Some(item) = &item {
        audio::Entity::find_by_id(item.audio_id)
            .select_only()
            .column(audio::Column::DeviceId)
            .into_tuple::<Uuid>()
            .one(db)
            .await
            .c(h!())?
    } else {
        None
    };
    let main = match device {
        Some(device) => {
            Some(MainGuard::acquire(runtime, device, true).await.c(h!())?)
        }
        None => None,
    };
    let files = db.begin().await.c(h!())?;
    let record = locked_run(&files, run, owner).await.c(h!())?;
    let Some(item) = item else {
        return Ok(Step::Done);
    };
    let step = if let (Some(device), Some(main)) = (device, main.as_ref()) {
        process_item(&files, record, item, main, device, admit)
            .await
            .c(h!())?
    } else {
        finalize(
            &files,
            record,
            item,
            "skipped",
            Some("source_missing".into()),
        )
        .await
        .c(h!())?
    };
    if let Some(main) = main {
        main.commit_files(files).await.c(h!())?;
    } else {
        files.commit().await.c(h!())?;
    }
    Ok(step)
}

async fn process_item(
    files: &DatabaseTransaction,
    record: runs::Model,
    item: items::Model,
    main: &MainGuard,
    device: Uuid,
    admit: bool,
) -> anyhow::Result<Step> {
    let enabled = admission::lock_setting(files, device).await.c(h!())?;
    let source = query::source(
        files,
        AudioTarget {
            device_id: device,
            audio_id: item.audio_id,
        },
        true,
    )
    .await
    .c(h!())?;
    let Some(source) = source else {
        return finalize(
            files,
            record,
            item,
            "skipped",
            Some("source_missing".into()),
        )
        .await
        .c(h!());
    };
    let current = job::Entity::find_by_id(item.audio_id)
        .lock_exclusive()
        .one(files)
        .await
        .c(h!())?;
    let item = items::Entity::find_by_id((item.run_id, item.audio_id))
        .one(files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("backfill item missing"))
        .c(h!())?;
    if let Some((outcome, reason)) =
        terminal_outcome(&item, current.as_ref(), source.has_automatic)
    {
        let item = if let Some(job) = current
            .as_ref()
            .filter(|job| job.state == "outcome_unknown")
        {
            observe(item, job.generation)
        } else {
            item
        };
        return finalize(files, record, item, outcome, reason).await.c(h!());
    }
    if item.observed_generation.is_some()
        && current.as_ref().is_some_and(|job| job.state == "running")
    {
        return Ok(Step::Waiting);
    }
    let reason = if !main.active() {
        Some("device_archived_or_missing")
    } else if !main.global_enabled {
        Some("global_disabled")
    } else if !enabled {
        Some("device_disabled")
    } else {
        None
    };
    if let Some(reason) = reason {
        return finalize(files, record, item, "skipped", Some(reason.into()))
            .await
            .c(h!());
    }
    if !admit {
        return Ok(Step::Waiting);
    }
    admit_item(files, record, item, main, device, current)
        .await
        .c(h!())
}

fn terminal_outcome(
    item: &items::Model,
    current: Option<&job::Model>,
    has_automatic: bool,
) -> Option<(&'static str, Option<String>)> {
    if has_automatic {
        let own = current.is_some_and(|job| {
            Some(job.generation) == item.observed_generation
                && job.state == "succeeded"
        });
        return Some((
            if own { "succeeded" } else { "skipped" },
            (!own).then(|| "already_present".into()),
        ));
    }
    let current = current?;
    match current.state.as_str() {
        "outcome_unknown" => Some((
            "recovery_required",
            current.attempt_id.map(|id| format!("attempt:{id}")),
        )),
        "failed" if item.observed_generation.is_some() => {
            Some(("failed", current.error_code.clone()))
        }
        "no_speech" if item.observed_generation.is_some() => {
            Some(("no_speech", None))
        }
        _ => None,
    }
}

async fn admit_item(
    files: &DatabaseTransaction,
    record: runs::Model,
    item: items::Model,
    main: &MainGuard,
    device: Uuid,
    current: Option<job::Model>,
) -> anyhow::Result<Step> {
    let audio_id = item.audio_id;
    let created = current.is_none();
    let current = match current {
        Some(job) => job,
        None => {
            admission::publish(files, device, item.audio_id, true, Some(main))
                .await
                .c(h!())?;
            job::Entity::find_by_id(item.audio_id)
                .one(files)
                .await
                .c(h!())?
                .ok_or_else(|| anyhow::anyhow!("backfill admission missing"))
                .c(h!())?
        }
    };
    let reset = matches!(
        current.state.as_str(),
        "suppressed" | "failed" | "no_speech" | "cancelled"
    );
    let generation = if reset {
        Uuid::new_v4()
    } else {
        current.generation
    };
    if reset || created {
        enqueue(files, current, generation, reset).await.c(h!())?;
    }
    let mut item = item.into_active_model();
    item.observed_generation = Set(Some(generation));
    item.update(files).await.c(h!())?;
    let mut record = record.into_active_model();
    record.current_audio_id = Set(Some(audio_id));
    record.update(files).await.c(h!())?;
    Ok(Step::Waiting)
}

fn observe(mut item: items::Model, generation: Uuid) -> items::Model {
    item.observed_generation = Some(generation);
    item
}

async fn enqueue(
    files: &DatabaseTransaction,
    current: job::Model,
    generation: Uuid,
    reset: bool,
) -> anyhow::Result<()> {
    let now = Utc::now().fixed_offset();
    let mut current = current.into_active_model();
    if reset {
        query::clear_attempt(&mut current);
        current.state = Set("queued".into());
        current.generation = Set(generation);
        current.status_version = Set(Uuid::new_v4());
        current.attempt_count = Set(0);
        current.generation_started_at = Set(now);
        current.next_attempt_at = Set(Some(now));
        current.error_code = Set(None);
    }
    current.priority = Set(2);
    current.trigger = Set("backfill".into());
    current.updated_at = Set(now);
    current.update(files).await.c(h!())?;
    Ok(())
}

async fn finalize(
    files: &DatabaseTransaction,
    record: runs::Model,
    item: items::Model,
    outcome: &str,
    reason: Option<String>,
) -> anyhow::Result<Step> {
    let id = item.audio_id;
    let at = item.audio_created_at;
    let observed = item.observed_generation;
    let mut item = item.into_active_model();
    item.observed_generation = Set(observed);
    item.outcome = Set(Some(outcome.into()));
    item.reason_code = Set(reason);
    item.finished_at = Set(Some(Utc::now().fixed_offset()));
    item.update(files).await.c(h!())?;
    let mut next = record.clone().into_active_model();
    next.checked = Set(record.checked + 1);
    match outcome {
        "succeeded" => next.succeeded = Set(record.succeeded + 1),
        "skipped" => next.skipped = Set(record.skipped + 1),
        "failed" => next.failed = Set(record.failed + 1),
        "no_speech" => next.no_speech = Set(record.no_speech + 1),
        "recovery_required" => {
            next.recovery_required = Set(record.recovery_required + 1)
        }
        _ => anyhow::bail!("invalid backfill outcome"),
    }
    if record
        .cursor_created_at
        .zip(record.cursor_id)
        .is_none_or(|cursor| (at, id) > cursor)
    {
        next.cursor_created_at = Set(Some(at));
        next.cursor_id = Set(Some(id));
    }
    next.current_audio_id = Set(None);
    next.update(files).await.c(h!())?;
    Ok(if outcome == "recovery_required" {
        Step::RecoveryRequired
    } else {
        Step::Finalized
    })
}

pub(super) async fn slot_requires_recovery(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<bool> {
    use crate::file_registry::entities::device_audio_asr_scheduler as slot;
    let current = slot::Entity::find_by_id(1_i16)
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    let Some(id) = current.and_then(|slot| slot.slot_audio_id) else {
        return Ok(false);
    };
    Ok(job::Entity::find_by_id(id)
        .select_only()
        .column(job::Column::State)
        .into_tuple::<String>()
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .is_some_and(|state| state == "outcome_unknown"))
}

pub(super) struct Report {
    pub checked: u64,
    pub succeeded: u64,
    pub skipped: u64,
    pub no_speech: u64,
    pub failed: u64,
    pub recovery_required: u64,
    pub unfinished: u64,
    pub skipped_by_reason: BTreeMap<String, u64>,
}

pub(super) async fn report(
    runtime: &DeviceAudioRuntime,
    run: Uuid,
) -> anyhow::Result<Report> {
    use sea_orm::PaginatorTrait;
    let files = runtime
        .file_database()
        .c(h!())?
        .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
        .await
        .c(h!())?;
    let record = runs::Entity::find_by_id(run)
        .one(&files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("backfill run missing"))
        .c(h!())?;
    let unfinished = items::Entity::find()
        .filter(items::Column::RunId.eq(run))
        .filter(items::Column::Outcome.is_null())
        .count(&files)
        .await
        .c(h!())?;
    let reasons = items::Entity::find()
        .select_only()
        .column(items::Column::ReasonCode)
        .column_as(Expr::col(items::Column::AudioId).count(), "count")
        .filter(items::Column::RunId.eq(run))
        .filter(items::Column::Outcome.eq("skipped"))
        .group_by(items::Column::ReasonCode)
        .into_tuple::<(String, i64)>()
        .all(&files)
        .await
        .c(h!())?;
    Ok(Report {
        checked: record.checked as u64,
        succeeded: record.succeeded as u64,
        skipped: record.skipped as u64,
        no_speech: record.no_speech as u64,
        failed: record.failed as u64,
        recovery_required: record.recovery_required as u64,
        unfinished,
        skipped_by_reason: reasons
            .into_iter()
            .map(|(reason, count)| (reason, count as u64))
            .collect(),
    })
}

pub(super) async fn database_name(
    db: &impl sea_orm::ConnectionTrait,
) -> anyhow::Result<String> {
    use sea_orm::sea_query::{Alias, Func, Query};
    let select = Query::select()
        .expr_as(
            Func::cust(Alias::new("current_database")),
            Alias::new("name"),
        )
        .to_owned();
    db.query_one_raw(db.get_database_backend().build(&select))
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("database name unavailable"))
        .c(h!())?
        .try_get("", "name")
        .c(h!())
}
