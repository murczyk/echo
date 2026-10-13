use crate::devices::config::DEVICE_AUDIO_ASR_BACKFILL_BATCH_SIZE;
use crate::file_registry::entities::{
    device_audio_asr_backfill as runs, device_audio_asr_backfill_item as items,
    device_audio_asr_job as job,
};
use crate::{h, types::ShortContext};
use sea_orm::{
    sea_query::{Expr, ExprTrait},
    ActiveModelTrait, ColumnTrait, Condition, DatabaseTransaction, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
pub(super) enum Outcome {
    Succeeded,
    NoSpeech,
    Failed,
    Cancelled,
    Retry,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Resolution {
    attempt_id: Uuid,
    pub outcome: Outcome,
    reason: Option<String>,
}

pub(super) async fn record(
    files: &DatabaseTransaction,
    job: &job::Model,
) -> anyhow::Result<()> {
    let Some(attempt) = job.attempt_id else {
        anyhow::bail!("missing recovered attempt");
    };
    record_marker(files, job, &format!("verified:{attempt}"), true)
        .await
        .c(h!())
}

pub(super) async fn resolved(
    files: &DatabaseTransaction,
    job: &job::Model,
    state: &str,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    if job.state != "outcome_unknown" {
        return Ok(());
    }
    let resolution = Resolution {
        attempt_id: job
            .attempt_id
            .ok_or_else(|| anyhow::anyhow!("missing resolved attempt"))
            .c(h!())?,
        outcome: match state {
            "succeeded" => Outcome::Succeeded,
            "no_speech" => Outcome::NoSpeech,
            "failed" => Outcome::Failed,
            "cancelled" => Outcome::Cancelled,
            "retry_wait" | "queued" => Outcome::Retry,
            _ => anyhow::bail!("invalid resolved ASR state"),
        },
        reason: reason.map(str::to_owned),
    };
    let marker =
        format!("resolved:{}", serde_json::to_string(&resolution).c(h!())?);
    record_marker(files, job, &marker, false).await.c(h!())
}

pub(super) fn resolution(
    item: &items::Model,
) -> anyhow::Result<Option<Resolution>> {
    item.reason_code
        .as_deref()
        .and_then(|reason| reason.strip_prefix("resolved:"))
        .map(serde_json::from_str)
        .transpose()
        .c(h!())
}

pub(super) async fn finalize(
    files: &DatabaseTransaction,
    item: items::Model,
    resolution: Resolution,
) -> anyhow::Result<()> {
    let (outcome, counter, reason) = match resolution.outcome {
        Outcome::Succeeded => ("succeeded", runs::Column::Succeeded, None),
        Outcome::NoSpeech => ("no_speech", runs::Column::NoSpeech, None),
        Outcome::Failed => ("failed", runs::Column::Failed, resolution.reason),
        Outcome::Cancelled => (
            "skipped",
            runs::Column::Skipped,
            Some("device_archived_or_missing".into()),
        ),
        Outcome::Retry => anyhow::bail!("retry is not a final outcome"),
    };
    let run = item.run_id;
    let mut item = item.into_active_model();
    item.outcome = Set(Some(outcome.into()));
    item.reason_code = Set(reason);
    item.finished_at = Set(Some(chrono::Utc::now().fixed_offset()));
    item.update(files).await.c(h!())?;
    // acquire holds the run lock; checked and its cursor already include this item.
    runs::Entity::update_many()
        .col_expr(
            runs::Column::RecoveryRequired,
            Expr::col(runs::Column::RecoveryRequired).sub(1),
        )
        .col_expr(counter, Expr::col(counter).add(1))
        .filter(runs::Column::RunId.eq(run))
        .exec(files)
        .await
        .c(h!())?;
    Ok(())
}

async fn record_marker(
    files: &DatabaseTransaction,
    job: &job::Model,
    marker: &str,
    reset_unfinished: bool,
) -> anyhow::Result<()> {
    let attempt = job
        .attempt_id
        .ok_or_else(|| anyhow::anyhow!("missing resolved attempt"))
        .c(h!())?;
    let mut cursor = None;
    loop {
        // Only run metadata is scanned; item lookups use (run_id, audio_id).
        // An observed unfinished item is current, and a finalized unknown
        // contributes to recovery_required until its run is resumed.
        let mut select = runs::Entity::find()
            .select_only()
            .column(runs::Column::RunId)
            .filter(
                Condition::any()
                    .add(runs::Column::CurrentAudioId.eq(job.audio_id))
                    .add(runs::Column::RecoveryRequired.gt(0)),
            );
        if let Some(cursor) = cursor {
            select = select.filter(runs::Column::RunId.gt(cursor));
        }
        let page = select
            .order_by_asc(runs::Column::RunId)
            .limit(DEVICE_AUDIO_ASR_BACKFILL_BATCH_SIZE)
            .into_tuple::<Uuid>()
            .all(files)
            .await
            .c(h!())?;
        let Some(last) = page.last().copied() else {
            return Ok(());
        };
        let matching = Condition::all()
            .add(items::Column::RunId.is_in(page))
            .add(items::Column::AudioId.eq(job.audio_id))
            .add(items::Column::ObservedGeneration.eq(job.generation));
        items::Entity::update_many()
            .col_expr(items::Column::ReasonCode, Expr::value(marker.to_owned()))
            .filter(matching.clone())
            .filter(items::Column::Outcome.eq("recovery_required"))
            .filter(items::Column::ReasonCode.eq(format!("attempt:{attempt}")))
            .exec(files)
            .await
            .c(h!())?;
        if reset_unfinished {
            items::Entity::update_many()
                .col_expr(
                    items::Column::ObservedGeneration,
                    Expr::value(Option::<Uuid>::None),
                )
                .filter(matching)
                .filter(items::Column::Outcome.is_null())
                .exec(files)
                .await
                .c(h!())?;
        }
        cursor = Some(last);
    }
}
