//! Extracts positions from new messages and completed document summaries.
//! One job per source; a rerun replaces that source's mentions.

use super::extract::{extract, Extraction};
use super::knowledge;
use super::normalize::ground;
use super::types::{AiPositionFound, AiPositionSpan};
use super::{effective_prompt, settings};
use crate::config::{
    AI_POSITION_BACKFILL_BATCH, AI_POSITION_WORKER_IDLE_SLEEP_MS,
    AI_POSITION_WORKER_MAX_ATTEMPTS, AI_POSITION_WORKER_MAX_ERROR_CHARS,
    AI_POSITION_WORKER_RETRY_BASE_SECS, AI_POSITION_WORKER_RETRY_MAX_SECS,
};
use crate::entities::{
    ai_engine, ai_position_coordinate, ai_position_mention,
    ai_position_worker_job,
};
use crate::event_stream::fanout_mult;
use crate::event_stream::types::{EventMsg, EventType};
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, FromQueryResult, QueryFilter, QueryOrder, QuerySelect,
    Statement, TransactionTrait,
};
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const ENABLED: &str = "exists (select 1 from ai_position_settings where id = 1 and worker_enabled and worker_ai_engine_id is not null)";

pub async fn enqueue_message_if_enabled<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "insert into ai_position_worker_job (sigint_inbox_item_id)
             select $1 where {ENABLED}
             on conflict (sigint_inbox_item_id) where sigint_inbox_item_id is not null
             do update set attempts = 0, last_error = null,
                 next_attempt_at = now() at time zone 'utc',
                 created_at = now() at time zone 'utc'"
        ),
        [sigint_inbox_item_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn enqueue_media_if_enabled<C>(
    dbx: &C,
    media_id: Uuid,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "insert into ai_position_worker_job (media_id)
             select $1 where {ENABLED}
             on conflict (media_id) where media_id is not null
             do update set attempts = 0, last_error = null,
                 next_attempt_at = now() at time zone 'utc',
                 created_at = now() at time zone 'utc'"
        ),
        [media_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

/// Enqueues messages and completed document summaries from the last `days`
/// days in seek batches; sources that already have a job keep it.
pub(crate) async fn enqueue_backfill(
    dbx: &DatabaseConnection,
    days: i64,
) -> anyhow::Result<(u64, u64)> {
    let since = Utc::now().naive_utc() - ChronoDuration::days(days);
    let mut cursor: (NaiveDateTime, i64) = (since, 0);
    let mut messages = 0;
    loop {
        let batch = BackfillBatch::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "with batch as (
                 select message.created_at, message.id
                 from signal_message message
                 where message.created_at >= $1 and (message.created_at, message.id) > ($2, $3)
                 order by message.created_at, message.id
                 limit $4
             ), queued as (
                 insert into ai_position_worker_job (sigint_inbox_item_id)
                 select item.id
                 from batch
                 join sigint_inbox_item item on item.id = batch.id
                 join signal_message message on message.id = batch.id
                 where not message.deleted
                 on conflict (sigint_inbox_item_id) where sigint_inbox_item_id is not null
                 do nothing
                 returning 1
             ), last as (
                 select created_at, id from batch order by created_at desc, id desc limit 1
             )
             select (select count(*) from queued) as queued,
                    (select created_at from last) as last_created_at,
                    (select id from last) as last_id",
            [
                since.into(),
                cursor.0.into(),
                cursor.1.into(),
                AI_POSITION_BACKFILL_BATCH.into(),
            ],
        ))
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
        messages += batch.queued as u64;
        let (Some(last_created_at), Some(last_id)) =
            (batch.last_created_at, batch.last_id)
        else {
            break;
        };
        cursor = (last_created_at, last_id);
    }
    // Completed summaries are few: one per document.
    let documents = dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into ai_position_worker_job (media_id)
             select summary.media_id
             from media_summary summary
             where summary.state = 'completed' and summary.completed_at >= $1
             on conflict (media_id) where media_id is not null
             do nothing",
            [since.into()],
        ))
        .await
        .c(h!())?
        .rows_affected();
    Ok((messages, documents))
}

#[derive(Debug, FromQueryResult)]
struct BackfillBatch {
    queued: i64,
    last_created_at: Option<NaiveDateTime>,
    last_id: Option<i64>,
}

pub async fn run_nofail(env: Arc<Env>, cancellation_token: CancellationToken) {
    let mut redis = env.redis.clone();
    info!("ai_position_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            info!("ai_position_worker received cancellation token");
            break;
        }
        let _loop_guard = worker_watch::loop_guard("ai_position_worker");
        let processed = match process_next(&env.dbx, &mut redis).await {
            Ok(processed) => processed,
            Err(error) => {
                error!("ai_position_worker failed: {error:#?}");
                false
            }
        };
        let recomputed =
            match knowledge::process_next(&env.dbx, &mut redis).await {
                Ok(recomputed) => recomputed,
                Err(error) => {
                    error!("ai_position_worker knowledge failed: {error:#?}");
                    false
                }
            };
        let linked =
            match knowledge::process_next_link(&env.dbx, &mut redis).await {
                Ok(linked) => linked,
                Err(error) => {
                    error!("ai_position_worker linking failed: {error:#?}");
                    false
                }
            };
        let processed = processed || recomputed || linked;
        if processed {
            continue;
        }
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(
                AI_POSITION_WORKER_IDLE_SLEEP_MS,
            )) => {}
        }
    }
}

