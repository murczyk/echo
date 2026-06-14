use crate::entities::*;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, OneoffMergeDatasourceGroupPs};
use sea_orm::*;
use sea_query::Expr;

pub async fn oneoff_merge_datasource_group(
    mode: Mode,
    ps: OneoffMergeDatasourceGroupPs,
) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let txn = dbx.begin().await.c(h!())?;

    let target_signal_group =
        signal_group::Entity::find_by_id(ps.target_group_key.clone())
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .c(h!())?;

    let Some(target_signal_group) = target_signal_group else {
        return Err(AppError::NotFound);
    };

    let group_name = target_signal_group.name.clone().unwrap();

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
            &datasource_group.group_master_key,
            &group_name,
            &target_signal_group.master_key
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

async fn merge_group_into(
    txn: &DatabaseTransaction,
    datasource_group: datasource_group::Model,
    source_signal_group: signal_group::Model,
    target_signal_group: &signal_group::Model,
) -> Result<(), AppError> {
    let datasource_group_id = datasource_group.id;
    let mut model = datasource_group.into_active_model();
    model.group_master_key = Set(target_signal_group.master_key.clone());
    model.update(txn).await.c(h!())?;

    signal_message_group::Entity::update_many()
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .filter(
            signal_message_group::Column::DatasourceGroupId
                .eq(datasource_group_id),
        )
        .col_expr(
            signal_message_group::Column::GroupMasterKey,
            Expr::value(target_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    group_admin_data::Entity::delete_many()
        .filter(
            group_admin_data::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    organism_group::Entity::delete_many()
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    secret_group_user::Entity::delete_many()
        .filter(
            secret_group_user::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    sigint_zone_datasource::Entity::delete_many()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    signal_group_aor::Entity::delete_many()
        .filter(
            signal_group_aor::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    let mut source_signal_group = source_signal_group.into_active_model();
    source_signal_group.deleted = Set(true);
    source_signal_group.update(txn).await.c(h!())?;

    Ok(())
}
