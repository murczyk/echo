use crate::delta::login::oauth::build_auth_url;
use crate::delta::login::types::UserInfo;
use crate::entities::*;
use crate::types::*;
use crate::users::validate_login;
use actix_session::Session;

use crate::entities::sea_orm_active_enums::DeactivationReasonEnum;
use actix_web::web::{Data, Json};
use actix_web::{get, HttpRequest, HttpResponse};
use echo_migration::Expr;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

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
    session: Session,
) -> HttpResponse {
    let req_clone = req.clone();
    match oauth::handle_receive_code(env.clone(), req).await {
        Ok(user_info) => {
            let user_name = user_info.user_name.clone();
            match perform_login(&env, &session, &req_clone, user_info).await {
                Ok(reason) => {
                    if let Some(_reason) = reason {
                        HttpResponse::Found()
                            .insert_header((
                                "Location",
                                "/login?api_error=err_delta_login_3278",
                            ))
                            .body("err_delta_login_3278")
                    } else {
                        HttpResponse::Found()
                            .insert_header(("Location", "/"))
                            .body("Success. Redirecting..")
                    }
                }
                Err(e) => {
                    error!("Failed to login, probably EXO account is missing: user_name: {user_name}; error: {:?}", e);
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
    session: &Session,
    req: &HttpRequest,
    user_info: UserInfo,
) -> Result<Option<DeactivationReasonEnum>, AppError> {
    let username = user_info.user_name;
    info!("delta: logging in as '{username}'");

    let delta_logins = delta_login::Entity::find()
        .find_with_related(login::Entity)
        .filter(login::Column::DeletedPermanently.eq(false))
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
            result_login = logins.iter().next();
        }
    }

    let login = result_login.context(h!())?;
    let login_validation =
        validate_login(&env.dbx, &login.login).await.context(h!())?;
    if let Some(reason) = login_validation.deactivation_reason {
        return Ok(Some(reason));
    }
    if let Some(err) = login_validation.validation_error {
        return Err(err);
    }
    if let Some(login) = login_validation.login_model {
        crate::users::initialize_browser_session(env, session, req, &login.id)
            .await
            .context(h!())?;
        return Ok(None);
    }
    let mut login_obfuscated = login.clone();
    login_obfuscated.password = login_obfuscated
        .password
        .clone()
        .map(|_| "<...>".to_string());
    Err(AppError::BL{ msg: format!("unexpected error occurred on login attempt, login={login_obfuscated:?}") })
}
