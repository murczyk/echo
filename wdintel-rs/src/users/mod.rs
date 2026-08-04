use self::types::*;
use crate::config::*;
use crate::entities::sea_orm_active_enums::DeactivationReasonEnum;
use crate::entities::*;
use crate::error::AppError;
use crate::messenger::group::get_identity_sigint_groups;
use crate::messenger::group::types::SignalGroupEntryF2;
use crate::session::{record_new_session, record_page_visit};
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use actix_session::SessionExt;
use actix_web::web::Json;
use actix_web::{get, post, HttpMessage, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use sea_orm::*;
use sea_query::Expr;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub mod types;

pub fn login_id_from_identity(user: &Identity) -> Result<Uuid, AppError> {
    let identity = user.id().map_err(|_| AppError::Unauthenticated)?;
    Uuid::parse_str(&identity).map_err(|_| AppError::Unauthenticated)
}

pub(crate) async fn start_user_session(
    env: &actix_web::web::Data<Env>,
    http_req: &HttpRequest,
    login_id: Uuid,
) -> Result<(), AppError> {
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

    update_last_active_at(&env.dbx, &login_id).await?;
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

fn has_update_login_description(req: &serde_json::Value) -> bool {
    req.as_object()
        .is_some_and(|req| req.contains_key("description"))
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

pub async fn ensure_rer_role(
    dbx: &sea_orm::DatabaseConnection,
    user: &Identity,
) -> Result<(), AppError> {
    ensure_rer_role_by_id(dbx, &login_id_from_identity(user)?).await
}

pub async fn ensure_rer_role_by_id<T>(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &T,
) -> Result<(), AppError>
where
    T: ToString + ?Sized,
{
    has_role(dbx, user_id, "Rer").await
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
    let login_obj = validate_login_id(dbx, &login_id).await.c(h!())?;
    if let Some(e) = login_obj.validation_error {
        return Err(e);
    }
    let login_obj = login_obj.login_model.c(h!())?;
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

fn role_matches(roles: &[String], role: &str) -> Result<bool, AppError> {
    Ok(match role {
        "Admin" => roles.contains(&"Admin".to_string()),
        "Api" => roles.contains(&"Api".to_string()),
        "ApiAgent" => roles.contains(&"ApiAgent".to_string()),
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
        "DeviceSource" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"DeviceSource".to_string())
        }
        "AdvancedReports" => {
            roles.contains(&"Admin".to_string())
                || roles.contains(&"AdvancedReports".to_string())
        }
        "NoAutoLogout" => roles.contains(&"NoAutoLogout".to_string()),
        role => {
            return Err(AppError::BL {
                msg: format!("impossible! unknown role {role}"),
            })
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
    let user_id = login_id_from_identity(&user)?;
    match update_last_active_at(&env.dbx, &user_id).await {
        Err(AppError::Unauthenticated) => {
            user.logout();
            return Err(AppError::Unauthenticated);
        }
        result => result?,
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
    let req: UpdateLoginReq = serde_json::from_value(req).c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;

    let login_id = Uuid::parse_str(&req.id).c(h!())?;
    let login_obj = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Id.eq(login_id))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let login_name = req.login.trim();
    if login_name.is_empty() {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "login".to_string(),
            "Логін не може бути пустим".to_string(),
        )])));
    }
    if login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(login_name))
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

    let delta_id = assign_delta_login(
        &txn,
        &login_obj.login,
        req.delta_login.as_deref(),
        login_obj.delta_login_id,
    )
    .await
    .c(h!())?;

    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.login = Set(login_name.to_string());
    login_obj.delta_login_id = Set(delta_id);
    if let Some(deleted) = req.deleted {
        login_obj.deleted = Set(deleted);
        if !deleted {
            // If user is being re-activated, clear deactivation_reason and update last_active_at
            login_obj.deactivation_reason = Set(None);
            login_obj.last_active_at = Set(Some(Utc::now().naive_utc()));
        }
    }
    if req.password.is_some() {
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
    if req.deactivation_reason.is_some() {
        login_obj.deactivation_reason = Set(req
            .deactivation_reason
            .clone()
            .map(DeactivationReasonEnum::from));
    }
    if update_description {
        login_obj.description =
            Set(normalize_login_description(req.description.clone()));
    }
    if let Some(password_auth_enabled) = req.password_auth_enabled {
        login_obj.password_auth_enabled = Set(password_auth_enabled);
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
    txn.commit().await.c(h!())?;
    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Id.eq(res.organism_id))
        .one(&env.dbx)
        .await
        .c(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };
    Ok(Json(Login {
        id: res.id.to_string(),
        organism_name,
        organism_enabled,
        delta_login: req.delta_login.clone(),
        login: res.login,
        roles: serde_json::from_value(res.roles).c(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&env.dbx)
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
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
    }))
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

    let salt_s =
        format!("{}{}", crate::config::IDENTITY_SALT, req.login.clone());
    let salt = salt_s.as_bytes();
    let config = argon2::Config::original();
    let hash =
        argon2::hash_encoded(req.password.as_bytes(), salt, &config).c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let res = insert_login(
        &txn,
        login::ActiveModel {
            id: Set(Uuid::now_v7()),
            // Make sure delta link is cleared for regular accounts
            delta_login_id: Set(None),
            login: Set(req.login.trim().to_string()),
            password: Set(Some(hash.to_string())),
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
            password_auth_enabled: Set(true),
        },
    )
    .await
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
        delta_login: None,
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
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
    };
    crate::sigint::zone::bl::refresh_secret_group_memberships(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(result))
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
        password_auth_enabled: bool,
    }

    let users_iter = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::SigintZone.def())
        .join(JoinType::LeftJoin, login::Relation::Organism.def())
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .filter(
            Condition::any()
                .add(organism::Column::DeletedPermanently.eq(false))
                .add(login::Column::OrganismId.is_null()),
        )
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .columns([
            login::Column::Id,
            login::Column::Login,
            login::Column::Roles,
            login::Column::SigintZoneId,
            login::Column::OrganismId,
            login::Column::CreatedAt,
            login::Column::Deleted,
            login::Column::LastActiveAt,
            login::Column::DeactivationReason,
            login::Column::Description,
            login::Column::PasswordAuthEnabled,
        ])
        .column_as(sigint_zone::Column::Name, "sigint_zone_name")
        .column_as(organism::Column::Name, "organism_name")
        .column_as(organism::Column::Enabled, "organism_enabled")
        .column_as(delta_login::Column::Login, "delta_login")
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
            description: login.description,
            password_auth_enabled: login.password_auth_enabled,
        };
        users.push(user);
    }
    Ok(Json(ListLoginsRsp { users }))
}

