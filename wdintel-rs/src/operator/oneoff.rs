use crate::entities::*;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, OneoffMergeDatasourceGroupPs};
use sea_orm::*;

pub async fn oneoff_merge_datasource_group(
    mode: Mode,
    ps: OneoffMergeDatasourceGroupPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    crate::battle_line::lock_updates(&txn).await.c(h!())?;

    let target_signal_group =
        signal_group::Entity::find_by_id(ps.target_group_key.clone())
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .c(h!())?;

    let Some(target_signal_group) = target_signal_group else {
        return Err(AppError::NotFound);
    };

    let group_name = target_signal_group.name.clone().unwrap_or_default();

    let datasource_groups = datasource_group::Entity::find()
        .find_also_related(signal_group::Entity)
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::Datasource.def(),
        )
        .filter(datasource::Column::Kind.eq("echo_operator"))
        .filter(
            datasource_group::Column::GroupMasterKey
                .ne(ps.target_group_key.clone()),
        )
        .filter(datasource_group::Column::Name.eq(group_name.clone()))
        .all(&txn)
        .await
        .c(h!())?;

    for (datasource_group, signal_group) in datasource_groups {
        let source_signal_group = signal_group.unwrap();
        println!(
            "will merge {} into '{}' {}",
            datasource_group.group_master_key,
            group_name,
            target_signal_group.master_key
        );
        merge_group_into(
            &txn,
            datasource_group,
            source_signal_group,
            &target_signal_group,
        )
        .await
        .c(h!())?;
    }

    if !ps.dry_run {
        txn.commit().await.c(h!())?;
    }

    Ok(())
}

pub async fn oneoff_compact_datasource_group(
    mode: Mode,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;

    print_datasource_group_size(&dbx, "before").await.c(h!())?;
    println!("datasource_group compaction started");
    dbx.execute_unprepared("vacuum (full, analyze) datasource_group;")
        .await
        .c(h!())?;
    print_datasource_group_size(&dbx, "after").await.c(h!())?;

    Ok(())
}

async fn print_datasource_group_size(
    dbx: &DatabaseConnection,
    label: &str,
) -> Result<(), AppError> {
    let row = dbx
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
            select
                pg_size_pretty(pg_relation_size('datasource_group')) as heap_size,
                pg_size_pretty(pg_total_relation_size('datasource_group')) as total_size
            "#
            .to_string(),
        ))
        .await
        .c(h!())?
        .c(h!())?;
    let heap_size: String = row.try_get("", "heap_size").c(h!())?;
    let total_size: String = row.try_get("", "total_size").c(h!())?;

    println!(
        "datasource_group {label}: heap_size={heap_size} total_size={total_size}"
    );

    Ok(())
}

async fn merge_group_into(
    txn: &DatabaseTransaction,
    datasource_group: datasource_group::Model,
    source_signal_group: signal_group::Model,
    target_signal_group: &signal_group::Model,
) -> Result<(), AppError> {
    let datasource_group_id = datasource_group.id;
    let mut datasource_group = datasource_group.into_active_model();
    datasource_group.group_master_key =
        Set(target_signal_group.master_key.clone());
    datasource_group.update(txn).await.c(h!())?;

    super::merge_signal_group_references(
        txn,
        datasource_group_id,
        source_signal_group,
        target_signal_group,
    )
    .await
    .c(h!())?;

    Ok(())
}
