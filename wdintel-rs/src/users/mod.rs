// use sea_orm::{prelude::Expr, *};
use self::types::*;
use crate::entities::login::Model;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
// use crate::utils::*;
use crate::session::{record_new_session, record_page_visit};
use actix_identity::Identity;
use actix_web::web::Json;
use actix_web::{get, post, HttpMessage, HttpRequest, HttpResponse};
use sea_orm::*;
use std::collections::BTreeMap;

pub mod types;

pub async fn has_role(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &str,
    role: &str,
) -> Result<(), AppError> {
    has_any_role(dbx, user_id, vec![role]).await
}

// WARNING: need to update Auth.elm too
pub async fn has_any_role(
    dbx: &sea_orm::DatabaseConnection,
    user_id: &str,
    roles_list: Vec<&str>,
) -> Result<(), AppError> {
    let login_obj = validate_login(dbx, user_id).await.context(h!())?;
    let roles: Vec<String> =
        serde_json::from_value(login_obj.roles).context(h!())?;
    let mut is_any_good = false;
    for role in roles_list.clone() {
        let is_good = match role {
            "Admin" => roles.contains(&"Admin".to_string()),
            "Api" => roles.contains(&"Api".to_string()),
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
            "CallsignsEditor" => {
                roles.contains(&"Admin".to_string())
                    || roles.contains(&"CallsignsEditor".to_string())
            }
            role => {
                return Err(AppError::BL {
                    msg: format!("impossible! unknown role {}", role),
                })
            }
        };
        is_any_good = is_any_good | is_good;
    }
    if !is_any_good {
        return Err(AppError::Forbidden(format!(
            "required role {}, only has {}",
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
    let user_id = user.id()?;
    record_page_visit(&user_id, &req.page_id, &env, None)
        .await
        .context(h!())?;
    Ok(Json(()))
}

#[post("/api/login/update")]
pub async fn update_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateLoginReq>,
) -> Result<Json<Login>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(req.login.clone()))
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let delta_id = match login_obj.delta_login_id.clone() {
        None => {
            if let Some(d_login) = &req.delta_login {
                let result = delta_login::ActiveModel {
                    id: NotSet,
                    login: Set(d_login.clone()),
                    created_at: NotSet,
                }
                .insert(&env.dbx)
                .await
                .context(h!())?;
                Some(result.id)
            } else {
                None
            }
        }
        Some(id) => {
            let login = delta_login::Entity::find()
                .filter(delta_login::Column::Id.eq(id))
                .one(&env.dbx)
                .await
                .context(h!())?
                .context(h!())?;
            match &req.delta_login {
                None => {
                    let logins = login::Entity::find()
                        .filter(login::Column::DeltaLoginId.eq(id))
                        .all(&env.dbx)
                        .await
                        .context(h!())?;
                    for l in logins {
                        let mut l = l.into_active_model();
                        l.delta_login_id = Set(None);
                        l.update(&env.dbx).await.context(h!())?;
                    }
                    login.delete(&env.dbx).await.context(h!())?;
                    None
                }
                Some(d_login) => {
                    if !d_login.eq(&login.login) {
                        let id = login.id;
                        let mut model = login.into_active_model();
                        model.login = Set(d_login.clone());
                        model.update(&env.dbx).await.context(h!())?;
                        Some(id)
                    } else {
                        let result = delta_login::ActiveModel {
                            id: NotSet,
                            login: Set(d_login.clone()),
                            created_at: NotSet,
                        }
                        .insert(&env.dbx)
                        .await
                        .context(h!())?;
                        Some(result.id)
                    }
                }
            }
        }
    };

    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.delta_login_id = Set(delta_id);
    if req.deleted.is_some() {
        login_obj.deleted = Set(req.deleted.context(h!())?);
    }
    if req.password.is_some() {
        let salt_s =
            format!("{}{}", crate::config::IDENTITY_SALT, req.login.clone());
        let salt = salt_s.as_bytes();
        let config = argon2::Config::original();
        let hash = argon2::hash_encoded(
            req.password.clone().context(h!())?.as_bytes(),
            salt,
            &config,
        )?;
        login_obj.password = Set(Some(format!("{}", hash)));
    }
    if req.roles.is_some() {
        login_obj.roles =
            Set(serde_json::to_value(req.roles.clone()).context(h!())?);
    }
    if req.sigint_zone_id.is_some() {
        login_obj.sigint_zone_id = Set(req.sigint_zone_id.clone());
    }
    if req.organism_id.is_some() {
        login_obj.organism_id = Set(req.organism_id.clone());
    }
    let res = login_obj.update(&env.dbx).await.context(h!())?;
    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::Id.eq(res.organism_id))
        .one(&env.dbx)
        .await
        .context(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };
    Ok(Json(Login {
        organism_name,
        organism_enabled,
        delta_login: req.delta_login.clone(),
        login: res.login,
        roles: serde_json::from_value(res.roles).context(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&env.dbx)
            .await
            .context(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
    }))
}

#[post("/api/login/delete")]
pub async fn delete_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<String>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(req.clone()))
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.deleted = Set(true);
    login_obj.update(&env.dbx).await.context(h!())?;
    Ok(Json(()))
}