struct WorkerConfig {
    prompt: String,
    ai_engine: ai_engine::Model,
}

/// The text a job reads, the message it belongs to, that message's time and
/// the group (with its areas of responsibility) it came from.
#[derive(Debug, PartialEq, FromQueryResult)]
pub(super) struct Source {
    pub(super) text: String,
    pub(super) message_id: i64,
    pub(super) message_at: NaiveDateTime,
    pub(super) group_master_key: Option<String>,
    pub(super) group_is_secret: bool,
    pub(super) aor_ids: Vec<i64>,
}

/// The message's first group, as `resolve_message_aor_ids_by_group` picks it.
pub(super) const SOURCE_GROUP_SQL: &str = "
    left join lateral (
        select smg.group_master_key
        from signal_message_group smg
        where smg.signal_message_id = message.id and smg.group_master_key is not null
        order by smg.id
        limit 1
    ) grp on true
    left join signal_group sg on sg.master_key = grp.group_master_key";
pub(super) const SOURCE_GROUP_COLUMNS: &str = "
    grp.group_master_key,
    coalesce(sg.is_secret, false) as group_is_secret,
    coalesce(array(
        select sga.aor_id
        from signal_group_aor sga
        join area_of_responsibility aor on aor.id = sga.aor_id
        where sga.master_key = grp.group_master_key and not aor.deleted
        order by sga.aor_id
    ), '{}') as aor_ids";

