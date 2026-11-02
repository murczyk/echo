use crate::entities::{datasource, echo_client_lock};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use crate::users::ensure_admin;
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use xshell::{cmd, Shell};

#[post("/api/admin/restart-datasource")]
pub async fn restart_datasource(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i32>,
) -> Result<Json<bool>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let datasource_id = req.into_inner();
    crate::datasource::native::require_external_datasource(
        &env.dbx,
        i64::from(datasource_id),
    )
    .await
    .c(h!())?;
    let client_id = datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            datasource::Relation::EchoClientLock.def(),
        )
        .filter(datasource::Column::Id.eq(datasource_id))
        .select_only()
        .column(echo_client_lock::Column::ClientId)
        .into_tuple::<i32>()
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    let options = crate::messenger::signal_restart::signal_worker_options(
        crate::messenger::signal_restart::RedisSignalRestartCoordinator::new(
            env.redis.clone(),
        ),
        None,
    );
    echo_im::restart_client_with_options(&env.dbx, client_id, &options)
        .await
        .c(h!())?;
    Ok(Json(true))
}

#[post("/api/admin/restart-echo")]
pub async fn restart_echo(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<RestartEchoRequest>,
) -> Result<Json<bool>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let mut args = Vec::new();
    if req.restart_postgres.unwrap_or(false) {
        args.push("--restart-postgres=true");
    }
    if req.restart_outdated_sources.unwrap_or(false) {
        args.push("--restart-messengers=true");
    }
    let sh = Shell::new().c(h!())?;
    let mode = env.mode.to_string().to_lowercase();
    cmd!(
        sh,
        "sudo wdintel-rs --mode {mode} oneoff-restart-echo {args...}"
    )
    .run()
    .context(h!())?;
    Ok(Json(true))
}

#[post("/api/admin/restart-report-worker")]
pub async fn restart_report_worker(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<bool>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let output = tokio::process::Command::new("systemctl")
        .args(["restart", crate::config::REPORT_HISTORY_WORKER_SERVICE])
        .output()
        .await
        .c(h!())?;
    if !output.status.success() {
        return Err(AppError::BL {
            msg: format!(
                "Не вдалося перезапустити обробник звітів: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    Ok(Json(true))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RestartEchoRequest {
    pub restart_postgres: Option<bool>,
    pub restart_outdated_sources: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        cookie::Key, http::StatusCode, test, web, App, HttpMessage,
        HttpRequest, HttpResponse,
    };

    async fn login(
        req: HttpRequest,
        id: web::Path<uuid::Uuid>,
    ) -> HttpResponse {
        Identity::login(&req.extensions(), id.to_string()).unwrap();
        HttpResponse::Ok().finish()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn issue_3974_report_worker_restart_requires_admin_before_running_systemctl(
    ) {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let actor = crate::functest::tests::mk_login(
            &env.dbx,
            crate::entities::login::ActiveModel {
                roles: Set(serde_json::json!(["Rer"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::from(env))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(store, Key::generate()))
                .route("/test-login/{id}", web::post().to(login))
                .service(restart_report_worker),
        )
        .await;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/restart-report-worker")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test-login/{}", actor.id))
                .to_request(),
        )
        .await;
        let cookie = response.response().cookies().next().unwrap().into_owned();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/admin/restart-report-worker")
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
