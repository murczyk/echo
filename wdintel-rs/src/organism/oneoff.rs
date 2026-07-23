use crate::entities::*;
use crate::error::AppError;
use crate::sigint::aor::load_default_aor;
use crate::types::*;
use crate::utils::string::master_key_shortcut;
use sea_orm::*;
use std::time::Duration;

struct DeletedGoiKnowledgeBounds {
    first_id: i64,
    last_id: i64,
}

struct DeletedGoiKnowledgeBatch {
    deleted_count: i64,
    last_scanned_id: Option<i64>,
}

pub async fn oneoff_delete_deleted_goi_knowledge(
    mode: Mode,
    ps: &crate::OneoffDeleteDeletedGoiKnowledgePs,
) -> Result<(), AppError> {
    if ps.batch_size == 0 {
        return Err(AppError::BL {
            msg: "batch_size must be greater than zero".to_string(),
        });
    }
    let batch_size = i64::try_from(ps.batch_size).c(h!())?;
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let Some(bounds) =
        deleted_goi_knowledge_bounds(&db, ps.integration_id).await?
    else {
        info!("No deleted GOI knowledge rows found");
        return Ok(());
    };
    if !ps.execute {
        let row_count =
            deleted_goi_knowledge_count(&db, ps.integration_id).await?;
        info!(
            "Found {row_count} deleted GOI knowledge rows in id range {}..={}",
            bounds.first_id, bounds.last_id
        );
        info!("Dry run only; rerun with --execute to delete these rows");
        return Ok(());
    }
    info!(
        "Deleting GOI knowledge rows in id range {}..={}",
        bounds.first_id, bounds.last_id
    );

    let mut next_id = bounds.first_id;
    let mut deleted_count = 0_i64;
    loop {
        let batch = delete_deleted_goi_knowledge_batch(
            &db,
            ps.integration_id,
            next_id,
            bounds.last_id,
            batch_size,
        )
        .await?;
        deleted_count += batch.deleted_count;
        let Some(last_scanned_id) = batch.last_scanned_id else {
            break;
        };
        info!(
            "Deleted {} GOI knowledge rows; total_deleted={deleted_count}, last_scanned_id={last_scanned_id}",
            batch.deleted_count
        );
        if last_scanned_id >= bounds.last_id {
            break;
        }
        next_id = last_scanned_id + 1;
        if ps.sleep_ms > 0 {
            tokio::time::sleep(Duration::from_millis(ps.sleep_ms)).await;
        }
    }
    info!("Finished deleting GOI knowledge rows: deleted={deleted_count}");
    Ok(())
}

async fn deleted_goi_knowledge_bounds(
    db: &DatabaseConnection,
    integration_id: Option<i64>,
) -> Result<Option<DeletedGoiKnowledgeBounds>, AppError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                select
                    min(id)::bigint as first_id,
                    max(id)::bigint as last_id
                from goi_knowledge
                where deleted = true
                    and ($1::bigint is null or integration_id = $1)
            "#,
            [integration_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let Some(first_id) = row.try_get("", "first_id").c(h!())? else {
        return Ok(None);
    };
    Ok(Some(DeletedGoiKnowledgeBounds {
        first_id,
        last_id: row.try_get("", "last_id").c(h!())?,
    }))
}

async fn deleted_goi_knowledge_count(
    db: &DatabaseConnection,
    integration_id: Option<i64>,
) -> Result<i64, AppError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                select count(*)::bigint as row_count
                from goi_knowledge
                where deleted = true
                    and ($1::bigint is null or integration_id = $1)
            "#,
            [integration_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    Ok(row.try_get("", "row_count").c(h!())?)
}

async fn delete_deleted_goi_knowledge_batch(
    db: &DatabaseConnection,
    integration_id: Option<i64>,
    first_id: i64,
    last_id: i64,
    batch_size: i64,
) -> Result<DeletedGoiKnowledgeBatch, AppError> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                with batch as materialized (
                    select id
                    from goi_knowledge
                    where deleted = true
                        and id between $2 and $3
                        and ($1::bigint is null or integration_id = $1)
                    order by id
                    limit $4
                ),
                deleted_rows as (
                    delete from goi_knowledge
                    using batch
                    where goi_knowledge.id = batch.id
                    returning goi_knowledge.id
                )
                select
                    (select count(*)::bigint from deleted_rows) as deleted_count,
                    (select max(id)::bigint from batch) as last_scanned_id
            "#,
            [
                integration_id.into(),
                first_id.into(),
                last_id.into(),
                batch_size.into(),
            ],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    Ok(DeletedGoiKnowledgeBatch {
        deleted_count: row.try_get("", "deleted_count").c(h!())?,
        last_scanned_id: row.try_get("", "last_scanned_id").c(h!())?,
    })
}

pub async fn oneoff_print_organism_groups(
    mode: Mode,
    ps: &crate::OneoffPrintOrganismGroupsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_print_organism_groups...");
    let config = crate::config::read_config(mode).c(h!())?;
    let db = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let organism_name = ps.organism_name.clone();
    info!(
        "Determining organism name for organism: {:#?}",
        organism_name
    );
    let organism = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Name.eq(organism_name))
        .one(&db)
        .await
        .c(h!())?
        .c(h!())?;

    let organism_groups =
        crate::organism::load_organism_group_ids(&db, organism.id)
            .await
            .c(h!())?;
    let available_keys = organism_groups.available_keys;
    info!("Available groups: {}", available_keys.len());
    for available_key in available_keys {
        let group = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::MasterKey.eq(available_key.clone()))
            .one(&db)
            .await
            .c(h!())?
            .context(available_key.clone())?;
        let master_key_short = master_key_shortcut(group.master_key.as_str());
        info!(
            "- {} master_key={}",
            group.name.unwrap_or("<None>".to_string()),
            master_key_short
        );
    }

    Ok(())
}

pub async fn oneoff_fix_organism_aors(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let organisms_without_aors = organism::Entity::find()
        .join(JoinType::LeftJoin, organism::Relation::OrganismAor.def())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism_aor::Column::Id.is_null())
        .all(dbx)
        .await
        .c(h!())?;
    if organisms_without_aors.is_empty() {
        return Ok(());
    };
    let default_aor = load_default_aor(dbx).await.c(h!())?;
    for o in organisms_without_aors {
        organism_aor::ActiveModel {
            id: NotSet,
            organism_id: Set(o.id),
            aor_id: Set(default_aor.id),
            created_at: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}
