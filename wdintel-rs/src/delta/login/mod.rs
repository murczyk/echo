use crate::delta::login::oauth::build_auth_url;
use crate::delta::login::types::UserInfo;
use crate::entities::*;
use crate::types::*;
use crate::users::validate_login;
use actix_identity::Identity;
use actix_web::dev::Extensions;
use actix_web::web::{Data, Json};
use actix_web::{get, HttpMessage, HttpRequest, HttpResponse};
use anyhow::Error;
use echo_migration::Expr;
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
    req: HttpRequest,
    env: actix_web::web::Data<Env>,
) -> HttpResponse {
    let config = &env.config;
    let authority = crate::utils::http::extract_authority_header(&req);
    let is_echoua =
        authority.clone().filter(|x| x.contains("echoua")).is_some();
    match build_auth_url(config, is_echoua).await.context(h!()) {
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

    let delta_logins = delta_login::Entity::find()
        .find_with_related(login::Entity)
        .filter(Expr::cust_with_values(
            "lower(delta_login.login) = $1",
            vec![username.to_lowercase()],
        ))
        .order_by_desc(delta_login::Column::CreatedAt)
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut result_login = None;
    for (delta_login, logins) in &delta_logins {
        if logins.is_empty() {
            continue;
        }
        if result_login.is_some() || logins.len() > 1 {
            warn!(
                "multiple logins for delta login {}: {:?}",
                delta_login.login, delta_logins
            );
        } else {
            result_login = logins.iter().next().clone();
        }
    }

    let login = result_login.context(h!())?;
    let login = validate_login(&env.dbx, &login.login).await.context(h!())?;
    Identity::login(&extensions, login.login)?;
    Ok(())
}
