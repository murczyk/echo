use crate::config::ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE;
use crate::entities::{signal_message, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use anyhow::Context;
use chrono::NaiveDateTime;
use dialoguer::{theme::ColorfulTheme, Confirm};
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    RelationTrait,
};
use uuid::Uuid;

#[derive(Debug, Default, PartialEq, Eq)]
struct BackfillCounts {
    eligible: usize,
    oversized: usize,
    non_audio: usize,
    already_queued: usize,
    processing: usize,
    completed: usize,
    terminal: usize,
    newly_queued: usize,
}

pub async fn run(
    mode: Mode,
    ps: crate::OneoffBackfillAudioTranscriberPs,
) -> Result<(), AppError> {
    let since = parse_since_ts(&ps.since_ts)?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let confirmed = ps.dry_run
        || ps.yes
        || Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt(format!(
                "Queue eligible audio created at or after {} UTC?",
                ps.since_ts
            ))
            .default(false)
            .interact()
            .c(h!())?;
    let Some(counts) = scan_confirmed(&dbx, since, ps.dry_run, confirmed)
        .await
        .c(h!())?
    else {
        println!("Backfill cancelled; no changes made.");
        return Ok(());
    };

    println!(
        "eligible={} oversized={} non_audio={} already_queued={} processing={} completed={} terminal={} newly_queued={} dry_run={}",
        counts.eligible,
        counts.oversized,
        counts.non_audio,
        counts.already_queued,
        counts.processing,
        counts.completed,
        counts.terminal,
        counts.newly_queued,
        ps.dry_run
    );
    Ok(())
}

async fn scan_confirmed(
    dbx: &sea_orm::DatabaseConnection,
    since: NaiveDateTime,
    dry_run: bool,
    confirmed: bool,
) -> anyhow::Result<Option<BackfillCounts>> {
    if !dry_run && !confirmed {
        return Ok(None);
    }
    Ok(Some(scan(dbx, since, dry_run).await.context(h!())?))
}

fn parse_since_ts(value: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").map_err(
        |_| AppError::BL {
            msg: "Invalid --since-ts. Use UTC yyyy-MM-ddThh:mm:ss, for example 2026-07-01T00:00:00"
                .to_string(),
        },
    )
}

async fn scan(
    dbx: &sea_orm::DatabaseConnection,
    since: NaiveDateTime,
    dry_run: bool,
) -> anyhow::Result<BackfillCounts> {
    let mut counts = BackfillCounts::default();
    let mut cursor: Option<(NaiveDateTime, Uuid)> = None;
    loop {
        let mut query = signal_message_media::Entity::find()
            .join(
                sea_orm::JoinType::InnerJoin,
                signal_message_media::Relation::SignalMessage.def(),
            )
            .filter(signal_message_media::Column::CreatedAt.gte(since))
            .filter(signal_message::Column::Deleted.eq(false))
            .order_by_asc(signal_message_media::Column::CreatedAt)
            .order_by_asc(signal_message_media::Column::Id)
            .limit(ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE);
        if let Some((created_at, id)) = cursor {
            query = query.filter(
                signal_message_media::Column::CreatedAt.gt(created_at).or(
                    signal_message_media::Column::CreatedAt
                        .eq(created_at)
                        .and(signal_message_media::Column::Id.gt(id)),
                ),
            );
        }
        let media = query.all(dbx).await.context(h!())?;
        if media.is_empty() {
            break;
        }
        cursor = media.last().map(|media| (media.created_at, media.id));
        let full_batch = media.len()
            == ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE as usize;
        for media in media {
            match super::media_queue::media_eligibility(&media) {
                super::media_queue::MediaEligibility::Eligible => {}
                super::media_queue::MediaEligibility::NonAudio => {
                    counts.non_audio += 1;
                    continue;
                }
                super::media_queue::MediaEligibility::Oversized => {
                    counts.oversized += 1;
                    continue;
                }
            }
            counts.eligible += 1;
            let outcome = if dry_run {
                match echo_gpu_client::lookup(dbx, media.id)
                    .await
                    .context(h!())?
                {
                    Some(item) => echo_gpu_client::EnqueueOutcome::Existing(
                        item.state().context(h!())?,
                    ),
                    None => echo_gpu_client::EnqueueOutcome::Queued,
                }
            } else {
                echo_gpu_client::enqueue(dbx, media.id)
                    .await
                    .context(h!())?
            };
            record_outcome(&mut counts, outcome, !dry_run);
        }
        if !full_batch {
            break;
        }
    }
    Ok(counts)
}

fn record_outcome(
    counts: &mut BackfillCounts,
    outcome: echo_gpu_client::EnqueueOutcome,
    changed: bool,
) {
    use echo_gpu_client::{EnqueueOutcome, QueueState};
    match outcome {
        EnqueueOutcome::Queued if changed => counts.newly_queued += 1,
        EnqueueOutcome::Queued => {}
        EnqueueOutcome::Existing(QueueState::Queued | QueueState::Retrying) => {
            counts.already_queued += 1
        }
        EnqueueOutcome::Existing(QueueState::Processing) => {
            counts.processing += 1
        }
        EnqueueOutcome::Existing(QueueState::Completed) => {
            counts.completed += 1
        }
        EnqueueOutcome::Existing(QueueState::Terminal) => counts.terminal += 1,
    }
}

fn confirm_reprocess(
    action: &str,
    ps: &crate::OneoffReprocessAudioTranscriberPs,
) -> Result<bool, AppError> {
    if ps.yes {
        return Ok(true);
    }
    Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!("{action} transcription source {}?", ps.source_id))
        .default(false)
        .interact()
        .c(h!())
        .map_err(Into::into)
}

