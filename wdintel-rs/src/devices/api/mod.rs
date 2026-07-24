use actix_web::web;
mod device;
mod files;
mod json;
mod mapping;
mod request;
pub mod types;

pub(crate) fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(device::list)
        .service(device::unit_stats)
        .service(device::detail)
        .service(device::create)
        .service(device::update)
        .service(files::roots)
        .service(files::browse)
        .service(files::search)
        .service(files::sync);
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::config::IDENTITY_DURATION_HOURS;
    use crate::types::Mode;
    use actix_identity::IdentityMiddleware;
    use actix_session::storage::RedisSessionStore;
    use actix_session::SessionMiddleware;
    use actix_web::cookie::Key;
    use actix_web::{http::StatusCode, test, App};

    const TARGET_ROUTES: [&str; 9] = [
        "/api/device/list",
        "/api/device/unit-stats",
        "/api/device/detail",
        "/api/device/create",
        "/api/device/update",
        "/api/device/files/roots",
        "/api/device/files/browse",
        "/api/device/files/search",
        "/api/device/files/sync",
    ];

    const EXCLUDED_ROUTES: [&str; 8] = [
        "/api/device/archive",
        "/api/device/restore",
        "/api/device/files/list",
        "/api/device/files/create",
        "/api/device/files/roots/create",
        "/api/device/files/hide",
        "/api/device/files/restore",
        "/api/device/files/content",
    ];

    #[actix_web::test]
    async fn target_route_matrix_has_only_nine_post_routes() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let redis_session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = test::init_service(
            App::new()
                .wrap(
                    IdentityMiddleware::builder()
                        .visit_deadline(Some(std::time::Duration::from_secs(
                            IDENTITY_DURATION_HOURS * 60 * 60,
                        )))
                        .build(),
                )
                .wrap(SessionMiddleware::new(
                    redis_session_store,
                    Key::generate(),
                ))
                .configure(configure_routes),
        )
        .await;

        for path in TARGET_ROUTES {
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(path)
                    .insert_header(("content-type", "application/json"))
                    .set_payload("{")
                    .to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "POST {path} must be registered and authenticate first",
            );

            let response = test::call_service(
                &app,
                test::TestRequest::get().uri(path).to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "GET {path} must not be registered",
            );
        }

        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/device/list")
                .insert_header(("content-type", "application/json"))
                .insert_header((
                    "content-length",
                    (crate::config::SERVER_JSON_PAYLOAD_MAX_BYTES + 1)
                        .to_string(),
                ))
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "oversized unauthenticated requests must authenticate first",
        );

        for path in EXCLUDED_ROUTES {
            let response = test::call_service(
                &app,
                test::TestRequest::post().uri(path).to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "POST {path} must stay excluded",
            );
        }
    }
}
