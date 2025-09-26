use crate::config;
use crate::server::middleware::request_log_context;
use anyhow::Context;
// use aws_sdk_s3::error::SdkError;
use log::error;
use log::warn;
use std::collections::BTreeMap;
use std::error::Error as StdError;
use thiserror::Error;

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
    #[error("opendal error")]
    OpendalError {
        #[from]
        source: opendal::Error,
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
    #[error("tl parse error")]
    HtmlParserError {
        #[from]
        source: tl::errors::ParseError,
    },
    #[error("reqwest error")]
    ReqwestError {
        #[from]
        source: reqwest::Error,
    },
    #[error("reqwest to str error")]
    ReqwestToStrError {
        #[from]
        source: reqwest::header::ToStrError,
    },
    #[error("walkdir error")]
    WalkdirError {
        #[from]
        source: walkdir::Error,
    },
    #[error("csv error")]
    CsvError {
        #[from]
        source: csv::Error,
    },
    #[error("sqlx error")]
    SqlxError {
        #[from]
        source: sqlx::Error,
    },
    #[error("strip prefix error")]
    StripPrefixError {
        #[from]
        source: std::path::StripPrefixError,
    },
    #[error("uuid error")]
    UuidError {
        #[from]
        source: uuid::Error,
    },
    #[error("anyhow error")]
    AnyhowError {
        #[from]
        source: anyhow::Error,
    },
    #[error("seaorm error")]
    SeaormError {
        #[from]
        source: sea_orm::DbErr,
    },
    #[error("calamine error")]
    CalamineErr {
        #[from]
        source: calamine::Error,
    },
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
    #[error("system time error")]
    SystemTimeError {
        #[from]
        source: std::time::SystemTimeError,
    },
    #[error("chrono parse error")]
    ChronoParseError {
        #[from]
        source: chrono::ParseError,
    },
    #[error("indicatif template error")]
    IndicatifTemplateError {
        #[from]
        source: indicatif::style::TemplateError,
    },
    #[error("PayloadError")]
    PayloadError {
        #[from]
        source: actix_web::error::PayloadError,
    },
    #[error("Base64DecodeError")]
    Base64DecodeError {
        #[from]
        source: base64::DecodeError,
    },
    #[error("Argon2 error")]
    Argon2Error {
        #[from]
        source: argon2::Error,
    },
    #[error("Argon2 error")]
    QueryPayloadError {
        #[from]
        source: actix_web::error::QueryPayloadError,
    },
    #[error("addr parse error")]
    AddrParseError {
        #[from]
        source: std::net::AddrParseError,
    },
    #[error("Toml De Error")]
    TomlDeError {
        #[from]
        source: Box<toml::de::Error>,
    },
    #[error("GetIdentityError")]
    GetIdentityError {
        #[from]
        source: actix_identity::error::GetIdentityError,
    },
    #[error("xshell::Error")]
    XshellError {
        #[from]
        source: xshell::Error,
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

impl actix_web::error::ResponseError for AppError {
    fn error_response(
        &self,
    ) -> actix_web::HttpResponse<actix_web::body::BoxBody> {
        // Special-case: during graceful shutdown the Tokio runtime may reject
        // new I/O, surfacing as an IO error like
        // "A Tokio 1.x context was found, but it is being shutdown.".
        // Return 503 to clients and avoid noisy stack traces.
        if self.is_runtime_shutting_down() {
            warn!("Service unavailable during shutdown: {self:?}");
            return actix_web::HttpResponseBuilder::new(
                actix_web::http::StatusCode::SERVICE_UNAVAILABLE,
            )
            .body("Service unavailable: server is shutting down");
        }
        match self {
            AppError::NotFound => actix_web::HttpResponseBuilder::new(
                actix_web::http::StatusCode::NOT_FOUND,
            )
            .body("Not found"),
            AppError::Unauthenticated => actix_web::HttpResponseBuilder::new(
                actix_web::http::StatusCode::UNAUTHORIZED,
            )
            .body("Unauthenticated"),
            AppError::Forbidden(msg) => actix_web::HttpResponseBuilder::new(
                actix_web::http::StatusCode::FORBIDDEN,
            )
            .body(format!("Forbidden: {msg}")),
            AppError::Form(es) => {
                println!("Form errors: {es:?}");
                actix_web::HttpResponseBuilder::new(
                    actix_web::http::StatusCode::BAD_REQUEST,
                )
                .body(
                    serde_json::to_string(&Vec::from_iter(es.iter())).unwrap(),
                )
            }
            _ => {
                let base_message = format!("Internal server error: {self:?}");
                let mut message = format!("{base_message}; user=<unknown>");

                if config::FEATURE_ERROR_CONTEXT {
                    if let Some(ctx) = request_log_context() {
                        let query_string =
                            ctx.query_string.as_deref().unwrap_or("");
                        let request_url = if query_string.is_empty() {
                            ctx.path.clone()
                        } else {
                            format!("{}?{}", ctx.path, query_string)
                        };
                        let params_json = ctx
                            .query_params
                            .as_ref()
                            .map(|params| {
                                serde_json::to_string(params)
                                    .unwrap_or_else(|_| "{}".to_string())
                            })
                            .unwrap_or_else(|| "{}".to_string());
                        message = format!(
                            "{base_message}; request_id={}; user={}; session_id={}; ip={}; method={}; url={}; query_params={}; user_agent={}",
                            ctx.request_id,
                            ctx.username.as_deref().unwrap_or("<unknown>"),
                            ctx.session_id.as_deref().unwrap_or("<unknown>"),
                            ctx.client_ip.as_deref().unwrap_or("<unknown>"),
                            ctx.method,
                            request_url,
                            params_json,
                            ctx.user_agent.as_deref().unwrap_or("<unknown>"),
                        );
                    }
                }

                error!("{message}");
                println!("{message}");
                println!("{message}");
                match self {
                    AppError::IO { .. }
                    | AppError::OpendalError { .. }
                    | AppError::JoinErr { .. }
                    | AppError::FsExtraErr { .. }
                    | AppError::HtmlParserError { .. }
                    | AppError::ReqwestError { .. }
                    | AppError::ReqwestToStrError { .. }
                    | AppError::WalkdirError { .. }
                    | AppError::CsvError { .. }
                    | AppError::SqlxError { .. }
                    | AppError::StripPrefixError { .. }
                    | AppError::UuidError { .. }
                    | AppError::AnyhowError { .. }
                    | AppError::SeaormError { .. }
                    | AppError::CalamineErr { .. }
                    | AppError::NotifyErr { .. }
                    | AppError::ActixParseErr { .. }
                    | AppError::SystemTimeError { .. }
                    | AppError::ChronoParseError { .. }
                    | AppError::IndicatifTemplateError { .. }
                    | AppError::PayloadError { .. }
                    | AppError::Base64DecodeError { .. }
                    | AppError::Argon2Error { .. }
                    | AppError::QueryPayloadError { .. }
                    | AppError::AddrParseError { .. }
                    | AppError::TomlDeError { .. }
                    | AppError::GetIdentityError { .. }
                    | AppError::XshellError { .. }
                    | AppError::MilgeoError { .. } => {
                        error!("{self:#?}");
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

impl From<&str> for AppError {
    fn from(v: &str) -> Self {
        AppError::BL { msg: v.to_string() }
    }
}

impl AppError {
    /// Detects the common shutdown error propagated from SQLx/SeaORM/Tokio
    /// when the Actix/Tokio runtime is terminating.
    fn is_runtime_shutting_down(&self) -> bool {
        // Helper: check error and its source chain for the shutdown marker.
        fn chain_has_shutdown(err: &dyn StdError) -> bool {
            let mut cur: Option<&(dyn StdError)> = Some(err);
            while let Some(e) = cur {
                let msg = e.to_string();
                if msg.contains("Tokio 1.x context")
                    && msg.contains("being shutdown")
                {
                    return true;
                }
                cur = e.source();
            }
            false
        }

        match self {
            AppError::AnyhowError { source } => {
                // anyhow::Error implements StdError, traverse its chain
                if let Some(inner) = source.source() {
                    if chain_has_shutdown(inner) {
                        return true;
                    }
                }
                // Fallback to message check
                source.to_string().contains("being shutdown")
            }
            AppError::SeaormError { source } => {
                chain_has_shutdown(source)
                    || source.to_string().contains("being shutdown")
            }
            AppError::SqlxError { source } => {
                chain_has_shutdown(source)
                    || source.to_string().contains("being shutdown")
            }
            _ => false,
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
