use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::cookie::Key;
use actix_web::{web, App, HttpServer};

use crate::types::Mode;

#[actix_web::test]
#[ignore = "Manual diagnostic server; reorders shadowed upload routes only in this test harness"]
async fn audit_diagnostic_upload_http_server() {
    let env = super::new_env(Mode::Debug).await.unwrap();
    assert!(env
        .config
        .pg_dbname
        .as_deref()
        .is_some_and(|name| name.starts_with("wd_test_")));
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    eprintln!("AUDIT_DIAGNOSTIC upload server 127.0.0.1:18083; test-only route ordering bypass; production routing remains unchanged");
    HttpServer::new(move || {
        let secret = env.config.cookie_session_secret.clone();
        let redis = env.redis.clone();
        App::new()
            .app_data(web::Data::from(env.clone()))
            .app_data(
                web::JsonConfig::default()
                    .limit(crate::config::SERVER_JSON_PAYLOAD_MAX_BYTES),
            )
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        crate::config::IDENTITY_DURATION_HOURS * 60 * 60,
                    )))
                    .build(),
            )
            .wrap(actix_web::middleware::from_fn(
                super::middleware::purge_legacy_identity_middleware,
            ))
            .wrap(actix_web::middleware::from_fn(
                crate::ai_agent::middleware::enforce_agent_routes,
            ))
            .wrap(SessionMiddleware::new(
                sessions.clone(),
                Key::from(secret.as_bytes()),
            ))
            .wrap(actix_web::middleware::from_fn(
                super::middleware::mk_activity_middleware(Some(redis)),
            ))
            .wrap(actix_web::middleware::from_fn(
                super::middleware::access_log_middleware,
            ))
            .configure(unit_attachment_routes)
            .configure(map_upload_routes)
            .configure(goi_routes)
            .configure(super::configure_routes)
    })
    .workers(2)
    .bind(("127.0.0.1", 18083))
    .unwrap()
    .run()
    .await
    .unwrap();
}

fn unit_attachment_routes(config: &mut web::ServiceConfig) {
    use crate::sigint::unit::attachment;
    config
        .service(attachment::unit_details)
        .service(attachment::unit_attachment_unit_ids)
        .service(attachment::upload_unit_attachment)
        .service(attachment::download_unit_attachment)
        .service(attachment::update_unit_attachment)
        .service(attachment::delete_unit_attachment);
}

fn map_upload_routes(config: &mut web::ServiceConfig) {
    config
        .service(crate::battle_line::read_battle_line)
        .service(crate::battle_line::upload_battle_line)
        .service(crate::battle_line::test_battle_line)
        .service(crate::palitra::create_palitra_with_kmz)
        .service(crate::palitra::create_palitra_basic)
        .service(crate::palitra::create_palitra_basic_v2)
        .service(crate::palitra::analyze_kmz)
        .service(crate::palitra::upload_palitra_points)
        .service(crate::palitra::read_palitra_v2)
        .service(crate::palitra::delete_palitra)
        .service(crate::alpine::convert_alpinequest_file)
        .service(crate::alpine::download_alpine_result);
}

fn goi_routes(config: &mut web::ServiceConfig) {
    use crate::organism::goi::integrations;
    config
        .service(integrations::list_admin_goi_integrations)
        .service(integrations::get_admin_goi_integration)
        .service(integrations::upsert_admin_goi_integration)
        .service(integrations::delete_admin_goi_integration)
        .service(integrations::check_goi_integration_connection)
        .service(integrations::setup_goi_integration_worker)
        .service(integrations::list_current_user_goi_integrations)
        .service(integrations::update_current_user_goi_pause_worker)
        .service(integrations::list_goi_report_tab_order)
        .service(integrations::update_goi_report_tab_order)
        .service(integrations::restart_current_user_goi_service)
        .service(integrations::unlink_current_user_goi_whatsapp)
        .service(integrations::download_current_user_goi_palettes)
        .service(integrations::upload_current_user_goi_categories)
        .service(integrations::list_current_user_goi_associations)
        .service(integrations::launch_current_user_goi_associations_report)
        .service(integrations::list_current_user_goi_knowledge);
}
