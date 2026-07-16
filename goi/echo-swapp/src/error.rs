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
