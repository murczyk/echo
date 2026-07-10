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
use actix_web::web::Json;
use actix_web::{get, post, HttpMessage, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use sea_orm::*;
use sea_query::Expr;
use std::collections::BTreeMap;

pub mod types;

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

pub async fn has_role(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &str,
    role: &str,
) -> Result<(), AppError> {
    has_any_role(dbx, user_id, vec![role]).await
}

pub async fn ensure_admin(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    has_role(dbx, &user.id().c(h!())?, "Admin").await
}

// WARNING: need to update Auth.elm too
pub async fn has_any_role(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &str,
    roles_list: Vec<&str>,
) -> Result<(), AppError> {
    let login_obj = validate_login(dbx, user_id).await.c(h!())?;
    if let Some(e) = login_obj.validation_error {
        return Err(e);
    }
    let login_obj = login_obj.login_model.c(h!())?;
    let roles: Vec<String> = serde_json::from_value(login_obj.roles).c(h!())?;
    let mut is_any_good = false;
    for role in roles_list.clone() {
        let is_good = match role {
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
        };
        is_any_good |= is_good;
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

#[post("/api/user/keep-alive")]
async fn keep_alive(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<KeepAliveReq>,
) -> Result<Json<()>, AppError> {
    let req = req.into_inner();
    let user_id = user.id().c(h!())?;
    update_last_active_at(&env.dbx, &user_id).await.c(h!())?;
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let req = req.into_inner();
    let update_description = has_update_login_description(&req);
    let req: UpdateLoginReq = serde_json::from_value(req).c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;

    let login_obj = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(req.login.clone()))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let delta_id = assign_delta_login(
        &txn,
        &req.login,
        req.delta_login.as_deref(),
        login_obj.delta_login_id,
    )
    .await
    .c(h!())?;

    let mut login_obj: login::ActiveModel = login_obj.into();
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
        let salt_s =
            format!("{}{}", crate::config::IDENTITY_SALT, req.login.clone());
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
    }))
}

