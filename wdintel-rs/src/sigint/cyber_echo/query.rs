use crate::entities::signal_group;
use crate::error::AppError;
use crate::types::*;
use sea_orm::*;

pub async fn find_available_signal_group<C>(
    dbx: &C,
    login: &str,
    signal_group_master_key: &str,
) -> Result<signal_group::Model, AppError>
where
    C: ConnectionTrait,
{
    let signal_group = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(signal_group_master_key))
        .filter(signal_group::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let available_groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, login)
            .await
            .c(h!())?;
    if !available_groups.contains(&signal_group.master_key) {
        return Err(AppError::Forbidden(
            "signal group is not available for user".to_string(),
        ));
    }

    Ok(signal_group)
}
