use crate::delta::login::oauth::build_auth_url;
use crate::delta::login::types::UserInfo;
use crate::entities::delta_login::Model;
use crate::entities::*;
use crate::types::*;
use crate::users::validate_login;
use actix_identity::Identity;
use actix_web::dev::Extensions;
use actix_web::web::{Data, Json};
use actix_web::{get, HttpMessage, HttpRequest, HttpResponse};
use anyhow::Error;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use std::cell::Ref;

pub mod oauth;
pub mod types;

#[derive(Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeltaLoginUrl {
    pub url: Option<String>,
}

#[get("/api/fetch-redirect-url")]
pub async fn fetch_redirect_url(
    env: actix_web::web::Data<Env>,
) -> HttpResponse {
    let config = &env.config;
    match build_auth_url(config).await.context(h!()) {
        Ok(url) => {
            HttpResponse::Ok().json(Json(DeltaLoginUrl { url: Some(url) }))
        }
        Err(e) => {
            warn!("failed to build auth url: {:?}", e);
            HttpResponse::BadRequest().body("Missing Delta API config")
        }
    }
}

#[get("/api/delta-redirect")]
pub async fn handle_redirect(
    req: HttpRequest,
    env: actix_web::web::Data<Env>,
) -> HttpResponse {
    let req_clone = req.clone();
    let extensions = req_clone.extensions();
    match oauth::handle_receive_code(env.clone(), req).await {
        Ok(user_info) => {
            let user_name = user_info.user_name.clone();
            match perform_login(&env, extensions, user_info).await {
                Ok(_) => HttpResponse::Found()
                    .insert_header(("Location", "/"))
                    .body("Success. Redirecting.."),
                Err(e) => {
                    error!("Failed to login, probably EXO account is missing: user_name: {user_name}; error: {e:?}");
                    HttpResponse::Found()
                        .insert_header((
                            "Location",
                            "/login?api_error=err_delta_login_7639",
                        ))
                        .body("err_delta_login_7639")
                }
            }
        }
        Err(e) => {
            error!("Delta API error occurred: {:?}", e);
            HttpResponse::Found()
                .insert_header((
                    "Location",
                    "/login?api_error=err_delta_login_4536",
                ))
                .body("err_delta_login_4536")
        }
    }
}

async fn perform_login(
    env: &Data<Env>,
    extensions: Ref<'_, Extensions>,
    user_info: UserInfo,
) -> Result<(), Error> {
    let username = user_info.user_name;
    info!("delta: logging in as '{}'", username);
    let delta_login = load_delta_login(&env, &username).await.context(h!())?;

    let login = login::Entity::find()
        .filter(login::Column::DeltaLoginId.eq(delta_login.id))
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    let delta_login = delta_login.login;
    if !delta_login.eq(&username) {
        warn!(
            "delta login: expected '{}' (in database), got '{}' from Delta API",
            delta_login, username
        )
    }
    let login = validate_login(&env.dbx, &login.login).await.context(h!())?;
    Identity::login(&extensions, login.login)?;
    Ok(())
}

async fn load_delta_login(
    env: &&Data<Env>,
    username: &String,
) -> Result<Model, Error> {
    let delta_logins = delta_login::Entity::find()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut m_delta_login = None;
    let username_lowercase = username.to_lowercase();
    for login in delta_logins {
        let delta_login = &login.login.to_lowercase();
        let delta_login = delta_login.trim();
        if delta_login.eq(&username_lowercase) {
            m_delta_login = Some(login);
        }
    }
    m_delta_login.context("delta login not found")
}