#[post("/api/login/delete")]
pub async fn delete_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<String>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let txn = env.dbx.begin().await.c(h!())?;
    let login_obj = login::Entity::find()
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Login.eq(req.clone()))
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

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
    has_role(&env.dbx, &user.id().c(h!())?, "Admin")
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    #[derive(FromQueryResult)]
    struct LoginRes {
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
    }

    let users_iter = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::SigintZone.def())
        .join(JoinType::LeftJoin, login::Relation::Organism.def())
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .columns([
            login::Column::Login,
            login::Column::Roles,
            login::Column::SigintZoneId,
            login::Column::OrganismId,
            login::Column::CreatedAt,
            login::Column::Deleted,
            login::Column::LastActiveAt,
            login::Column::DeactivationReason,
            login::Column::Description,
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
    let username = user.id().c(h!())?;
    let Some(login_obj) = login::Entity::find()
        .filter(login::Column::Login.eq(username.clone()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        println!("user not found: {}", username.clone());
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
    let goi = user_goi_state(&env.dbx, login_obj.organism_id, &username)
        .await
        .c(h!())?;
    Ok(Json(User {
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

#[post("/api/user/release-seen")]
pub async fn mark_release_seen(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<types::MarkReleaseSeenReq>,
) -> Result<Json<()>, AppError> {
    let username = user.id().c(h!())?;
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(username.clone()))
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
    let goi = user_goi_state(&env.dbx, login_obj.organism_id, &username)
        .await
        .c(h!())?;
    Ok(Json(User {
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
    user_id: &str,
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
    has_role(&env.dbx, &user_id, "Api").await.c(h!())?;
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
    let password = login_obj.password.clone().ok_or_else(|| {
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

    Identity::login(&http_req.extensions(), user_id.clone()).c(h!())?;
    Ok(Json(()))
}

#[post("/api/user/login")]
pub async fn user_login(
    env: actix_web::web::Data<Env>,
    session: actix_session::Session,
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

    Identity::login(&http_req.extensions(), user_id.clone()).c(h!())?;

    let session_id = Uuid::now_v7();
    session.insert("id", session_id.to_string()).c(h!())?;

    let account_id = login_obj.login.clone();
    crate::session::add_session(
        &mut env.redis.clone(),
        session_id,
        &account_id,
    )
    .await
    .c(h!())?;
    crate::event_stream::create_redis_stream(
        &mut env.redis.clone(),
        session_id,
    )
    .await
    .c(h!())?;

    update_last_active_at(&env.dbx, &user_id).await.c(h!())?;

    record_new_session(&user_id, session_id, &env)
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
        .filter(login::Column::Login.eq(user.id().c(h!())?))
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
    let login = user.id().c(h!())?;
    let all_groups =
        get_identity_sigint_groups(&env.dbx, &login).await.c(h!())?;
    let Some(since_ts) = &req.since_date_inclusive_ms else {
        return Ok(Json(all_groups));
    };
    let ts = crate::utils::dt_from_millis(*since_ts).c(h!())?;
    let recent_keys = signal_message_group::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalMessage.def(),
        )
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .filter(signal_message::Column::Timestamp.gt(ts))
        .filter(signal_message_group::Column::GroupMasterKey.eq_any(all_groups))
        .group_by(signal_message_group::Column::GroupMasterKey)
        .into_tuple::<Option<String>>()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let res = recent_keys.into_iter().flatten().collect::<Vec<String>>();
    Ok(Json(res))
}

#[post("/api/user/sigint-groups-detailed")]
pub async fn user_sigint_groups_detailed(
    env: actix_web::web::Data<Env>,
    req: Json<SigintGroupsReq>,
    user: Identity,
) -> Result<Json<Vec<SignalGroupEntryF2>>, AppError> {
    // let res = get_identity_sigint_groups_since(&env.dbx, &user, req.since_date_inclusive_ms).await.c(h!())?;
    let login = user.id().c(h!())?;
    has_any_role(&env.dbx, &login, vec!["Rer", "Admin", "Api"]).await?;
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
//         .filter(login::Column::Login.eq(user.id().c(h!())?))
//         .one(txn)
//         .await.c(h!())?
//         .ok_or(AppError::NotFound)?;
//     let zone_id: i64 = login_obj.sigint_zone_id.ok_or(AppError::BL {
//         msg: format!("Zone must be set for user: {}", user.id().c(h!())?),
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
    login_s: &str,
) -> Result<(login::Model, Vec<String>), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login = login::Entity::find()
        .filter(login::Column::Login.eq(login_s.to_string()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    let mut res = vec![login_s.to_string()];
    if let Some(organism_id) = login.organism_id {
        let logins = login::Entity::find()
            .filter(login::Column::OrganismId.eq(organism_id))
            .filter(login::Column::DeletedPermanently.eq(false))
            .all(txn)
            .await
            .c(h!())?;
        for login in logins {
            if !res.contains(&login.login) {
                res.push(login.login.to_string());
            }
        }
    }
    Ok((login, res))
}

pub async fn get_organism_logins<'a, 'async_trait, C>(
    txn: &'a C,
    // login_s: &str,
    user: actix_identity::Identity,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_s = user.id().c(h!())?;
    let (login, res) = get_organism_logins_inner(txn, &login_s).await?;
    if login.deleted {
        user.logout();
        return Err(AppError::Unauthenticated);
    }
    Ok(res)
}

pub async fn get_organism_logins_by_login<'a, 'async_trait, C>(
    txn: &'a C,
    login_s: &str,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let (login, res) = get_organism_logins_inner(txn, login_s).await?;
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

    if login::Entity::find_by_id(key.clone())
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
    user_id: &str,
) -> anyhow::Result<()> {
    let mut user: login::ActiveModel = login::Entity::find_by_id(user_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?
        .into_active_model();

    user.last_active_at = Set(Some(Utc::now().naive_utc()));
    user.update(dbx).await.c(h!())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_login, mk_organism, mk_signal_group,
    };
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

        let regular = login::Entity::find_by_id("Regular".to_string())
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(regular.delta_login_id, None);

        let kolya = login::Entity::find_by_id("kolya".to_string())
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

        let old_owner = login::Entity::find_by_id("OldOwner".to_string())
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
                },
            )
            .await
            .unwrap();
        }

        insert_login(
            &env.dbx,
            login::ActiveModel {
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
            let login = login::Entity::find_by_id(login_name.to_string())
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
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let err = insert_login(
            &env.dbx,
            login::ActiveModel {
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

        let login = login::Entity::find_by_id("Kolya".to_string())
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
            .filter(secret_group_user::Column::Login.eq(login.login.clone()))
            .filter(
                secret_group_user::Column::SecretGroupOrganismId.is_not_null(),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(derived_count, 1);

        inactive_users_worker_1(&env.dbx).await.unwrap();

        let login = login::Entity::find_by_id(login.login.clone())
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
            .filter(secret_group_user::Column::Login.eq(login.login))
            .filter(
                secret_group_user::Column::SecretGroupOrganismId.is_not_null(),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(derived_count, 0);
    }
}