#[post("/api/login/create")]
pub async fn create_login(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateLoginReq>,
) -> Result<Json<Login>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    let salt_s =
        format!("{}{}", crate::config::IDENTITY_SALT, req.login.clone());
    let salt = salt_s.as_bytes();
    let config = argon2::Config::original();
    let hash = argon2::hash_encoded(req.password.as_bytes(), salt, &config)?;

    let login_obj = login::ActiveModel {
        delta_login_id: NotSet,
        login: Set(req.login.trim().to_string()),
        password: Set(Some(format!("{}", hash))),
        roles: Set(serde_json::to_value(req.roles.clone()).context(h!())?),
        created_at: NotSet,
        sigint_zone_id: Set(req.sigint_zone_id.clone()),
        organism_id: Set(req.organism_id.clone()),
        deleted: Set(false),
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let res = login::Entity::find()
        .filter(login::Column::Login.eq(login_obj.login))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;

    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::Id.eq(res.organism_id))
        .one(&env.dbx)
        .await
        .context(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };

    Ok(Json(Login {
        delta_login: None,
        organism_name,
        organism_enabled,
        login: res.login,
        roles: serde_json::from_value(res.roles).context(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(&env.dbx)
            .await
            .context(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
    }))
}

#[post("/api/login/create-delta")]
pub async fn create_delta_login(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateDeltaLoginReq>,
) -> Result<Json<Login>, AppError> {
    has_role(&env.dbx, &user.id()?, "Admin")
        .await
        .context(h!())?;

    let login = req.login.clone();
    let roles = req.roles.clone();
    let sigint_zone = req.sigint_zone_id.clone();
    let organism_id = req.organism_id.clone();

    let result =
        register_delta_user(&env.dbx, login, roles, sigint_zone, organism_id)
            .await
            .context(h!())?;
    Ok(Json(result))
}

#[post("/api/logins")]
pub async fn list_logins(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListLoginsReq>,
) -> Result<Json<ListLoginsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin").await?;

    #[derive(FromQueryResult)]
    struct LoginRes {
        login: String,
        roles: serde_json::Value,
        sigint_zone_id: Option<i64>,
        organism_id: Option<i64>,
        created_at: sea_orm::prelude::DateTime,
        deleted: bool,
        sigint_zone_name: Option<String>,
        organism_name: Option<String>,
        organism_enabled: Option<bool>,
        delta_login: Option<String>,
    }

    let users_iter = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::SigintZone.def())
        .join(JoinType::LeftJoin, login::Relation::Organism.def())
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .select_only()
        .columns([
            login::Column::Login,
            login::Column::Roles,
            login::Column::SigintZoneId,
            login::Column::OrganismId,
            login::Column::CreatedAt,
            login::Column::Deleted,
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
        .context(h!())?
        .into_iter();

    let mut users = vec![];
    for login in users_iter {
        let user = Login {
            login: login.login,
            roles: serde_json::from_value(login.roles).context(h!())?,
            created_at: login.created_at.and_utc().timestamp_millis(),
            deleted: login.deleted,
            sigint_zone_id: login.sigint_zone_id,
            sigint_zone_name: login.sigint_zone_name,
            organism_id: login.organism_id,
            organism_name: login.organism_name,
            organism_enabled: login.organism_enabled,
            delta_login: login.delta_login,
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
    let username = user.id()?;
    let Some(login_obj) = login::Entity::find()
        .filter(login::Column::Login.eq(username.clone()))
        .one(&env.dbx)
        .await
        .context(h!())?
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
            .context(h!())?
            .map(|x| x.login),
    };
    Ok(Json(User {
        delta_login,
        name: username.clone(),
        roles: serde_json::from_value(login_obj.roles).context(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id.clone(),
        organism_id: login_obj.organism_id.clone(),
    }))
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
        .one(&env.dbx)
        .await
        .context(h!())?
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
            .context(h!())?
            .map(|x| x.login),
    };
    Ok(Json(User {
        delta_login,
        name: username.clone(),
        roles: serde_json::from_value(login_obj.roles).context(h!())?,
        sigint_zone_id: login_obj.sigint_zone_id.clone(),
        organism_id: login_obj.organism_id.clone(),
    }))
}

#[get("/api/user/logout")]
async fn user_logout(user: Identity) -> Result<HttpResponse, AppError> {
    user.logout();
    // todo call delta logout here
    Ok(HttpResponse::Found()
        .insert_header(("Location", "/login"))
        .body("Success. Redirecting.."))
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
        Err(_) => {
            return Err(AppError::Form(BTreeMap::from_iter([(
                "login".to_string(),
                format!("Невірний логін \"{}\"", req.user),
            )])));
        }
    };
    let password = login_obj.password.clone().ok_or(AppError::Form(
        BTreeMap::from_iter([(
            "login".to_string(),
            format!(
            "Даний спосіб авторизації не підтримується для користувача \"{}\"",
            req.user
        ),
        )]),
    ))?;
    let is_valid = argon2::verify_encoded(&password, req.password.as_bytes())?;
    if !is_valid {
        println!("> warning: invalid password attempt: {}", req.user);
        return Err(AppError::Form(BTreeMap::from_iter([(
            "password".to_string(),
            "Невірний пароль".to_string(),
        )])));
    };

    Identity::login(&http_req.extensions(), user_id.clone().into())
        .context(h!())?;

    record_new_session(&user_id, &env).await.context(h!())?;
    Ok(Json(()))
}

#[post("/api/user/settings-save")]
pub async fn settings_save(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SettingsSaveReq>,
) -> Result<Json<()>, AppError> {
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(user.id()?))
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let mut login_obj: login::ActiveModel = login_obj.into();
    login_obj.sigint_zone_id = Set(req.sigint_zone_id.clone());
    login_obj.update(&env.dbx).await.context(h!())?;
    Ok(Json(()))
}

