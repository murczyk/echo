use crate::config::DELTA_LOGIN_REDIRECT_SESSION_PREFIX;
use crate::delta::login::oauth::build_auth_url;
use crate::delta::login::types::UserInfo;
use crate::entities::sea_orm_active_enums::DeactivationReasonEnum;
use crate::entities::*;
use crate::types::*;
use crate::users::validate_login;
use crate::utils::http::{
    local_login_redirect, login_redirect_url, LoginRedirectQuery,
};
use actix_session::SessionExt;
use actix_web::web::{Data, Json, Query};
use actix_web::{get, HttpRequest, HttpResponse};
use echo_migration::Expr;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;

pub mod oauth;
pub mod types;

#[cfg(test)]
mod tests;

#[derive(Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeltaLoginUrl {
    pub url: Option<String>,
}

#[get("/api/fetch-redirect-url")]
pub async fn fetch_redirect_url(
    req: HttpRequest,
    env: Data<Env>,
    query: Query<LoginRedirectQuery>,
) -> HttpResponse {
    match auth_url_for_request(&req, &env, query.redirect.as_deref()).await {
        Ok(url) => HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .json(Json(DeltaLoginUrl { url: Some(url) })),
        Err(e) => {
            warn!("failed to build auth url: {:?}", e);
            HttpResponse::BadRequest().body("Missing Delta API config")
        }
    }
}

async fn auth_url_for_request(
    req: &HttpRequest,
    env: &Env,
    redirect: Option<&str>,
) -> anyhow::Result<String> {
    let authority = crate::utils::http::extract_authority_header(req);
    let is_echoua = authority.is_some_and(|x| x.contains("echoua"));
    let (url, state) = build_auth_url(&env.config, is_echoua).await.c(h!())?;
    remember_redirect(req, state.secret(), redirect).c(h!())?;
    Ok(url)
}

fn remember_redirect(
    req: &HttpRequest,
    state: &str,
    redirect: Option<&str>,
) -> anyhow::Result<()> {
    if let Some(redirect) = redirect.and_then(local_login_redirect) {
        req.get_session()
            .insert(
                format!("{DELTA_LOGIN_REDIRECT_SESSION_PREFIX}{state}"),
                redirect,
            )
            .c(h!())?;
    }
    Ok(())
}

fn take_redirect(req: &HttpRequest) -> anyhow::Result<Option<String>> {
    #[derive(Deserialize)]
    struct CallbackState {
        state: Option<String>,
    }
    let query =
        Query::<CallbackState>::from_query(req.query_string()).c(h!())?;
    let Some(state) = &query.state else {
        return Ok(None);
    };
    let key = format!("{DELTA_LOGIN_REDIRECT_SESSION_PREFIX}{state}");
    let session = req.get_session();
    let redirect = session.get::<String>(&key).c(h!())?;
    session.remove(&key);
    Ok(redirect.filter(|target| local_login_redirect(target).is_some()))
}

#[get("/api/delta-redirect")]
pub async fn handle_redirect(req: HttpRequest, env: Data<Env>) -> HttpResponse {
    let redirect = match take_redirect(&req) {
        Ok(redirect) => redirect,
        Err(e) => {
            error!("Failed to retrieve Delta login destination: {:?}", e);
            return login_response(None, Some("err_delta_login_4536"));
        }
    };
    let user_info = oauth::handle_receive_code(env.clone(), req.clone()).await;
    complete_login(&env, &req, user_info, redirect.as_deref()).await
}

async fn complete_login(
    env: &Data<Env>,
    req: &HttpRequest,
    user_info: anyhow::Result<UserInfo>,
    redirect: Option<&str>,
) -> HttpResponse {
    let api_error = match user_info {
        Ok(user_info) => {
            let user_name = user_info.user_name.clone();
            match perform_login(env, req, user_info).await {
                Ok(None) => None,
                Ok(Some(_)) => Some("err_delta_login_3278"),
                Err(e) => {
                    error!(
                        "Failed to login, probably EXO account is missing: user_name: {user_name}; error: {:?}",
                        e
                    );
                    Some("err_delta_login_7639")
                }
            }
        }
        Err(e) => {
            error!("Delta API error occurred: {:?}", e);
            Some("err_delta_login_4536")
        }
    };
    login_response(redirect, api_error)
}

fn login_response(
    redirect: Option<&str>,
    api_error: Option<&'static str>,
) -> HttpResponse {
    let location = match api_error {
        Some(_) => login_redirect_url(redirect, api_error),
        None => redirect
            .and_then(local_login_redirect)
            .unwrap_or("/")
            .to_owned(),
    };
    crate::utils::http::redirect_response(
        &location,
        api_error.unwrap_or("Success. Redirecting.."),
    )
}

async fn perform_login(
    env: &Data<Env>,
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
        crate::users::start_user_session(env, req, login.id, &env.dbx)
            .await
            .context(h!())?;
        return Ok(None);
    }
    let mut login_obfuscated = login.clone();
    login_obfuscated.password = login_obfuscated
        .password
        .clone()
        .map(|_| "<...>".to_string());
    Err(AppError::BL {
        msg: format!(
            "unexpected error occurred on login attempt, login={login_obfuscated:?}"
        ),
    })
}
