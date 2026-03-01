use crate::config::PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE;
use crate::entities::{palitra_point, palitra_point_lexeme};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use futures_util::TryStreamExt;
use sea_orm::*;
use sea_query::{Expr, OnConflict};
use std::collections::HashSet;

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
