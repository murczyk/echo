use crate::entities::{sigint_inbox_item, sigint_inbox_item_tag, tag};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, OneoffSuggestInboxMessageTagsPs};
use chrono::NaiveDateTime;
use log::info;
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
    let start = parse_date(&ps.start).c(h!())?;
    let end = parse_date(&ps.end).c(h!())?;

    let tags = tag::Entity::find()
        .filter(tag::Column::Enabled.eq(true))
        .all(&dbx)
        .await
        .c(h!())?;

    let message_ids: Vec<i64> = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemTag.def(),
        )
        .select_only()
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(sigint_inbox_item_tag::Column::Id.is_null())
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&dbx)
        .await
        .c(h!())?;

    let txn = dbx.begin().await.c(h!())?;

    let len = message_ids.len();
    crate::tags::worker::process_messages(
        message_ids,
        &tags,
        &env.rq,
        &txn,
        &env.tag_keyword_regex_cache,
    )
    .await
    .c(h!())?;

    txn.commit().await.c(h!())?;

    info!("done oneoff_suggest_inbox_message_tags, processed {len} messages");
    Ok(())
}

fn parse_date(val: &str) -> Result<NaiveDateTime, AppError> {
    let local_datetime =
        NaiveDateTime::parse_from_str(val, "%Y-%m-%dT%H:%M:%S").c(h!())?;
    let tz = crate::config::get_tz();
    let zoned = local_datetime.and_local_timezone(tz).unwrap();

    Ok(zoned.to_utc().naive_utc())
}
