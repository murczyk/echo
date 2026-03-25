pub mod types;

use crate::entities::system_settings;
use crate::error::AppError;
use crate::h;
use crate::system_settings::types::{
    ActivateSystemSettingsReq, CreateSystemSettingsReq,
    SystemSettingsCurrentRsp, SystemSettingsItem, SystemSettingsListRsp,
};
use crate::types::Env;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, TransactionTrait,
};

fn map_system_settings_item(
    settings: system_settings::Model,
) -> Result<SystemSettingsItem, AppError> {
    Ok(SystemSettingsItem {
        id: settings.id,
        rer_analysis_units_exact_match_only_default: settings
            .rer_analysis_units_exact_match_only_default,
        rer_duty_test_enabled: settings.rer_duty_test_enabled,
        rer_duty_test_since_ms: settings.rer_duty_test_since_ms,
        rer_duty_test_limit: settings.rer_duty_test_limit,
        created_at: settings.created_at.and_utc().timestamp_millis(),
        updated_at: settings.updated_at.and_utc().timestamp_millis(),
        updated_by: settings.updated_by,
        deleted: settings.deleted,
    })
}

pub async fn get_active_system_settings(
    dbx: &DatabaseConnection,
) -> Result<Option<system_settings::Model>, AppError> {
    Ok(system_settings::Entity::find()
        .filter(system_settings::Column::Deleted.eq(false))
        .order_by_desc(system_settings::Column::UpdatedAt)
        .one(dbx)
        .await
        .c(h!())?)
}

pub async fn get_rer_analysis_units_exact_match_only_default(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.rer_analysis_units_exact_match_only_default)
        .unwrap_or(true))
}

fn now_utc() -> chrono::NaiveDateTime {
    Utc::now().naive_utc()
}

async fn deactivate_active_settings<C>(
    dbx: &C,
    updated_by: &str,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let active_rows = system_settings::Entity::find()
        .filter(system_settings::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;

    for row in active_rows {
        let mut row: system_settings::ActiveModel = row.into();
        row.deleted = Set(true);
        row.updated_by = Set(Some(updated_by.to_string()));
        row.updated_at = Set(now_utc());
        row.update(dbx).await.c(h!())?;
    }

    Ok(())
}

#[post("/api/system-settings/current")]
pub async fn current_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SystemSettingsCurrentRsp>, AppError> {
    let _login = user.id().c(h!())?;
    let settings = get_active_system_settings(&env.dbx).await.c(h!())?;
    Ok(Json(match settings {
        Some(settings) => SystemSettingsCurrentRsp {
            id: Some(settings.id),
            rer_analysis_units_exact_match_only_default: settings
                .rer_analysis_units_exact_match_only_default,
            rer_duty_test_enabled: settings.rer_duty_test_enabled,
            rer_duty_test_since_ms: settings.rer_duty_test_since_ms,
            rer_duty_test_limit: settings.rer_duty_test_limit,
        },
        None => SystemSettingsCurrentRsp {
            id: None,
            rer_analysis_units_exact_match_only_default: true,
            rer_duty_test_enabled: false,
            rer_duty_test_since_ms: 0,
            rer_duty_test_limit: 1,
        },
    }))
}

#[post("/api/admin/system-settings/list")]
pub async fn list_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SystemSettingsListRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let items = system_settings::Entity::find()
        .order_by_desc(system_settings::Column::Deleted)
        .order_by_desc(system_settings::Column::UpdatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(map_system_settings_item)
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;

    Ok(Json(SystemSettingsListRsp { items }))
}

#[post("/api/admin/system-settings/create")]
pub async fn create_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateSystemSettingsReq>,
) -> Result<Json<SystemSettingsItem>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    deactivate_active_settings(&txn, &login).await.c(h!())?;
    let created = system_settings::ActiveModel {
        id: sea_orm::ActiveValue::NotSet,
        rer_analysis_units_exact_match_only_default: Set(
            req.rer_analysis_units_exact_match_only_default
        ),
        rer_duty_test_enabled: Set(req.rer_duty_test_enabled),
        rer_duty_test_since_ms: Set(req.rer_duty_test_since_ms),
        rer_duty_test_limit: Set(req.rer_duty_test_limit),
        created_at: sea_orm::ActiveValue::NotSet,
        updated_at: sea_orm::ActiveValue::NotSet,
        updated_by: Set(Some(login)),
        deleted: Set(false),
    }
    .insert(&txn)
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;

    Ok(Json(map_system_settings_item(created)?))
}

#[post("/api/admin/system-settings/activate")]
pub async fn activate_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ActivateSystemSettingsReq>,
) -> Result<Json<SystemSettingsItem>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    deactivate_active_settings(&txn, &login).await.c(h!())?;

    let settings = system_settings::Entity::find_by_id(req.id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut settings: system_settings::ActiveModel = settings.into();
    settings.deleted = Set(false);
    settings.updated_by = Set(Some(login));
    settings.updated_at = Set(now_utc());
    let settings = settings.update(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;

    Ok(Json(map_system_settings_item(settings)?))
}
