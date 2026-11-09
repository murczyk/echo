#[cfg(test)]
use crate::config::ANALYTICS_HTTP_READ_TIMEOUT_MS;
use crate::error::AppError;
use actix_web::{
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    Error, HttpMessage,
};
#[cfg(test)]
use std::time::Duration;

fn has_read_deadline(path: &str) -> bool {
    path.starts_with("/api/rer/analysis/stats/")
        || matches!(
            path,
            "/api/rer/analysis/stats"
                | "/api/rer/analysis/callsigns-page"
                | "/api/rer/analysis/summary-table-freq"
                | "/api/rer/analysis/ai/frequency-summary"
                | "/api/rer/analysis/correlated-freqs"
                | "/api/rer/analysis/new-callsigns"
                | "/api/rer/analysis/activity-daily"
                | "/api/rer/analysis/callsign-relations"
                | "/api/rer/analysis/callsign-frequency-matches"
                | "/api/rer-importer/get-inbox"
                | "/api/rer-importer/get-inbox-map"
                | "/api/rer-importer/get-inbox-group-stats"
                | "/api/rer-importer/get-inbox-count"
                | "/api/rer-importer/get-inbox-unit-stats"
                | "/api/rer-importer/messages-by-id-matching-filters"
                | "/api/sigint/freqs"
                | "/api/sigint/freqs-v2"
                | "/api/sigint/freqs-for-period"
                | "/api/sigint/freqs/daily"
                | "/api/sigint/freqs/alt-unit"
                | "/api/sigint/network-group-activity"
                | "/api/sigint/network-group-activity-one"
                | "/api/sigint/network-group-activity-summary"
        )
}