pub async fn requeue_terminal(
    mode: Mode,
    ps: crate::OneoffReprocessAudioTranscriberPs,
) -> Result<(), AppError> {
    if !confirm_reprocess("Requeue terminal", &ps)? {
        println!("Requeue cancelled; no changes made.");
        return Ok(());
    }
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let updated = echo_gpu_client::requeue_terminal(
        &dbx,
        ps.source_id,
        &ps.reason,
        &ps.requester,
    )
    .await
    .context(h!())?;
    println!("requeued={updated} source_id={}", ps.source_id);
    Ok(())
}

pub async fn retranscribe_completed(
    mode: Mode,
    ps: crate::OneoffReprocessAudioTranscriberPs,
) -> Result<(), AppError> {
    if !confirm_reprocess("Retranscribe completed", &ps)? {
        println!("Retranscription cancelled; no changes made.");
        return Ok(());
    }
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let updated = echo_gpu_client::retranscribe_completed(
        &dbx,
        ps.source_id,
        &ps.reason,
        &ps.requester,
    )
    .await
    .context(h!())?;
    println!("retranscribed={updated} source_id={}", ps.source_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::signal_message_media;
    use sea_orm::{ActiveValue::Set, EntityTrait};

    #[test]
    fn parses_utc_timestamp_without_an_implicit_timezone() {
        assert_eq!(
            parse_since_ts("2026-07-21T12:34:56").unwrap(),
            NaiveDateTime::parse_from_str(
                "2026-07-21T12:34:56",
                "%Y-%m-%dT%H:%M:%S"
            )
            .unwrap()
        );
        assert!(parse_since_ts("2026-07-21").is_err());
        assert!(parse_since_ts("2026-07-21T12:34:56Z").is_err());
        assert!(parse_since_ts("2026-02-29T12:34:56").is_err());
    }

    #[test]
    fn dry_run_does_not_report_a_new_write() {
        let mut counts = BackfillCounts::default();
        record_outcome(
            &mut counts,
            echo_gpu_client::EnqueueOutcome::Queued,
            false,
        );
        assert_eq!(counts.eligible, 0);
        assert_eq!(counts.newly_queued, 0);
    }

    #[test]
    fn records_each_queue_outcome_category() {
        use echo_gpu_client::{EnqueueOutcome, QueueState};

        let mut counts = BackfillCounts::default();
        record_outcome(&mut counts, EnqueueOutcome::Queued, true);
        for state in [
            QueueState::Queued,
            QueueState::Retrying,
            QueueState::Processing,
            QueueState::Completed,
            QueueState::Terminal,
        ] {
            record_outcome(&mut counts, EnqueueOutcome::Existing(state), false);
        }

        assert_eq!(counts.newly_queued, 1);
        assert_eq!(counts.already_queued, 2);
        assert_eq!(counts.processing, 1);
        assert_eq!(counts.completed, 1);
        assert_eq!(counts.terminal, 1);
    }

    #[tokio::test]
    async fn database_scan_is_inclusive_batched_and_confirmation_safe() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let since = chrono::Utc::now().naive_utc();
        let mut rows = Vec::new();
        let exact_id = Uuid::now_v7();
        rows.push(signal_message_media::ActiveModel {
            id: Set(exact_id),
            signal_message_id: Set(message.id),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("exact.ogg".into())),
            size_bytes: Set(104_857_600),
            is_encrypted: Set(false),
            created_at: Set(since),
        });
        for _ in 0..ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE {
            rows.push(signal_message_media::ActiveModel {
                id: Set(Uuid::now_v7()),
                signal_message_id: Set(message.id),
                content_type: Set("audio/ogg".into()),
                file_ext: Set(Some("ogg".into())),
                file_name: Set(Some("batch.ogg".into())),
                size_bytes: Set(1),
                is_encrypted: Set(false),
                created_at: Set(since),
            });
        }
        rows.push(signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("large.ogg".into())),
            size_bytes: Set(104_857_601),
            is_encrypted: Set(false),
            created_at: Set(since),
        });
        rows.push(signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("text/plain".into()),
            file_ext: Set(Some("txt".into())),
            file_name: Set(Some("note.txt".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            created_at: Set(since),
        });
        rows.push(signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("old.ogg".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            created_at: Set(since - chrono::Duration::seconds(1)),
        });
        signal_message_media::Entity::insert_many(rows)
            .exec(&env.dbx)
            .await
            .unwrap();

        assert!(scan_confirmed(&env.dbx, since, false, false)
            .await
            .unwrap()
            .is_none());
        assert!(echo_gpu_client::lookup(&env.dbx, exact_id)
            .await
            .unwrap()
            .is_none());

        let dry_run = scan_confirmed(&env.dbx, since, true, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(dry_run.eligible, 201);
        assert_eq!(dry_run.oversized, 1);
        assert_eq!(dry_run.non_audio, 1);
        assert_eq!(dry_run.newly_queued, 0);

        let live = scan_confirmed(&env.dbx, since, false, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(live.eligible, 201);
        assert_eq!(live.newly_queued, 201);
        assert_eq!(live.oversized, 1);
        assert_eq!(live.non_audio, 1);

        let rerun = scan(&env.dbx, since, false).await.unwrap();
        assert_eq!(rerun.newly_queued, 0);
        assert_eq!(rerun.already_queued, 201);
        assert_eq!(
            echo_gpu_client::queue_status(&env.dbx)
                .await
                .unwrap()
                .queued,
            201
        );
    }
}
