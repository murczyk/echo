use self::types::*;
use crate::config::*;
use crate::entities::sea_orm_active_enums::DeactivationReasonEnum;
use crate::entities::*;
use crate::error::AppError;
use crate::messenger::group::get_identity_sigint_groups;
use crate::messenger::group::types::SignalGroupEntryF2;
use crate::session::{record_new_session, record_page_visit};
use crate::types::*;
use actix_identity::Identity;
use actix_session::SessionExt;
use actix_web::web::Json;
use actix_web::{get, post, HttpMessage, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use sea_orm::*;
use sea_query::Expr;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub mod cli_session;
pub mod display_name;
pub mod login_totp;
pub mod messenger_profile;
pub mod totp;
pub mod totp_challenge;
pub mod totp_crypto;
pub mod types;

#[cfg(test)]
mod cyber_roles_migration_tests;
#[cfg(test)]
mod session_tests;

pub fn login_id_from_identity(user: &Identity) -> Result<Uuid, AppError> {
    let identity = user
        .id()
        .map_err(|_| AppError::Unauthenticated)
        .context(h!())?;
    let login = Uuid::parse_str(&identity)
        .map_err(|_| AppError::Unauthenticated)
        .context(h!())?;
    crate::read_query::set_login(login);
    Ok(login)
}

pub(crate) async fn load_active_login(
    db: &impl ConnectionTrait,
    login_id: &Uuid,
) -> anyhow::Result<login::Model> {
    let (login, organism) = login::Entity::find_by_id(*login_id)
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .find_also_related(organism::Entity)
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
        .c(h!())?;
    if login.organism_id.is_some()
        && !organism.is_some_and(|organism| {
            organism.enabled && !organism.deleted_permanently
        })
    {
        return Err(AppError::Unauthenticated).c(h!());
    }
    Ok(login)
}

pub(crate) async fn start_user_session(
    env: &actix_web::web::Data<Env>,
    http_req: &HttpRequest,
    login_id: Uuid,
    db: &impl ConnectionTrait,
) -> Result<(), AppError> {
    update_last_active_at(db, &login_id).await.c(h!())?;
    initialize_user_session(env, http_req, login_id)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn initialize_user_session(
    env: &actix_web::web::Data<Env>,
    http_req: &HttpRequest,
    login_id: Uuid,
) -> anyhow::Result<()> {
    let session_id = Uuid::now_v7();
    crate::session::add_session(&mut env.redis.clone(), session_id, &login_id)
        .await
        .c(h!())?;
    crate::event_stream::create_redis_stream(
        &mut env.redis.clone(),
        session_id,
    )
    .await
    .c(h!())?;

    record_new_session(&login_id, session_id, env)
        .await
        .c(h!())?;

    http_req
        .get_session()
        .insert("id", session_id.to_string())
        .c(h!())?;
    Identity::login(&http_req.extensions(), login_id.to_string()).c(h!())?;

    Ok(())
}

pub async fn login_id_by_name<C>(
    dbx: &C,
    login_name: &str,
) -> Result<Uuid, AppError>
where
    C: ConnectionTrait,
{
    login::Entity::find()
        .select_only()
        .column(login::Column::Id)
        .filter(login::Column::Login.eq(login_name))
        .filter(login::Column::DeletedPermanently.eq(false))
        .into_tuple()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn system_login_id<C>(dbx: &C) -> Result<Uuid, AppError>
where
    C: ConnectionTrait,
{
    login_id_by_name(dbx, SYSTEM_LOGIN_NAME).await
}

pub async fn login_names_by_ids<C>(
    dbx: &C,
    login_ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(login::Entity::find()
        .select_only()
        .columns([login::Column::Id, login::Column::Login])
        .filter(login::Column::Id.is_in(login_ids))
        .into_tuple::<(Uuid, String)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

fn log_login_form_error(login: &str, errors: &BTreeMap<String, String>) {
    error!(
        target: "form_error_details",
        "Login attempt for \"{login}\" failed: {:?}",
        errors
    );
}

fn normalize_login_description(description: Option<String>) -> Option<String> {
    description
        .map(|description| description.trim().to_string())
        .filter(|description| !description.is_empty())
}

fn normalize_login_value(login: &str) -> String {
    login.trim().to_string()
}

fn normalize_optional_login_value(login: Option<String>) -> Option<String> {
    login
        .map(|login| normalize_login_value(&login))
        .filter(|login| !login.is_empty())
}

fn optional_login_values_equal(
    left: Option<&str>,
    right: Option<&str>,
) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        (None, None) => true,
        _ => false,
    }
}

fn validate_active_sign_in_methods(
    deleted: bool,
    password_auth_enabled: bool,
    has_password: bool,
    has_delta_login: bool,
) -> Result<(), AppError> {
    if deleted || (password_auth_enabled && has_password) || has_delta_login {
        return Ok(());
    }

    Err(AppError::Form(BTreeMap::from_iter([(
        "password_auth_enabled".to_string(),
        "Для активного користувача налаштуйте вхід за паролем або Delta"
            .to_string(),
    )])))
}

fn validate_password_authentication(
    password_auth_enabled: bool,
    has_password: bool,
) -> Result<(), AppError> {
    if !password_auth_enabled || has_password {
        return Ok(());
    }

    Err(AppError::Form(BTreeMap::from_iter([(
        "password".to_string(),
        "Для входу за паролем вкажіть пароль".to_string(),
    )])))
}

fn validate_supplied_password(password: Option<&str>) -> Result<(), AppError> {
    if password.is_some_and(|password| password.trim().is_empty()) {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "password".to_string(),
            "Пароль не може бути пустим або складатися лише з пробілів"
                .to_string(),
        )])));
    }

    Ok(())
}

fn login_skips_totp(login_obj: &login::Model) -> Result<bool, AppError> {
    let roles: Vec<String> =
        serde_json::from_value(login_obj.roles.clone()).c(h!())?;
    Ok(roles.iter().any(|role| {
        role == ROLE_API || role == AI_AGENT_ROLE_API || role == ROLE_NO2FA
    }))
}

fn has_update_login_description(req: &serde_json::Value) -> bool {
    req.as_object()
        .is_some_and(|req| req.contains_key("description"))
}

fn has_update_login_field(req: &serde_json::Value, field: &str) -> bool {
    req.as_object().is_some_and(|req| req.contains_key(field))
}

pub async fn has_role<T>(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &T,
    role: &str,
) -> Result<(), AppError>
where
    T: ToString + ?Sized,
{
    has_any_role(dbx, user_id, vec![role]).await
}

pub async fn ensure_basic_role(
    dbx: &sea_orm::DatabaseConnection,
    user: &Identity,
) -> Result<(), AppError> {
    has_role(dbx, &login_id_from_identity(user)?, "Basic").await
}

pub async fn ensure_base_role(
    dbx: &sea_orm::DatabaseConnection,
    user: &Identity,
) -> Result<(), AppError> {
    ensure_base_role_by_id(dbx, &login_id_from_identity(user).c(h!())?).await
}

pub async fn ensure_base_role_by_id<T>(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &T,
) -> Result<(), AppError>
where
    T: ToString + ?Sized,
{
    has_any_role(dbx, user_id, vec!["Rer", ROLE_CYBER_VIEWER_RESTRICTED]).await
}

pub async fn ensure_message_write(
    dbx: &DatabaseConnection,
    user: &Identity,
) -> Result<(), AppError> {
    has_any_role(
        dbx,
        &login_id_from_identity(user).c(h!())?,
        vec!["Rer", "Cyber"],
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn ensure_admin(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    has_role(dbx, &login_id_from_identity(user)?, "Admin").await
}

// WARNING: need to update Auth.elm too
pub async fn has_any_role<T>(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &T,
    roles_list: Vec<&str>,
) -> Result<(), AppError>
where
    T: ToString + ?Sized,
{
    let user_id = user_id.to_string();
    let login_id = match Uuid::parse_str(&user_id) {
        Ok(login_id) => login_id,
        Err(_) => login_id_by_name(dbx, &user_id).await.c(h!())?,
    };
    let login_obj = load_active_login(dbx, &login_id).await.c(h!())?;
    let roles: Vec<String> = serde_json::from_value(login_obj.roles).c(h!())?;
    let mut is_any_good = false;
    for role in roles_list.clone() {
        is_any_good |= role_matches(&roles, role)?;
    }
    if !is_any_good {
        return Err(AppError::Forbidden(format!(
            "user_id: {user_id}, required role {}, only has {}",
            roles_list.join(", "),
            roles.join(", ")
        )));
    }
    Ok(())
}

pub(crate) fn role_matches(
    roles: &[String],
    role: &str,
) -> Result<bool, AppError> {
    Ok(match role {
        "Admin" => roles.contains(&"Admin".to_string()),
        "Api" => roles.contains(&ROLE_API.to_string()),
        "ApiAgent" => roles.contains(&AI_AGENT_ROLE_API.to_string()),
        "Full" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Full".to_string())
        }
        "DeleteMsg" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Full".to_string())
                || roles.contains(&"DeleteMsg".to_string())
        }
        "Rer" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Full".to_string())
                || roles.contains(&"Rer".to_string())
        }
        "Bpla" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Full".to_string())
                || roles.contains(&"Bpla".to_string())
        }
        "Basic" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Full".to_string())
                || roles.contains(&"Bpla".to_string())
                || roles.contains(&"Rer".to_string())
                || roles.contains(&"Cyber".to_string())
                || roles.contains(&crate::config::ROLE_CYBER_VIEWER.to_string())
                || roles.contains(&ROLE_CYBER_VIEWER_RESTRICTED.to_string())
                || roles.contains(&"Basic".to_string())
        }
        "UnitsEditor" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"UnitsEditor".to_string())
        }
        "NetworkEditor" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"NetworkEditor".to_string())
        }
        "CallsignsEditor" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"CallsignsEditor".to_string())
        }
        "Cyber" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Cyber".to_string())
        }
        "CyberViewer" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"Cyber".to_string())
                || roles.contains(&crate::config::ROLE_CYBER_VIEWER.to_string())
        }
        ROLE_CYBER_VIEWER_RESTRICTED => {
            roles.contains(&ROLE_ADMIN.to_string())
                || roles.contains(&ROLE_CYBER.to_string())
                || roles.contains(&ROLE_CYBER_VIEWER.to_string())
                || roles.contains(&ROLE_CYBER_VIEWER_RESTRICTED.to_string())
        }
        "AdvancedReports" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"AdvancedReports".to_string())
        }
        "NoAutoLogout" => roles.contains(&"NoAutoLogout".to_string()),
        "No2FA" => roles.contains(&ROLE_NO2FA.to_string()),
        "MessengerIngest" => roles.contains(&ROLE_MESSENGER_INGEST.to_string()),
        ROLE_CYBER_MESSENGERS => {
            roles.contains(&ROLE_ADMIN.to_string())
                || roles.contains(&ROLE_CYBER_MESSENGERS.to_string())
        }
        role => {
            return Err(AppError::BL {
                msg: format!("impossible! unknown role {role}"),
            });
        }
    })
}

