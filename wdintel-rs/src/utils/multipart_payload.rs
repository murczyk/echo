use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};

use actix_web::dev::{Payload, ServiceRequest};
use actix_web::error::PayloadError;
use actix_web::{web::Bytes, HttpMessage};
use futures_util::{Stream, StreamExt};

tokio::task_local! {
    static PAYLOAD_EOF: Rc<Cell<bool>>;
}

pub(super) async fn with_eof_tracking<F: Future>(
    mut request: ServiceRequest,
    handler: impl FnOnce(ServiceRequest) -> F,
) -> F::Output {
    let multipart = request
        .mime_type()
        .ok()
        .flatten()
        .is_some_and(|mime| mime.type_().as_str() == "multipart");
    if !multipart {
        return handler(request).await;
    }
    let reached_eof = Rc::new(Cell::new(false));
    let payload = EofTrackingPayload {
        payload: request.take_payload(),
        reached_eof: reached_eof.clone(),
    };
    request.set_payload(payload.boxed_local().into());
    PAYLOAD_EOF.scope(reached_eof, handler(request)).await
}

pub(super) fn has_reached_eof() -> bool {
    PAYLOAD_EOF.try_with(|eof| eof.get()).unwrap_or(false)
}

struct EofTrackingPayload {
    payload: Payload,
    reached_eof: Rc<Cell<bool>>,
}

impl Stream for EofTrackingPayload {
    type Item = Result<Bytes, PayloadError>;

    fn poll_next(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let payload = self.get_mut();
        let result = Pin::new(&mut payload.payload).poll_next(context);
        if matches!(result, Poll::Ready(None)) {
            payload.reached_eof.set(true);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App, HttpResponse};
    use std::time::Duration;

    async fn read_fields(
        mut payload: actix_multipart::Multipart,
    ) -> Result<HttpResponse, crate::error::AppError> {
        let mut values = Vec::new();
        while let Some(field) =
            super::super::multipart::next(&mut payload).await?
        {
            let mut field =
                field.map_err(super::super::multipart::to_app_error)?;
            values.extend(
                super::super::multipart::read_field_limited(&mut field, 1024)
                    .await?,
            );
        }
        Ok(HttpResponse::Ok().body(values))
    }

    #[actix_web::test]
    async fn truncated_fields_release_admission_without_idle_timeout() {
        let app = test::init_service(
            App::new()
                .wrap(actix_web::middleware::from_fn(
                    super::super::multipart_admission::limit_requests,
                ))
                .default_service(actix_web::web::to(read_fields)),
        )
        .await;
        let mut bodies = ["", "\r", "\r\n", "\r\n--te", "\r\n--test-"]
            .map(|suffix| format!("--test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\npartial{suffix}"))
            .to_vec();
        let embedded = "\r\n--test--\r\n";
        bodies.push(format!("--test\r\nContent-Disposition: form-data; name=\"first\"\r\nContent-Length: {}\r\n\r\n{embedded}\r\n--test\r\nContent-Disposition: form-data; name=\"second\"\r\n\r\ntruncated\r\n", embedded.len()));
        for body in bodies {
            let request = test::TestRequest::post()
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=test",
                ))
                .set_payload(body)
                .to_request();
            let response = tokio::time::timeout(Duration::from_secs(1), test::call_service(&app, request))
                .await.expect("EOF must release the upload slot without waiting for the idle timeout");
            assert_eq!(response.status(), 400);
            test::read_body(response).await;
        }
        let request = test::TestRequest::post()
            .insert_header(("content-type", "multipart/form-data; boundary=test"))
            .set_payload("--test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\noriginal\r\n--test--\r\nepilogue")
            .to_request();
        assert_eq!(test::call_and_read_body(&app, request).await, "original");
    }

    #[actix_web::test]
    async fn eof_scope_preserves_buffered_fields_and_isolates_pending_requests()
    {
        let finished = PAYLOAD_EOF.scope(Rc::new(Cell::new(true)), async {
            let mut ready = futures_util::stream::iter([b"original"]);
            assert_eq!(
                super::super::multipart::next(&mut ready).await.unwrap(),
                Some(b"original")
            );
            tokio::task::yield_now().await;
            let mut pending = futures_util::stream::pending::<Bytes>();
            assert!(super::super::multipart::next(&mut pending).await.is_err());
        });
        let waiting = PAYLOAD_EOF.scope(Rc::new(Cell::new(false)), async {
            let mut pending = futures_util::stream::pending::<Bytes>();
            assert!(tokio::time::timeout(
                Duration::from_millis(25),
                super::super::multipart::next(&mut pending)
            )
            .await
            .is_err());
        });
        tokio::join!(finished, waiting);
        assert!(!has_reached_eof());
    }
}