pub async fn register_user(
    dbx: &sea_orm::DatabaseConnection,
    user: &str,
    password: &str,
    roles: &Vec<String>,
    sigint_zone_id: i64,
    organism_id: Option<i64>,
) -> Result<(), AppError> {
    let txn = dbx.begin().await.context(h!())?;
    let salt_s = format!("{}{}", crate::config::IDENTITY_SALT, user);
    let salt = salt_s.as_bytes();
    let config = argon2::Config::original();
    let hash = argon2::hash_encoded(password.as_bytes(), salt, &config)?;
    let hash_s = format!("{}", hash);
    login::ActiveModel {
        login: Set(user.to_string()),
        password: Set(Some(hash_s.clone())),
        roles: Set(serde_json::to_value(roles.clone()).context(h!())?),
        created_at: NotSet,
        sigint_zone_id: Set(Some(sigint_zone_id)),
        organism_id: Set(organism_id),
        deleted: Set(false),
        delta_login_id: NotSet,
    }
    .insert(&txn)
    .await
    .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(())
}

#[post("/api/user/sigint-groups")]
pub async fn user_sigint_groups(
    env: actix_web::web::Data<Env>,
    _req: Json<SigintGroupsReq>,
    user: Identity,
) -> Result<Json<Vec<String>>, AppError> {
    // let res = get_identity_sigint_groups_since(&env.dbx, &user, req.since_date_inclusive_ms).await.context(h!())?;
    let login = user.id()?;
    let res = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    Ok(Json(res))
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
//         .filter(login::Column::Login.eq(user.id()?))
//         .one(txn)
//         .await.context(h!())?
//         .ok_or(AppError::NotFound)?;
//     let zone_id: i64 = login_obj.sigint_zone_id.ok_or(AppError::BL {
//         msg: format!("Zone must be set for user: {}", user.id()?),
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
//         .await.context(h!())?
//         .into_iter()
//         .collect())
// }

pub async fn get_identity_sigint_groups<'a, 'async_trait, C>(
    txn: &'a C,
    login: &str,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(login))
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let zone_id: i64 = login_obj.sigint_zone_id.ok_or(AppError::BL {
        msg: format!("Zone must be set for user: {}", login),
    })?;

    let mut organism_groups_obj = vec![];
    if let Some(organism_id) = login_obj.organism_id {
        organism_groups_obj = organism_group::Entity::find()
            .join(
                JoinType::InnerJoin,
                organism_group::Relation::SignalGroup.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_group::Relation::Datasource.def(),
            )
            .join(
                JoinType::InnerJoin,
                datasource::Relation::SigintZoneDatasource.def(),
            )
            .filter(organism_group::Column::OrganismId.eq(organism_id))
            .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
            .all(txn)
            .await
            .context(h!())?
            .into_iter()
            .map(|og| og.signal_group_master_key)
            .collect();
    }

    let mut res = vec![];
    if organism_groups_obj.len() > 0 {
        res = organism_groups_obj;
    } else {
        let szds = sigint_zone_datasource::Entity::find()
            .filter(sigint_zone_datasource::Column::SigintZoneId.eq(zone_id))
            .all(txn)
            .await
            .context(h!())?;
        for szd in szds {
            let Some(group_master_keys) = szd.group_master_keys else {
                continue;
            };
            let mut groups: Vec<String> =
                serde_json::from_value(group_master_keys).context(h!())?;
            res.append(&mut groups);
        }
    }
    Ok(res)
}

