use crate::config::{
    mk_s3, mk_s3_config, read_config, PALITRA_POINT_LEXEME_BACKFILL_BATCH_SIZE,
};
use crate::entities::{
    palitra, palitra_geometry, palitra_point, palitra_point_lexeme,
    sigint_inbox_item, sigint_inbox_item_point_token,
};
use crate::error::AppError;
use crate::palitra::worker::{do_palitra_highlight, PalitraWorkerContext};
use crate::storage;
use crate::types::{Kyiv, Mode, ShortContext, Utc};
use crate::utils::parse_local_datetime;
use crate::{h, new_pg_pool_from_config, new_pg_pool_from_mode};
use futures_util::TryStreamExt;
use sea_orm::*;
use sea_query::{Expr, OnConflict};
use std::collections::HashSet;
use std::sync::Arc;

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

    let message_ids = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemPointToken.def(),
        )
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(sigint_inbox_item_point_token::Column::Id.is_null())
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&dbx)
        .await
        .c(h!())?;

    let context = Arc::new(PalitraWorkerContext::default());

    let total_messages = message_ids.len();
    println!("loaded {total_messages} total messages");
    let mut total_palitra_points = 0;
    let mut message_count = 0;

    for chunk in message_ids.chunks(100) {
        let (total, _) =
            do_palitra_highlight(chunk.to_vec(), &rq, &dbx, &context).await?;
        message_count += chunk.len();
        total_palitra_points += total;
        println!(
            "processed {message_count} messages, palitra points so far: {total_palitra_points}"
        );
    }

    println!(
        "> backfill done: messages={} highlighted points={} elapsed={:?}",
        total_messages,
        total_palitra_points,
        started_at.elapsed()
    );
    Ok(())
}

pub async fn oneoff_backup_palitras(mode: Mode) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    println!("> starting oneoff_backup_palitras");
    let config = read_config(mode).c(h!())?;
    let dbx = new_pg_pool_from_config(&config).await.c(h!())?;
    let s3 = mk_s3(&config).c(h!())?;
    let s3_config = mk_s3_config(&config).c(h!())?.ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let s3_config_for_download = Some(s3_config);
    let strongbox_key = config
        .s3_config
        .as_ref()
        .ok_or(AppError::BL {
            msg: "S3 is not configured".to_string(),
        })?
        .strongbox_key
        .clone();
    let date = Utc::now()
        .with_timezone(&Kyiv)
        .date_naive()
        .format("%Y-%m-%d");
    let output_dir =
        std::path::PathBuf::from(format!("/var/tmp/palitras_bkp_{date}"));
    if output_dir.exists() {
        return Err(AppError::BL {
            msg: format!(
                "backup directory already exists: {}",
                output_dir.display()
            ),
        });
    }
    std::fs::create_dir_all(&output_dir).c(h!())?;

    let palitras = palitra::Entity::find()
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra::Column::S3Id.is_not_null())
        .order_by_asc(palitra::Column::Id)
        .all(&dbx)
        .await
        .c(h!())?;
    println!("loaded {} palitras with s3_id", palitras.len());

    let mut restored = 0usize;
    for palitra in palitras {
        let geometry = palitra_geometry::Entity::find()
            .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
            .filter(palitra_geometry::Column::Deleted.eq(false))
            .order_by_desc(palitra_geometry::Column::UpdatedAt)
            .order_by_desc(palitra_geometry::Column::Id)
            .one(&dbx)
            .await
            .c(h!())?;
        let s3_id = palitra.s3_id.clone().c(h!())?;
        let bytes = storage::download_and_decrypt_from_s3_with_operator(
            &s3,
            &s3_config_for_download,
            &strongbox_key,
            &s3_id,
        )
        .await
        .c(h!())?;
        let filename = crate::palitra::bl::build_palitra_download_file_name(
            &palitra,
            geometry.as_ref(),
        );
        let target_path = output_dir.join(filename);
        tokio::fs::write(&target_path, bytes).await.c(h!())?;
        restored += 1;
        println!(
            "restored palitra_id={} s3_id={} -> {}",
            palitra.id,
            s3_id,
            target_path.display()
        );
    }

    println!(
        "> backup done: palitras={} dir={} elapsed={:?}",
        restored,
        output_dir.display(),
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
