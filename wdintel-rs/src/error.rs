use anyhow::Context;
// use aws_sdk_s3::error::SdkError;
use crate::types::error;
use crate::types::warn;
use once_cell::sync::Lazy;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

static INTERNAL_SERVER_ERROR_LOGS: Lazy<Mutex<HashMap<u64, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const INTERNAL_SERVER_ERROR_LOG_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Business-logic error: {msg}")]
    BL { msg: String },
    #[error("Not found")]
    NotFound,
    #[error("Unauthenticated")]
    Unauthenticated,
    #[error("Forbidden")]
    Forbidden(String),
    #[error("Form errors")]
    Form(BTreeMap<String, String>),
    #[error("IO Error")]
    IO {
        #[from]
        source: std::io::Error,
    },
    #[error("join error")]
    JoinErr {
        #[from]
        source: tokio::task::JoinError,
    },
    #[error("fs_extra error")]
    FsExtraErr {
        #[from]
        source: fs_extra::error::Error,
    },
    #[error("anyhow error")]
    AnyhowError { source: anyhow::Error },
    #[error("notify error")]
    NotifyErr {
        #[from]
        source: notify::Error,
    },
    #[error("actix parse error")]
    ActixParseErr {
        #[from]
        source: actix_web::error::ParseError,
    },
    #[error("PayloadError")]
    PayloadError {
        #[from]
        source: actix_web::error::PayloadError,
    },
    #[error("milgeo_rs::MilGeoError")]
    MilgeoError {
        #[from]
        source: milgeo_rs::MilGeoError,
    },
}

impl From<String> for AppError {
    fn from(v: String) -> Self {
        AppError::BL { msg: v }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        for err in value.chain() {
            if let Some(AppError::Forbidden(msg)) =
                err.downcast_ref::<AppError>()
            {
                return AppError::Forbidden(msg.clone());
            }
        }
        AppError::AnyhowError { source: value }
    }
}

impl actix_web::error::ResponseError for AppError {
    fn error_response(
        &self,
    ) -> actix_web::HttpResponse<actix_web::body::BoxBody> {
        // Special-case: during graceful shutdown the Tokio runtime may reject
        // new I/O, surfacing as an IO error like
        // "A Tokio 1.x context was found, but it is being shutdown.".
        // Return 503 to clients and avoid noisy stack traces.
        if self.is_runtime_shutting_down() {
            warn!("Service unavailable during shutdown: {:?}", self);
            return actix_web::HttpResponseBuilder::new(
                actix_web::http::StatusCode::SERVICE_UNAVAILABLE,
            )
            .body("Service unavailable: server is shutting down");
        }
        match self {
            AppError::NotFound => {
                warn!(target: "not_found_details", "Not found triggered");
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::NOT_FOUND,
                )
                .body("Not found")
            }
            AppError::Unauthenticated => {
                warn!(target: "unauthenticated_details", "Unauthenticated access detected");
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::UNAUTHORIZED,
                )
                .body("Unauthenticated")
            }
            AppError::Forbidden(msg) => {
                error!(target: "forbidden_details", "Forbidden access: {msg}");
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::FORBIDDEN,
                )
                .body("Forbidden")
            }
            AppError::Form(es) => {
                error!(target: "form_error_details", "Form errors: {:?}", es);
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::BAD_REQUEST,
                )
                .body(
                    serde_json::to_string(&Vec::from_iter(es.iter())).unwrap(),
                )
            }
            AppError::BL { msg } => {
                warn!(target: "business_error", "Business logic error: {msg}");
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::BAD_REQUEST,
                )
                .body(msg.clone())
            }
            _ => {
                log_internal_server_error(self);
                match self {
                    AppError::IO { .. }
                    | AppError::JoinErr { .. }
                    | AppError::FsExtraErr { .. }
                    | AppError::AnyhowError { .. }
                    | AppError::NotifyErr { .. }
                    | AppError::ActixParseErr { .. }
                    | AppError::PayloadError { .. }
                    | AppError::MilgeoError { .. } => {
                        error!("{:#?}", self);
                    }
                    AppError::BL { .. }
                    | AppError::Form(_)
                    | AppError::NotFound
                    | AppError::Unauthenticated
                    | AppError::Forbidden(_) => {}
                }
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                )
                .body("Internal server error")
            }
        }
    }
}

fn log_internal_server_error(err: &AppError) {
    use std::hash::{Hash, Hasher};

    let fingerprint = {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        format!("{:#?}", err).hash(&mut hasher);
        hasher.finish()
    };

    let mut logs = INTERNAL_SERVER_ERROR_LOGS
        .lock()
        .expect("internal server error log state mutex poisoned");
    logs.retain(|_, last_logged_at| {
        last_logged_at.elapsed() < INTERNAL_SERVER_ERROR_LOG_COOLDOWN
    });

    let should_log = match logs.get_mut(&fingerprint) {
        Some(last_logged_at) => {
            if last_logged_at.elapsed() < INTERNAL_SERVER_ERROR_LOG_COOLDOWN {
                false
            } else {
                *last_logged_at = Instant::now();
                true
            }
        }
        None => {
            logs.insert(fingerprint, Instant::now());
            true
        }
    };

    if should_log {
        error!("Internal server error: {:?}", err);
    }
}

impl From<&str> for AppError {
    fn from(v: &str) -> Self {
        AppError::BL { msg: v.to_string() }
    }
}

impl AppError {
    /// Detects the Tokio/SQLx shutdown sentinel propagated when the runtime is terminating.
    ///
    /// The string "A Tokio 1.x context was found, but it is being shutdown." originates in
    /// Tokio's runtime guard (see tokio-rs/tokio#4091). SQLx/SeaORM surface the same text when
    /// the connection pool is torn down during graceful shutdown.
    fn is_runtime_shutting_down(&self) -> bool {
        fn message_indicates_shutdown(msg: &str) -> bool {
            msg.contains("Tokio 1.x context") && msg.contains("being shutdown")
        }

        fn chain_has_shutdown(err: &dyn StdError) -> bool {
            let mut cur: Option<&dyn StdError> = Some(err);
            while let Some(e) = cur {
                if message_indicates_shutdown(&e.to_string()) {
                    return true;
                }
                cur = e.source();
            }
            false
        }

        match self {
            AppError::AnyhowError { source } => {
                chain_has_shutdown(source.as_ref())
            }
            AppError::IO { source } => chain_has_shutdown(source),
            _ => false,
        }
    }
}

impl From<sea_orm::DbErr> for AppError {
    fn from(value: sea_orm::DbErr) -> Self {
        AppError::AnyhowError {
            source: anyhow::Error::new(value),
        }
    }
}

/// Trait that combines context addition and error conversion to AppError
pub trait ContextAndError<T, E> {
    /// Add context to an error and convert it to AppError
    ///
    /// cae stands for "Context and Error"
    fn cae(self, ctx: impl Into<String>) -> Result<T, AppError>;
}

// Implementation for any Result with an error that can be converted to anyhow::Error
impl<T, E> ContextAndError<T, E> for Result<T, E>
where
    E: std::error::Error + Send + Sync + 'static,
{
    fn cae(self, ctx: impl Into<String>) -> Result<T, AppError> {
        self.context(ctx.into()).map_err(Into::<AppError>::into)
    }
}