/// Gets group keys similar to get_identity_sigint_groups but without the import group id
pub async fn get_identity_sigint_groups_noimport(
    dbx: &sea_orm::DatabaseConnection,
    user: &actix_identity::Identity,
    _config: &crate::config::Config,
) -> Result<Vec<String>, AppError> {
    let login = user.id()?;
    let master_keys = get_identity_sigint_groups(dbx, &login)
        .await
        .context(h!())?;
    // let mut master_keys = get_identity_sigint_groups(dbx, user).await.context(h!())?;
    // if let Some(import_group) = signal_group::Entity::find()
    //     .filter(
    //         signal_group::Column::Name
    //             .eq(config.signal_import_group_name.clone()),
    //     )
    //     .one(dbx)
    //     .await.context(h!())?
    // {
    //     master_keys = master_keys
    //         .clone()
    //         .into_iter()
    //         .filter(|key| key != &import_group.master_key)
    //         .collect::<Vec<_>>();
    // }
    Ok(master_keys)
}

#[tokio::main]
pub async fn oneoff_register_user(
    mode: Mode,
    ps: &crate::OneoffRegisterUserPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_register_user");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    register_user(
        &dbx,
        &ps.login,
        &ps.password,
        &vec![ps.role.clone()],
        ps.sigint_zone,
        ps.organism_id,
    )
    .await
    .context(h!())?;
    Ok(())
}