async fn process_next(
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> anyhow::Result<bool> {
    let Some(config) = load_worker_config(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let Some(job) = load_next_job(dbx).await.c(h!())? else {
        return Ok(false);
    };
    let Some(source) = load_source(dbx, &job).await.c(h!())? else {
        // The message was deleted or the summary is gone: so are its facts.
        drop_unavailable_source(dbx, &job).await.c(h!())?;
        return Ok(true);
    };
    let extraction = match extract(
        &config.ai_engine,
        &config.prompt,
        &source.text,
        &source_settlements(dbx, &job).await.c(h!())?,
    )
    .await
    {
        Ok(extraction) => extraction,
        Err(error) => {
            fail_job(dbx, &job, format!("{error:#}")).await.c(h!())?;
            return Ok(true);
        }
    };
    if let Err(error) =
        complete_job(dbx, &job, &source, &config, extraction).await
    {
        fail_job(dbx, &job, format!("{error:#}")).await.c(h!())?;
        return Ok(true);
    }
    if let Err(error) = fanout_mult(
        redis,
        vec![EventMsg::new(EventType::ETInboxChanged(source.message_id))],
    )
    .await
    {
        error!(
            "ai_position_worker failed to fanout message_id={}: {error:#?}",
            source.message_id
        );
    }
    Ok(true)
}

async fn load_worker_config(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<WorkerConfig>> {
    let Some(settings) = settings(dbx).await.c(h!())? else {
        return Ok(None);
    };
    let (true, Some(ai_engine_id)) =
        (settings.worker_enabled, settings.worker_ai_engine_id)
    else {
        return Ok(None);
    };
    let ai_engine = ai_engine::Entity::find_by_id(ai_engine_id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?;
    let Some(ai_engine) = ai_engine else {
        return Ok(None);
    };
    Ok(Some(WorkerConfig {
        prompt: effective_prompt(&settings.prompt).to_string(),
        ai_engine,
    }))
}

async fn load_next_job(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Option<ai_position_worker_job::Model>> {
    ai_position_worker_job::Entity::find()
        .filter(
            ai_position_worker_job::Column::NextAttemptAt
                .lte(Utc::now().naive_utc()),
        )
        .order_by_asc(ai_position_worker_job::Column::NextAttemptAt)
        .order_by_asc(ai_position_worker_job::Column::CreatedAt)
        .order_by_asc(ai_position_worker_job::Column::Id)
        .one(dbx)
        .await
        .c(h!())
}

/// The job's source. `lock` (inside a transaction) holds the text rows so a
/// concurrent edit or reprocess waits until the mentions are saved; the
/// invalidation triggers then remove them.
async fn load_source_with<C>(
    dbx: &C,
    job: &ai_position_worker_job::Model,
    lock: bool,
) -> anyhow::Result<Option<Source>>
where
    C: ConnectionTrait,
{
    let statement = match (job.sigint_inbox_item_id, job.media_id) {
        (Some(item_id), _) => Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                "select coalesce(message.body, '') as text, message.id as message_id,
                        coalesce(item.datetime, message.timestamp, message.created_at) as message_at,
                        {SOURCE_GROUP_COLUMNS}
                 from sigint_inbox_item item
                 join signal_message message on message.id = item.id
                 {SOURCE_GROUP_SQL}
                 where item.id = $1 and not message.deleted
                 {}",
                if lock { "for share of message, item" } else { "" }
            ),
            [item_id.into()],
        ),
        (None, Some(media_id)) => Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                "select summary.summary as text, message.id as message_id,
                        coalesce(message.timestamp, message.created_at) as message_at,
                        {SOURCE_GROUP_COLUMNS}
                 from media_summary summary
                 join signal_message_media media on media.id = summary.media_id
                 join signal_message message on message.id = media.signal_message_id
                 {SOURCE_GROUP_SQL}
                 where summary.media_id = $1 and summary.state = 'completed'
                   and summary.summary is not null and not message.deleted
                 {}",
                if lock { "for share of summary, message" } else { "" }
            ),
            [media_id.into()],
        ),
        (None, None) => return Ok(None),
    };
    Source::find_by_statement(statement).one(dbx).await.c(h!())
}

async fn load_source<C>(
    dbx: &C,
    job: &ai_position_worker_job::Model,
) -> anyhow::Result<Option<Source>>
where
    C: ConnectionTrait,
{
    load_source_with(dbx, job, false).await
}

/// Locks the source's group links and text rows, then checks the source is
/// still the one extracted. A concurrent edit or group move waits; its
/// trigger then fixes the mentions saved here.
async fn lock_unchanged_source<C>(
    dbx: &C,
    job: &ai_position_worker_job::Model,
    source: &Source,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select 1 from signal_message_group where signal_message_id = $1 for share",
        [source.message_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(
        load_source_with(dbx, job, true).await.c(h!())?.as_ref()
            == Some(source),
    )
}

/// Settlements Echo's parsers already found in a message, a hint that they
/// are not positions.
async fn source_settlements(
    dbx: &DatabaseConnection,
    job: &ai_position_worker_job::Model,
) -> anyhow::Result<Vec<String>> {
    use crate::entities::{sigint_inbox_item, sigint_inbox_item_settlement};
    let Some(item_id) = job.sigint_inbox_item_id else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = sigint_inbox_item::Entity::find_by_id(item_id)
        .one(dbx)
        .await
        .c(h!())?
        .and_then(|item| item.location_v2)
        .map(|locations| crate::location::utils::to_location_list(&locations))
        .unwrap_or_default();
    names.extend(
        sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|link| link.settlement_text),
    );
    names.sort();
    names.dedup();
    Ok(names)
}

/// Deletes the job and its source's mentions unless the job was re-enqueued
/// or the source came back meanwhile (e.g. a summary completed).
async fn drop_unavailable_source(
    dbx: &DatabaseConnection,
    job: &ai_position_worker_job::Model,
) -> anyhow::Result<()> {
    let transaction = dbx.begin().await.c(h!())?;
    let current = ai_position_worker_job::Entity::find_by_id(job.id)
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?;
    let unchanged =
        current.is_some_and(|current| current.created_at == job.created_at);
    if unchanged && load_source(&transaction, job).await.c(h!())?.is_none() {
        delete_source_mentions(&transaction, job).await.c(h!())?;
        delete_job(&transaction, job.id).await.c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn complete_job(
    dbx: &DatabaseConnection,
    job: &ai_position_worker_job::Model,
    source: &Source,
    config: &WorkerConfig,
    extraction: Extraction,
) -> anyhow::Result<()> {
    let transaction = dbx.begin().await.c(h!())?;
    // Source rows first, then the job: the same order as an edit, which
    // holds the message and then re-enqueues the job.
    if !lock_unchanged_source(&transaction, job, source)
        .await
        .c(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    let current = ai_position_worker_job::Entity::find_by_id(job.id)
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?;
    // A job re-enqueued meanwhile (edited message, new summary) runs again.
    if current.as_ref().map(|current| current.created_at)
        != Some(job.created_at)
    {
        transaction.commit().await.c(h!())?;
        return Ok(());
    }
    replace_mentions(&transaction, job, source, config, extraction)
        .await
        .c(h!())?;
    delete_job(&transaction, job.id).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn replace_mentions<C>(
    dbx: &C,
    job: &ai_position_worker_job::Model,
    source: &Source,
    config: &WorkerConfig,
    extraction: Extraction,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    delete_source_mentions(dbx, job).await.c(h!())?;
    let mut knowledge_jobs = BTreeSet::new();
    let scopes = knowledge::scopes_for(
        source.group_master_key.as_deref(),
        source.group_is_secret,
        &source.aor_ids,
    );
    // Recomputes apply the group's current privacy, so queue every scope a
    // fact could feed.
    let fed = knowledge::fed_scopes(
        source.group_master_key.as_deref(),
        &source.aor_ids,
    );
    // Names reviewers rejected («not a position») are never saved again.
    let rejected = super::feedback::rejected_name_keys(dbx).await.c(h!())?;
    let extracted: Vec<AiPositionFound> = extraction
        .positions
        .into_iter()
        .filter(|position| !rejected.contains(&position.name_key))
        .collect();
    let positions =
        with_known_names(dbx, &scopes, &source.text, extracted, &rejected)
            .await
            .c(h!())?;
    for position in positions {
        if !position.coordinates.is_empty() {
            knowledge_jobs.extend(
                fed.iter()
                    .map(|scope| (scope.clone(), position.name_key.clone())),
            );
        }
        let mut mention_ids = Vec::new();
        for span in &position.spans {
            let mention = ai_position_mention::Entity::insert(
                ai_position_mention::ActiveModel {
                    id: NotSet,
                    sigint_inbox_item_id: Set(job.sigint_inbox_item_id),
                    media_id: Set(job.media_id),
                    name: Set(source
                        .text
                        .chars()
                        .skip(span.begin as usize)
                        .take((span.end - span.begin) as usize)
                        .collect()),
                    name_key: Set(position.name_key.clone()),
                    kind: Set(position.kind.clone()),
                    begin_char: Set(span.begin),
                    end_char: Set(span.end),
                    message_at: Set(source.message_at),
                    group_master_key: Set(source.group_master_key.clone()),
                    group_is_secret: Set(source.group_is_secret),
                    aor_ids: Set(source.aor_ids.clone()),
                    ai_engine_id: Set(Some(config.ai_engine.id)),
                    model_name: Set(extraction.model_name.clone()),
                    created_at: NotSet,
                },
            )
            .exec(dbx)
            .await
            .c(h!())?;
            mention_ids.push((span.begin, mention.last_insert_id));
        }
        for coordinate in position.coordinates {
            // The fact belongs to the occurrence nearest to the coordinate.
            let anchor = coordinate.span.as_ref().map_or(0, |span| span.begin);
            let mention_id = mention_ids
                .iter()
                .min_by_key(|(begin, _)| (begin - anchor).abs())
                .map(|(_, id)| *id)
                .c(h!())?;
            ai_position_coordinate::Entity::insert(
                ai_position_coordinate::ActiveModel {
                    id: NotSet,
                    mention_id: Set(mention_id),
                    coordinate_text: Set(coordinate.text),
                    coordinate_system: Set(coordinate.system),
                    mgrs: Set(coordinate.mgrs),
                    lat: Set(coordinate.lat),
                    lng: Set(coordinate.lng),
                    certainty: Set(coordinate.certainty),
                    evidence: Set(coordinate.evidence),
                    coord_begin_char: Set(coordinate
                        .span
                        .as_ref()
                        .map(|span| span.begin)),
                    coord_end_char: Set(coordinate
                        .span
                        .as_ref()
                        .map(|span| span.end)),
                    message_at: Set(source.message_at),
                    created_at: NotSet,
                },
            )
            .exec(dbx)
            .await
            .c(h!())?;
        }
    }
    knowledge::enqueue(dbx, &knowledge_jobs).await.c(h!())?;
    Ok(())
}

/// Adds positions this scope already knows that occur in the text but the
/// model did not name (e.g. «ЦИРКОН-9 на зв'язку», read as a callsign).
async fn with_known_names<C>(
    dbx: &C,
    scopes: &[knowledge::Scope],
    text: &str,
    mut positions: Vec<AiPositionFound>,
    rejected: &std::collections::HashSet<String>,
) -> anyhow::Result<Vec<AiPositionFound>>
where
    C: ConnectionTrait,
{
    for (name, name_key, kind) in
        knowledge::known_names(dbx, scopes).await.c(h!())?
    {
        if rejected.contains(&name_key) {
            continue;
        }
        if positions
            .iter()
            .any(|position| position.name_key == name_key)
        {
            continue;
        }
        // The canonical key also matches inflected or differently written
        // occurrences.
        let spans = ground(text, &name_key);
        if spans.is_empty() {
            continue;
        }
        positions.push(AiPositionFound {
            name,
            name_key,
            kind,
            spans: spans
                .into_iter()
                .map(|(begin, end)| AiPositionSpan {
                    begin: begin as i32,
                    end: end as i32,
                })
                .collect(),
            coordinates: vec![],
        });
    }
    Ok(positions)
}

/// Mentions of a known position found without the model, in a message that
/// had none for it.
pub(super) async fn insert_linked_mentions<C>(
    dbx: &C,
    source: &Source,
    name_key: &str,
    kind: &str,
    spans: &[(usize, usize)],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    for &(begin, end) in spans {
        ai_position_mention::Entity::insert(ai_position_mention::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(Some(source.message_id)),
            media_id: Set(None),
            name: Set(source
                .text
                .chars()
                .skip(begin)
                .take(end - begin)
                .collect()),
            name_key: Set(name_key.to_string()),
            kind: Set(kind.to_string()),
            begin_char: Set(begin as i32),
            end_char: Set(end as i32),
            message_at: Set(source.message_at),
            group_master_key: Set(source.group_master_key.clone()),
            group_is_secret: Set(source.group_is_secret),
            aor_ids: Set(source.aor_ids.clone()),
            ai_engine_id: Set(None),
            model_name: Set(LINKED_MODEL_NAME.to_string()),
            created_at: NotSet,
        })
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

/// `model_name` of mentions linked from knowledge rather than extracted.
pub(super) const LINKED_MODEL_NAME: &str = "knowledge";

/// Deletes a source's mentions. The delete trigger queues the knowledge
/// they may have fed for a recompute.
async fn delete_source_mentions<C>(
    dbx: &C,
    job: &ai_position_worker_job::Model,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let delete = ai_position_mention::Entity::delete_many();
    let delete = match (job.sigint_inbox_item_id, job.media_id) {
        (Some(item_id), _) => delete
            .filter(ai_position_mention::Column::SigintInboxItemId.eq(item_id)),
        (None, media_id) => {
            delete.filter(ai_position_mention::Column::MediaId.eq(media_id))
        }
    };
    delete.exec(dbx).await.c(h!())?;
    Ok(())
}

async fn fail_job(
    dbx: &DatabaseConnection,
    job: &ai_position_worker_job::Model,
    error_text: String,
) -> anyhow::Result<()> {
    let attempts = job.attempts + 1;
    let error_text: String = error_text
        .chars()
        .take(AI_POSITION_WORKER_MAX_ERROR_CHARS)
        .collect();
    if attempts >= AI_POSITION_WORKER_MAX_ATTEMPTS {
        error!(
            "ai_position_worker dropped job={} after {attempts} attempts: {error_text}",
            job.id
        );
        // A job re-enqueued meanwhile has a new created_at and stays.
        ai_position_worker_job::Entity::delete_many()
            .filter(ai_position_worker_job::Column::Id.eq(job.id))
            .filter(
                ai_position_worker_job::Column::CreatedAt.eq(job.created_at),
            )
            .exec(dbx)
            .await
            .c(h!())?;
        return Ok(());
    }
    // Matching created_at keeps a re-enqueued job's fresh state.
    ai_position_worker_job::Entity::update_many()
        .col_expr(ai_position_worker_job::Column::Attempts, attempts.into())
        .col_expr(
            ai_position_worker_job::Column::NextAttemptAt,
            (Utc::now().naive_utc()
                + ChronoDuration::seconds(retry_delay_secs(attempts)))
            .into(),
        )
        .col_expr(
            ai_position_worker_job::Column::LastError,
            Some(error_text).into(),
        )
        .filter(ai_position_worker_job::Column::Id.eq(job.id))
        .filter(ai_position_worker_job::Column::CreatedAt.eq(job.created_at))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn delete_job<C>(dbx: &C, id: i64) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    ai_position_worker_job::Entity::delete_by_id(id)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn pending_jobs(
    dbx: &DatabaseConnection,
) -> anyhow::Result<i64> {
    use sea_orm::PaginatorTrait;
    Ok(ai_position_worker_job::Entity::find()
        .count(dbx)
        .await
        .c(h!())? as i64)
}

fn retry_delay_secs(attempts: i32) -> i64 {
    let exponent = u32::try_from(attempts.saturating_sub(1)).unwrap_or(0);
    AI_POSITION_WORKER_RETRY_BASE_SECS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(AI_POSITION_WORKER_RETRY_MAX_SECS)
}

#[cfg(test)]
mod tests {
    use super::{
        complete_job, enqueue_message_if_enabled, load_next_job, load_source,
        load_worker_config, Extraction,
    };
    use crate::ai_position::types::{
        AiPositionCoordinateItem, AiPositionFound, AiPositionSpan,
    };
    use crate::config::AI_POSITION_SETTINGS_ID;
    use crate::entities::{
        ai_engine, ai_position_coordinate, ai_position_mention,
        ai_position_settings, ai_position_worker_job, sigint_inbox_item,
        signal_message,
    };
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        IntoActiveModel, QueryFilter,
    };

    const BODY: &str =
        "Переміщення всл \"Гудок\" до \"Циркон 9\" (36T XT 75734 68963)";

    async fn enable_worker(dbx: &sea_orm::DatabaseConnection) {
        let now = chrono::Utc::now().naive_utc();
        let ai_engine_id = uuid::Uuid::now_v7();
        ai_engine::ActiveModel {
            id: Set(ai_engine_id),
            name: Set(format!("position-worker-test-{ai_engine_id}")),
            url: Set("http://localhost".to_string()),
            token: Set(None),
            model_name: Set("test".to_string()),
            created_at: Set(now),
            updated_at: Set(now),
            enabled: Set(true),
            callsign_enabled: Set(true),
            ocr_enabled: Set(false),
            ocr_request_profile: Set("openai_vision".to_string()),
        }
        .insert(dbx)
        .await
        .unwrap();
        ai_position_settings::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        ai_position_settings::ActiveModel {
            id: Set(AI_POSITION_SETTINGS_ID),
            prompt: Set(String::new()),
            worker_enabled: Set(true),
            worker_ai_engine_id: Set(Some(ai_engine_id)),
            updated_at: Set(now),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    fn extraction(with_coordinate: bool) -> Extraction {
        Extraction {
            positions: vec![AiPositionFound {
                name: "Циркон 9".to_string(),
                name_key: "циркон 9".to_string(),
                kind: "position".to_string(),
                spans: vec![AiPositionSpan { begin: 28, end: 36 }],
                coordinates: if with_coordinate {
                    vec![AiPositionCoordinateItem {
                        text: "36T XT 75734 68963".to_string(),
                        system: "mgrs".to_string(),
                        mgrs: "36TXT7573468963".to_string(),
                        lat: 47.55,
                        lng: 35.33,
                        certainty: "high".to_string(),
                        evidence: "до Циркон 9".to_string(),
                        span: Some(AiPositionSpan { begin: 39, end: 57 }),
                    }]
                } else {
                    vec![]
                },
            }],
            response_text: String::new(),
            model_name: "test".to_string(),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn replaces_message_positions_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        enable_worker(&env.dbx).await;
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(BODY.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();

        for with_coordinate in [true, false] {
            enqueue_message_if_enabled(&env.dbx, message.id)
                .await
                .unwrap();
            let job = load_next_job(&env.dbx).await.unwrap().unwrap();
            assert_eq!(job.sigint_inbox_item_id, Some(message.id));
            let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
            assert_eq!(source.text, BODY);
            complete_job(
                &env.dbx,
                &job,
                &source,
                &config,
                extraction(with_coordinate),
            )
            .await
            .unwrap();
            let mentions = ai_position_mention::Entity::find()
                .filter(
                    ai_position_mention::Column::SigintInboxItemId
                        .eq(message.id),
                )
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(mentions.len(), 1);
            assert_eq!(mentions[0].name, "Циркон 9");
            assert_eq!(mentions[0].name_key, "циркон 9");
            let coordinates = ai_position_coordinate::Entity::find()
                .filter(
                    ai_position_coordinate::Column::MentionId
                        .eq(mentions[0].id),
                )
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(coordinates.len(), usize::from(with_coordinate));
            assert!(ai_position_worker_job::Entity::find()
                .one(&env.dbx)
                .await
                .unwrap()
                .is_none());
        }
    }

    async fn grouped_message(
        dbx: &sea_orm::DatabaseConnection,
        is_secret: bool,
    ) -> (i64, String, i64) {
        use crate::entities::{
            area_of_responsibility, signal_group, signal_group_aor,
            signal_message_group,
        };
        let now = chrono::Utc::now().naive_utc();
        let group = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .one(dbx)
            .await
            .unwrap()
            .unwrap();
        let master_key = group.master_key.clone();
        let mut group = group.into_active_model();
        group.is_secret = Set(is_secret);
        group.update(dbx).await.unwrap();
        let aor = area_of_responsibility::ActiveModel {
            name: Set(format!("position-test-{}", uuid::Uuid::now_v7())),
            left_bound: Set(0.0),
            right_bound: Set(1.0),
            updated_at: Set(now),
            created_at: Set(now),
            deleted: Set(false),
            is_top_level: Set(false),
            is_default: Set(false),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        signal_group_aor::ActiveModel {
            master_key: Set(master_key.clone()),
            aor_id: Set(aor.id),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        let message = crate::functest::tests::mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(BODY.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(master_key.clone())),
            created_at: Set(message.created_at),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        (message.id, master_key, aor.id)
    }

    async fn knowledge_scopes(
        env: &crate::types::Env,
    ) -> Vec<(String, String)> {
        use crate::entities::ai_position_knowledge;
        let dbx = &env.dbx;
        let mut redis = env.redis.clone();
        loop {
            let recomputed =
                crate::ai_position::knowledge::process_next(dbx, &mut redis)
                    .await
                    .unwrap();
            let linked = crate::ai_position::knowledge::process_next_link(
                dbx, &mut redis,
            )
            .await
            .unwrap();
            if !recomputed && !linked {
                break;
            }
        }
        let mut scopes: Vec<(String, String)> =
            ai_position_knowledge::Entity::find()
                .all(dbx)
                .await
                .unwrap()
                .into_iter()
                .map(|row| (row.scope_kind, row.scope_key))
                .collect();
        scopes.sort();
        scopes
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn shares_knowledge_by_aor_but_not_from_private_groups_3064() {
        use crate::entities::{
            ai_position_knowledge, ai_position_knowledge_job,
        };
        for is_secret in [false, true] {
            let env = crate::functest::tests::cleanup().await.unwrap();
            ai_position_knowledge::Entity::delete_many()
                .exec(&env.dbx)
                .await
                .unwrap();
            ai_position_knowledge_job::Entity::delete_many()
                .exec(&env.dbx)
                .await
                .unwrap();
            enable_worker(&env.dbx).await;
            let (message_id, master_key, aor_id) =
                grouped_message(&env.dbx, is_secret).await;
            let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
            enqueue_message_if_enabled(&env.dbx, message_id)
                .await
                .unwrap();
            let job = load_next_job(&env.dbx).await.unwrap().unwrap();
            let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
            assert!(source.aor_ids.contains(&aor_id));
            assert_eq!(source.group_is_secret, is_secret);
            complete_job(&env.dbx, &job, &source, &config, extraction(true))
                .await
                .unwrap();

            let mut expected = vec![("group".to_string(), master_key.clone())];
            if !is_secret {
                expected.extend(
                    source
                        .aor_ids
                        .iter()
                        .map(|id| ("aor".to_string(), id.to_string())),
                );
            }
            expected.sort();
            assert_eq!(knowledge_scopes(&env).await, expected);

            // Losing the fact removes the knowledge.
            enqueue_message_if_enabled(&env.dbx, message_id)
                .await
                .unwrap();
            let job = load_next_job(&env.dbx).await.unwrap().unwrap();
            complete_job(&env.dbx, &job, &source, &config, extraction(false))
                .await
                .unwrap();
            assert!(knowledge_scopes(&env).await.is_empty());

            let mut group =
                crate::entities::signal_group::Entity::find_by_id(master_key)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap()
                    .into_active_model();
            group.is_secret = Set(false);
            group.update(&env.dbx).await.unwrap();
        }
    }

    async fn message_in_group(
        dbx: &sea_orm::DatabaseConnection,
        master_key: &str,
        body: &str,
    ) -> i64 {
        use crate::entities::signal_message_group;
        let message = crate::functest::tests::mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                body: Set(Some(body.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(master_key.to_string())),
            created_at: Set(message.created_at),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
        message.id
    }

    async fn linked_names(
        dbx: &sea_orm::DatabaseConnection,
        message_id: i64,
    ) -> Vec<String> {
        ai_position_mention::Entity::find()
            .filter(
                ai_position_mention::Column::SigintInboxItemId.eq(message_id),
            )
            .all(dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|mention| mention.name)
            .collect()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn links_a_known_position_in_its_scope_only_3064() {
        for is_secret in [false, true] {
            let env = crate::functest::tests::cleanup().await.unwrap();
            crate::entities::ai_position_knowledge::Entity::delete_many()
                .exec(&env.dbx)
                .await
                .unwrap();
            enable_worker(&env.dbx).await;
            let (message_id, master_key, _) =
                grouped_message(&env.dbx, is_secret).await;
            let later = message_in_group(
                &env.dbx,
                &master_key,
                "ЦИРКОН-9 на зв'язку, без змін",
            )
            .await;
            // Latin look-alikes: «Циpкoн» with Latin p and o.
            let latin =
                message_in_group(&env.dbx, &master_key, "Циpкoн 9 тихо").await;
            let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
            enqueue_message_if_enabled(&env.dbx, message_id)
                .await
                .unwrap();
            let job = load_next_job(&env.dbx).await.unwrap().unwrap();
            let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
            complete_job(&env.dbx, &job, &source, &config, extraction(true))
                .await
                .unwrap();
            knowledge_scopes(&env).await;

            // The group's own later message gets the name either way.
            assert_eq!(linked_names(&env.dbx, later).await, vec!["ЦИРКОН-9"]);
            assert_eq!(linked_names(&env.dbx, latin).await, vec!["Циpкoн 9"]);

            // Another group in the same AOR only when the source is public.
            let other_group = crate::entities::signal_group::Entity::find()
                .filter(
                    crate::entities::signal_group::Column::Deleted.eq(false),
                )
                .filter(
                    crate::entities::signal_group::Column::MasterKey
                        .ne(master_key.clone()),
                )
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            crate::entities::signal_group_aor::ActiveModel {
                master_key: Set(other_group.master_key.clone()),
                aor_id: Set(source.aor_ids[0]),
                created_at: Set(chrono::Utc::now().naive_utc()),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            let elsewhere = message_in_group(
                &env.dbx,
                &other_group.master_key,
                "Двоє вийшли на позицію Циркон 9",
            )
            .await;
            enqueue_message_if_enabled(&env.dbx, elsewhere)
                .await
                .unwrap();
            let job = load_next_job(&env.dbx).await.unwrap().unwrap();
            let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
            complete_job(
                &env.dbx,
                &job,
                &source,
                &config,
                Extraction {
                    positions: vec![],
                    response_text: String::new(),
                    model_name: "test".to_string(),
                },
            )
            .await
            .unwrap();
            let expected: Vec<String> = if is_secret {
                vec![]
            } else {
                vec!["Циркон 9".to_string()]
            };
            assert_eq!(linked_names(&env.dbx, elsewhere).await, expected);

            let mut group =
                crate::entities::signal_group::Entity::find_by_id(master_key)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap()
                    .into_active_model();
            group.is_secret = Set(false);
            group.update(&env.dbx).await.unwrap();
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn retracts_knowledge_when_private_or_deleted_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        crate::entities::ai_position_knowledge::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        enable_worker(&env.dbx).await;
        let (message_id, master_key, _) =
            grouped_message(&env.dbx, false).await;
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message_id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();
        let shared = |scopes: Vec<(String, String)>| {
            scopes.iter().any(|(kind, _)| kind == "aor")
        };
        assert!(shared(knowledge_scopes(&env).await));

        // The group turns private: AOR knowledge stops using its facts.
        let mut group = crate::entities::signal_group::Entity::find_by_id(
            master_key.clone(),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
        group.is_secret = Set(true);
        group.update(&env.dbx).await.unwrap();
        let scopes = knowledge_scopes(&env).await;
        assert_eq!(scopes, vec![("group".to_string(), master_key.clone())]);

        // The message is deleted: its knowledge goes, its facts wait in case
        // it is restored (restaging deletes and restores a message).
        let set_deleted = |deleted: bool| {
            let dbx = env.dbx.clone();
            async move {
                let mut message =
                    signal_message::Entity::find_by_id(message_id)
                        .one(&dbx)
                        .await
                        .unwrap()
                        .unwrap()
                        .into_active_model();
                message.deleted = Set(deleted);
                message.update(&dbx).await.unwrap();
            }
        };
        set_deleted(true).await;
        assert!(knowledge_scopes(&env).await.is_empty());
        assert_eq!(linked_names(&env.dbx, message_id).await, vec!["Циркон 9"]);
        set_deleted(false).await;
        assert_eq!(
            knowledge_scopes(&env).await,
            vec![("group".to_string(), master_key.clone())]
        );

        // A corrected event time moves the facts.
        // Microseconds: what the database keeps.
        let corrected = chrono::DateTime::from_timestamp_micros(
            (chrono::Utc::now() - chrono::Duration::days(3)).timestamp_micros(),
        )
        .unwrap()
        .naive_utc();
        let mut item = sigint_inbox_item::Entity::find_by_id(message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        item.datetime = Set(Some(corrected));
        item.update(&env.dbx).await.unwrap();
        let mention = ai_position_mention::Entity::find()
            .filter(
                ai_position_mention::Column::SigintInboxItemId.eq(message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(mention.message_at, corrected);
        let known = crate::entities::ai_position_knowledge::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        knowledge_scopes(&env).await;
        let known_after =
            crate::entities::ai_position_knowledge::Entity::find()
                .all(&env.dbx)
                .await
                .unwrap();
        assert_ne!(known[0].last_fact_at, corrected);
        assert_eq!(known_after[0].last_fact_at, corrected);

        let mut group =
            crate::entities::signal_group::Entity::find_by_id(master_key)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        group.is_secret = Set(false);
        group.update(&env.dbx).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn drops_mentions_when_the_body_changes_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        enable_worker(&env.dbx).await;
        let (message_id, _, _) = grouped_message(&env.dbx, false).await;
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message_id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();
        assert_eq!(linked_names(&env.dbx, message_id).await, vec!["Циркон 9"]);

        let mut message = signal_message::Entity::find_by_id(message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        message.body = Set(Some("Переміщення до Береза 4".to_string()));
        message.update(&env.dbx).await.unwrap();

        assert!(linked_names(&env.dbx, message_id).await.is_empty());
        assert!(knowledge_scopes(&env).await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn follows_a_message_to_its_new_group_3064() {
        use crate::entities::{signal_group, signal_message_group};
        let env = crate::functest::tests::cleanup().await.unwrap();
        crate::entities::ai_position_knowledge::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        enable_worker(&env.dbx).await;
        let (message_id, master_key, _) =
            grouped_message(&env.dbx, false).await;
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message_id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();
        knowledge_scopes(&env).await;

        // A merge moves the message into another group.
        let target = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::MasterKey.ne(master_key.clone()))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        signal_message_group::Entity::update_many()
            .col_expr(
                signal_message_group::Column::GroupMasterKey,
                Some(target.master_key.clone()).into(),
            )
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message_id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();

        let mention = ai_position_mention::Entity::find()
            .filter(
                ai_position_mention::Column::SigintInboxItemId.eq(message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            mention.group_master_key.as_deref(),
            Some(target.master_key.as_str())
        );
        let scopes = knowledge_scopes(&env).await;
        assert!(
            scopes.contains(&("group".to_string(), target.master_key.clone()))
        );
        assert!(!scopes.contains(&("group".to_string(), master_key.clone())));

        // Links replaced (delete, then insert the chosen group) move it back.
        signal_message_group::Entity::delete_many()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message_id),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message_id),
            group_master_key: Set(Some(master_key.clone())),
            created_at: Set(chrono::Utc::now().naive_utc()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mention = ai_position_mention::Entity::find()
            .filter(
                ai_position_mention::Column::SigintInboxItemId.eq(message_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            mention.group_master_key.as_deref(),
            Some(master_key.as_str())
        );
        let scopes = knowledge_scopes(&env).await;
        assert!(scopes.contains(&("group".to_string(), master_key)));
        assert!(!scopes.contains(&("group".to_string(), target.master_key)));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn moves_knowledge_with_aor_reassignment_3064() {
        use crate::entities::{area_of_responsibility, signal_group_aor};
        let env = crate::functest::tests::cleanup().await.unwrap();
        crate::entities::ai_position_knowledge::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        enable_worker(&env.dbx).await;
        let (message_id, master_key, _) =
            grouped_message(&env.dbx, false).await;
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message_id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();
        knowledge_scopes(&env).await;

        // The group is reassigned to a new AOR only.
        let now = chrono::Utc::now().naive_utc();
        let new_aor = area_of_responsibility::ActiveModel {
            name: Set(format!("position-test-{}", uuid::Uuid::now_v7())),
            left_bound: Set(0.0),
            right_bound: Set(1.0),
            updated_at: Set(now),
            created_at: Set(now),
            deleted: Set(false),
            is_top_level: Set(false),
            is_default: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        signal_group_aor::Entity::delete_many()
            .filter(signal_group_aor::Column::MasterKey.eq(master_key.clone()))
            .exec(&env.dbx)
            .await
            .unwrap();
        signal_group_aor::ActiveModel {
            master_key: Set(master_key.clone()),
            aor_id: Set(new_aor.id),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let mut expected = vec![
            ("aor".to_string(), new_aor.id.to_string()),
            ("group".to_string(), master_key),
        ];
        expected.sort();
        assert_eq!(knowledge_scopes(&env).await, expected);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn skips_names_reviewers_rejected_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        enable_worker(&env.dbx).await;
        let (message_id, _, _) = grouped_message(&env.dbx, false).await;
        crate::entities::ai_position_feedback::ActiveModel {
            target_kind: Set("mention".to_string()),
            name: Set("Циркон 9".to_string()),
            name_key: Set("циркон 9".to_string()),
            verdict: Set("not_position".to_string()),
            coordinates: Set(serde_json::json!([])),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message_id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();
        assert!(linked_names(&env.dbx, message_id).await.is_empty());
        assert!(knowledge_scopes(&env).await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_a_job_reenqueued_during_extraction_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        enable_worker(&env.dbx).await;
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(BODY.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let config = load_worker_config(&env.dbx).await.unwrap().unwrap();
        enqueue_message_if_enabled(&env.dbx, message.id)
            .await
            .unwrap();
        let job = load_next_job(&env.dbx).await.unwrap().unwrap();
        let source = load_source(&env.dbx, &job).await.unwrap().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        enqueue_message_if_enabled(&env.dbx, message.id)
            .await
            .unwrap();

        complete_job(&env.dbx, &job, &source, &config, extraction(true))
            .await
            .unwrap();

        assert!(ai_position_mention::Entity::find()
            .filter(
                ai_position_mention::Column::SigintInboxItemId.eq(message.id)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert!(ai_position_worker_job::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }
}