#[get("/api/user")]
async fn api_user(
    env: actix_web::web::Data<Env>,
    user: Option<Identity>,
) -> Result<Json<User>, AppError> {
    let Some(user) = user else {
        return Err(AppError::Unauthenticated);
    };
    let user_id = login_id_from_identity(&user)?;
    let Some(login_obj) = login::Entity::find_by_id(user_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        println!("user not found: {user_id}");
        return Err(AppError::Unauthenticated);
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
    Ok(Json(User {
        id: login_obj.id.to_string(),
        delta_login,
        name: login_obj.login.clone(),
        roles: serde_json::from_value(login_obj.roles).c(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id,
        organism_id: login_obj.organism_id,
        goi_configured_for_organism: goi.configured,
        goi_full_access_for_organism: goi.full_access,
        goi_host: goi.host,
        goi_integrations: goi.integrations,
        last_release_seen: login_obj.last_release_seen,
    }))
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
    Ok(Json(User {
        id: login_obj.id.to_string(),
        delta_login,
        name: username.clone(),
        roles: serde_json::from_value(login_obj.roles).c(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id,
        organism_id: login_obj.organism_id,
        goi_configured_for_organism: goi.configured,
        goi_full_access_for_organism: goi.full_access,
        goi_host: goi.host,
        goi_integrations: goi.integrations,
        last_release_seen: login_obj.last_release_seen,
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
async fn user_logout(user: Identity) -> Result<HttpResponse, AppError> {
    user.logout();
    // todo call delta logout here
    Ok(HttpResponse::Found()
        .insert_header(("Location", "/login"))
        .body("Success. Redirecting.."))
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
) -> Result<Json<()>, AppError> {
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

    start_user_session(&env, &http_req, login_obj.id)
        .await
        .c(h!())?;

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
    req: Json<SigintGroupsReq>,
    user: Identity,
) -> Result<Json<Vec<SignalGroupEntryF2>>, AppError> {
    // let res = get_identity_sigint_groups_since(&env.dbx, &user, req.since_date_inclusive_ms).await.c(h!())?;
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Admin", "Api"],
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
    let groups = crate::messenger::group::collect_groups_f2(keys, &env.dbx)
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

pub async fn validate_login(
    dbx: &DatabaseConnection,
    login: &str,
) -> Result<UserValidationResult, AppError> {
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
            println!("user {} not authorized, reason: organism {} (id {}) was disabled", login, organism.name, organism.id);
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
                let message = format!("Користувача \"{login}\" було заблоковано як не активного більше {INACTIVE_USERS_DEACTIVATE_AFTER_DAYS} днів. Зверніться до адміністратора");
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

pub async fn validate_login_id(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<UserValidationResult, AppError> {
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
) -> Result<Login, AppError> {
    let txn = dbx.begin().await.c(h!())?;

    let login_obj = insert_login(
        &txn,
        login::ActiveModel {
            id: Set(Uuid::now_v7()),
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
        description: res.description,
        password_auth_enabled: res.password_auth_enabled,
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
    if let Some(delta_login_id) = current_delta_login_id {
        unlink_deleted_logins_from_shared_delta_login(dbx, delta_login_id)
            .await
            .c(h!())?;
    }

    let Some(delta_login) = delta_login else {
        return Ok(None);
    };

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

    let logins = query.all(dbx).await.c(h!())?;
    for login in logins {
        let mut login = login.into_active_model();
        login.delta_login_id = Set(None);
        login.update(dbx).await.c(h!())?;
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
    dbx: &DatabaseConnection,
    user_id: &Uuid,
) -> Result<(), AppError> {
    let mut user: login::ActiveModel = login::Entity::find_by_id(*user_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?
        .into_active_model();

    user.last_active_at = Set(Some(Utc::now().naive_utc()));
    user.update(dbx).await.c(h!())?;

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
    use serial_test::serial;

    static TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

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

    async fn start_test_user_session(
        env: web::Data<Env>,
        req: HttpRequest,
    ) -> Result<HttpResponse, AppError> {
        let login = find_test_login(&env.dbx).await.c(h!())?;
        start_user_session(&env, &req, login.id).await.c(h!())?;
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
                .cookie(cookie)
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
                id: NotSet,
                login: Set("Regular".to_string()),
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
                    id: NotSet,
                    login: Set(login_name.to_string()),
                    password: Set(None),
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
                    password_auth_enabled: Set(false),
                },
            )
            .await
            .unwrap();
        }

        insert_login(
            &env.dbx,
            login::ActiveModel {
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
    async fn insert_login_does_not_resurrect_permanently_deleted_login() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();

        login::ActiveModel {
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
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let err = insert_login(
            &env.dbx,
            login::ActiveModel {
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
    fn devices_roles_preserve_boundaries() {
        assert!(role_matches(&roles(&["Cyber"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["DeviceSource"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["Cyber"]), "DeviceSource").unwrap());
        assert!(
            role_matches(&roles(&["DeviceSource"]), "DeviceSource").unwrap()
        );
        assert!(role_matches(&roles(&["Admin"]), "Cyber").unwrap());
        assert!(role_matches(&roles(&["Admin"]), "DeviceSource").unwrap());
        assert!(!role_matches(&roles(&["Api"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["Full"]), "Cyber").unwrap());
        assert!(!role_matches(&roles(&["Api"]), "DeviceSource").unwrap());
        assert!(!role_matches(&roles(&["Full"]), "DeviceSource").unwrap());
    }
}
