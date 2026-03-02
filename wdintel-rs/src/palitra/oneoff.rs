use crate::config::PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE;
use crate::entities::{
    palitra_point, palitra_point_lexeme, sigint_inbox_item,
    sigint_inbox_item_network, sigint_inbox_item_point_tokens,
};
use crate::error::AppError;
use crate::inbox::{
    resolve_aor_ids_by_networks, resolve_message_aor_ids_by_group,
};
use crate::palitra::types::PalitraAccess;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::{Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{h, new_pg_pool_from_mode};
use futures_util::TryStreamExt;
use sea_orm::*;
use sea_query::{Expr, OnConflict};
use std::collections::{HashMap, HashSet};

pub async fn oneoff_backfill_palitra_point_lexemes(
    mode: Mode,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    println!("> starting oneoff_backfill_palitra_point_lexemes");
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();
    let filter = palitra_point_lexeme::Entity::find()
        .filter(
            Expr::col((
                palitra_point_lexeme::Entity,
                palitra_point_lexeme::Column::PalitraPointId,
            ))
            .equals((palitra_point::Entity, palitra_point::Column::Id)),
        )
        .select_only()
        .expr(1)
        .into_query();

    let mut points = palitra_point::Entity::find()
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .filter(palitra_point::Column::Label.ne(""))
        .filter(Expr::exists(filter).not())
        .stream(&dbx)
        .await
        .c(h!())?;
    let mut batch: Vec<palitra_point::Model> =
        Vec::with_capacity(PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE);
    let mut total_points: u64 = 0;
    let mut total_lexemes: u64 = 0;

    while let Some(point) = points.try_next().await.c(h!())? {
        batch.push(point);
        total_points += 1;
        if batch.len() >= PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE {
            total_lexemes += insert_lexeme_batch(&rq, &dbx, &mut batch).await?;
        }
    }
    if !batch.is_empty() {
        total_lexemes += insert_lexeme_batch(&rq, &dbx, &mut batch).await?;
    }

    println!(
        "> backfill done: points={} lexemes={} elapsed={:?}",
        total_points,
        total_lexemes,
        started_at.elapsed()
    );
    Ok(())
}

pub async fn oneoff_highlight_inbox_message_palitra_points(
    mode: Mode,
    ps: &crate::OneoffHighlightInboxMessagePalitraPs,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    println!("> starting oneoff_highlight_inbox_message_palitra_points");
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();

    let start = parse_local_datetime(&ps.start).c(h!())?;
    let end = parse_local_datetime(&ps.end).c(h!())?;

    let messages_and_networks = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemPointTokens.def(),
        )
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(sigint_inbox_item_point_tokens::Column::Id.is_null())
        .find_with_related(sigint_inbox_item_network::Entity)
        .all(&dbx)
        .await
        .c(h!())?;

    let total_messages = messages_and_networks.len();
    println!("loaded {total_messages} total messages");
    let mut total_palitra_points = 0;
    let mut message_count = 0;

    let mut lexeme_cache: HashMap<Vec<i64>, _> = HashMap::new();

    for (message, networks) in messages_and_networks {
        let body_noheader: NoHeadersBody =
            serde_json::from_value(message.body_noheader.unwrap())
                .map_err(|e| anyhow::anyhow!("JSON parse error: {e}"))?;

        let network_ids: Vec<i64> =
            networks.iter().map(|x| x.sigint_network_id).collect();
        let mut palitra_aor_ids =
            resolve_aor_ids_by_networks(&dbx, network_ids).await?;

        if palitra_aor_ids.is_empty() {
            palitra_aor_ids =
                resolve_message_aor_ids_by_group(&dbx, message.id).await?;
        }

        if palitra_aor_ids.is_empty() {
            continue;
        }
        palitra_aor_ids.sort();

        let palitra_point_lexemes = match lexeme_cache.get(&palitra_aor_ids) {
            Some(cached) => cached,
            _ => {
                let access = PalitraAccess::ByAor {
                    aor_ids: palitra_aor_ids.clone(),
                };
                let lexemes = crate::rer_importer::points::load_relevant_palitra_point_lexemes(
                    &dbx, access, false,
                )
                .await
                .c(h!())?;
                lexeme_cache.entry(palitra_aor_ids).or_insert(lexemes)
            }
        };

        let message_palitra_highlights =
            crate::rer_importer::points::highlight_points(
                &rq,
                &body_noheader.body,
                &palitra_point_lexemes,
                body_noheader.start,
            )
            .await
            .c(h!())?;

        let inbox_item_point_tokens: Vec<_> = message_palitra_highlights
            .iter()
            .map(|highlight| {
                let point_tokens = serde_json::json!(&highlight.points);
                sigint_inbox_item_point_tokens::ActiveModel {
                    palitra_id: Set(highlight.palitra_id),
                    point_tokens: Set(point_tokens),
                    sigint_inbox_item_id: Set(message.id),
                    ..Default::default()
                }
            })
            .collect();
        if !inbox_item_point_tokens.is_empty() {
            total_palitra_points += inbox_item_point_tokens.len();

            sigint_inbox_item_point_tokens::Entity::insert_many(
                inbox_item_point_tokens,
            )
            .exec_without_returning(&dbx)
            .await
            .c(h!())?;
        }
        message_count += 1;
        if message_count % 100 == 0 {
            println!("processed {message_count} messages, palitra points so far: {total_palitra_points}");
        }
    }

    println!(
        "> backfill done: messages={} highlighted points={} elapsed={:?}",
        total_messages,
        total_palitra_points,
        started_at.elapsed()
    );
    Ok(())
}

async fn insert_lexeme_batch(
    rq: &reqwest::Client,
    dbx: &DatabaseConnection,
    batch: &mut Vec<palitra_point::Model>,
) -> Result<u64, AppError> {
    let batch = std::mem::take(batch);

    let mut palitra_point_ids = Vec::with_capacity(batch.len());
    let mut tokens = Vec::with_capacity(batch.len());
    for point in batch {
        if let Some(label) = point.label {
            palitra_point_ids.push(point.id);
            tokens.push(label);
        }
    }

    let lexemes_batch = crate::nlp::token_lexemes_batch(rq, tokens).await?;
    let mut items = Vec::with_capacity(lexemes_batch.len());
    let mut uniq = HashSet::new();

    for (point_id, lexemes) in palitra_point_ids.into_iter().zip(lexemes_batch)
    {
        for lexeme in lexemes {
            let lexeme = lexeme.to_lowercase().trim().to_string();
            if !uniq.contains(&lexeme) {
                uniq.insert(lexeme.clone());
                let item = palitra_point_lexeme::ActiveModel {
                    palitra_point_id: Set(point_id),
                    lexeme: Set(lexeme),
                    ..Default::default()
                };
                items.push(item);
            }
        }
        uniq.clear();
    }

    let lexemes_inserted = palitra_point_lexeme::Entity::insert_many(items)
        .on_conflict(
            OnConflict::columns([
                palitra_point_lexeme::Column::PalitraPointId,
                palitra_point_lexeme::Column::Lexeme,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(dbx)
        .await
        .or_else(|err| match err {
            DbErr::RecordNotInserted => Ok(0),
            _ => Err(err),
        })
        .c(h!())?;
    Ok(lexemes_inserted)
}