#[post("/api/user/keep-alive")]
async fn keep_alive(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<KeepAliveReq>,
) -> Result<Json<()>, AppError> {
    let req = req.into_inner();
    let user_id = login_id_from_identity(&user).c(h!())?;
    match update_last_active_at(&env.dbx, &user_id).await {
        Err(AppError::Unauthenticated) => {
            user.logout();
            return Err(AppError::Unauthenticated);
        }
        result => result.c(h!())?,
    }
    record_page_visit(&user_id, &req.page_id, &env, None)
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/login/update")]
pub async fn update_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<serde_json::Value>,
) -> Result<Json<Login>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    let req = req.into_inner();
    let update_description = has_update_login_description(&req);
    let update_delta_login = has_update_login_field(&req, "delta_login");
    let update_signal_profile =
        has_update_login_field(&req, "signal_profile_id");
    let req: UpdateLoginReq = serde_json::from_value(req).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    acquire_delta_assignment_serialization_lock(&txn)
        .await
        .c(h!())?;

    let login_id = Uuid::parse_str(&req.id).c(h!())?;
    crate::ai_agent::ensure_unmanaged_login(&txn, login_id).await?;
    let login_obj = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Id.eq(login_id))
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let login_name = normalize_login_value(&req.login);
    if login_name.is_empty() {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "login".to_string(),
            "Логін не може бути пустим".to_string(),
        )])));
    }
    if login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(&login_name))
        .filter(login::Column::Id.ne(login_id))
        .one(&txn)
        .await
        .c(h!())?
        .is_some()
    {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "login".to_string(),
            "Користувач з таким логіном вже існує".to_string(),
        )])));
    }

    let original_delta_login =
        load_delta_login_value(&txn, login_obj.delta_login_id)
            .await
            .context(h!())?;
    let requested_delta_login =
        normalize_optional_login_value(req.delta_login.clone());
    let effective_delta_login = if update_delta_login {
        requested_delta_login.clone()
    } else {
        original_delta_login.clone()
    };
    let delta_changed = !optional_login_values_equal(
        original_delta_login.as_deref(),
        effective_delta_login.as_deref(),
    );
    let delta_id = if delta_changed {
        assign_delta_login(
            &txn,
            &login_obj.login,
            effective_delta_login.as_deref(),
            login_obj.delta_login_id,
        )
        .await
        .c(h!())?
    } else {
        login_obj.delta_login_id
    };

    let password_auth_enabled = req
        .password_auth_enabled
        .unwrap_or(login_obj.password_auth_enabled);
    let password_auth_changed =
        password_auth_enabled != login_obj.password_auth_enabled;
    if password_auth_enabled {
        validate_supplied_password(req.password.as_deref()).context(h!())?;
    }
    let password_changed = req.password.is_some() && password_auth_enabled;
    let has_password = password_changed || login_obj.password.is_some();
    let deleted = req.deleted.unwrap_or(login_obj.deleted);
    let authentication_changed =
        delta_changed || password_auth_changed || password_changed;
    let changes_account_state =
        req.deleted.is_some_and(|value| value != login_obj.deleted);
    if password_auth_changed && password_auth_enabled {
        validate_password_authentication(password_auth_enabled, has_password)
            .context(h!())?;
    }
    if (authentication_changed && !deleted)
        || (changes_account_state && !deleted)
    {
        validate_active_sign_in_methods(
            deleted,
            password_auth_enabled,
            has_password,
            delta_id.is_some(),
        )
        .context(h!())?;
    }

    let mut login_obj: login::ActiveModel = login_obj.into();
    if update_signal_profile {
        login_obj.signal_profile_id = Set(req.signal_profile_id.clone());
    }
    login_obj.login = Set(login_name.clone());
    login_obj.delta_login_id = Set(delta_id);
    if let Some(deleted) = req.deleted {
        login_obj.deleted = Set(deleted);
        if !deleted && changes_account_state {
            login_obj.deactivation_reason = Set(None);
            login_obj.last_active_at = Set(Some(Utc::now().naive_utc()));
        } else if deleted && changes_account_state {
            login_obj.deactivation_reason =
                Set(Some(DeactivationReasonEnum::Admin));
        }
    }
    if password_changed {
        let salt_s = format!("{}{}", crate::config::IDENTITY_SALT, login_name);
        let salt = salt_s.as_bytes();
        let config = argon2::Config::original();
        let hash = argon2::hash_encoded(
            req.password.clone().c(h!())?.as_bytes(),
            salt,
            &config,
        )
        .c(h!())?;
        login_obj.password = Set(Some(hash.to_string()));
    }
    if req.roles.is_some() {
        login_obj.roles = Set(serde_json::to_value(req.roles.clone()).c(h!())?);
    }
    if req.sigint_zone_id.is_some() {
        login_obj.sigint_zone_id = Set(req.sigint_zone_id);
    }
    login_obj.organism_id = Set(Some(req.organism_id));
    if update_description {
        login_obj.description =
            Set(normalize_login_description(req.description.clone()));
    }
    if password_auth_changed {
        login_obj.password_auth_enabled = Set(password_auth_enabled);
    }
    let clear_totp = req.clear_totp == Some(true);
    let password_auth_disabled =
        password_auth_changed && !password_auth_enabled;
    let invalidate_totp_challenges =
        clear_totp || password_changed || password_auth_disabled;
    if invalidate_totp_challenges {
        if clear_totp {
            let admin_login_id = login_id_from_identity(&user)?;
            info!(
                "Admin {admin_login_id} cleared TOTP for login {login_id} ({login_name})"
            );
        }
        // SQL-side increment under the login row lock; avoid lost updates when
        // two invalidating admin updates overlap.
        login_totp::bump_epoch(&txn, login_id).await.c(h!())?;
        // Keep ActiveModel from writing a stale totp_epoch over the bump.
        login_obj.totp_epoch = NotSet;
    }
    if clear_totp {
        login_totp::clear_secret(&txn, login_id).await.c(h!())?;
    }
    let res = login_obj.update(&txn).await.c(h!())?;
    if let Some(delta_id) = delta_id {
        unlink_deleted_logins_from_shared_delta_login(&txn, delta_id)
            .await
            .c(h!())?;
    }
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    let res = login::Entity::find_by_id(res.id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Id.eq(res.organism_id))
        .one(&txn)
        .await
        .c(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };
    let delta_login = load_delta_login_value(&txn, res.delta_login_id)
        .await
        .context(h!())?;
    let result = Login {
        id: res.id.to_string(),
        organism_name,
        organism_enabled,
        delta_login,
        login: res.login,
        roles: serde_json::from_value(res.roles).c(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&txn)
            .await
            .c(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
        last_active_at: res
            .last_active_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        deactivation_reason: res
            .deactivation_reason
            .map(DeactivationReasonType::from),
        signal_profile_id: res.signal_profile_id,
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
        has_password: res.password.is_some(),
        totp_enabled: login_totp::is_enabled(&txn, res.id).await.c(h!())?,
    };
    txn.commit().await.c(h!())?;
    if invalidate_totp_challenges {
        totp_challenge::invalidate_login_challenges(
            &mut env.redis.clone(),
            login_id,
        )
        .await
        .c(h!())?;
    }
    Ok(Json(result))
}

#[post("/api/login/delete")]
pub async fn delete_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<String>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let login_id = Uuid::parse_str(req.as_str()).c(h!())?;
    crate::ai_agent::ensure_unmanaged_login(&txn, login_id).await?;
    let login_obj = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Id.eq(login_id))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.deleted = Set(true);
    login_obj.update(&txn).await.c(h!())?;
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/login/create")]
pub async fn create_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateLoginReq>,
) -> Result<Json<Login>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(
        create_login_1(&env.dbx, req.into_inner()).await.c(h!())?,
    ))
}

async fn create_login_1(
    dbx: &DatabaseConnection,
    req: CreateLoginReq,
) -> Result<Login, AppError> {
    let login_name = normalize_login_value(&req.login);
    if login_name.is_empty() {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "login".to_string(),
            "Логін не може бути пустим".to_string(),
        )])));
    }
    let delta_login = normalize_optional_login_value(req.delta_login.clone());
    let password_auth_enabled = req.password_auth_enabled.unwrap_or(true);
    let password = password_auth_enabled.then_some(req.password).flatten();
    validate_supplied_password(password.as_deref()).context(h!())?;
    validate_password_authentication(password_auth_enabled, password.is_some())
        .context(h!())?;
    validate_active_sign_in_methods(
        false,
        password_auth_enabled,
        password.is_some(),
        delta_login.is_some(),
    )
    .context(h!())?;
    let password = password
        .map(|password| {
            let salt =
                format!("{}{}", crate::config::IDENTITY_SALT, login_name);
            argon2::hash_encoded(
                password.as_bytes(),
                salt.as_bytes(),
                &argon2::Config::original(),
            )
            .c(h!())
        })
        .transpose()
        .context(h!())?;

    let txn = dbx.begin().await.c(h!())?;
    acquire_delta_assignment_serialization_lock(&txn)
        .await
        .c(h!())?;
    let res = insert_login(
        &txn,
        login::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_profile_id: Set(req.signal_profile_id.clone()),
            delta_login_id: Set(None),
            login: Set(login_name.clone()),
            password: Set(password),
            roles: Set(serde_json::to_value(req.roles.clone()).c(h!())?),
            created_at: NotSet,
            sigint_zone_id: Set(req.sigint_zone_id),
            organism_id: Set(Some(req.organism_id)),
            deleted: Set(false),
            last_active_at: Set(Some(Utc::now().naive_utc())),
            deactivation_reason: NotSet,
            deleted_permanently: NotSet,
            last_release_seen: NotSet,
            description: Set(normalize_login_description(
                req.description.clone(),
            )),
            password_auth_enabled: Set(password_auth_enabled),
            totp_epoch: Set(None),
            display_name: NotSet,
        },
    )
    .await
    .c(h!())?;

    let delta_login_id =
        assign_delta_login(&txn, &res.login, delta_login.as_deref(), None)
            .await
            .c(h!())?;
    let mut res = res.into_active_model();
    res.delta_login_id = Set(delta_login_id);
    let res = res.update(&txn).await.c(h!())?;
    if let Some(delta_login_id) = delta_login_id {
        unlink_deleted_logins_from_shared_delta_login(&txn, delta_login_id)
            .await
            .c(h!())?;
    }
    let delta_login = load_delta_login_value(&txn, res.delta_login_id)
        .await
        .context(h!())?;

    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::Id.eq(res.organism_id))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&txn)
        .await
        .c(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };

    let result = Login {
        id: res.id.to_string(),
        delta_login,
        organism_name,
        organism_enabled,
        login: res.login,
        roles: serde_json::from_value(res.roles).c(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&txn)
            .await
            .c(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
        last_active_at: res
            .last_active_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        deactivation_reason: res
            .deactivation_reason
            .map(DeactivationReasonType::from),
        signal_profile_id: res.signal_profile_id,
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
        has_password: res.password.is_some(),
        totp_enabled: false,
    };
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(result)
}

#[post("/api/login/create-delta")]
pub async fn create_delta_login(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateDeltaLoginReq>,
) -> Result<Json<Login>, AppError> {
    has_role(&env.dbx, &login_id_from_identity(&user)?, "Admin")
        .await
        .c(h!())?;
    let login = req.login.clone();
    let roles = req.roles.clone();
    let sigint_zone = req.sigint_zone_id;
    let organism_id = Some(req.organism_id);
    let description = req.description.clone();

    let result = register_delta_user(
        &env.dbx,
        login,
        roles,
        sigint_zone,
        organism_id,
        description,
        req.signal_profile_id.clone(),
    )
    .await
    .c(h!())?;
    Ok(Json(result))
}

#[post("/api/logins")]
pub async fn list_logins(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListLoginsReq>,
) -> Result<Json<ListLoginsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    #[derive(FromQueryResult)]
    struct LoginRes {
        id: Uuid,
        signal_profile_id: Option<String>,
        login: String,
        roles: serde_json::Value,
        sigint_zone_id: Option<i64>,
        organism_id: Option<i64>,
        created_at: sea_orm::prelude::DateTime,
        deleted: bool,
        last_active_at: Option<sea_orm::prelude::DateTime>,
        deactivation_reason: Option<DeactivationReasonEnum>,
        sigint_zone_name: Option<String>,
        organism_name: Option<String>,
        organism_enabled: Option<bool>,
        delta_login: Option<String>,
        description: Option<String>,
        password: Option<String>,
        password_auth_enabled: bool,
        totp_enabled: bool,
    }

    let users_iter = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::SigintZone.def())
        .join(JoinType::LeftJoin, login::Relation::Organism.def())
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .join(JoinType::LeftJoin, login::Relation::LoginTotp.def())
        .filter(
            Condition::any()
                .add(organism::Column::DeletedPermanently.eq(false))
                .add(login::Column::OrganismId.is_null()),
        )
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(crate::ai_agent::unmanaged_login_condition())
        .select_only()
        .columns([
            login::Column::Id,
            login::Column::SignalProfileId,
            login::Column::Login,
            login::Column::Roles,
            login::Column::SigintZoneId,
            login::Column::OrganismId,
            login::Column::CreatedAt,
            login::Column::Deleted,
            login::Column::LastActiveAt,
            login::Column::DeactivationReason,
            login::Column::Description,
            login::Column::Password,
            login::Column::PasswordAuthEnabled,
        ])
        .column_as(sigint_zone::Column::Name, "sigint_zone_name")
        .column_as(organism::Column::Name, "organism_name")
        .column_as(organism::Column::Enabled, "organism_enabled")
        .column_as(delta_login::Column::Login, "delta_login")
        .column_as(
            Expr::cust("login_totp.login_id is not null"),
            "totp_enabled",
        )
        .order_by(
            login::Column::CreatedAt,
            if let Some(sort_by) = &req.sort_by {
                match sort_by {
                    ListLoginsSortBy::LoginCreatedAtDesc => Order::Desc,
                    ListLoginsSortBy::LoginCreatedAtAsc => Order::Asc,
                }
            } else {
                Order::Desc
            },
        )
        .into_model::<LoginRes>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter();

    let mut users = vec![];
    for login in users_iter {
        let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
        let mut skip = false;
        if let Some(filter_roles) = &req.filter_by_roles {
            for role in filter_roles {
                if !roles.contains(role) {
                    skip = true;
                }
            }
        }
        if skip {
            continue;
        }
        let user = Login {
            id: login.id.to_string(),
            login: login.login,
            roles,
            created_at: login.created_at.and_utc().timestamp_millis(),
            deleted: login.deleted,
            sigint_zone_id: login.sigint_zone_id,
            sigint_zone_name: login.sigint_zone_name,
            organism_id: login.organism_id,
            organism_name: login.organism_name,
            organism_enabled: login.organism_enabled,
            delta_login: login.delta_login,
            last_active_at: login
                .last_active_at
                .map(|dt| dt.and_utc().timestamp_millis()),
            deactivation_reason: login
                .deactivation_reason
                .map(DeactivationReasonType::from),
            signal_profile_id: login.signal_profile_id,
            description: login.description,
            password_auth_enabled: login.password_auth_enabled,
            has_password: login.password.is_some(),
            totp_enabled: login.totp_enabled,
        };
        users.push(user);
    }
    Ok(Json(ListLoginsRsp { users }))
}

