use std::future::{ready, Ready};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};

use actix_web::body::{BodySize, EitherBody, MessageBody};
use actix_web::dev::{Payload, ServiceRequest, ServiceResponse};
use actix_web::middleware::Next;
use actix_web::{web::Bytes, Error, FromRequest, HttpMessage, HttpRequest};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::MULTIPART_MAX_CONCURRENT_BUFFERED_REQUESTS;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;

static ADMISSION: LazyLock<Arc<Semaphore>> = LazyLock::new(|| {
    Arc::new(Semaphore::new(MULTIPART_MAX_CONCURRENT_BUFFERED_REQUESTS))
});

#[derive(Clone, Default)]
pub struct MultipartAdmission {
    _permit: Option<Arc<OwnedSemaphorePermit>>,
}

impl FromRequest for MultipartAdmission {
    type Error = Error;
    type Future = Ready<Result<Self, Error>>;

    fn from_request(request: &HttpRequest, _: &mut Payload) -> Self::Future {
        ready(Ok(request
            .extensions()
            .get::<Self>()
            .cloned()
            .unwrap_or_default()))
    }
}

pub async fn limit_requests<B: MessageBody + 'static>(
    request: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    super::multipart_payload::with_eof_tracking(request, |request| {
        limit_with_semaphore(request, next, ADMISSION.clone())
    })
    .await
}

async fn limit_with_semaphore<B: MessageBody>(
    request: ServiceRequest,
    next: Next<B>,
    admission: Arc<Semaphore>,
) -> Result<ServiceResponse<EitherBody<B, AdmissionBody<B>>>, Error> {
    let is_buffered = request.path()
        != crate::sigint::file_upload::FALLBACK_PATH
        && request
            .mime_type()
            .ok()
            .flatten()
            .is_some_and(|mime| mime.type_().as_str() == "multipart");
    if !is_buffered {
        return next
            .call(request)
            .await
            .map(ServiceResponse::map_into_left_body);
    }
    let permit = admission
        .acquire_owned()
        .await
        .c(h!())
        .map_err(AppError::from)?;
    let admission = MultipartAdmission {
        _permit: Some(Arc::new(permit)),
    };
    request.extensions_mut().insert(admission.clone());
    let response = next.call(request).await;
    response.map(|response| {
        response
            .map_body(|_, body| AdmissionBody {
                body: Box::pin(body),
                _admission: admission,
            })
            .map_into_right_body()
    })
}

struct AdmissionBody<B> {
    body: Pin<Box<B>>,
    _admission: MultipartAdmission,
}

impl<B: MessageBody> MessageBody for AdmissionBody<B> {
    type Error = B::Error;

    fn size(&self) -> BodySize {
        self.body.size()
    }

    fn poll_next(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Bytes, Self::Error>>> {
        self.get_mut().body.as_mut().poll_next(context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App, HttpResponse};

    #[actix_web::test]
    async fn buffered_upload_admission_survives_response_and_detached_work() {
        let permits = Arc::new(Semaphore::new(1));
        let task_guard =
            web::Data::new(std::sync::Mutex::new(None::<MultipartAdmission>));
        let middleware_permits = permits.clone();
        let app = test::init_service(
            App::new()
                .app_data(task_guard.clone())
                .wrap(actix_web::middleware::from_fn(move |request, next| {
                    limit_with_semaphore(
                        request,
                        next,
                        middleware_permits.clone(),
                    )
                }))
                .route(
                    "/upload",
                    web::post().to(
                        |mut payload: actix_multipart::Multipart,
                         admission: MultipartAdmission,
                         guard: web::Data<
                            std::sync::Mutex<Option<MultipartAdmission>>,
                        >| async move {
                            let (_, bytes) =
                                crate::utils::multipart::extract(&mut payload)
                                    .await
                                    .unwrap();
                            *guard.lock().unwrap() = Some(admission);
                            HttpResponse::Ok().body(bytes)
                        },
                    ),
                )
                .default_service(web::to(|| async {
                    HttpResponse::Ok().finish()
                })),
        )
        .await;
        let request = || {
            test::TestRequest::post()
                .uri("/upload")
                .insert_header(("content-type", "multipart/form-data; boundary=test"))
                .set_payload("--test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nuploaded\r\n--test--\r\n")
                .to_request()
        };
        let response = test::call_service(&app, request()).await;
        assert_eq!(permits.available_permits(), 0);
        let mut cancelled = Box::pin(test::call_service(&app, request()));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(25),
            &mut cancelled
        )
        .await
        .is_err());
        drop(cancelled);
        let mut waiting = Box::pin(test::call_service(&app, request()));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(25),
            &mut waiting
        )
        .await
        .is_err());
        for path in [crate::sigint::file_upload::FALLBACK_PATH, "/health"] {
            let mut request = test::TestRequest::post().uri(path);
            if path == crate::sigint::file_upload::FALLBACK_PATH {
                request = request.insert_header((
                    "content-type",
                    "multipart/form-data; boundary=test",
                ));
            }
            assert!(test::call_service(&app, request.to_request())
                .await
                .status()
                .is_success());
        }
        drop(response);
        assert_eq!(permits.available_permits(), 0);
        drop(task_guard.lock().unwrap().take());
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
                .await
                .unwrap();
        assert!(response.status().is_success());
        drop(task_guard.lock().unwrap().take());
        assert_eq!(permits.available_permits(), 0);
        assert_eq!(test::read_body(response).await, "uploaded");
        assert_eq!(permits.available_permits(), 1);
    }

    #[actix_web::test]
    async fn cancelled_multipart_read_releases_capacity_for_retry() {
        let permits = Arc::new(Semaphore::new(1));
        let middleware_permits = permits.clone();
        let app = test::init_service(
            App::new()
                .wrap(actix_web::middleware::from_fn(move |request, next| {
                    limit_with_semaphore(
                        request,
                        next,
                        middleware_permits.clone(),
                    )
                }))
                .default_service(web::to(
                    |mut payload: actix_multipart::Multipart| async move {
                        let (_, bytes) =
                            crate::utils::multipart::extract(&mut payload)
                                .await
                                .unwrap();
                        HttpResponse::Ok().body(bytes)
                    },
                )),
        )
        .await;
        let request = |body: &'static str| {
            test::TestRequest::post()
                .insert_header((
                    "content-type",
                    "multipart/form-data; boundary=test",
                ))
                .set_payload(body)
                .to_request()
        };
        let mut stalled = Box::pin(test::call_service(&app, request(
            "--test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\npartial\r\n"
        )));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(25),
            &mut stalled
        )
        .await
        .is_err());
        assert_eq!(permits.available_permits(), 0);
        drop(stalled);
        assert_eq!(permits.available_permits(), 1);
        let response = test::call_service(&app, request(
            "--test\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nretry\r\n--test--\r\n"
        )).await;
        assert_eq!(test::read_body(response).await, "retry");
        assert_eq!(permits.available_permits(), 1);
    }
}
