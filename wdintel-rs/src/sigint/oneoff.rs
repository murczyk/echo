use crate::config::TAG_SUGGEST_WORKER_BATCH_SIZE;
use crate::entities::{sigint_inbox_item, sigint_inbox_item_tag, tag};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{h, OneoffSuggestInboxMessageTagsPs};
use log::{info, warn};
use sea_orm::prelude::*;
use sea_orm::*;

pub async fn oneoff_fill_sigint_inbox_item_tags(
    mode: Mode,
) -> Result<(), AppError> {
    info!("starting oneoff_fill_sigint_inbox_item_tags...");
    let config = crate::config::read_config(mode)?;
    let db = crate::new_pg_pool_from_config(&config).await?;

    db.execute_unprepared(
        r#"
            insert into sigint_inbox_item_tag (
                sigint_inbox_item_id,
                tag_id
            )
            select distinct
                x.sigint_inbox_item_id,
                x.tag_id::bigint
            from (
                select
                    id as sigint_inbox_item_id,
                    jsonb_array_elements(tags) as tag_id
                from
                    sigint_inbox_item i
                where
                    i.tags is not null  
                    and not exists (
                        select 1 from sigint_inbox_item_tag it
                        where it.sigint_inbox_item_id = i.id
                    )
            ) as x;
    "#,
    )
    .await
    .c(h!())?;
    info!("done oneoff_fill_sigint_inbox_item_tags");
    Ok(())
}

pub async fn oneoff_suggest_inbox_message_tags(
    mode: Mode,
    ps: &OneoffSuggestInboxMessageTagsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_suggest_inbox_message_tags...");
    let env = crate::server::new_env(mode).await.c(h!())?;

    let dbx = env.dbx.clone();
    let start = parse_local_datetime(&ps.start).c(h!())?;
    let end = parse_local_datetime(&ps.end).c(h!())?;

    let tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .all(&dbx)
        .await
        .c(h!())?;

    let q = sigint_inbox_item_tag::Entity::find()
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .select_only();
    let exists = Expr::exists(q.expr(Expr::value(1)).into_query());

    let message_ids: Vec<i64> = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemTag.def(),
        )
        .select_only()
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(exists.not())
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&dbx)
        .await
        .c(h!())?;

    let total_len = message_ids.len();
    info!("oneoff_suggest_inbox_message_tags, about to process {total_len} messages");
    let mut processed = 0;
    let mut suggested = 0;
    for chunk in message_ids.chunks(TAG_SUGGEST_WORKER_BATCH_SIZE) {
        let txn: DatabaseTransaction = dbx.begin().await.c(h!())?;

        let result = crate::tags::worker::process_messages(
            chunk.to_vec(),
            &tags,
            &env.rq,
            &txn,
            &env.tag_keyword_regex_cache,
        )
        .await
        .c(h!())?;

        processed += chunk.len();
        suggested += result.inserted_count;

        info!("oneoff_suggest_inbox_message_tags, {suggested} tags suggested for {processed}/{total_len} messages");

        txn.commit().await.c(h!())?;
    }

    if suggested == 0 {
        warn!("no tags suggested for {processed} messages, did you forget to set up tag keywords or run `just ai-sync-from-cloud`?")
    } else {
        info!("done oneoff_suggest_inbox_message_tags, total {suggested} tags suggested for {processed} messages");
    }

    Ok(())
}
