use crate::config::PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE;
use crate::entities::{palitra_point, palitra_point_lexeme};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode, nlp};
use futures_util::TryStreamExt;
use sea_orm::*;
use sea_query::OnConflict;
use std::collections::HashSet;

pub async fn oneoff_backfill_palitra_point_lexemes(
    mode: Mode,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    println!("> starting oneoff_backfill_palitra_point_lexemes");
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();
    let mut points = palitra_point::Entity::find()
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::Label.is_not_null())
        .stream(&dbx)
        .await
        .c(h!())?;
    let mut batch: Vec<palitra_point_lexeme::ActiveModel> =
        Vec::with_capacity(PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE);
    let mut total_points = 0_u64;
    let mut total_lexemes = 0_u64;

    while let Some(point) = points.try_next().await.c(h!())? {
        let Some(label) = point.label else { continue };
        total_points += 1;
        let lexemes = build_lexemes_for_label(&rq, &label).await?;
        if lexemes.is_empty() {
            continue;
        }
        total_lexemes += lexemes.len() as u64;
        for lexeme in lexemes {
            batch.push(palitra_point_lexeme::ActiveModel {
                palitra_point_id: Set(point.id),
                lexeme: Set(lexeme),
                ..Default::default()
            });
        }
        if batch.len() >= PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE {
            insert_lexeme_batch(&dbx, &mut batch).await?;
        }
    }
    if !batch.is_empty() {
        insert_lexeme_batch(&dbx, &mut batch).await?;
    }

    dbx.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        "UPDATE palitra_point_lexeme SET label_tsv = to_tsvector('russian', lexeme) WHERE label_tsv IS NULL",
    ))
    .await
    .c(h!())?;

    println!(
        "> backfill done: points={} lexemes={} elapsed={:?}",
        total_points,
        total_lexemes,
        started_at.elapsed()
    );
    Ok(())
}

async fn build_lexemes_for_label(
    rq: &reqwest::Client,
    label: &str,
) -> Result<Vec<String>, AppError> {
    let mut lexemes = nlp::token_lexemes(rq, label).await.c(h!())?;
    lexemes.push(label.to_string());
    let mut uniq = HashSet::new();
    let mut out = Vec::new();
    for lexeme in lexemes {
        let lexeme = lexeme.to_lowercase().trim().to_string();
        if lexeme.is_empty() {
            continue;
        }
        if uniq.insert(lexeme.clone()) {
            out.push(lexeme);
        }
    }
    Ok(out)
}

async fn insert_lexeme_batch(
    dbx: &DatabaseConnection,
    batch: &mut Vec<palitra_point_lexeme::ActiveModel>,
) -> Result<(), AppError> {
    let items = std::mem::take(batch);
    palitra_point_lexeme::Entity::insert_many(items)
        .on_conflict(
            OnConflict::columns([
                palitra_point_lexeme::Column::PalitraPointId,
                palitra_point_lexeme::Column::Lexeme,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(dbx)
        .await
        .map(|_| ())
        .or_else(|err| match err {
            DbErr::RecordNotInserted => Ok(()),
            _ => Err(err),
        })
        .c(h!())?;
    Ok(())
}