pub(super) async fn enforce<B: MessageBody>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<B>, Error> {
    if !has_read_deadline(req.path()) {
        return next.call(req).await;
    }
    let path = req.path().to_owned();
    let request_id = req
        .extensions()
        .get::<crate::read_query::RequestId>()
        .map(|id| id.0.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let source_pools = req
        .app_data::<actix_web::web::Data<crate::types::Env>>()
        .map(|env| {
            let mut pools = vec![crate::read_query::pool_identity(&env.dbx)];
            pools.extend(env.replicas.iter().map(|replica| {
                crate::read_query::pool_identity(&replica.conn)
            }));
            pools
        })
        .unwrap_or_default();
    let search_timeouts = req
        .app_data::<actix_web::web::Data<crate::types::Env>>()
        .and_then(|env| env.config.postgres_runtime.as_ref())
        .map(|config| crate::read_query::SearchTimeouts {
            statement_ms: config.search_statement_timeout_ms,
            http_ms: config.search_http_timeout_ms,
        })
        .unwrap_or_default();
    crate::read_query::scope(request_id, source_pools, async move {
    crate::read_query::configure_search_timeouts(search_timeouts);
    if path.ends_with("/count") || path.ends_with("get-inbox-count") ||
        path.ends_with("get-inbox-unit-stats") {
        crate::read_query::set_count_request();
    }
    let started = tokio::time::Instant::now();
    match crate::read_query::with_deadline(next.call(req))
    .await
    {
        Ok(response) => response,
        Err(_) => {
            let deadline_ms = crate::read_query::http_timeout_ms();
            log::warn!(
                target: "analytics_route",
                "request_id={} path={} outcome=error reason=request_deadline elapsed_ms={} deadline_ms={deadline_ms}",
                crate::read_query::request_id(), path,
                started.elapsed().as_millis(),
            );
            let error = AppError::ServiceUnavailable {
                msg: "Перевищено час виконання запиту. Звузьте параметри пошуку та повторіть спробу.".into(),
                retry_after_secs: 1,
            };
            Err(error.into())
        }
    }
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App, HttpResponse};

    #[actix_web::test]
    async fn search_reads_extend_the_deadline_but_still_expire_3780() {
        let app = test::init_service(
            App::new()
                .wrap(actix_web::middleware::from_fn(enforce))
                .route(
                    "/api/rer/analysis/stats/messages/count",
                    web::post().to(|| async {
                        crate::read_query::set_search(&Some("needle".into()));
                        tokio::time::sleep(Duration::from_millis(
                            ANALYTICS_HTTP_READ_TIMEOUT_MS + 1,
                        ))
                        .await;
                        HttpResponse::Ok().finish()
                    }),
                )
                .route(
                    "/api/rer-importer/get-inbox",
                    web::post().to(|| async {
                        crate::read_query::set_search(&Some("needle".into()));
                        std::future::pending::<HttpResponse>().await
                    }),
                ),
        )
        .await;
        tokio::time::pause();
        let response = test::try_call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/analysis/stats/messages/count")
                .to_request(),
        );
        tokio::pin!(response);
        assert!(futures::poll!(&mut response).is_pending());
        tokio::time::advance(Duration::from_millis(
            ANALYTICS_HTTP_READ_TIMEOUT_MS,
        ))
        .await;
        assert!(futures::poll!(&mut response).is_pending());
        tokio::time::advance(Duration::from_millis(2)).await;
        assert_eq!(response.await.unwrap().status(), 200);
        let response = test::try_call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer-importer/get-inbox")
                .to_request(),
        );
        tokio::pin!(response);
        assert!(futures::poll!(&mut response).is_pending());
        tokio::time::advance(Duration::from_millis(
            crate::config::ANALYSIS_SEARCH_HTTP_TIMEOUT_MS_DEFAULT,
        ))
        .await;
        assert_eq!(response.await.unwrap_err().error_response().status(), 503);
    }

    // #3780: a queued read must expire even when it never executes SQL.
    #[actix_web::test]
    async fn queued_read_respects_request_deadline() {
        let queue = web::Data::new(tokio::sync::Mutex::new(()));
        let held = queue.lock().await;
        let app = test::init_service(
            App::new()
                .app_data(queue.clone())
                .wrap(actix_web::middleware::from_fn(enforce))
                .service(
                    web::resource([
                        "/api/rer/analysis/stats/messages/count",
                        "/api/rer-importer/get-inbox-unit-stats",
                    ])
                    .route(web::post().to(
                        |queue: web::Data<tokio::sync::Mutex<()>>| async move {
                            let _held = queue.lock().await;
                            HttpResponse::Ok().finish()
                        },
                    )),
                ),
        )
        .await;
        tokio::time::pause();
        for path in [
            "/api/rer/analysis/stats/messages/count",
            "/api/rer-importer/get-inbox-unit-stats",
        ] {
            let response = test::try_call_service(
                &app,
                test::TestRequest::post().uri(path).to_request(),
            );
            tokio::pin!(response);
            assert!(futures::poll!(&mut response).is_pending());
            tokio::time::advance(Duration::from_millis(
                ANALYTICS_HTTP_READ_TIMEOUT_MS,
            ))
            .await;
            let response = response.await.unwrap_err().error_response();
            assert_eq!(response.status(), 503);
            assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        }
        drop(held);
        assert!(queue.try_lock().is_ok());
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn deadline_retains_request_and_actual_503_response_3780() {
        use crate::server::middleware::{
            mk_activity_middleware, ActivityDetails,
        };
        use redis::AsyncCommands;
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let mut redis = crate::new_redis_for_db(&config, 15).await.unwrap();
        let entered = web::Data::new(tokio::sync::Notify::new());
        let request_id =
            std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let recorded_id = request_id.clone();
        let app = test::init_service(App::new()
            .app_data(entered.clone())
            .wrap(actix_web::middleware::from_fn(enforce))
            .wrap(actix_web::middleware::from_fn(mk_activity_middleware(Some(redis.clone()))))
            .route("/api/rer/analysis/stats/messages/count", web::post().to(move |req: actix_web::HttpRequest, entered: web::Data<tokio::sync::Notify>| {
                let recorded_id = recorded_id.clone();
                async move {
                    *recorded_id.lock().unwrap() = Some(req.extensions().get::<crate::read_query::RequestId>().unwrap().0.clone());
                    entered.notify_one();
                    std::future::pending::<HttpResponse>().await
                }
            }))).await;
        let running = actix_web::rt::spawn(async move {
            test::try_call_service(
                &app,
                test::TestRequest::post()
                    .uri("/api/rer/analysis/stats/messages/count")
                    .to_request(),
            )
            .await
        });
        entered.notified().await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(
            ANALYTICS_HTTP_READ_TIMEOUT_MS,
        ))
        .await;
        tokio::task::yield_now().await;
        tokio::time::resume();
        let error = running.await.unwrap().unwrap_err();
        assert_eq!(error.as_response_error().status_code(), 503);
        let request_id = request_id.lock().unwrap().clone().unwrap();
        let members: Vec<String> =
            redis.zrange("echo-md-requests", 0, -1).await.unwrap();
        let mut records = Vec::new();
        for member in members
            .into_iter()
            .filter(|member| member.contains(&request_id))
        {
            let key = format!("echo-md-requests:{member}");
            let payload: String = redis.get(&key).await.unwrap();
            records.push(
                serde_json::from_str::<ActivityDetails>(&payload).unwrap(),
            );
            let _: () = redis.zrem("echo-md-requests", member).await.unwrap();
            let _: () = redis.del(key).await.unwrap();
        }
        assert_eq!(records.len(), 2);
        assert_eq!(
            records
                .iter()
                .filter(|record| record.event_type == "request")
                .count(),
            1
        );
        let response = records
            .iter()
            .find(|record| record.event_type == "response")
            .unwrap();
        assert_eq!(response.response_status, Some(503));
        assert_eq!(response.request_id, request_id);
    }
}