#[get("/api/user")]
async fn api_user(
    env: actix_web::web::Data<Env>,
    user: Option<Identity>,
    http_req: HttpRequest,
) -> Result<Json<User>, AppError> {
    let Some(user) = user else {
        return Err(AppError::Unauthenticated);
    };
    let user_id = login_id_from_identity(&user).c(h!())?;
    let login_obj = match login_for_user_response(&env.dbx, &http_req, user_id)
        .await
        .map_err(AppError::from)
    {
        Err(AppError::Unauthenticated) => {
            user.logout();
            return Err(AppError::Unauthenticated);
        }
        result => result.c(h!())?,
    };
    let delta_login = match login_obj.delta_login_id {
        None => None,
        Some(id) => delta_login::Entity::find()
            .filter(delta_login::Column::Id.eq(id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|x| x.login),
    };
    let goi = user_goi_state(&env.dbx, login_obj.organism_id, &user_id)
        .await
        .c(h!())?;
    let rer_report_eligible =
        crate::rer_report_admin::user_is_eligible(&env.dbx, &user_id)
            .await
            .c(h!())?;
    Ok(Json(User {
        id: login_obj.id.to_string(),
        delta_login,
        name: login_obj.login.clone(),
        display_name: login_obj.display_name.clone(),
        roles: serde_json::from_value(login_obj.roles).c(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id,
        organism_id: login_obj.organism_id,
        goi_configured_for_organism: goi.configured,
        goi_full_access_for_organism: goi.full_access,
        goi_host: goi.host,
        goi_integrations: goi.integrations,
        last_release_seen: login_obj.last_release_seen,
        rer_report_eligible,
    }))
}

async fn login_for_user_response(
    db: &impl ConnectionTrait,
    http_req: &HttpRequest,
    login_id: Uuid,
) -> anyhow::Result<login::Model> {
    if let Some(login) = crate::ai_agent::middleware::test_identity(http_req)
        .filter(|login| login.id == login_id)
    {
        return Ok(login);
    }
    load_active_login(db, &login_id).await.c(h!())
}

#[post("/api/user/release-seen")]
pub async fn mark_release_seen(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<types::MarkReleaseSeenReq>,
) -> Result<Json<()>, AppError> {
    let login_id = login_id_from_identity(&user)?;
    let login_obj = login::Entity::find()
        .filter(login::Column::Id.eq(login_id))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.last_release_seen = Set(Some(req.release_id.clone()));
    login_obj.update(&env.dbx).await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/user/user-info")]
async fn api_user_info(
    env: actix_web::web::Data<Env>,
    user: Option<Identity>,
    req: Json<UserInfoReq>,
) -> Result<Json<User>, AppError> {
    let Some(_user) = user else {
        return Err(AppError::Unauthenticated);
    };
    let username = req.login.clone();
    let Some(login_obj) = login::Entity::find()
        .filter(login::Column::Login.eq(username.clone()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        println!("user not found: {}", username.clone());
        return Err(AppError::NotFound);
    };
    let delta_login = match login_obj.delta_login_id {
        None => None,
        Some(id) => delta_login::Entity::find()
            .filter(delta_login::Column::Id.eq(id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|x| x.login),
    };
    let goi = user_goi_state(&env.dbx, login_obj.organism_id, &login_obj.id)
        .await
        .c(h!())?;
    let rer_report_eligible =
        crate::rer_report_admin::user_is_eligible(&env.dbx, &login_obj.id)
            .await
            .c(h!())?;
    Ok(Json(User {
        id: login_obj.id.to_string(),
        delta_login,
        name: username.clone(),
        display_name: login_obj.display_name.clone(),
        roles: serde_json::from_value(login_obj.roles).c(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id,
        organism_id: login_obj.organism_id,
        goi_configured_for_organism: goi.configured,
        goi_full_access_for_organism: goi.full_access,
        goi_host: goi.host,
        goi_integrations: goi.integrations,
        last_release_seen: login_obj.last_release_seen,
        rer_report_eligible,
    }))
}

struct UserGoiState {
    configured: bool,
    full_access: bool,
    host: Option<String>,
    integrations: Vec<crate::organism::goi::types::GoiUserIntegration>,
}

async fn user_goi_state(
    dbx: &DatabaseConnection,
    organism_id: Option<i64>,
    user_id: &Uuid,
) -> Result<UserGoiState, AppError> {
    let Some(organism_id) = organism_id else {
        return Ok(UserGoiState {
            configured: false,
            full_access: false,
            host: None,
            integrations: Vec::new(),
        });
    };

    let integrations =
        crate::organism::goi::integrations::load_user_goi_integrations(
            dbx,
            Some(organism_id),
            user_id,
        )
        .await
        .c(h!())?;

    Ok(UserGoiState {
        configured: !integrations.is_empty(),
        full_access: integrations.iter().any(|item| item.has_data_access),
        host: integrations
            .iter()
            .find_map(|item| item.goi_url.clone())
            .or_else(|| {
                integrations.iter().find_map(|item| item.swapp_url.clone())
            }),
        integrations,
    })
}

#[get("/api/user/logout")]
async fn user_logout(
    user: Option<Identity>,
    query: actix_web::web::Query<crate::utils::http::LoginRedirectQuery>,
) -> Result<HttpResponse, AppError> {
    if let Some(user) = user {
        user.logout();
    }
    // todo call delta logout here
    Ok(crate::utils::http::redirect_response(
        &crate::utils::http::login_redirect_url(
            query.redirect.as_deref(),
            None,
        ),
        "Success. Redirecting..",
    ))
}

/// does not initiate a new session. use this for API integrations only
#[post("/api/user/test-api-login")]
pub async fn user_test_api_login(
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<LoginReq>,
) -> Result<Json<()>, AppError> {
    let user_id = req.user.clone();
    let login_obj = match validate_login(&env.dbx, &user_id).await {
        Ok(obj) => obj,
        Err(e) => match e {
            AppError::Form(_) => {
                let errors = BTreeMap::from_iter([(
                    "login".to_string(),
                    "Не вдалося залогінитись".to_string(),
                )]);
                log_login_form_error(&user_id, &errors);
                return Err(AppError::Form(errors));
            }
            _ => {
                return Err(e);
            }
        },
    };
    if let Some(err) = login_obj.validation_error {
        return Err(err);
    }
    let login_obj = login_obj.login_model.c(h!())?;
    let password = login_obj
        .password
        .clone()
        .filter(|_| login_obj.password_auth_enabled)
        .ok_or_else(|| {
            let errors = BTreeMap::from_iter([(
                "login".to_string(),
                "Не вдалося залогінитись".to_string(),
            )]);
            log_login_form_error(&user_id, &errors);
            AppError::Form(errors)
        })?;
    let is_valid =
        argon2::verify_encoded(&password, req.password.as_bytes()).c(h!())?;
    if !is_valid {
        println!("> warning: invalid password attempt: {}", req.user);
        let errors = BTreeMap::from_iter([(
            "password".to_string(),
            "Не вдалося залогінитись".to_string(),
        )]);
        log_login_form_error(&user_id, &errors);
        return Err(AppError::Form(errors));
    };

    has_role(&env.dbx, &login_obj.id, "Api").await.c(h!())?;

    Identity::login(&http_req.extensions(), login_obj.id.to_string())
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/user/login")]
pub async fn user_login(
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<LoginReq>,
) -> Result<Json<LoginRsp>, AppError> {
    let user_id = req.user.clone();
    let login_obj = match validate_login(&env.dbx, &user_id).await {
        Ok(obj) => obj,
        Err(e) => {
            match e {
                AppError::Form(errors) => {
                    let login_error =
                        errors.get("login").map(String::as_str).unwrap_or("");
                    let errors = BTreeMap::from_iter([(
                        "login".to_string(),
                        format!(
                            "Невірний логін \"{}\". {}",
                            req.user, login_error
                        ),
                    )]);
                    log_login_form_error(&user_id, &errors);
                    return Err(AppError::Form(errors));
                }
                _ => {
                    return Err(e);
                }
            }
            // return Err(AppError::Form(BTreeMap::from_iter([(
            //     "login".to_string(),
            //     format!("Невірний логін \"{}\"", req.user),
            // )])));
        }
    };
    if let Some(err) = login_obj.validation_error {
        return Err(err);
    }
    let login_obj = login_obj.login_model.c(h!())?;
    let password = login_obj
        .password
        .clone()
        .filter(|_| login_obj.password_auth_enabled)
        .ok_or_else(|| {
            let errors = BTreeMap::from_iter([(
                "login".to_string(),
                format!(
                "Даний спосіб авторизації не підтримується для користувача \"{}\"",
                req.user
            ),
            )]);
            log_login_form_error(&user_id, &errors);
            AppError::Form(errors)
        })?;
    let is_valid =
        argon2::verify_encoded(&password, req.password.as_bytes()).c(h!())?;
    if !is_valid {
        println!("> warning: invalid password attempt: {}", req.user);
        let errors = BTreeMap::from_iter([(
            "password".to_string(),
            "Невірний пароль".to_string(),
        )]);
        log_login_form_error(&user_id, &errors);
        return Err(AppError::Form(errors));
    };

    let rsp = begin_totp_login_challenge(&env, &http_req, &login_obj)
        .await
        .context(h!())?;
    Ok(Json(rsp))
}

async fn begin_totp_login_challenge(
    env: &actix_web::web::Data<Env>,
    http_req: &HttpRequest,
    login_obj: &login::Model,
) -> Result<LoginRsp, AppError> {
    // Unattended API clients (echo-agent / Api*) skip interactive TOTP.
    if login_skips_totp(login_obj).context(h!())?
        || !crate::system_settings::two_factor_auth_enabled(&env.dbx)
            .await
            .c(h!())?
    {
        start_user_session(env, http_req, login_obj.id, &env.dbx)
            .await
            .context(h!())?;
        return Ok(LoginRsp::Authenticated);
    }

    let totp_key = totp_crypto::require_totp_strongbox_key(
        env.config.totp_strongbox_key.as_deref(),
    )
    .c(h!())?;
    let mut redis = env.redis.clone();
    if login_totp::is_enabled(&env.dbx, login_obj.id)
        .await
        .c(h!())?
    {
        match totp_challenge::create_verify_challenge(
            &mut redis,
            login_obj.id,
            login_totp::epoch_of(login_obj),
        )
        .await
        .c(h!())?
        {
            totp_challenge::CreateChallengeOutcome::LockedOut => {
                Err(totp_login_form_error(
                    "Забагато невдалих спроб. Спробуйте пізніше",
                ))
            }
            totp_challenge::CreateChallengeOutcome::Created(challenge_id) => {
                Ok(LoginRsp::Needs2fa {
                    challenge_id: challenge_id.to_string(),
                })
            }
        }
    } else {
        let enrollment = totp::generate_enrollment(&login_obj.login).c(h!())?;
        let pending_secret = totp_crypto::encrypt_secret(
            totp_key,
            login_obj.id,
            &enrollment.secret_base32,
        )
        .c(h!())?;
        match totp_challenge::create_enroll_challenge(
            &mut redis,
            login_obj.id,
            &pending_secret,
            login_totp::epoch_of(login_obj),
        )
        .await
        .c(h!())?
        {
            totp_challenge::CreateChallengeOutcome::LockedOut => {
                Err(totp_login_form_error(
                    "Забагато невдалих спроб. Спробуйте пізніше",
                ))
            }
            totp_challenge::CreateChallengeOutcome::Created(challenge_id) => {
                Ok(LoginRsp::Needs2faSetup {
                    challenge_id: challenge_id.to_string(),
                    qr_base64: enrollment.qr_base64,
                    manual_key: enrollment.manual_key,
                })
            }
        }
    }
}

fn totp_form_error(field: &str, msg: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(field.to_string(), msg.to_string())]))
}

/// Lockout / pre-OTP errors for `/api/user/login`
fn totp_login_form_error(msg: &str) -> AppError {
    totp_form_error("login", msg)
}

/// OTP-step errors for `/api/user/confirm-2fa`
fn totp_challenge_form_error(msg: &str) -> AppError {
    totp_form_error("token", msg)
}

#[post("/api/user/confirm-2fa")]
pub async fn user_confirm_2fa(
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    req: Json<Confirm2faReq>,
) -> Result<Json<()>, AppError> {
    let challenge_id =
        Uuid::parse_str(req.challenge_id.trim()).map_err(|_| {
            totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            )
        })?;
    let mut redis = env.redis.clone();
    let Some(challenge) =
        totp_challenge::get_challenge(&mut redis, challenge_id)
            .await
            .c(h!())?
    else {
        return Err(totp_challenge_form_error(
            "Невірний або прострочений код підтвердження",
        ));
    };

    let login_id = challenge.login_id();
    let login_obj = match validate_login_id(&env.dbx, &login_id).await {
        Ok(obj) => obj,
        Err(_) => {
            let _ = totp_challenge::delete_challenge(
                &mut redis,
                login_id,
                challenge_id,
            )
            .await;
            return Err(totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            ));
        }
    };
    if let Some(err) = login_obj.validation_error {
        let _ = totp_challenge::delete_challenge(
            &mut redis,
            login_id,
            challenge_id,
        )
        .await;
        return Err(err);
    }
    let login_obj = login_obj.login_model.c(h!())?;
    if !login_obj.password_auth_enabled
        || login_totp::epoch_of(&login_obj) != challenge.epoch()
    {
        let _ = totp_challenge::delete_challenge(
            &mut redis,
            login_id,
            challenge_id,
        )
        .await;
        return Err(totp_challenge_form_error(
            "Невірний або прострочений код підтвердження",
        ));
    }

    // Stale enroll: another challenge already configured TOTP.
    if matches!(&challenge, totp_challenge::TotpChallenge::Enroll { .. })
        && login_totp::is_enabled(&env.dbx, login_id).await.c(h!())?
    {
        let _ = totp_challenge::delete_challenge(
            &mut redis,
            login_id,
            challenge_id,
        )
        .await;
        return Err(totp_challenge_form_error(
            "Невірний або прострочений код підтвердження",
        ));
    }

    let totp_key = totp_crypto::require_totp_strongbox_key(
        env.config.totp_strongbox_key.as_deref(),
    )
    .map_err(|_| {
        totp_challenge_form_error("Невірний або прострочений код підтвердження")
    })?;
    let secret = match &challenge {
        totp_challenge::TotpChallenge::Enroll { pending_secret, .. } => {
            totp_crypto::decrypt_secret(totp_key, login_id, pending_secret)
                .map_err(|_| {
                    totp_challenge_form_error(
                        "Невірний або прострочений код підтвердження",
                    )
                })?
        }
        totp_challenge::TotpChallenge::Verify { .. } => {
            login_totp::find_secret(&env.dbx, login_id, totp_key)
                .await
                .map_err(|_| {
                    totp_challenge_form_error(
                        "Невірний або прострочений код підтвердження",
                    )
                })?
                .ok_or_else(|| {
                    totp_challenge_form_error(
                        "Невірний або прострочений код підтвердження",
                    )
                })?
        }
    };

    let matched_step =
        totp::verify_token(&secret, req.token.trim()).map_err(|_| {
            totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            )
        })?;
    let Some(matched_step) = matched_step else {
        match totp_challenge::record_failed_attempt(
            &mut redis,
            login_id,
            challenge_id,
        )
        .await
        .c(h!())?
        {
            totp_challenge::FailedAttemptResult::StillOpen => {
                return Err(totp_challenge_form_error("Невірний код"));
            }
            totp_challenge::FailedAttemptResult::LockedOut
            | totp_challenge::FailedAttemptResult::Missing => {
                return Err(totp_challenge_form_error(
                    "Невірний або прострочений код підтвердження",
                ));
            }
        }
    };

    // Claim + record the accepted step atomically: a failed claim must not
    // burn the code, and a step replay must leave the challenge for the next code.
    let claimed = match totp_challenge::claim_challenge_with_step(
        &mut redis,
        login_id,
        challenge_id,
        matched_step,
    )
    .await
    .c(h!())?
    {
        totp_challenge::ClaimChallengeOutcome::Claimed(claimed) => claimed,
        totp_challenge::ClaimChallengeOutcome::StepReplayed => {
            return Err(totp_challenge_form_error("Невірний код"));
        }
        totp_challenge::ClaimChallengeOutcome::Missing => {
            return Err(totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            ));
        }
    };

    // Hold the login row lock through enroll + session issuance so an admin
    // epoch bump / password-auth disable cannot slip in after the recheck.
    let txn = env.dbx.begin().await.c(h!())?;
    let login_guard = login_totp::lock_for_session_guard(&txn, login_id)
        .await
        .c(h!())?
        .ok_or_else(|| {
            totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            )
        })?;
    if !login_guard.password_auth_enabled
        || login_totp::epoch_of(&login_guard) != claimed.epoch()
    {
        txn.rollback().await.c(h!())?;
        return Err(totp_challenge_form_error(
            "Невірний або прострочений код підтвердження",
        ));
    }

    if let totp_challenge::TotpChallenge::Enroll {
        pending_secret,
        epoch,
        ..
    } = &claimed
    {
        // Only the first successful enroll wins; later challenges stay rejected.
        // Epoch must still match so admin clear cannot be undone by a claimed challenge.
        if !login_totp::insert_secret_if_absent(
            &txn,
            login_id,
            pending_secret,
            *epoch,
        )
        .await
        .c(h!())?
        {
            txn.rollback().await.c(h!())?;
            return Err(totp_challenge_form_error(
                "Невірний або прострочений код підтвердження",
            ));
        }
    }

    start_user_session(&env, &http_req, login_id, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/user/settings-save")]
pub async fn settings_save(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SettingsSaveReq>,
) -> Result<Json<()>, AppError> {
    let login_obj = login::Entity::find()
        .filter(login::Column::Id.eq(login_id_from_identity(&user)?))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.sigint_zone_id = Set(req.sigint_zone_id);
    login_obj.update(&env.dbx).await.c(h!())?;
    Ok(Json(()))
}

pub async fn register_user(
    dbx: &sea_orm::DatabaseConnection,
    user: &str,
    password: &str,
    roles: &[String],
    sigint_zone_id: i64,
    organism_id: Option<i64>,
) -> Result<(), AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let salt_s = format!("{}{}", crate::config::IDENTITY_SALT, user);
    let salt = salt_s.as_bytes();
    let config = argon2::Config::original();
    let hash_s =
        argon2::hash_encoded(password.as_bytes(), salt, &config).c(h!())?;
    login::ActiveModel {
        signal_profile_id: NotSet,
        id: Set(Uuid::now_v7()),
        login: Set(user.to_string()),
        password: Set(Some(hash_s.clone())),
        roles: Set(serde_json::to_value(roles.to_owned()).c(h!())?),
        created_at: NotSet,
        sigint_zone_id: Set(Some(sigint_zone_id)),
        organism_id: Set(organism_id),
        deleted: Set(false),
        delta_login_id: NotSet,
        last_active_at: Set(Some(Utc::now().naive_utc())),
        deactivation_reason: NotSet,
        deleted_permanently: NotSet,
        last_release_seen: NotSet,
        description: NotSet,
        password_auth_enabled: Set(true),
        totp_epoch: Set(None),
        display_name: NotSet,
    }
    .insert(&txn)
    .await
    .c(h!())?;
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

#[post("/api/user/sigint-groups")]
pub async fn user_sigint_groups(
    env: actix_web::web::Data<Env>,
    req: Json<SigintGroupsReq>,
    user: Identity,
) -> Result<Json<Vec<String>>, AppError> {
    // let res = get_identity_sigint_groups_since(&env.dbx, &user, req.since_date_inclusive_ms).await.c(h!())?;
    let login = login_id_from_identity(&user)?;
    let all_groups =
        get_identity_sigint_groups(&env.dbx, &login).await.c(h!())?;
    let Some(since_ts) = &req.since_date_inclusive_ms else {
        return Ok(Json(all_groups));
    };
    let ts = crate::utils::dt_from_millis(*since_ts).c(h!())?;
    {
        let since = crate::stats::round_up_to_5min(ts).c(h!())?;
        let till =
            crate::stats::round_up_to_5min(Utc::now().naive_utc()).c(h!())?;
        if crate::stats::can_read_stats_aggregated(&env.config, since, till) {
            let recent_keys =
                crate::stats::read_group_stats_aggregated_for_env(
                    &env, all_groups, since, till,
                )
                .await
                .c(h!())?
                .into_iter()
                .map(|group| group.master_key)
                .collect();
            return Ok(Json(recent_keys));
        }
    }
    let analytics_groups = all_groups.clone();
    let recent_keys =
        crate::rer_importer::analysis::with_analytics_read_fallback(
            env.get_ref(),
            "user sigint groups",
            true,
            |db| async move {
                read_active_sigint_groups_since(&db, analytics_groups, ts).await
            },
            |db| async move {
                read_active_sigint_groups_since(&db, all_groups, ts).await
            },
        )
        .await
        .c(h!())?;
    Ok(Json(recent_keys))
}

async fn read_active_sigint_groups_since(
    db: &DatabaseConnection,
    groups: Vec<String>,
    ts: chrono::NaiveDateTime,
) -> Result<Vec<String>, AppError> {
    #[derive(FromQueryResult)]
    struct ActiveSigintGroup {
        group_master_key: String,
    }

    let sql = r#"
        with recent_messages as materialized (
            select id
            from signal_message
            where "timestamp" > $1
        )
        select smg.group_master_key
        from recent_messages sm
        inner join signal_message_group smg
            on smg.signal_message_id = sm.id
        -- This exact lower bound lets PostgreSQL use the leading index column
        -- without assuming that message IDs and timestamps are correlated.
        where smg.signal_message_id >= (
            select min(id)
            from recent_messages
        )
          and smg.group_master_key = any($2::text[])
        group by smg.group_master_key
    "#;
    let active_groups =
        ActiveSigintGroup::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![ts.into(), groups.into()],
        ))
        .all(db)
        .await
        .c(h!())?;

    Ok(active_groups
        .into_iter()
        .map(|group| group.group_master_key)
        .collect())
}

