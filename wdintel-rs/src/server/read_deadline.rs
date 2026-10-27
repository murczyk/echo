use crate::config::ANALYTICS_HTTP_READ_TIMEOUT_MS;
use crate::error::AppError;
use actix_web::{
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    Error,
};
use std::time::Duration;

fn has_read_deadline(path: &str) -> bool {
    path.starts_with("/api/rer/analysis/stats/")
        || matches!(
            path,
            "/api/rer/analysis/stats"
                | "/api/rer/analysis/callsigns-page"
                | "/api/rer/analysis/summary-table-freq"
                | "/api/rer/analysis/correlated-freqs"
                | "/api/rer/analysis/new-callsigns"
                | "/api/rer/analysis/activity-daily"
                | "/api/rer/analysis/callsign-relations"
                | "/api/rer/analysis/callsign-frequency-matches"
                | "/api/rer-importer/get-inbox"
                | "/api/rer-importer/get-inbox-map"
                | "/api/rer-importer/get-inbox-group-stats"
                | "/api/rer-importer/get-inbox-count"
                | "/api/rer-importer/messages-by-id-matching-filters"
                | "/api/sigint/freqs"
                | "/api/sigint/freqs-v2"
                | "/api/sigint/freqs-for-period"
                | "/api/sigint/freqs/daily"
                | "/api/sigint/freqs/alt-unit"
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
    let started = tokio::time::Instant::now();
    match tokio::time::timeout(
        Duration::from_millis(ANALYTICS_HTTP_READ_TIMEOUT_MS),
        next.call(req),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => {
            log::warn!(
                target: "analytics_route",
                "path={} outcome=error reason=request_deadline elapsed_ms={} deadline_ms={ANALYTICS_HTTP_READ_TIMEOUT_MS}",
                path,
                started.elapsed().as_millis(),
            );
            let error = AppError::ServiceUnavailable {
                msg: "Перевищено час виконання запиту. Звузьте параметри пошуку та повторіть спробу.".into(),
                retry_after_secs: 1,
            };
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App, HttpResponse};

    // #3780: a queued read must expire even when it never executes SQL.
    #[actix_web::test]
    async fn queued_read_respects_request_deadline() {
        let queue = web::Data::new(tokio::sync::Mutex::new(()));
        let held = queue.lock().await;
        let app = test::init_service(
            App::new()
                .app_data(queue.clone())
                .wrap(actix_web::middleware::from_fn(enforce))
                .route(
                    "/api/rer/analysis/stats/messages/count",
                    web::post().to(
                        |queue: web::Data<tokio::sync::Mutex<()>>| async move {
                            let _held = queue.lock().await;
                            HttpResponse::Ok().finish()
                        },
                    ),
                ),
        )
        .await;
        let response = test::try_call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/rer/analysis/stats/messages/count")
                .to_request(),
        );
        tokio::pin!(response);
        assert!(futures::poll!(&mut response).is_pending());
        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(
            ANALYTICS_HTTP_READ_TIMEOUT_MS,
        ))
        .await;
        let response = response.await.unwrap_err().error_response();
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        drop(held);
        assert!(queue.try_lock().is_ok());
    }
}
