#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserErrorKind {
    BadRequest,
    NotFound,
    Conflict,
    ServiceUnavailable,
}

#[derive(Debug)]
pub struct UserError {
    pub kind: UserErrorKind,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl UserError {
    fn into_error(
        kind: UserErrorKind,
        message: impl Into<String>,
    ) -> anyhow::Error {
        anyhow::Error::new(Self {
            kind,
            message: message.into(),
            source: None,
        })
    }

    fn into_error_with_source<E>(
        kind: UserErrorKind,
        message: impl Into<String>,
        source: E,
    ) -> anyhow::Error
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        anyhow::Error::new(Self {
            kind,
            message: message.into(),
            source: Some(Box::new(source)),
        })
    }
}

impl std::fmt::Display for UserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for UserError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

pub fn bad_request(message: impl Into<String>) -> anyhow::Error {
    UserError::into_error(UserErrorKind::BadRequest, message)
}

pub fn not_found(message: impl Into<String>) -> anyhow::Error {
    UserError::into_error(UserErrorKind::NotFound, message)
}

pub fn conflict(message: impl Into<String>) -> anyhow::Error {
    UserError::into_error(UserErrorKind::Conflict, message)
}

pub fn service_unavailable(message: impl Into<String>) -> anyhow::Error {
    UserError::into_error(UserErrorKind::ServiceUnavailable, message)
}

pub fn service_unavailable_with_source<E>(
    message: impl Into<String>,
    source: E,
) -> anyhow::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    UserError::into_error_with_source(
        UserErrorKind::ServiceUnavailable,
        message,
        source,
    )
}

/// Shorthand trait for anyhow-like `Context` allowing `.c(h!())` usage.
pub trait ShortContext<T> {
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static;
}

impl<T, E> ShortContext<T> for Result<T, E>
where
    E: Into<anyhow::Error>,
{
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        let res: anyhow::Result<T> = self.map_err(Into::into);
        anyhow::Context::context(res, context)
    }
}

impl<T> ShortContext<T> for Option<T> {
    fn c<C>(self, context: C) -> anyhow::Result<T>
    where
        C: std::fmt::Display + Send + Sync + 'static,
    {
        anyhow::Context::context(self, context)
    }
}

#[macro_export]
macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}