#[post("/api/user/sigint-groups-detailed")]
pub async fn user_sigint_groups_detailed(
    env: actix_web::web::Data<Env>,
    req: Json<SigintGroupsDetailedReq>,
    user: Identity,
) -> Result<Json<Vec<SignalGroupEntryF2>>, AppError> {
    // let res = get_identity_sigint_groups_since(&env.dbx, &user, req.since_date_inclusive_ms).await.c(h!())?;
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", ROLE_CYBER_VIEWER_RESTRICTED, "Admin", "Api"],
    )
    .await?;
    let login = login_id_from_identity(&user)?;
    let mut keys =
        get_identity_sigint_groups(&env.dbx, &login).await.c(h!())?;
    if let Some(since_ts) = &req.since_date_inclusive_ms {
        let ts = crate::utils::dt_from_millis(*since_ts).c(h!())?;
        let recent_keys = signal_message_group::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message_group::Relation::SignalMessage.def(),
            )
            .select_only()
            .column(signal_message_group::Column::GroupMasterKey)
            .filter(signal_message::Column::Timestamp.gt(ts))
            .filter(signal_message_group::Column::GroupMasterKey.eq_any(keys))
            .group_by(signal_message_group::Column::GroupMasterKey)
            .into_tuple::<Option<String>>()
            .all(&env.dbx)
            .await
            .c(h!())?;
        keys = recent_keys.into_iter().flatten().collect();
    }
    let groups = crate::messenger::group::collect_groups_f2(
        keys,
        &env,
        crate::messenger::group::CollectGroupsOpts {
            skip_group_stats: req.skip_group_stats.unwrap_or(false),
        },
    )
    .await
    .c(h!())?;
    Ok(Json(groups))
}

// THIS FAILED BADLY. Soledar user was seeing Donetsk groups in Operatyvnyi

// pub async fn get_identity_sigint_groups_since<'a, 'async_trait, C>(
//     txn: &'a C,
//     user: &actix_identity::Identity,
//     since_date_inclusive_ms: Option<i64>,
// ) -> Result<Vec<String>, AppError>
// where
//     C: ConnectionTrait + 'async_trait,
// {
//     let login_obj = login::Entity::find()
//         .filter(login::Column::Login.eq(login_id_from_identity(&user)?))
//         .one(txn)
//         .await.c(h!())?
//         .ok_or(AppError::NotFound)?;
//     let zone_id: i64 = login_obj.sigint_zone_id.ok_or(AppError::BL {
//         msg: format!("Zone must be set for user: {}", login_id_from_identity(&user)?),
//     })?;

//     let since_ms = if let Some(since) = since_date_inclusive_ms {
//         Some(dt_from_millis(since)?)
//     } else {
//         None
//     };

//     Ok(signal_message::Entity::find()
//         .select_only()
//         .column(signal_message::Column::GroupMasterKey)
//         .join(
//             JoinType::InnerJoin,
//             signal_message::Relation::SignalGroup.def(),
//         )
//         .join(
//             JoinType::LeftJoin,
//             signal_group::Relation::OrganismGroup.def(),
//         )
//         .join(
//             JoinType::InnerJoin,
//             signal_group::Relation::Datasource.def(),
//         )
//         .join(
//             JoinType::InnerJoin,
//             datasource::Relation::SigintZoneDatasource.def(),
//         )
//         .apply_if(Some(login_obj.organism_id), |q, oid| {
//             q.filter(
//                 Condition::any()
//                     .add(Expr::cust(
//                         organism_group::Entity::find()
//                             .select_only()
//                             .expr(organism_group::Column::SignalGroupMasterKey.count())
//                             .filter(
//                                 organism_group::Column::OrganismId.eq(oid),
//                             )
//                             .build(txn.get_database_backend()).to_string(),
//                     ).eq(0))
//                     .add(organism_group::Column::OrganismId.eq(oid)),
//             )
//         })
//         .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
//         .apply_if(since_ms, |q, since| {
//             q.filter(signal_message::Column::Timestamp.gte(since))
//         })
//         .group_by(signal_message::Column::GroupMasterKey)
//         .into_tuple::<String>()
//         .all(txn)
//         .await.c(h!())?
//         .into_iter()
//         .collect())
// }

pub async fn oneoff_register_user(
    mode: Mode,
    ps: &crate::OneoffRegisterUserPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_register_user");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    register_user(
        &dbx,
        &ps.login,
        &ps.password,
        std::slice::from_ref(&ps.role),
        ps.sigint_zone,
        ps.organism_id,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn oneoff_register_delta_user(
    mode: Mode,
    ps: &crate::OneoffRegisterDeltaUserPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_register_delta_user");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    register_delta_user(
        &dbx,
        ps.login.clone(),
        vec![ps.role.clone()],
        Some(ps.sigint_zone),
        ps.organism_id,
        None,
        None,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn get_organism_logins_inner<'a, 'async_trait, C>(
    txn: &'a C,
    login_id: &Uuid,
) -> Result<(login::Model, Vec<Uuid>), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login = login::Entity::find_by_id(*login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    let mut res = vec![login.id];
    if let Some(organism_id) = login.organism_id {
        let logins = login::Entity::find()
            .filter(login::Column::OrganismId.eq(organism_id))
            .filter(login::Column::DeletedPermanently.eq(false))
            .all(txn)
            .await
            .c(h!())?;
        for login in logins {
            let login_id = login.id;
            if !res.contains(&login_id) {
                res.push(login_id);
            }
        }
    }
    Ok((login, res))
}

pub async fn get_organism_login_ids<'a, 'async_trait, C>(
    txn: &'a C,
    // login_s: &str,
    user: actix_identity::Identity,
) -> Result<Vec<Uuid>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_s = login_id_from_identity(&user)?;
    let (login, res) = get_organism_logins_inner(txn, &login_s).await?;
    if login.deleted {
        user.logout();
        return Err(AppError::Unauthenticated);
    }
    Ok(res)
}

pub async fn get_organism_login_ids_by_login<'a, 'async_trait, C>(
    txn: &'a C,
    login_s: &str,
) -> Result<Vec<Uuid>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_id = login_id_by_name(txn, login_s).await?;
    let (login, res) = get_organism_logins_inner(txn, &login_id).await?;
    if login.deleted {
        return Err(AppError::Unauthenticated);
    }
    Ok(res)
}

pub async fn get_organism_login_ids_by_id<'a, 'async_trait, C>(
    txn: &'a C,
    login_id: &Uuid,
) -> Result<Vec<Uuid>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let (login, res) = get_organism_logins_inner(txn, login_id).await?;
    if login.deleted {
        return Err(AppError::Unauthenticated);
    }
    Ok(res)
}

pub async fn validate_login<C>(
    dbx: &C,
    login: &str,
) -> Result<UserValidationResult, AppError>
where
    C: ConnectionTrait,
{
    let login_result = login::Entity::find()
        .filter(login::Column::Login.eq(login))
        .find_with_related(organism::Entity)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .all(dbx)
        .await
        .c(h!());
    let login_data = match login_result {
        Ok(data) => data,
        Err(e) => {
            error!("failed to load login {login}: {:?}", e);
            return Ok(UserValidationResult {
                login_model: None,
                is_valid: false,
                deactivation_reason: None,
                validation_error: Some(AppError::Unauthenticated),
            });
        }
    };
    let Some((login_obj, organisms)) = login_data.into_iter().next() else {
        println!("user not found: {login}");
        return Ok(UserValidationResult {
            login_model: None,
            is_valid: false,
            deactivation_reason: None,
            validation_error: Some(AppError::Unauthenticated),
        });
    };
    if let Some(organism) = organisms.into_iter().next() {
        if !organism.enabled {
            println!(
                "user {} not authorized, reason: organism {} (id {}) was disabled",
                login, organism.name, organism.id
            );
            return Ok(UserValidationResult {
                login_model: None,
                is_valid: true,
                deactivation_reason: None,
                validation_error: Some(AppError::Unauthenticated),
            });
        }
    }

    if login_obj.deleted {
        let (msg, reason) = match login_obj.deactivation_reason {
            Some(DeactivationReasonEnum::Inactive) => {
                let message = format!(
                    "Користувача \"{login}\" було заблоковано як не активного більше {INACTIVE_USERS_DEACTIVATE_AFTER_DAYS} днів. Зверніться до адміністратора"
                );
                (message, Some(DeactivationReasonEnum::Inactive))
            }
            Some(DeactivationReasonEnum::Admin) => {
                let message = format!(
                    "Користувач \"{login}\" заблокований адміністратором"
                );
                (message, Some(DeactivationReasonEnum::Admin))
            }
            _ => (format!("Користувача було видалено: {login}"), None),
        };
        warn!("{msg}");
        let errors =
            BTreeMap::from_iter([("login".to_string(), msg.to_string())]);
        log_login_form_error(login, &errors);
        let err = AppError::Form(errors);
        return Ok(UserValidationResult {
            login_model: None,
            is_valid: true,
            deactivation_reason: reason,
            validation_error: Some(err),
        });
    }

    Ok(UserValidationResult {
        login_model: Some(login_obj),
        is_valid: true,
        deactivation_reason: None,
        validation_error: None,
    })
}

