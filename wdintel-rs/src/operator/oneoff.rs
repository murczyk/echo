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

    let source_signal_group =
        signal_group::Entity::find_by_id(ps.source_group_key)
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .c(h!())?;

    let Some(source_signal_group) = source_signal_group else {
        return Err(AppError::NotFound);
    };

    let Some(datasource_id) = source_signal_group.datasource_id else {
        return Err(AppError::NotFound);
    };

    let target_signal_group =
        signal_group::Entity::find_by_id(ps.target_group_key)
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .c(h!())?;

    let Some(target_signal_group) = target_signal_group else {
        return Err(AppError::NotFound);
    };

    let datasource_group = datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .one(&txn)
        .await
        .c(h!())?;

    if let Some(group) = datasource_group {
        let datasource_group_id = group.id;
        let mut model = group.into_active_model();
        model.group_master_key = Set(target_signal_group.master_key.clone());
        model.update(&txn).await.c(h!())?;

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
            .exec(&txn)
            .await
            .c(h!())?;
    }

    datasource_group::Entity::update_many()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .col_expr(
            datasource_group::Column::GroupMasterKey,
            Expr::value(target_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    group_admin_data::Entity::delete_many()
        .filter(
            group_admin_data::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    organism_group::Entity::delete_many()
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    secret_group_user::Entity::delete_many()
        .filter(
            secret_group_user::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    sigint_zone_datasource::Entity::delete_many()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    signal_group_aor::Entity::delete_many()
        .filter(
            signal_group_aor::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    let mut source_signal_group = source_signal_group.into_active_model();
    source_signal_group.deleted = Set(true);
    source_signal_group.update(&txn).await.c(h!())?;

    txn.commit().await.c(h!())?;

    Ok(())
}