#[tokio::main]
pub async fn oneoff_register_delta_user(
    mode: Mode,
    ps: &crate::OneoffRegisterDeltaUserPs,
) -> Result<(), AppError> {
    println!("> starting oneoff_register_delta_user");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    register_delta_user(
        &dbx,
        ps.login.clone(),
        vec![ps.role.clone()],
        Some(ps.sigint_zone),
        ps.organism_id,
    )
    .await
    .context(h!())?;
    Ok(())
}

pub async fn get_organism_logins<'a, 'async_trait, C>(
    txn: &'a C,
    // login_s: &str,
    user: actix_identity::Identity,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login_s = user.id()?;
    let login = login::Entity::find()
        .filter(login::Column::Login.eq(login_s.to_string()))
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::Unauthenticated)?;
    if login.deleted {
        user.logout();
        return Err(AppError::Unauthenticated);
    }
    let mut res = vec![login_s.to_string()];
    if let Some(organism_id) = login.organism_id {
        let logins = login::Entity::find()
            .filter(login::Column::OrganismId.eq(organism_id))
            .all(txn)
            .await
            .context(h!())?;
        for login in logins {
            if !res.contains(&login.login) {
                res.push(login.login.to_string());
            }
        }
    }
    Ok(res)
}

pub async fn validate_login(
    dbx: &DatabaseConnection,
    login: &str,
) -> Result<Model, AppError> {
    let Some((login_obj, organisms)) = login::Entity::find()
        .filter(login::Column::Login.eq(login))
        .find_with_related(organism::Entity)
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .next()
    else {
        println!("user not found: {}", login);
        return Err(AppError::Unauthenticated);
    };
    if let Some(organism) = organisms.into_iter().next() {
        if !organism.enabled {
            println!("user {} not authorized, reason: organism {} (id {}) was disabled", login, organism.name, organism.id);
            return Err(AppError::Unauthenticated);
        }
    }
    if login_obj.deleted {
        println!("login deleted: {}", login);
        return Err(AppError::Unauthenticated);
    }
    Ok(login_obj)
}

async fn register_delta_user(
    dbx: &DatabaseConnection,
    login: String,
    roles: Vec<String>,
    sigint_zone: Option<i64>,
    organism_id: Option<i64>,
) -> Result<Login, AppError> {
    let delta_login = delta_login::ActiveModel {
        id: NotSet,
        login: Set(login.clone()),
        created_at: NotSet,
    }
    .insert(dbx)
    .await
    .context(h!())?;

    let login_obj = login::ActiveModel {
        login: Set(login),
        password: Set(None),
        roles: Set(serde_json::to_value(roles).context(h!())?),
        created_at: NotSet,
        sigint_zone_id: Set(sigint_zone),
        organism_id: Set(organism_id),
        deleted: Set(false),
        delta_login_id: Set(Some(delta_login.id)),
    }
    .insert(dbx)
    .await
    .context(h!())?;

    let res = login::Entity::find()
        .filter(login::Column::Login.eq(login_obj.login))
        .one(dbx)
        .await
        .context(h!())?
        .context(h!())?;

    let (organism_name, organism_enabled) = match organism::Entity::find()
        .filter(organism::Column::Id.eq(res.organism_id))
        .one(dbx)
        .await
        .context(h!())?
    {
        None => (None, None),
        Some(organism) => (Some(organism.name.clone()), Some(organism.enabled)),
    };

    let delta_login = match login_obj.delta_login_id {
        None => None,
        Some(id) => delta_login::Entity::find()
            .filter(delta_login::Column::Id.eq(id))
            .one(dbx)
            .await
            .context(h!())?
            .map(|x| x.login),
    };
    let result = Login {
        delta_login,
        organism_name,
        organism_enabled,
        login: res.login,
        roles: serde_json::from_value(res.roles).context(h!())?,
        created_at: res.created_at.and_utc().timestamp_millis(),
        deleted: res.deleted,
        sigint_zone_id: res.sigint_zone_id,
        sigint_zone_name: sigint_zone::Entity::find()
            .filter(sigint_zone::Column::Id.eq(res.sigint_zone_id))
            .one(dbx)
            .await
            .context(h!())?
            .map(|sz| sz.name),
        organism_id: res.organism_id,
    };
    Ok(result)
}