pub async fn validate_login_id<C>(
    dbx: &C,
    login_id: &Uuid,
) -> Result<UserValidationResult, AppError>
where
    C: ConnectionTrait,
{
    let login_name = login::Entity::find_by_id(*login_id)
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    validate_login(dbx, &login_name).await
}

async fn register_delta_user(
    dbx: &DatabaseConnection,
    login: String,
    roles: Vec<String>,
    sigint_zone: Option<i64>,
    organism_id: Option<i64>,
    description: Option<String>,
    signal_profile_id: Option<String>,
) -> Result<Login, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    acquire_delta_assignment_serialization_lock(&txn)
        .await
        .c(h!())?;

    let login_obj = insert_login(
        &txn,
        login::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_profile_id: Set(signal_profile_id),
            login: Set(login),
            password: Set(None),
            roles: Set(serde_json::to_value(roles).c(h!())?),
            created_at: NotSet,
            sigint_zone_id: Set(sigint_zone),
            organism_id: Set(organism_id),
            deleted: Set(false),
            delta_login_id: Set(None),
            last_active_at: Set(Some(Utc::now().naive_utc())),
            deactivation_reason: NotSet,
            deleted_permanently: NotSet,
            last_release_seen: NotSet,
            description: Set(normalize_login_description(description)),
            password_auth_enabled: Set(false),
            totp_epoch: Set(None),
            display_name: NotSet,
        },
    )
    .await
    .c(h!())?;

    let delta_login_id = assign_delta_login(
        &txn,
        &login_obj.login,
        Some(&login_obj.login),
        None,
    )
    .await
    .c(h!())?;
    let mut login_obj = login_obj.into_active_model();
    login_obj.delta_login_id = Set(delta_login_id);
    let login_obj = login_obj.update(&txn).await.c(h!())?;
    let delta_login = login_obj.login.clone();

    let res = login::Entity::find()
        .filter(login::Column::Login.eq(login_obj.login.clone()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&txn)
        .await
        .c(h!())?
        .c(h!())?;

    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::Id.eq(res.organism_id))
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&txn)
        .await
        .c(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };

    let result = Login {
        id: res.id.to_string(),
        delta_login: Some(delta_login),
        organism_name,
        organism_enabled,
        login: res.login,
        roles: serde_json::from_value(res.roles).c(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&txn)
            .await
            .c(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
        last_active_at: res
            .last_active_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        deactivation_reason: res
            .deactivation_reason
            .map(DeactivationReasonType::from),
        signal_profile_id: res.signal_profile_id,
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
        has_password: res.password.is_some(),
        totp_enabled: login_totp::is_enabled(&txn, res.id).await.c(h!())?,
    };
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(result)
}

async fn assign_delta_login<C>(
    dbx: &C,
    login_name: &str,
    delta_login: Option<&str>,
    current_delta_login_id: Option<i32>,
) -> Result<Option<i32>, AppError>
where
    C: ConnectionTrait,
{
    acquire_delta_assignment_serialization_lock(dbx)
        .await
        .c(h!())?;

    if let Some(delta_login_id) = current_delta_login_id {
        unlink_deleted_logins_from_shared_delta_login(dbx, delta_login_id)
            .await
            .c(h!())?;
    }

    let Some(delta_login) = delta_login else {
        return Ok(None);
    };

    acquire_delta_assignment_lock(dbx, delta_login)
        .await
        .c(h!())?;

    if let Some(existing_delta_login) =
        find_delta_login_by_login(dbx, delta_login).await.c(h!())?
    {
        unlink_logins_from_delta_login(
            dbx,
            existing_delta_login.id,
            Some(login_name),
        )
        .await
        .c(h!())?;
        let delta_login_id = existing_delta_login.id;
        update_delta_login_value(dbx, existing_delta_login, delta_login)
            .await
            .c(h!())?;
        return Ok(Some(delta_login_id));
    }

    if let Some(delta_login_id) = current_delta_login_id {
        if delta_login_has_other_logins(dbx, delta_login_id, login_name)
            .await
            .c(h!())?
        {
            return Ok(Some(
                create_delta_login_row(dbx, delta_login).await.c(h!())?,
            ));
        }

        let existing_delta_login =
            delta_login::Entity::find_by_id(delta_login_id)
                .one(dbx)
                .await
                .context(format!("delta_id: {delta_login_id}"))
                .c(h!())?
                .c(h!())?;
        update_delta_login_value(dbx, existing_delta_login, delta_login)
            .await
            .c(h!())?;
        return Ok(Some(delta_login_id));
    }

    Ok(Some(
        create_delta_login_row(dbx, delta_login).await.c(h!())?,
    ))
}

async fn load_delta_login_value<C>(
    dbx: &C,
    delta_login_id: Option<i32>,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait,
{
    let Some(delta_login_id) = delta_login_id else {
        return Ok(None);
    };

    Ok(delta_login::Entity::find_by_id(delta_login_id)
        .one(dbx)
        .await
        .c(h!())?
        .map(|delta_login| delta_login.login))
}

async fn find_delta_login_by_login<C>(
    dbx: &C,
    delta_login: &str,
) -> Result<Option<delta_login::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(delta_login::Entity::find()
        .filter(Expr::cust_with_values(
            "lower(delta_login.login) = $1",
            vec![delta_login.to_lowercase()],
        ))
        .one(dbx)
        .await
        .c(h!())?)
}

async fn acquire_delta_assignment_lock<C>(
    dbx: &C,
    delta_login: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtext($1))",
        vec![delta_login.to_lowercase().into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn acquire_delta_assignment_serialization_lock<C>(
    dbx: &C,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtext($1))",
        vec!["users.delta-assignment".into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn create_delta_login_row<C>(
    dbx: &C,
    delta_login: &str,
) -> Result<i32, AppError>
where
    C: ConnectionTrait,
{
    Ok(delta_login::ActiveModel {
        id: NotSet,
        login: Set(delta_login.to_string()),
        created_at: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?
    .id)
}

async fn update_delta_login_value<C>(
    dbx: &C,
    delta_login: delta_login::Model,
    new_login: &str,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if delta_login.login == new_login {
        return Ok(());
    }

    let mut delta_login = delta_login.into_active_model();
    delta_login.login = Set(new_login.to_string());
    delta_login.update(dbx).await.c(h!())?;
    Ok(())
}

async fn delta_login_has_other_logins<C>(
    dbx: &C,
    delta_login_id: i32,
    login_name: &str,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    Ok(login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::DeltaLoginId.eq(delta_login_id))
        .filter(login::Column::Login.ne(login_name))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn unlink_logins_from_delta_login<C>(
    dbx: &C,
    delta_login_id: i32,
    keep_login: Option<&str>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let mut query = login::Entity::find()
        .filter(login::Column::DeltaLoginId.eq(delta_login_id));
    if let Some(keep_login) = keep_login {
        query = query.filter(login::Column::Login.ne(keep_login));
    }

    let logins = query
        .order_by_asc(login::Column::Id)
        .lock_exclusive()
        .all(dbx)
        .await
        .c(h!())?;
    validate_delta_login_owners_can_be_unlinked(&logins).context(h!())?;
    for login in logins {
        let mut login = login.into_active_model();
        login.delta_login_id = Set(None);
        login.update(dbx).await.c(h!())?;
    }

    Ok(())
}

fn validate_delta_login_owners_can_be_unlinked(
    logins: &[login::Model],
) -> Result<(), AppError> {
    if logins.iter().any(|login| {
        !login.deleted
            && !login.deleted_permanently
            && (!login.password_auth_enabled || login.password.is_none())
    }) {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "delta_login".to_string(),
            "Неможливо передати Delta-логін: один з користувачів втратить усі способи входу"
                .to_string(),
        )])));
    }
    Ok(())
}

async fn unlink_deleted_logins_from_shared_delta_login<C>(
    dbx: &C,
    delta_login_id: i32,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let logins = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::DeltaLoginId.eq(delta_login_id))
        .all(dbx)
        .await
        .c(h!())?;
    if logins.len() <= 1 || !logins.iter().any(|login| !login.deleted) {
        return Ok(());
    }

    for login in logins.into_iter().filter(|login| login.deleted) {
        let mut login = login.into_active_model();
        login.delta_login_id = Set(None);
        login.update(dbx).await.c(h!())?;
    }

    Ok(())
}

async fn insert_login<C>(
    dbx: &C,
    desired: login::ActiveModel,
) -> Result<login::Model, AppError>
where
    C: ConnectionTrait,
{
    let key = match desired.login.clone() {
        Set(k) => k,
        _ => {
            // Produce anyhow error with context to preserve stack trace
            return Err(
                anyhow!("login must be Set(...) for insert_login").c(h!())
            );
        }
    };

    if login::Entity::find()
        .filter(login::Column::Login.eq(key.clone()))
        .one(dbx)
        .await
        .c(h!())?
        .is_some()
    {
        return Err(AppError::BL {
            msg: format!("login {key} is already in use"),
        });
    }

    Ok(desired.insert(dbx).await.c(h!())?)
}

pub async fn inactive_users_worker(dbx: &DatabaseConnection) {
    debug!("Starting inactive_users_worker");

    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("inactive_users_worker");
        if let Err(e) = inactive_users_worker_1(dbx).await {
            error!("error in inactive_users_worker_1: {:?}", e);
        }
        tokio::time::sleep(std::time::Duration::from_secs(
            INACTIVE_USERS_DEACTIVATE_DURATION_SEC,
        ))
        .await;
    }
}

