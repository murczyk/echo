use super::{start_user_session, validate_login};
use crate::config::SESSION_CLI_HOST_SUFFIX;
use crate::error::AppError;
use crate::h;
use crate::server::{identity_middleware, session_middleware};
use crate::types::{Env, Mode, ShortContext};
use actix_session::storage::RedisSessionStore;
use actix_web::cookie::Cookie;
use actix_web::test::{call_service, init_service, TestRequest};
use actix_web::{web, App, HttpRequest, HttpResponse};
use std::sync::Arc;
use uuid::Uuid;

#[derive(clap::Parser, Debug)]
pub struct IssueSessionPs {
    /// Login that the session belongs to.
    #[arg(long)]
    pub login: String,
}

/// Prints a session cookie for staging checks. See DEVELOPMENT.md.
pub async fn issue_session(
    mode: Mode,
    ps: IssueSessionPs,
) -> anyhow::Result<()> {
    let config = crate::config::read_config(mode).c(h!())?;
    ensure_staging_host(&config.public_host).c(h!())?;
    let env = crate::server::new_env(mode).await.c(h!())?;
    let cookie = issued_cookie(env, &ps.login).await.c(h!())?;
    println!("{}={}", cookie.name(), cookie.value());
    Ok(())
}

fn ensure_staging_host(public_host: &str) -> anyhow::Result<()> {
    let host_name = public_host.split('.').next().unwrap_or_default();
    anyhow::ensure!(
        host_name.ends_with(SESSION_CLI_HOST_SUFFIX),
        "issue-session only runs on staging, not on {public_host}"
    );
    Ok(())
}

// Runs the server's real login behind its real middleware, so the cookie
// never depends on how actix encodes a session.
async fn issued_cookie(
    env: Arc<Env>,
    login: &str,
) -> anyhow::Result<Cookie<'static>> {
    let validation = validate_login(&env.dbx, login).await.c(h!())?;
    if let Some(error) = validation.validation_error {
        return Err(error).c(h!());
    }
    let login_id = validation.login_model.c(h!())?.id;
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).c(h!())?)
            .await
            .c(h!())?;
    let secret = env.config.cookie_session_secret.clone();
    let app = init_service(
        App::new()
            .app_data(web::Data::from(env))
            .app_data(web::Data::new(login_id))
            .wrap(identity_middleware())
            .wrap(session_middleware(store, &secret))
            .route("/issue-session", web::post().to(start_session)),
    )
    .await;
    let response = call_service(
        &app,
        TestRequest::post().uri("/issue-session").to_request(),
    )
    .await;
    anyhow::ensure!(
        response.status().is_success(),
        "login failed with {}",
        response.status()
    );
    let cookie = response.response().cookies().next().c(h!())?;
    Ok(cookie.into_owned())
}

async fn start_session(
    env: web::Data<Env>,
    request: HttpRequest,
    login_id: web::Data<Uuid>,
) -> Result<HttpResponse, AppError> {
    start_user_session(&env, &request, *login_id.get_ref(), &env.dbx)
        .await
        .c(h!())?;
    Ok(HttpResponse::NoContent().finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::login;
    use crate::functest::tests::{
        cleanup, mk_login, mk_organism, mk_test_identity,
    };
    use actix_identity::Identity;
    use actix_session::Session;
    use actix_web::test::read_body;
    use sea_orm::Set;
    use serial_test::serial;

    async fn session_summary(user: Identity, session: Session) -> String {
        let session_id = crate::event_stream::get_session_id(&session).unwrap();
        format!("{} {}", user.id().unwrap(), session_id.is_some())
    }

    #[test]
    fn only_staging_hosts_can_issue_sessions() {
        for host in [
            "echo-staging.eagle-atria.ts.net",
            "echo-cbr-staging.raptor-tench.ts.net",
        ] {
            assert!(ensure_staging_host(host).is_ok(), "{host}");
        }
        for host in [
            "echo-cbr.raptor-tench.ts.net",
            "echo-kharkiv2.comet-vernier.ts.net",
            "echo-kupiansk.husky-insen.ts.net",
            "echo.staging-looking.ts.net",
            "localhost",
            "",
        ] {
            assert!(ensure_staging_host(host).is_err(), "{host}");
        }
    }

    // A cookie alone would pass auth but break event streams, which need the
    // session id that a real login stores.
    #[serial]
    #[tokio::test]
    async fn issued_cookie_opens_a_real_session_for_that_login() {
        let env = cleanup().await.unwrap();
        let identity = mk_test_identity().await.unwrap();
        let login_id =
            crate::users::login_id_by_name(&env.dbx, &identity.login)
                .await
                .unwrap();

        let cookie = issued_cookie(env.clone(), &identity.login).await.unwrap();

        let store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = init_service(
            App::new()
                .wrap(identity_middleware())
                .wrap(session_middleware(
                    store,
                    &env.config.cookie_session_secret,
                ))
                .route("/session", web::get().to(session_summary)),
        )
        .await;
        let response = call_service(
            &app,
            TestRequest::get()
                .uri("/session")
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        assert_eq!(
            read_body(response).await,
            format!("{login_id} true").as_bytes()
        );
    }

    #[serial]
    #[tokio::test]
    async fn logins_that_cannot_sign_in_get_no_cookie() {
        let env = cleanup().await.unwrap();
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let login_in_organism = |deleted| login::ActiveModel {
            organism_id: Set(Some(organism.id)),
            deleted: Set(deleted),
            ..Default::default()
        };
        let active =
            mk_login(&env.dbx, login_in_organism(false)).await.unwrap();
        let deleted =
            mk_login(&env.dbx, login_in_organism(true)).await.unwrap();

        assert!(issued_cookie(env.clone(), &active.login).await.is_ok());
        assert!(issued_cookie(env.clone(), &deleted.login).await.is_err());
        assert!(issued_cookie(env, "no-such-login").await.is_err());
    }
}
