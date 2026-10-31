use crate::config::USER_ROLE_SETTINGS_ROLES;
use crate::entities::role_message_settings;
use crate::sigint::direct_submit::types::DirectSubmitPayload;
use crate::types::*;
use actix_identity::Identity;
use actix_web::{get, post, web};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set,
};
use types::{
    MessageCreationSettings, RoleMessageSettings, RoleMessageSettingsKey,
    RoleMessageSettingsListRsp,
};

pub mod types;

#[post("/api/admin/role-message-settings/list")]
pub async fn list(
    user: Identity,
    env: web::Data<Env>,
) -> Result<web::Json<RoleMessageSettingsListRsp>, AppError> {
    super::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = role_message_settings::Entity::find()
        .order_by_asc(role_message_settings::Column::Role)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(to_settings)
        .collect();
    Ok(web::Json(RoleMessageSettingsListRsp {
        settings,
        roles: USER_ROLE_SETTINGS_ROLES
            .iter()
            .map(|role| role.to_string())
            .collect(),
    }))
}

fn to_settings(settings: role_message_settings::Model) -> RoleMessageSettings {
    RoleMessageSettings {
        role: settings.role,
        unit_required: settings.unit_required,
        device_required: settings.device_required,
        allow_unit_creation: settings.allow_unit_creation,
    }
}

fn to_active(
    settings: RoleMessageSettings,
) -> anyhow::Result<role_message_settings::ActiveModel> {
    if !USER_ROLE_SETTINGS_ROLES.contains(&settings.role.as_str()) {
        return Err(AppError::BL {
            msg: "Оберіть відому роль.".to_string(),
        })
        .c(h!());
    }
    Ok(role_message_settings::ActiveModel {
        role: Set(settings.role),
        unit_required: Set(settings.unit_required),
        device_required: Set(settings.device_required),
        allow_unit_creation: Set(settings.allow_unit_creation),
    })
}

#[post("/api/admin/role-message-settings/create")]
pub async fn create(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<RoleMessageSettings>,
) -> Result<web::Json<RoleMessageSettings>, AppError> {
    super::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = to_active(req.into_inner())
        .c(h!())?
        .insert(&env.dbx)
        .await
        .map_err(|error| {
            if matches!(
                error.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) {
                AppError::BL {
                    msg: "Ця роль уже має налаштування.".to_string(),
                }
            } else {
                error.into()
            }
        })
        .c(h!())?;
    Ok(web::Json(to_settings(settings)))
}

#[post("/api/admin/role-message-settings/update")]
pub async fn update(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<RoleMessageSettings>,
) -> Result<web::Json<RoleMessageSettings>, AppError> {
    super::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = to_active(req.into_inner())
        .c(h!())?
        .update(&env.dbx)
        .await
        .c(h!())?;
    Ok(web::Json(to_settings(settings)))
}

#[post("/api/admin/role-message-settings/delete")]
pub async fn delete(
    user: Identity,
    env: web::Data<Env>,
    req: web::Json<RoleMessageSettingsKey>,
) -> Result<web::Json<()>, AppError> {
    super::ensure_admin(&env.dbx, &user).await.c(h!())?;
    role_message_settings::Entity::delete_by_id(req.role.clone())
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(web::Json(()))
}

#[get("/api/1.1/submit-direct/settings")]
pub async fn current(
    user: Identity,
    env: web::Data<Env>,
) -> Result<web::Json<MessageCreationSettings>, AppError> {
    super::ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = super::login_id_from_identity(&user).c(h!())?;
    Ok(web::Json(resolve(&env.dbx, &login).await.c(h!())?))
}

pub(crate) async fn resolve(
    db: &DatabaseConnection,
    login: &Uuid,
) -> anyhow::Result<MessageCreationSettings> {
    let login = super::load_active_login(db, login).await.c(h!())?;
    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    let settings = role_message_settings::Entity::find()
        .filter(role_message_settings::Column::Role.is_in(roles.clone()))
        .all(db)
        .await
        .c(h!())?;
    let mut rules = MessageCreationSettings {
        unit_required: false,
        device_required: false,
        allow_unit_creation: true,
    };
    if !settings.is_empty() {
        rules.unit_required =
            settings.iter().all(|settings| settings.unit_required);
        rules.device_required =
            settings.iter().all(|settings| settings.device_required);
        rules.allow_unit_creation =
            settings.iter().any(|settings| settings.allow_unit_creation);
    }
    if rules.unit_required {
        rules.unit_required = super::role_matches(&roles, "Rer").c(h!())?
            || super::role_matches(&roles, "Cyber").c(h!())?;
    }
    if rules.device_required {
        rules.device_required =
            crate::devices::access::resolve_message_devices_access(
                crate::devices::access::require_message_devices(db, &login.id)
                    .await,
            )
            .c(h!())?;
    }
    Ok(rules)
}

pub(crate) async fn validate_creation(
    db: &DatabaseConnection,
    login: &Uuid,
    payload: &DirectSubmitPayload,
) -> anyhow::Result<()> {
    let settings = resolve(db, login).await.c(h!())?;
    let mut errors = BTreeMap::new();
    if settings.unit_required
        && payload.unit_id.is_none()
        && payload
            .unit
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        errors.insert("unit".to_string(), "Оберіть підрозділ.".to_string());
    }
    if settings.device_required && payload.device_name_id.flatten().is_none() {
        errors.insert(
            "deviceName".to_string(),
            "Вкажіть назву пристрою.".to_string(),
        );
    }
    if !errors.is_empty() {
        return Err(AppError::Form(errors)).c(h!());
    }
    if payload.create_unit && !settings.allow_unit_creation {
        return Err(unit_creation_forbidden()).c(h!());
    }
    Ok(())
}

pub(crate) async fn ensure_unit_creation(
    db: &DatabaseConnection,
    login: &Uuid,
) -> anyhow::Result<()> {
    if !resolve(db, login).await.c(h!())?.allow_unit_creation {
        return Err(unit_creation_forbidden()).c(h!());
    }
    Ok(())
}

pub(crate) async fn ensure_catalog_unit_creation(
    db: &DatabaseConnection,
    login: &Uuid,
) -> anyhow::Result<()> {
    let account = super::load_active_login(db, login).await.c(h!())?;
    let roles: Vec<String> = serde_json::from_value(account.roles).c(h!())?;
    if !super::role_matches(&roles, "UnitsEditor").c(h!())? {
        ensure_unit_creation(db, login).await.c(h!())?;
    }
    Ok(())
}

fn unit_creation_forbidden() -> AppError {
    AppError::Forbidden(
        "Налаштування ролей забороняють створення підрозділів.".to_string(),
    )
}

#[cfg(test)]
mod tests;