async fn inactive_users_worker_1(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let threshold = Utc::now().naive_utc()
        - Duration::days(INACTIVE_USERS_DEACTIVATE_AFTER_DAYS);
    let txn = dbx.begin().await.c(h!())?;

    // Find all active users whose last_active_at is older than threshold
    let inactive_users = login::Entity::find()
        .filter(login::Column::Deleted.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(
            login::Column::LastActiveAt
                .lte(threshold)
                .or(login::Column::LastActiveAt.is_null()),
        )
        // This checks that 'NoAutoLogout' is NOT present in the roles JSONB array
        .filter(Expr::cust_with_values(
            "NOT (roles @> $1::jsonb)",
            vec![r#"["NoAutoLogout"]"#.to_string()],
        ))
        .all(&txn)
        .await
        .c(h!())?;

    let deactivated_any = !inactive_users.is_empty();
    for user in inactive_users {
        let login_name = user.login.clone();
        let mut model = user.into_active_model();
        model.deleted = Set(true);
        model.deactivation_reason =
            Set(Some(sea_orm_active_enums::DeactivationReasonEnum::Inactive));
        model.update(&txn).await.c(h!())?;

        info!("> Deactivating user {login_name} due to inactivity");
    }

    if deactivated_any {
        crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
            .await
            .c(h!())?;
    }

    txn.commit().await.c(h!())?;
    debug!("inactive_users_worker completed");
    Ok(())
}

pub async fn update_last_active_at(
    db: &impl ConnectionTrait,
    user_id: &Uuid,
) -> Result<(), AppError> {
    let mut user = load_active_login(db, user_id)
        .await
        .c(h!())?
        .into_active_model();

    user.last_active_at = Set(Some(Utc::now().naive_utc()));
    user.update(db).await.c(h!())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, find_test_login, mk_login, mk_organism, mk_signal_group,
        mk_signal_message, mk_signal_message_group,
    };
    use actix_identity::IdentityMiddleware;
    use actix_session::{
        storage::RedisSessionStore, Session, SessionMiddleware,
    };
    use actix_web::{cookie::Key, test as actix_test, web, App};
    use redis::AsyncCommands;
    use sea_query::{Alias, Query};
    use serial_test::serial;

    static TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    async fn wait_for_delta_assignment_lock_waiters(
        dbx: &DatabaseConnection,
        lock_holder: &DatabaseTransaction,
        expected_waiters: i64,
    ) -> bool {
        let holder_pid = lock_holder
            .query_one(
                &Query::select()
                    .expr_as(Expr::cust("pg_backend_pid()"), Alias::new("pid"))
                    .to_owned(),
            )
            .await
            .unwrap()
            .unwrap()
            .try_get::<i32>("", "pid")
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let waiters = dbx
                    .query_one(
                        &Query::select()
                            .expr_as(
                                Expr::cust("count(*)"),
                                Alias::new("count"),
                            )
                            .from(Alias::new("pg_locks"))
                            .and_where(Expr::cust_with_values(
                                "locktype = 'advisory' and not granted
                                 and database = (select oid from pg_database where datname = current_database())
                                 and exists (
                                     select 1 from pg_locks held
                                     where held.pid = $1 and held.granted
                                       and held.locktype = pg_locks.locktype
                                       and held.database = pg_locks.database
                                       and held.classid = pg_locks.classid
                                       and held.objid = pg_locks.objid
                                       and held.objsubid = pg_locks.objsubid
                                       and held.pid = any(pg_blocking_pids(pg_locks.pid))
                                 )",
                                vec![holder_pid],
                            ))
                            .to_owned(),
                    )
                    .await
                    .unwrap()
                    .unwrap()
                    .try_get::<i64>("", "count")
                    .unwrap();
                if waiters >= expected_waiters {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok()
    }

    #[test]
    fn detects_update_login_description_presence() {
        assert!(!has_update_login_description(&serde_json::json!({})));
        assert!(has_update_login_description(&serde_json::json!({
            "description": null
        })));
        assert!(has_update_login_description(&serde_json::json!({
            "description": "note"
        })));
    }

    #[actix_web::test]
    async fn logout_redirects_unauthenticated_user_to_login() {
        let config = read_config(Mode::Test).unwrap();
        let session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .service(user_logout),
        )
        .await;
        // Regression: https://github.com/echoua/echo/issues/3665
        for (uri, expected) in [
            ("/api/user/logout", "/login"),
            (
                "/api/user/logout?redirect=%2Frer-analysis-neo%3Fm%3Dmessage%26source%3Dhttp%253A%252F%252Fexample.test%23card",
                "/login?redirect=%2Frer-analysis-neo%3Fm%3Dmessage%26source%3Dhttp%253A%252F%252Fexample.test%23card",
            ),
            ("/api/user/logout?redirect=https%3A%2F%2Fexternal.test", "/login"),
            ("/api/user/logout?redirect=%2F%2Fexternal.test", "/login"),
            ("/api/user/logout?redirect=%2F%5Cexternal.test", "/login"),
            ("/api/user/logout?redirect=%2Flogin", "/login"),
            ("/api/user/logout?redirect=%2Fignored%2F..%2Flogin", "/login"),
        ] {
            let request = actix_test::TestRequest::get().uri(uri).to_request();
            let response = actix_test::call_service(&app, request).await;
            assert_eq!(response.status(), actix_web::http::StatusCode::FOUND);
            assert_eq!(
                response.headers().get(actix_web::http::header::LOCATION)
                    .and_then(|value| value.to_str().ok()),
                Some(expected),
                "{uri}",
            );
        }
    }

    async fn create_grouped_message(
        dbx: &DatabaseConnection,
        group_master_key: &str,
        timestamp: chrono::NaiveDateTime,
    ) {
        let message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                created_at: Set(timestamp),
                timestamp: Set(Some(timestamp)),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group_master_key.to_string())),
                datasource_group_id: Set(None),
                created_at: Set(timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn active_sigint_groups_use_exact_message_timestamp() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let cutoff = Utc::now().naive_utc() - Duration::days(1);
        let group_keys = [
            "active-groups-old",
            "active-groups-recent-a",
            "active-groups-recent-b",
            "active-groups-denied",
        ];
        for group_master_key in group_keys {
            mk_signal_group(
                &env.dbx,
                signal_group::ActiveModel {
                    master_key: Set(group_master_key.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        create_grouped_message(
            &env.dbx,
            "active-groups-old",
            cutoff - Duration::hours(1),
        )
        .await;
        create_grouped_message(
            &env.dbx,
            "active-groups-recent-a",
            cutoff + Duration::hours(1),
        )
        .await;
        create_grouped_message(
            &env.dbx,
            "active-groups-old",
            cutoff - Duration::hours(2),
        )
        .await;
        create_grouped_message(
            &env.dbx,
            "active-groups-recent-b",
            cutoff + Duration::hours(2),
        )
        .await;
        create_grouped_message(
            &env.dbx,
            "active-groups-recent-a",
            cutoff + Duration::hours(3),
        )
        .await;
        create_grouped_message(
            &env.dbx,
            "active-groups-denied",
            cutoff + Duration::hours(4),
        )
        .await;

        let mut active_groups = read_active_sigint_groups_since(
            &env.dbx,
            vec![
                "active-groups-old".to_string(),
                "active-groups-recent-a".to_string(),
                "active-groups-recent-b".to_string(),
            ],
            cutoff,
        )
        .await
        .unwrap();
        active_groups.sort();

        assert_eq!(
            active_groups,
            vec![
                "active-groups-recent-a".to_string(),
                "active-groups-recent-b".to_string(),
            ]
        );
    }

    pub(super) async fn start_test_user_session(
        env: web::Data<Env>,
        req: HttpRequest,
    ) -> Result<HttpResponse, AppError> {
        let login = find_test_login(&env.dbx).await.c(h!())?;
        start_user_session(&env, &req, login.id, &env.dbx)
            .await
            .c(h!())?;
        Ok(HttpResponse::Ok().finish())
    }

    async fn get_test_user_session(
        env: web::Data<Env>,
        user: Identity,
        session: Session,
    ) -> Result<Json<(String, Uuid, String, bool)>, AppError> {
        let identity = user.id().c(h!())?;
        let session_id = crate::event_stream::get_session_id(&session)
            .c(h!())?
            .c(h!())?;
        let redis_session = crate::session::get_session_by_id(
            &mut env.redis.clone(),
            session_id,
        )
        .await
        .c(h!())?
        .c(h!())?;
        let stream_exists = env
            .redis
            .clone()
            .exists(crate::event_stream::session_stream_id(session_id))
            .await
            .c(h!())?;
        user.logout();
        Ok(Json((
            identity,
            session_id,
            redis_session.account_id,
            stream_exists,
        )))
    }

    #[actix_web::test]
    #[serial]
    async fn start_user_session_initializes_identity_and_event_stream() {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .app_data(web::Data::from(env.clone()))
                .route(
                    "/test/start-user-session",
                    web::post().to(start_test_user_session),
                )
                .route(
                    "/test/get-user-session",
                    web::get().to(get_test_user_session),
                ),
        )
        .await;

        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/test/start-user-session")
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let cookie = response.response().cookies().next().unwrap().into_owned();

        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/test/get-user-session")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let (identity, session_id, account_id, stream_exists): (
            String,
            Uuid,
            String,
            bool,
        ) = actix_test::read_body_json(response).await;

        assert_eq!(identity, login.id.to_string());
        assert_eq!(account_id, login.id.to_string());
        assert!(stream_exists);

        let mut redis = env.redis.clone();
        redis
            .del::<_, ()>(crate::event_stream::session_stream_id(session_id))
            .await
            .unwrap();
        redis
            .del::<_, ()>(crate::event_stream::get_sess_key(session_id))
            .await
            .unwrap();
        redis
            .srem::<_, _, ()>(REDIS_SESSIONS_KEY, session_id.to_string())
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn register_delta_user_reassigns_case_insensitive_delta_login() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();

        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("Kolya".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: sea_orm::ActiveValue::NotSet,
                id: NotSet,
                login: Set("Regular".to_string()),
                password: Set(Some(
                    argon2::hash_encoded(
                        b"regular-password",
                        b"regular-owner-salt",
                        &argon2::Config::original(),
                    )
                    .unwrap(),
                )),
                roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(Some(delta_login.id)),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: Default::default(),
                description: Default::default(),
                password_auth_enabled: Set(true),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();
        register_delta_user(
            &env.dbx,
            "kolya".to_string(),
            vec!["Rer".to_string()],
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let regular = login::Entity::find()
            .filter(login::Column::Login.eq("Regular"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(regular.delta_login_id, None);
        assert!(regular.password_auth_enabled);
        assert!(argon2::verify_encoded(
            regular.password.as_deref().unwrap(),
            b"regular-password"
        )
        .unwrap());

        let kolya = login::Entity::find()
            .filter(login::Column::Login.eq("kolya"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kolya.delta_login_id, Some(delta_login.id));

        let delta_login = delta_login::Entity::find_by_id(delta_login.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delta_login.login, "kolya");
    }

    #[tokio::test]
    #[serial]
    async fn register_delta_user_rejects_unsafe_delta_owners() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        for (delta_name, password_auth_enabled, include_safe_owner) in [
            ("DeltaOnly", false, false),
            ("NoPassword", true, false),
            ("MixedOwners", false, true),
        ] {
            let delta_login = delta_login::ActiveModel {
                id: NotSet,
                login: Set(delta_name.to_string()),
                created_at: NotSet,
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            let owner = insert_login(
                &env.dbx,
                login::ActiveModel {
                    signal_profile_id: NotSet,
                    id: NotSet,
                    login: Set(format!("{delta_name}-owner")),
                    password: Set(None),
                    roles: Set(serde_json::json!(["Rer"])),
                    created_at: NotSet,
                    sigint_zone_id: Set(None),
                    organism_id: Set(None),
                    deleted: Set(false),
                    delta_login_id: Set(Some(delta_login.id)),
                    last_active_at: Set(Some(Utc::now().naive_utc())),
                    deactivation_reason: Set(None),
                    deleted_permanently: Set(false),
                    last_release_seen: Default::default(),
                    description: Set(None),
                    password_auth_enabled: Set(password_auth_enabled),
                    totp_epoch: Set(None),
                    display_name: NotSet,
                },
            )
            .await
            .unwrap();
            if include_safe_owner {
                let mut safe_owner = owner.into_active_model();
                safe_owner.id = Set(Uuid::now_v7());
                safe_owner.login = Set(format!("{delta_name}-safe-owner"));
                safe_owner.password = Set(Some(
                    argon2::hash_encoded(
                        b"safe-owner-password",
                        b"safe-owner-salt",
                        &argon2::Config::original(),
                    )
                    .unwrap(),
                ));
                safe_owner.password_auth_enabled = Set(true);
                insert_login(&env.dbx, safe_owner).await.unwrap();
            }
            let owners_before = login::Entity::find()
                .filter(login::Column::DeltaLoginId.eq(delta_login.id))
                .order_by_asc(login::Column::Id)
                .all(&env.dbx)
                .await
                .unwrap();
            let requested_login = delta_name.to_lowercase();
            let error = register_delta_user(
                &env.dbx,
                requested_login.clone(),
                vec!["Rer".to_string()],
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap_err();
            assert!(
                matches!(error, AppError::Form(errors) if errors.contains_key("delta_login"))
            );
            assert!(login::Entity::find()
                .filter(login::Column::Login.eq(requested_login))
                .one(&env.dbx)
                .await
                .unwrap()
                .is_none());
            let owners_after = login::Entity::find()
                .filter(login::Column::DeltaLoginId.eq(delta_login.id))
                .order_by_asc(login::Column::Id)
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(owners_after, owners_before);
            let unchanged_delta =
                delta_login::Entity::find_by_id(delta_login.id)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(unchanged_delta.login, delta_name);
        }
    }

    #[tokio::test]
    #[serial]
    async fn register_delta_user_reclaims_inactive_and_permanently_deleted_owners(
    ) {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        for (delta_name, permanently_deleted) in
            [("InactiveDelta", false), ("RemovedDelta", true)]
        {
            let owner = create_login_1(
                &env.dbx,
                CreateLoginReq {
                    signal_profile_id: None,
                    login: format!("{delta_name}-owner"),
                    password: None,
                    roles: vec!["Rer".to_string()],
                    sigint_zone_id: None,
                    organism_id: organism.id,
                    description: None,
                    delta_login: Some(delta_name.to_string()),
                    password_auth_enabled: Some(false),
                },
            )
            .await
            .unwrap();
            let owner_id = Uuid::parse_str(&owner.id).unwrap();
            let owner = login::Entity::find_by_id(owner_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            let delta_id = owner.delta_login_id.unwrap();
            let mut owner = owner.into_active_model();
            owner.deleted = Set(true);
            owner.deleted_permanently = Set(permanently_deleted);
            owner.deactivation_reason =
                Set(Some(DeactivationReasonEnum::Admin));
            owner.update(&env.dbx).await.unwrap();
            let replacement = register_delta_user(
                &env.dbx,
                delta_name.to_lowercase(),
                vec!["Rer".to_string()],
                None,
                Some(organism.id),
                None,
                None,
            )
            .await
            .unwrap();
            let replacement = login::Entity::find_by_id(
                Uuid::parse_str(&replacement.id).unwrap(),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
            assert_eq!(replacement.delta_login_id, Some(delta_id));
            let owner = login::Entity::find_by_id(owner_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(owner.delta_login_id, None);
            assert!(owner.deleted);
            assert_eq!(owner.deleted_permanently, permanently_deleted);
        }
    }

    #[tokio::test]
    #[serial]
    async fn create_login_rejects_reassignment_from_active_owner_with_disabled_password_authentication(
    ) {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("CreateBlocked".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("create-blocked-owner".to_string()),
                password: Set(Some(
                    argon2::hash_encoded(
                        b"retained-password",
                        b"create-blocked-owner-salt",
                        &argon2::Config::original(),
                    )
                    .unwrap(),
                )),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(Some(delta_login.id)),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: Default::default(),
                description: Set(None),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();

        let error = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "rejected-create".to_string(),
                password: None,
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: Some("createblocked".to_string()),
                password_auth_enabled: Some(false),
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, AppError::Form(errors) if errors.contains_key("delta_login"))
        );
        assert!(login::Entity::find()
            .filter(login::Column::Login.eq("rejected-create"))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let owner = login::Entity::find()
            .filter(login::Column::Login.eq("create-blocked-owner"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.delta_login_id, Some(delta_login.id));
        let delta_login = delta_login::Entity::find_by_id(delta_login.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delta_login.login, "CreateBlocked");
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_delta_transfers_serialize_without_locking_out_active_accounts(
    ) {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "concurrent-owner".to_string(),
                password: Some("owner-password".to_string()),
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: Some("ConcurrentDelta".to_string()),
                password_auth_enabled: Some(true),
            },
        )
        .await
        .unwrap();

        let lock_txn = env.dbx.begin().await.unwrap();
        acquire_delta_assignment_serialization_lock(&lock_txn)
            .await
            .unwrap();
        let observer =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let create = |login: &'static str, dbx: DatabaseConnection| async move {
            create_login_1(
                &dbx,
                CreateLoginReq {
                    signal_profile_id: None,
                    login: login.to_string(),
                    password: None,
                    roles: vec!["Rer".to_string()],
                    sigint_zone_id: None,
                    organism_id: organism.id,
                    description: None,
                    delta_login: Some("concurrentdelta".to_string()),
                    password_auth_enabled: Some(false),
                },
            )
            .await
        };
        let first_dbx =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let second_dbx =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let mut first = tokio::spawn(create("concurrent-first", first_dbx));
        let mut second = tokio::spawn(create("concurrent-second", second_dbx));
        if !wait_for_delta_assignment_lock_waiters(&observer, &lock_txn, 2)
            .await
        {
            first.abort();
            second.abort();
            let _ = first.await;
            let _ = second.await;
            lock_txn.rollback().await.unwrap();
            panic!(
                "competing transfers must wait for the Delta assignment lock"
            );
        }
        lock_txn.commit().await.unwrap();
        let (first, second) = match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async { tokio::join!(&mut first, &mut second) },
        )
        .await
        {
            Ok(results) => results,
            Err(_) => {
                first.abort();
                second.abort();
                let _ = first.await;
                let _ = second.await;
                panic!("concurrent Delta transfers must not deadlock");
            }
        };
        let results = [first.unwrap(), second.unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results.iter().any(|result| {
            matches!(result, Err(AppError::Form(errors)) if errors.contains_key("delta_login"))
        }));
        let owner = login::Entity::find()
            .filter(login::Column::Login.eq("concurrent-owner"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(owner.password_auth_enabled && owner.password.is_some());
        assert_eq!(
            login::Entity::find()
                .filter(
                    login::Column::Login
                        .is_in(["concurrent-first", "concurrent-second"])
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            delta_login::Entity::find()
                .filter(Expr::cust_with_values(
                    "lower(delta_login.login) = $1",
                    vec!["concurrentdelta".to_string()],
                ))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_creation_and_update_login_conflict_without_deadlock() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let mut admin =
            find_test_login(&env.dbx).await.unwrap().into_active_model();
        admin.roles = Set(serde_json::json!(["Admin"]));
        admin.update(&env.dbx).await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let target = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "concurrent-rename-target".to_string(),
                password: Some("target-password".to_string()),
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: None,
                password_auth_enabled: Some(true),
            },
        )
        .await
        .unwrap();
        let mut update_env = (*env).clone();
        update_env.dbx =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .app_data(web::Data::new(update_env))
                .route("/test/login", web::post().to(start_test_user_session))
                .service(update_login),
        )
        .await;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/test/login")
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let cookie = response.response().cookies().next().unwrap().into_owned();

        let lock_txn = env.dbx.begin().await.unwrap();
        acquire_delta_assignment_serialization_lock(&lock_txn)
            .await
            .unwrap();
        let observer =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let create_dbx =
            crate::new_pg_pool_from_config(&env.config).await.unwrap();
        let mut create = tokio::spawn(async move {
            create_login_1(
                &create_dbx,
                CreateLoginReq {
                    signal_profile_id: None,
                    login: "concurrent-conflict".to_string(),
                    password: Some("new-password".to_string()),
                    roles: vec!["Rer".to_string()],
                    sigint_zone_id: None,
                    organism_id: organism.id,
                    description: None,
                    delta_login: None,
                    password_auth_enabled: Some(true),
                },
            )
            .await
        });
        let mut update = Box::pin(actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie)
                .set_json(serde_json::json!({
                    "id": target.id,
                    "login": "concurrent-conflict",
                    "organism_id": organism.id,
                    "roles": ["Rer"],
                }))
                .to_request(),
        ));
        let mut waiters = Box::pin(wait_for_delta_assignment_lock_waiters(
            &observer, &lock_txn, 2,
        ));
        let lock_waited = tokio::select! {
            reached = &mut waiters => reached,
            response = &mut update => {
                create.abort();
                let _ = create.await;
                drop(waiters);
                lock_txn.rollback().await.unwrap();
                panic!("update completed before reaching the Delta assignment lock: {:?}", response.status());
            }
        };
        drop(waiters);
        if !lock_waited {
            create.abort();
            let _ = create.await;
            lock_txn.rollback().await.unwrap();
            panic!(
                "creation and update must wait for the Delta assignment lock"
            );
        }
        lock_txn.commit().await.unwrap();
        let (create, update) = match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async { tokio::join!(&mut create, &mut update) },
        )
        .await
        {
            Ok(results) => results,
            Err(_) => {
                create.abort();
                let _ = create.await;
                panic!("concurrent creation and update must not deadlock");
            }
        };
        let create = create.unwrap();
        let update_status = update.status();
        assert_eq!(
            usize::from(create.is_ok())
                + usize::from(update_status.is_success()),
            1
        );
        assert!(create.is_err() || update_status.is_client_error());
        if update_status.is_client_error() {
            let errors: serde_json::Value =
                actix_test::read_body_json(update).await;
            assert!(errors.to_string().contains("login"));
        }
        assert_eq!(
            login::Entity::find()
                .filter(login::Column::Login.eq("concurrent-conflict"))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        let target =
            login::Entity::find_by_id(Uuid::parse_str(&target.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(
            target.login == "concurrent-rename-target"
                || target.login == "concurrent-conflict"
        );
    }

    #[tokio::test]
    #[serial]
    async fn create_login_persists_each_supported_authentication_configuration()
    {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();

        let cases = [
            ("delta-only", None, Some("delta-only"), false),
            ("password-only", Some("secret"), None, true),
            ("local-login", Some("secret"), Some("delta-login"), true),
        ];
        for (login, password, delta_login, password_auth_enabled) in cases {
            let created = create_login_1(
                &env.dbx,
                CreateLoginReq {
                    signal_profile_id: None,
                    login: format!("{login}-account"),
                    password: password.map(str::to_string),
                    roles: vec!["Rer".to_string()],
                    sigint_zone_id: None,
                    organism_id: organism.id,
                    description: None,
                    delta_login: delta_login.map(str::to_string),
                    password_auth_enabled: Some(password_auth_enabled),
                },
            )
            .await
            .unwrap();

            assert_eq!(created.password_auth_enabled, password_auth_enabled);
            assert_eq!(created.has_password, password.is_some());
            assert_eq!(created.delta_login.as_deref(), delta_login);
            assert!(!created.deleted);
        }

        let disabled_password = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "disabled-password-account".to_string(),
                password: Some("must-not-be-stored".to_string()),
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: Some("disabled-password-delta".to_string()),
                password_auth_enabled: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(!disabled_password.has_password);

        let spaced_password = "  exact password  ";
        let spaced_login = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "spaced-password-account".to_string(),
                password: Some(spaced_password.to_string()),
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: None,
                password_auth_enabled: Some(true),
            },
        )
        .await
        .unwrap();
        let stored = login::Entity::find_by_id(
            Uuid::parse_str(&spaced_login.id).unwrap(),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(argon2::verify_encoded(
            stored.password.as_deref().unwrap(),
            spaced_password.as_bytes()
        )
        .unwrap());
    }

    #[tokio::test]
    #[serial]
    async fn delta_assignment_side_effects_roll_back_with_failed_creation() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let shared_delta = delta_login::ActiveModel {
            id: NotSet,
            login: Set("Alpha".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: Set(Uuid::now_v7()),
                login: Set("existing-owner".to_string()),
                password: Set(Some(
                    argon2::hash_encoded(
                        b"existing-owner-password",
                        b"existing-owner-salt",
                        &argon2::Config::original(),
                    )
                    .unwrap(),
                )),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(Some(shared_delta.id)),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: Default::default(),
                description: Default::default(),
                password_auth_enabled: Set(true),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();

        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        env.dbx
            .execute_unprepared(
                "CREATE FUNCTION fail_admin_user_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.login = 'rolled-back-account' THEN RAISE EXCEPTION 'injected login update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_admin_user_creation BEFORE UPDATE ON login FOR EACH ROW EXECUTE FUNCTION fail_admin_user_creation();",
            )
            .await
            .unwrap();

        let result = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "rolled-back-account".to_string(),
                password: None,
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: Some("ALPHA".to_string()),
                password_auth_enabled: Some(false),
            },
        )
        .await;
        let cleanup_trigger = || async {
            env.dbx
                .execute_unprepared(
                    "DROP TRIGGER IF EXISTS fail_admin_user_creation ON login; DROP FUNCTION IF EXISTS fail_admin_user_creation();",
                )
                .await
        };
        let cleanup_result = cleanup_trigger().await;
        assert!(cleanup_result.is_ok());
        let error = result.unwrap_err();
        assert!(format!("{error:?}").contains("injected login update failure"));

        let owner = login::Entity::find()
            .filter(login::Column::Login.eq("existing-owner"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.delta_login_id, Some(shared_delta.id));
        assert!(owner.password_auth_enabled);
        assert!(argon2::verify_encoded(
            owner.password.as_deref().unwrap(),
            b"existing-owner-password"
        )
        .unwrap());
        let restored_delta = delta_login::Entity::find_by_id(shared_delta.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored_delta.login, "Alpha");
        assert!(login::Entity::find()
            .filter(login::Column::Login.eq("rolled-back-account"))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[actix_web::test]
    #[serial]
    async fn update_login_preserves_authentication_and_activation_boundaries() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let mut admin =
            find_test_login(&env.dbx).await.unwrap().into_active_model();
        admin.roles = Set(serde_json::json!(["Admin"]));
        admin.update(&env.dbx).await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let target = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "update-target".to_string(),
                password: Some("existing password".to_string()),
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: Some("before".to_string()),
                delta_login: Some("original-delta".to_string()),
                password_auth_enabled: Some(true),
            },
        )
        .await
        .unwrap();
        let session_store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(session_store, Key::generate()))
                .app_data(web::Data::from(env.clone()))
                .route("/test/login", web::post().to(start_test_user_session))
                .service(update_login),
        )
        .await;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/test/login")
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let cookie = response.response().cookies().next().unwrap().into_owned();
        let base = serde_json::json!({
            "id": target.id,
            "login": target.login,
            "organism_id": organism.id,
            "roles": ["Rer"],
        });

        let mut omit_delta = base.clone();
        omit_delta["description"] = serde_json::json!("omitted delta");
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(omit_delta)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let response: Login = actix_test::read_body_json(response).await;
        assert_eq!(response.delta_login.as_deref(), Some("original-delta"));

        let mut clear_delta = base.clone();
        clear_delta["delta_login"] = serde_json::Value::Null;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(clear_delta)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let response: Login = actix_test::read_body_json(response).await;
        assert_eq!(response.delta_login, None);

        let mut whitespace_password = base.clone();
        whitespace_password["password"] = serde_json::json!("   ");
        whitespace_password["description"] =
            serde_json::json!("must not persist");
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(whitespace_password)
                .to_request(),
        )
        .await;
        assert!(response.status().is_client_error());
        let persisted =
            login::Entity::find_by_id(Uuid::parse_str(&target.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(persisted.description.as_deref(), Some("omitted delta"));
        assert!(argon2::verify_encoded(
            persisted.password.as_deref().unwrap(),
            b"existing password"
        )
        .unwrap());

        let mut deactivate = base.clone();
        deactivate["deleted"] = serde_json::json!(true);
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(deactivate)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let deactivated: Login = actix_test::read_body_json(response).await;
        assert!(deactivated.deleted);
        assert_eq!(
            deactivated.deactivation_reason,
            Some(DeactivationReasonType::Admin)
        );

        let mut reactivate = base.clone();
        reactivate["deleted"] = serde_json::json!(false);
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(reactivate)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let reactivated: Login = actix_test::read_body_json(response).await;
        assert!(!reactivated.deleted);
        assert_eq!(reactivated.deactivation_reason, None);
        assert!(reactivated.last_active_at.is_some());

        let spaced_password = "  replacement password  ";
        let mut replace_password = base.clone();
        replace_password["password"] = serde_json::json!(spaced_password);
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(replace_password)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let persisted =
            login::Entity::find_by_id(Uuid::parse_str(&target.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(argon2::verify_encoded(
            persisted.password.as_deref().unwrap(),
            spaced_password.as_bytes()
        )
        .unwrap());
        assert!(!argon2::verify_encoded(
            persisted.password.as_deref().unwrap(),
            spaced_password.trim().as_bytes()
        )
        .unwrap());

        let mut disable_password = base.clone();
        disable_password["password_auth_enabled"] = serde_json::json!(false);
        disable_password["delta_login"] =
            serde_json::json!("enabled-password-delta");
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(disable_password)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let mut enable_password = base.clone();
        enable_password["password_auth_enabled"] = serde_json::json!(true);
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(enable_password)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let reenabled: Login = actix_test::read_body_json(response).await;
        assert!(reenabled.password_auth_enabled && reenabled.has_password);

        let unsafe_owner = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "unsafe-update-owner".to_string(),
                password: None,
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: None,
                delta_login: Some("blocked-update-delta".to_string()),
                password_auth_enabled: Some(false),
            },
        )
        .await
        .unwrap();
        let target_before =
            login::Entity::find_by_id(Uuid::parse_str(&target.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let mut blocked_transfer = base.clone();
        blocked_transfer["login"] = serde_json::json!("target-must-not-change");
        blocked_transfer["password"] = serde_json::json!("must not persist");
        blocked_transfer["deleted"] = serde_json::json!(true);
        blocked_transfer["description"] = serde_json::json!("must not persist");
        blocked_transfer["delta_login"] =
            serde_json::json!("blocked-update-delta");
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(blocked_transfer)
                .to_request(),
        )
        .await;
        assert!(response.status().is_client_error());
        let errors: serde_json::Value =
            actix_test::read_body_json(response).await;
        assert!(errors.to_string().contains("delta_login"));
        let target_after = login::Entity::find_by_id(target_before.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target_after.login, target_before.login);
        assert_eq!(target_after.password, target_before.password);
        assert_eq!(target_after.deleted, target_before.deleted);
        assert_eq!(target_after.description, target_before.description);
        assert_eq!(target_after.delta_login_id, target_before.delta_login_id);
        let unsafe_owner = login::Entity::find_by_id(
            Uuid::parse_str(&unsafe_owner.id).unwrap(),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(unsafe_owner.delta_login_id.is_some());

        let delta_only = create_login_1(
            &env.dbx,
            CreateLoginReq {
                signal_profile_id: None,
                login: "delta-only-update".to_string(),
                password: None,
                roles: vec!["Rer".to_string()],
                sigint_zone_id: None,
                organism_id: organism.id,
                description: Some("before".to_string()),
                delta_login: Some("delta-only-update".to_string()),
                password_auth_enabled: Some(false),
            },
        )
        .await
        .unwrap();
        let invalid_enable = serde_json::json!({
            "id": delta_only.id,
            "login": delta_only.login,
            "organism_id": organism.id,
            "password_auth_enabled": true,
            "description": "must not persist",
        });
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(invalid_enable)
                .to_request(),
        )
        .await;
        assert!(response.status().is_client_error());
        let delta_only_persisted =
            login::Entity::find_by_id(Uuid::parse_str(&delta_only.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(!delta_only_persisted.password_auth_enabled);
        assert_eq!(delta_only_persisted.description.as_deref(), Some("before"));

        let inactive_at = Utc::now().naive_utc() - Duration::days(3);
        let mut inactive =
            login::Entity::find_by_id(Uuid::parse_str(&target.id).unwrap())
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
        inactive.deleted = Set(true);
        inactive.deactivation_reason =
            Set(Some(DeactivationReasonEnum::Inactive));
        inactive.last_active_at = Set(Some(inactive_at));
        inactive.update(&env.dbx).await.unwrap();
        let mut unrelated_edit = base.clone();
        unrelated_edit["description"] = serde_json::json!("inactive note");
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(unrelated_edit)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let inactive: Login = actix_test::read_body_json(response).await;
        assert!(inactive.deleted);
        assert_eq!(
            inactive.deactivation_reason,
            Some(DeactivationReasonType::Inactive)
        );
        assert_eq!(
            inactive.last_active_at,
            Some(inactive_at.and_utc().timestamp_millis())
        );

        let legacy = insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("legacy-authentication".to_string()),
                password: Set(None),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(Some(organism.id)),
                deleted: Set(false),
                delta_login_id: Set(None),
                last_active_at: Set(None),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: NotSet,
                description: Set(Some("before".to_string())),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();
        let legacy_update = serde_json::json!({
            "id": legacy.id,
            "login": legacy.login,
            "organism_id": organism.id,
            "password_auth_enabled": false,
            "delta_login": null,
            "description": "ordinary legacy edit",
        });
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(legacy_update)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());

        let unusable = insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("unusable-reactivation".to_string()),
                password: Set(None),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(Some(organism.id)),
                deleted: Set(true),
                delta_login_id: Set(None),
                last_active_at: Set(None),
                deactivation_reason: Set(Some(DeactivationReasonEnum::Admin)),
                deleted_permanently: Set(false),
                last_release_seen: NotSet,
                description: Set(Some("before".to_string())),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();
        let invalid_reactivation = serde_json::json!({
            "id": unusable.id,
            "login": unusable.login,
            "organism_id": organism.id,
            "deleted": false,
            "description": "must not persist",
        });
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie.clone())
                .set_json(invalid_reactivation)
                .to_request(),
        )
        .await;
        assert!(response.status().is_client_error());
        let unusable = login::Entity::find_by_id(unusable.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(unusable.deleted);
        assert_eq!(unusable.description.as_deref(), Some("before"));

        let shared_delta = delta_login::ActiveModel {
            id: NotSet,
            login: Set("shared-final-response".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let target_id = Uuid::parse_str(&target.id).unwrap();
        let mut shared_target = login::Entity::find_by_id(target_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        shared_target.deleted = Set(false);
        shared_target.deactivation_reason = Set(None);
        shared_target.delta_login_id = Set(Some(shared_delta.id));
        shared_target.update(&env.dbx).await.unwrap();
        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("shared-delta-owner".to_string()),
                password: Set(None),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(Some(organism.id)),
                deleted: Set(false),
                delta_login_id: Set(Some(shared_delta.id)),
                last_active_at: Set(None),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: NotSet,
                description: Set(None),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();
        let mut shared_cleanup = base;
        shared_cleanup["deleted"] = serde_json::json!(true);
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/login/update")
                .cookie(cookie)
                .set_json(shared_cleanup)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let cleaned: Login = actix_test::read_body_json(response).await;
        assert!(cleaned.deleted);
        assert_eq!(cleaned.delta_login, None);
    }

    #[tokio::test]
    #[serial]
    async fn assign_delta_login_creates_new_row_when_current_row_is_shared() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();

        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("Alpha".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for login_name in ["OldOwner", "Edited"] {
            insert_login(
                &env.dbx,
                login::ActiveModel {
                    signal_profile_id: sea_orm::ActiveValue::NotSet,
                    id: NotSet,
                    login: Set(login_name.to_string()),
                    password: Set(None),
                    roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
                    created_at: NotSet,
                    sigint_zone_id: Set(None),
                    organism_id: Set(None),
                    deleted: Set(false),
                    delta_login_id: Set(Some(delta_login.id)),
                    last_active_at: Set(Some(Utc::now().naive_utc())),
                    deactivation_reason: Set(None),
                    deleted_permanently: Set(false),
                    last_release_seen: Default::default(),
                    description: Default::default(),
                    password_auth_enabled: Set(false),
                    totp_epoch: Set(None),
                    display_name: NotSet,
                },
            )
            .await
            .unwrap();
        }

        let new_delta_login_id = assign_delta_login(
            &env.dbx,
            "Edited",
            Some("Beta"),
            Some(delta_login.id),
        )
        .await
        .unwrap()
        .unwrap();

        assert_ne!(new_delta_login_id, delta_login.id);

        let old_owner = login::Entity::find()
            .filter(login::Column::Login.eq("OldOwner"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old_owner.delta_login_id, Some(delta_login.id));

        let new_delta_login =
            delta_login::Entity::find_by_id(new_delta_login_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(new_delta_login.login, "Beta");
    }

    #[tokio::test]
    #[serial]
    async fn assign_delta_login_unassigns_logins_from_existing_case_insensitive_row(
    ) {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();

        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("Alpha".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for (login_name, deleted) in
            [("OldOwner", false), ("DeletedOwner", true)]
        {
            insert_login(
                &env.dbx,
                login::ActiveModel {
                    signal_profile_id: sea_orm::ActiveValue::NotSet,
                    id: NotSet,
                    login: Set(login_name.to_string()),
                    password: Set(
                        (!deleted).then_some("stored-password".to_string())
                    ),
                    roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
                    created_at: NotSet,
                    sigint_zone_id: Set(None),
                    organism_id: Set(None),
                    deleted: Set(deleted),
                    delta_login_id: Set(Some(delta_login.id)),
                    last_active_at: Set(Some(Utc::now().naive_utc())),
                    deactivation_reason: Set(None),
                    deleted_permanently: Set(false),
                    last_release_seen: Default::default(),
                    description: Default::default(),
                    password_auth_enabled: Set(!deleted),
                    totp_epoch: Set(None),
                    display_name: NotSet,
                },
            )
            .await
            .unwrap();
        }

        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: sea_orm::ActiveValue::NotSet,
                id: NotSet,
                login: Set("NewOwner".to_string()),
                password: Set(None),
                roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(None),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: Default::default(),
                description: Default::default(),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();

        let delta_login_id =
            assign_delta_login(&env.dbx, "NewOwner", Some("ALPHA"), None)
                .await
                .unwrap()
                .unwrap();

        assert_eq!(delta_login_id, delta_login.id);

        for login_name in ["OldOwner", "DeletedOwner"] {
            let login = login::Entity::find()
                .filter(login::Column::Login.eq(login_name))
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(login.delta_login_id, None);
        }

        let delta_login = delta_login::Entity::find_by_id(delta_login.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delta_login.login, "ALPHA");
    }

    #[tokio::test]
    #[serial]
    async fn delta_reassignment_rejects_active_owner_without_usable_password_authentication(
    ) {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("Alpha".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("unsafe-owner".to_string()),
                password: Set(None),
                roles: Set(serde_json::json!(["Rer"])),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(Some(delta_login.id)),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: Set(None),
                deleted_permanently: Set(false),
                last_release_seen: Default::default(),
                description: Set(None),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap();

        let error =
            assign_delta_login(&env.dbx, "new-owner", Some("ALPHA"), None)
                .await
                .unwrap_err();
        assert!(
            matches!(error, AppError::Form(errors) if errors.contains_key("delta_login"))
        );

        let owner = login::Entity::find()
            .filter(login::Column::Login.eq("unsafe-owner"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.delta_login_id, Some(delta_login.id));
    }

    #[tokio::test]
    #[serial]
    async fn insert_login_does_not_resurrect_permanently_deleted_login() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();

        login::ActiveModel {
            signal_profile_id: sea_orm::ActiveValue::NotSet,
            id: NotSet,
            login: Set("Kolya".to_string()),
            password: Set(None),
            roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
            created_at: NotSet,
            sigint_zone_id: Set(None),
            organism_id: Set(None),
            deleted: Set(true),
            delta_login_id: Set(None),
            last_active_at: Set(Some(Utc::now().naive_utc())),
            deactivation_reason: Set(None),
            deleted_permanently: Set(true),
            last_release_seen: Default::default(),
            description: Default::default(),
            password_auth_enabled: Set(false),
            totp_epoch: Set(None),
            display_name: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let err = insert_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: sea_orm::ActiveValue::NotSet,
                id: NotSet,
                login: Set("Kolya".to_string()),
                password: Set(None),
                roles: Set(serde_json::to_value(vec!["Rer"]).unwrap()),
                created_at: NotSet,
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                deleted: Set(false),
                delta_login_id: Set(None),
                last_active_at: Set(Some(Utc::now().naive_utc())),
                deactivation_reason: NotSet,
                deleted_permanently: NotSet,
                last_release_seen: Default::default(),
                description: Default::default(),
                password_auth_enabled: Set(false),
                totp_epoch: Set(None),
                display_name: NotSet,
            },
        )
        .await
        .unwrap_err();

        match err {
            AppError::BL { msg } => {
                assert!(msg.contains("login Kolya is already in use"));
            }
            err => panic!("unexpected error: {err:?}"),
        }

        let login = login::Entity::find()
            .filter(login::Column::Login.eq("Kolya"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(login.deleted_permanently);
    }

    #[tokio::test]
    #[serial]
    async fn inactive_users_worker_refreshes_secret_group_memberships() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                signal_profile_id: NotSet,
                id: NotSet,
                login: Set("inactive-secret-group-user".to_string()),
                organism_id: Set(Some(organism.id)),
                last_active_at: Set(Some(
                    Utc::now().naive_utc()
                        - Duration::days(
                            INACTIVE_USERS_DEACTIVATE_AFTER_DAYS + 1,
                        ),
                )),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        crate::sigint::zone::bl::update_signal_group_access_and_admins(
            vec![],
            vec![organism.id],
            vec![],
            true,
            &group.master_key,
            &txn,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let derived_count = secret_group_user::Entity::find()
            .filter(
                secret_group_user::Column::MasterKey
                    .eq(group.master_key.clone()),
            )
            .filter(secret_group_user::Column::LoginId.eq(login.id))
            .filter(
                secret_group_user::Column::SecretGroupOrganismId.is_not_null(),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(derived_count, 1);

        inactive_users_worker_1(&env.dbx).await.unwrap();

        let login = login::Entity::find_by_id(login.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(login.deleted);
        let derived_count = secret_group_user::Entity::find()
            .filter(
                secret_group_user::Column::MasterKey
                    .eq(group.master_key.clone()),
            )
            .filter(secret_group_user::Column::LoginId.eq(login.id))
            .filter(
                secret_group_user::Column::SecretGroupOrganismId.is_not_null(),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(derived_count, 0);
    }
    fn roles(roles: &[&str]) -> Vec<String> {
        roles.iter().map(|role| (*role).to_owned()).collect()
    }

    #[test]
    fn issue_3568_cyber_inherits_basic_but_not_rer() {
        assert!(role_matches(&roles(&["Cyber"]), "Basic").unwrap());
        assert!(!role_matches(&roles(&["Cyber"]), "Rer").unwrap());
    }

    #[test]
    fn restricted_viewer_keeps_non_device_permissions() {
        for required in [
            "Admin",
            "Api",
            "ApiAgent",
            "Full",
            "DeleteMsg",
            "Rer",
            "Bpla",
            "Basic",
            "UnitsEditor",
            "NetworkEditor",
            "CallsignsEditor",
            "Cyber",
            "AdvancedReports",
            "NoAutoLogout",
            "No2FA",
            ROLE_CYBER_VIEWER_RESTRICTED,
        ] {
            assert_eq!(
                role_matches(&roles(&[ROLE_CYBER_VIEWER_RESTRICTED]), required)
                    .unwrap(),
                role_matches(&roles(&[ROLE_CYBER_VIEWER]), required).unwrap(),
                "{required}",
            );
        }
        assert!(!role_matches(
            &roles(&[ROLE_CYBER_VIEWER_RESTRICTED]),
            ROLE_CYBER_VIEWER
        )
        .unwrap());
        for extra in ["Rer", "Full", "CyberViewer", "Cyber", "Admin"] {
            let combined = roles(&[ROLE_CYBER_VIEWER_RESTRICTED, extra]);
            assert!(
                role_matches(&combined, ROLE_CYBER_VIEWER_RESTRICTED).unwrap()
            );
            assert_eq!(
                role_matches(&combined, ROLE_CYBER_VIEWER).unwrap(),
                ["CyberViewer", "Cyber", "Admin"].contains(&extra),
            );
        }
    }

    #[test]
    fn devices_roles_preserve_boundaries() {
        assert!(role_matches(&roles(&["Cyber"]), "Cyber").unwrap());
        assert!(role_matches(&roles(&["Admin"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["Api"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["Full"]), "Cyber").unwrap());
        assert!(role_matches(&roles(&["CyberViewer"]), "Basic").unwrap());
        assert!(role_matches(&roles(&["CyberViewer"]), "CyberViewer").unwrap());
        assert!(role_matches(&roles(&["Cyber"]), "CyberViewer").unwrap());
        assert!(role_matches(&roles(&["Admin"]), "CyberViewer").unwrap());
        assert!(!role_matches(&roles(&["CyberViewer"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["CyberViewer"]), "Rer").unwrap());
        assert!(!role_matches(&roles(&["CyberViewer"]), "DeleteMsg").unwrap());
        assert!(!role_matches(&roles(&["DeviceSource"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["DeviceSource"]), "Basic").unwrap());
        assert!(role_matches(&roles(&["Admin"]), "DeviceSource").is_err());
    }

    #[test]
    fn no2fa_role_is_exact_match_only() {
        assert!(role_matches(&roles(&[ROLE_NO2FA]), ROLE_NO2FA).unwrap());
        assert!(!role_matches(&roles(&[ROLE_ADMIN]), ROLE_NO2FA).unwrap());
        assert!(!role_matches(&roles(&[ROLE_API]), ROLE_NO2FA).unwrap());
    }

    #[test]
    fn messenger_ingest_role_is_exact_match_only() {
        assert!(role_matches(
            &roles(&[ROLE_MESSENGER_INGEST]),
            ROLE_MESSENGER_INGEST
        )
        .unwrap());
        assert!(!role_matches(&roles(&[ROLE_ADMIN]), ROLE_MESSENGER_INGEST)
            .unwrap());
        assert!(
            !role_matches(&roles(&[ROLE_API]), ROLE_MESSENGER_INGEST).unwrap()
        );
        assert!(!role_matches(&roles(&[]), ROLE_MESSENGER_INGEST).unwrap());
    }
}
