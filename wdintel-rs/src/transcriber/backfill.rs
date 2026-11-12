use crate::config::ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE;
use crate::entities::{signal_message, signal_message_media};
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use anyhow::Context;
use chrono::NaiveDateTime;
use dialoguer::{theme::ColorfulTheme, Confirm};
#[cfg(test)]
use sea_orm::NotSet;
use sea_orm::{
    ColumnTrait, EntityTrait, ExprTrait, QueryFilter, QueryOrder, QuerySelect,
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
    crate::transcription::service::ensure_sources_registered(dbx)
        .await
        .context(h!())?;
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
                match match crate::transcription::service::source_id(
                    dbx,
                    &super::media_queue::source_key(&media),
                )
                .await
                .context(h!())?
                {
                    Some(source) => echo_gpu_client::lookup(dbx, source)
                        .await
                        .context(h!())?,
                    None => None,
                } {
                    Some(item) => echo_gpu_client::EnqueueOutcome::Existing(
                        item.state().context(h!())?,
                    ),
                    None => echo_gpu_client::EnqueueOutcome::Queued,
                }
            } else {
                crate::transcription::service::enqueue(
                    dbx,
                    &super::media_queue::source_key(&media),
                )
                .await
                .context(h!())?
                .1
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
    let config = crate::config::read_config(mode).c(h!())?;
    let updated = reprocess_source(&dbx, &config, mode, &ps, "terminal")
        .await
        .c(h!())?;
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
    let config = crate::config::read_config(mode).c(h!())?;
    let updated = reprocess_source(&dbx, &config, mode, &ps, "completed")
        .await
        .c(h!())?;
    println!("retranscribed={updated} source_id={}", ps.source_id);
    Ok(())
}

async fn reprocess_source(
    dbx: &sea_orm::DatabaseConnection,
    config: &crate::config::Config,
    mode: Mode,
    ps: &crate::OneoffReprocessAudioTranscriberPs,
    expected_state: &str,
) -> anyhow::Result<bool> {
    let key = crate::transcription::service::source_key(dbx, ps.source_id)
        .await
        .context(h!())?
        .context("transcription source missing")
        .context(h!())?;
    let files = if key.starts_with(
        crate::config::ECHO_AUDIO_TRANSCRIPTION_DEVICE_SOURCE_PREFIX,
    ) {
        crate::file_registry::connect_runtime(config, mode)
            .await
            .c(h!())?
    } else {
        None
    };
    super::reprocess::request_if_state(
        dbx,
        files.as_ref().map(|files| files.connection()),
        ps.source_id,
        expected_state,
        &ps.reason,
        Some(&ps.requester),
    )
    .await
    .context(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::signal_message_media;
    use sea_orm::{ActiveValue::Set, EntityTrait};

    #[tokio::test]
    #[serial_test::serial]
    async fn non_device_reprocess_does_not_require_file_registry() {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};

        // Regression for https://github.com/echoua/echo/pull/3844.
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        env.dbx
            .execute_unprepared(
                "update system_settings set devices_section_enabled = false",
            )
            .await
            .unwrap();
        let mut config = env.config.clone();
        config.file_registry.as_mut().unwrap().pg_dbname =
            Some(format!("missing_{}", Uuid::new_v4().simple()));
        assert!(crate::file_registry::connect_runtime(&config, Mode::Debug)
            .await
            .is_err());

        for key in [
            "message-media/ordinary",
            "legacy/audio",
            "device-audio-other/audio",
        ] {
            let (source, _) =
                crate::transcription::service::enqueue(&env.dbx, key)
                    .await
                    .unwrap();
            for (index, state) in
                ["terminal", "completed"].into_iter().enumerate()
            {
                env.dbx.execute_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "update echo_gpu_transcription_queue set state=$2 where source_id=$1",
                    [source.into(), state.into()],
                )).await.unwrap();
                let ps = crate::OneoffReprocessAudioTranscriberPs {
                    source_id: source,
                    requester: "test".into(),
                    reason: "non-device reprocess regression".into(),
                    yes: true,
                };
                assert!(reprocess_source(
                    &env.dbx,
                    &config,
                    Mode::Debug,
                    &ps,
                    state
                )
                .await
                .unwrap());
                let task = echo_gpu_client::lookup(&env.dbx, source)
                    .await
                    .unwrap()
                    .unwrap()
                    .0;
                assert_eq!(task.state, "queued");
                assert_eq!(task.reprocess_count, index as i32 + 1);
                assert_eq!(
                    task.reprocess_reason.as_deref(),
                    Some(ps.reason.as_str())
                );
                assert_eq!(
                    task.reprocess_requested_by.as_deref(),
                    Some(ps.requester.as_str())
                );
            }
        }
    }

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
    #[serial_test::serial]
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
            order_f64: Set(None),
            id: Set(exact_id),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("exact.ogg".into())),
            size_bytes: Set(104_857_600),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(since),
        });
        for _ in 0..ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE {
            rows.push(signal_message_media::ActiveModel {
                order_f64: Set(None),
                id: Set(Uuid::now_v7()),
                signal_message_id: Set(message.id),
                signal_message_uuid: Set(message.id_uuid),
                content_type: Set("audio/ogg".into()),
                file_ext: Set(Some("ogg".into())),
                file_name: Set(Some("batch.ogg".into())),
                size_bytes: Set(1),
                is_encrypted: Set(false),
                storage_key: NotSet,
                created_at: Set(since),
            });
        }
        rows.push(signal_message_media::ActiveModel {
            order_f64: Set(None),
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("large.ogg".into())),
            size_bytes: Set(104_857_601),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(since),
        });
        rows.push(signal_message_media::ActiveModel {
            order_f64: Set(None),
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("text/plain".into()),
            file_ext: Set(Some("txt".into())),
            file_name: Set(Some("note.txt".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: NotSet,
            created_at: Set(since),
        });
        rows.push(signal_message_media::ActiveModel {
            order_f64: Set(None),
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(message.id),
            signal_message_uuid: Set(message.id_uuid),
            content_type: Set("audio/ogg".into()),
            file_ext: Set(Some("ogg".into())),
            file_name: Set(Some("old.ogg".into())),
            size_bytes: Set(1),
            is_encrypted: Set(false),
            storage_key: NotSet,
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

        echo_gpu_client::enqueue(&env.dbx, exact_id).await.unwrap();
        for dry_run in [true, false] {
            let error = scan_confirmed(&env.dbx, since, dry_run, true)
                .await
                .unwrap_err();
            assert!(format!("{error:#}").contains("Run database migrations"));
        }
        assert_eq!(
            echo_gpu_client::queue_status(&env.dbx)
                .await
                .unwrap()
                .queued,
            202
        );
    }
}
