use std::{cell::RefCell, pin::Pin, rc::Rc, task::Poll, time::Instant};

use actix_web::{
    body::MessageBody,
    dev::{Decompress, Payload, ServiceRequest, ServiceResponse},
    error::PayloadError,
    http::{
        header::{self, HeaderMap, HeaderValue},
        StatusCode,
    },
    middleware::Next,
    web, Error, HttpMessage, HttpResponse,
};
use bytes::{Bytes, BytesMut};
use futures_util::{stream, Stream, StreamExt};
use serde::de::{Error as _, MapAccess, Visitor};
use serde::Deserializer;

use crate::types::Env;

use crate::config::{
    DEVICE_UPLOAD_FINALIZATION_COMPLETE_BODY_BYTES,
    SERVER_JSON_PAYLOAD_MAX_BYTES,
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum AdmissionOutcome {
    CapacityUnavailable,
    Replayed,
}

pub(crate) fn mark_response(
    mut response: HttpResponse,
    outcome: AdmissionOutcome,
) -> HttpResponse {
    response.extensions_mut().insert(outcome);
    response
}

pub(crate) async fn file<B: MessageBody + 'static>(
    request: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<B>, Error> {
    inspect(
        request,
        next,
        DEVICE_UPLOAD_FINALIZATION_COMPLETE_BODY_BYTES,
        "file",
    )
    .await
}

pub(crate) async fn audio<B: MessageBody + 'static>(
    request: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<B>, Error> {
    inspect(request, next, SERVER_JSON_PAYLOAD_MAX_BYTES, "audio").await
}

async fn inspect<B: MessageBody + 'static>(
    mut request: ServiceRequest,
    next: Next<B>,
    limit: usize,
    kind: &'static str,
) -> Result<ServiceResponse<B>, Error> {
    let started = Instant::now();
    let metrics = request
        .app_data::<web::Data<Env>>()
        .and_then(|env| env.metrics.clone());
    let headers = request.headers().clone();
    let captured = observe(&mut request, limit);
    let result = next.call(request).await;
    let captured = std::mem::take(&mut *captured.borrow_mut());
    let asynchronous =
        probe(&captured.prefix, &headers, limit, kind == "audio").await;
    if !asynchronous && captured.complete && !captured.truncated {
        return result;
    }
    let status = match &result {
        Ok(response) => response.status(),
        Err(error) => error.as_response_error().status_code(),
    };
    if let Some(metrics) = metrics.filter(|_| asynchronous) {
        let marked = result.as_ref().ok().and_then(|response| {
            response
                .response()
                .extensions()
                .get::<AdmissionOutcome>()
                .copied()
        });
        let outcome = match (marked, status) {
            (Some(AdmissionOutcome::CapacityUnavailable), _) => {
                "capacity_unavailable"
            }
            (Some(AdmissionOutcome::Replayed), _) => "replayed",
            (_, StatusCode::ACCEPTED) => "accepted",
            (_, StatusCode::OK) => "replayed",
            (_, StatusCode::TOO_MANY_REQUESTS) => "capacity_unavailable",
            (_, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                "forbidden"
            }
            (
                _,
                StatusCode::BAD_REQUEST
                | StatusCode::PRECONDITION_FAILED
                | StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ) => "invalid_request",
            (_, status) if status.is_server_error() => "unavailable",
            _ => "rejected",
        };
        metrics.record_upload_finalization_admission(
            kind,
            outcome,
            started.elapsed(),
        );
    }
    result
        .map(|mut response| {
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            );
            response
        })
        .map_err(|error| {
            let mut response = error.error_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            );
            actix_web::error::InternalError::from_response(error, response)
                .into()
        })
}

#[derive(Default)]
struct CapturedBody {
    prefix: BytesMut,
    complete: bool,
    truncated: bool,
}

fn observe(
    request: &mut ServiceRequest,
    limit: usize,
) -> Rc<RefCell<CapturedBody>> {
    let captured = Rc::new(RefCell::new(CapturedBody::default()));
    let observed = captured.clone();
    let mut payload = request.take_payload();
    let stream: Pin<Box<dyn Stream<Item = Result<Bytes, PayloadError>>>> =
        Box::pin(stream::poll_fn(move |context| {
            let chunk = Pin::new(&mut payload).poll_next(context);
            match &chunk {
                Poll::Ready(Some(Ok(bytes))) => {
                    let mut observed = observed.borrow_mut();
                    let consumed =
                        bytes.len().min(limit - observed.prefix.len());
                    observed.prefix.extend_from_slice(&bytes[..consumed]);
                    observed.truncated |= consumed < bytes.len();
                }
                Poll::Ready(None) => observed.borrow_mut().complete = true,
                _ => {}
            }
            chunk
        }));
    request.set_payload(Payload::from(stream));
    captured
}

async fn probe(
    prefix: &[u8],
    headers: &HeaderMap,
    limit: usize,
    decode: bool,
) -> bool {
    if !decode || !headers.contains_key(header::CONTENT_ENCODING) {
        return explicit_async(prefix);
    }
    let raw =
        stream::iter([Ok::<_, PayloadError>(Bytes::copy_from_slice(prefix))]);
    let mut decoded = Decompress::from_headers(raw, headers);
    let mut json = BytesMut::new();
    while json.len() < limit {
        let Some(Ok(chunk)) = decoded.next().await else {
            break;
        };
        let consumed = chunk.len().min(limit - json.len());
        json.extend_from_slice(&chunk[..consumed]);
        if explicit_async(&json) {
            return true;
        }
    }
    false
}

fn explicit_async(prefix: &[u8]) -> bool {
    struct AsyncFlag<'a>(&'a mut bool);

    impl<'de> Visitor<'de> for AsyncFlag<'_> {
        type Value = ();

        fn expecting(
            &self,
            formatter: &mut std::fmt::Formatter,
        ) -> std::fmt::Result {
            formatter.write_str("an upload finalization request object")
        }

        fn visit_map<M: MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<(), M::Error> {
            while let Ok(Some(key)) = map.next_key::<String>() {
                if key == "async_finalization" {
                    if matches!(map.next_value::<bool>(), Ok(true)) {
                        *self.0 = true;
                        // Keep the marker even when later input is invalid or too large.
                        return Err(M::Error::custom(
                            "async finalization detected",
                        ));
                    }
                } else if map.next_value::<serde::de::IgnoredAny>().is_err() {
                    break;
                }
            }
            Ok(())
        }
    }

    let mut asynchronous = false;
    let _ = serde_json::Deserializer::from_slice(prefix)
        .deserialize_map(AsyncFlag(&mut asynchronous));
    asynchronous
}
