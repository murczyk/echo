use crate::devices::devices::query::{
    DeviceReadScope, FileRegistryDeviceAccess,
};
use crate::{
    entities::{ai_agent_user_link, login},
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use uuid::Uuid;

pub(crate) async fn reader(
    env: &Env,
    id: Uuid,
) -> Result<login::Model, AppError> {
    let login = crate::users::load_active_login(&env.dbx, &id)
        .await
        .c(h!())?;
    let login = if login
        .roles
        .as_array()
        .is_some_and(|roles| roles.iter().any(|r| r == "ApiAgent"))
    {
        let link = ai_agent_user_link::Entity::find()
            .filter(ai_agent_user_link::Column::AgentLoginId.eq(id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::Unauthenticated)?;
        crate::devices::access::resolve_login_by_id(
            &env.dbx,
            &link.human_login_id,
        )
        .await
        .c(h!())?
    } else {
        crate::devices::access::resolve_login_by_id(&env.dbx, &id)
            .await
            .c(h!())?
    };
    crate::devices::access::require_read(&login.roles).c(h!())?;
    Ok(login)
}

pub(crate) async fn authorize(
    env: &Env,
    login: &login::Model,
    device: Uuid,
) -> Result<(), AppError> {
    crate::devices::devices::query::authorize_file_registry_access(
        &env.dbx,
        login,
        device,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn visible_ids(
    env: &Env,
    login: &login::Model,
    archived: bool,
) -> Result<Vec<Uuid>, AppError> {
    crate::devices::devices::query::visible_devices_query(
        login,
        if archived {
            DeviceReadScope::IncludeArchived
        } else {
            DeviceReadScope::ActiveOnly
        },
    )
    .c(h!())?
    .select_only()
    .column(crate::entities::device::Column::Id)
    .into_tuple::<Uuid>()
    .all(&env.dbx)
    .await
    .c(h!())
    .map_err(Into::into)
}

pub(crate) async fn available(env: &Env, id: Uuid) -> bool {
    if reader(env, id).await.is_err() {
        return false;
    }
    let Ok(registry) = env.file_registry_db() else {
        return false;
    };
    #[derive(sea_orm::FromQueryResult)]
    struct Schema {
        available: bool,
    }
    crate::attachments::store::rows::<Schema,_>(registry.connection(),"select to_regclass('public.file_document_revision_generation') is not null as available",vec![])
        .await.is_ok_and(|rows|rows.first().is_some_and(|row|row.available))
}
