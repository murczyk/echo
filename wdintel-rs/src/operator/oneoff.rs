use crate::entities::*;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, OneoffMergeDatasourceGroupPs};
use echo_migration::Expr;
use sea_orm::*;

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

    let target_signal_group =
        signal_group::Entity::find_by_id(ps.target_group_key)
            .filter(signal_group::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .c(h!())?;

    let Some(target_signal_group) = target_signal_group else {
        return Err(AppError::NotFound);
    };

    datasource_group::Entity::update_many()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
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

    signal_message_group::Entity::update_many()
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .col_expr(
            signal_message_group::Column::GroupMasterKey,
            Expr::value(target_signal_group.master_key.clone()),
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
