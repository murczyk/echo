use anyhow::Context;
use aws_sdk_s3::error::SdkError;
use log::error;
use std::collections::BTreeMap;
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
    #[error("aws sdk s3 get object error")]
    AwsSdkGetObjectErr {
        #[from]
        source:
            Box<SdkError<aws_sdk_s3::operation::get_object::GetObjectError>>,
    },
    #[error("aws sdk s3 presigning error")]
    AwsPresigningErr {
        #[from]
        source: Box<aws_sdk_s3::Error>,
    },
    #[error("aws sdk s3 put object error")]
    AwsPutObjectErr {
        #[from]
        source:
            Box<SdkError<aws_sdk_s3::operation::put_object::PutObjectError>>,
    },
    #[error("aws sdk s3 presigning config error")]
    PresigningConfigError {
        #[from]
        source: Box<aws_sdk_s3::presigning::PresigningConfigError>,
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
                error!("Internal server error: {self:?}");
                println!("Internal server error: {self:?}");
                println!("Internal server error: {self:?}");
                match self {
                    AppError::IO { .. }
                    | AppError::AwsSdkGetObjectErr { .. }
                    | AppError::AwsPresigningErr { .. }
                    | AppError::AwsPutObjectErr { .. }
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
                    | AppError::PresigningConfigError { .. }
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
