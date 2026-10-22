use super::*;
use crate::functest::tests::{cleanup_locked, find_test_login};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{cookie::Key, test, web, App};
use serial_test::serial;

#[derive(Deserialize)]
struct BeginQuery {
    state: String,
    redirect: Option<String>,
}

async fn begin_callback_fixture(
    req: HttpRequest,
    query: Query<BeginQuery>,
) -> Result<HttpResponse, AppError> {
    remember_redirect(&req, &query.state, query.redirect.as_deref()).c(h!())?;
    Ok(HttpResponse::Found()
        .insert_header(("Location", "/"))
        .finish())
}

async fn finish_callback_fixture(
    req: HttpRequest,
    env: Data<Env>,
) -> Result<HttpResponse, AppError> {
    let redirect = take_redirect(&req).c(h!())?;
    let user_info = UserInfo {
        user_name: "Tester".to_owned(),
    };
    Ok(complete_login(&env, &req, Ok(user_info), redirect.as_deref()).await)
}

// Regression: https://github.com/echoua/echo/issues/3665
#[actix_web::test]
#[serial]
async fn issue_3665_delta_callbacks_restore_and_consume_their_own_destination()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let delta_login = delta_login::ActiveModel {
        login: Set("Tester".to_owned()),
        created_at: Set(Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let mut login =
        find_test_login(&env.dbx).await.unwrap().into_active_model();
    login.delta_login_id = Set(Some(delta_login.id));
    login.update(&env.dbx).await.unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(sessions, Key::generate()))
            .app_data(Data::from(env))
            .route("/test/begin", web::get().to(begin_callback_fixture))
            .route("/test/finish", web::get().to(finish_callback_fixture))
            .service(handle_redirect),
    )
    .await;
    let destination = "/rer-analysis-neo?m=01a10624-3a80-7972-9fbf-ea5eb1a9cb36&source=http%3A%2F%2Fexample.test#message";
    let encoded = urlencoding::encode(destination);
    let error_destination =
        login_redirect_url(Some(destination), Some("err_delta_login_4536"));
    let cases = [
        (format!("/test/begin?state=first&redirect={encoded}"), "/".to_owned()),
        ("/test/begin?state=second&redirect=%2Frer-duty-neo%3Fgroup%3Da%23message".to_owned(), "/".to_owned()),
        ("/test/finish?state=first".to_owned(), destination.to_owned()),
        ("/test/finish?state=first".to_owned(), "/".to_owned()),
        ("/test/finish?state=unknown".to_owned(), "/".to_owned()),
        ("/test/finish?state=second".to_owned(), "/rer-duty-neo?group=a#message".to_owned()),
        ("/test/finish".to_owned(), "/".to_owned()),
        (format!("/test/begin?state=failure&redirect={encoded}"), "/".to_owned()),
        ("/api/delta-redirect?state=failure".to_owned(), error_destination),
        ("/api/delta-redirect?state=failure".to_owned(), "/login?api_error=err_delta_login_4536".to_owned()),
        ("/test/begin?state=unsafe&redirect=%2F%2Fexternal.test".to_owned(), "/".to_owned()),
        ("/test/finish?state=unsafe".to_owned(), "/".to_owned()),
    ];
    let mut cookie = None;
    for (uri, expected) in cases {
        let mut request = test::TestRequest::get().uri(&uri);
        if let Some(cookie) = cookie.clone() {
            request = request.cookie(cookie);
        }
        let response = test::call_service(&app, request.to_request()).await;
        if let Some(next_cookie) = response.response().cookies().next() {
            cookie = Some(next_cookie.into_owned());
        }
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::FOUND,
            "{uri}"
        );
        assert_eq!(
            response
                .headers()
                .get("Location")
                .unwrap()
                .to_str()
                .unwrap(),
            expected,
            "{uri}"
        );
    }
}

#[actix_web::test]
async fn oversized_login_redirects_preserve_destination_without_large_headers_3780(
) {
    let destination = format!("/rer-analysis-neo?filter={}&tail=\"</script><script>globalThis.injected=true</script>", "a".repeat(12_000));
    for error in [None, Some("err_delta_login_4536")] {
        let response = login_response(Some(&destination), error);
        assert_eq!(response.status(), actix_web::http::StatusCode::OK);
        assert!(!response.headers().contains_key("Location"));
        let header_bytes: usize = response
            .headers()
            .iter()
            .map(|(name, value)| {
                name.as_str().len() + value.as_bytes().len() + 4
            })
            .sum();
        assert!(header_bytes < crate::config::HTTP_REDIRECT_MAX_HEADER_BYTES);
        let csp = response
            .headers()
            .get("Content-Security-Policy")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let nonce = csp
            .split("'nonce-")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap();
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains(&format!("nonce=\"{nonce}\"")));
        assert!(!body.contains("</script><script>"));
        let encoded = body
            .split("location.replace(")
            .nth(1)
            .unwrap()
            .split(")</script>")
            .next()
            .unwrap();
        let actual: String = serde_json::from_str(encoded).unwrap();
        assert_eq!(
            actual,
            match error {
                Some(error) =>
                    login_redirect_url(Some(&destination), Some(error)),
                None => destination.clone(),
            }
        );
    }
}
