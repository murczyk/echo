use std::fmt;

#[allow(dead_code)]
pub(crate) fn compact_debug<T>(value: &T) -> String
where
    T: fmt::Debug + ?Sized,
{
    format!("{:#?}", value)
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
}

#[allow(dead_code)]
pub(crate) struct LogArg<'a, T>
where
    T: ?Sized,
{
    value: &'a T,
}

#[allow(dead_code)]
pub(crate) fn log_arg<T>(value: &T) -> LogArg<'_, T>
where
    T: ?Sized,
{
    LogArg { value }
}

#[allow(dead_code)]
pub(crate) fn location(file: &str, line: u32) -> String {
    format!("at {file}::{line}")
}

impl<T> fmt::Debug for LogArg<'_, T>
where
    T: fmt::Debug + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&compact_debug(self.value))
    }
}

impl<T> fmt::Display for LogArg<'_, T>
where
    T: fmt::Display + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self.value, f)
    }
}

#[allow(unused_macros)]
macro_rules! error {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        log::error!(
            target: $target,
            concat!($fmt, " {}")
            $(, $crate::logging::log_arg(&$arg))*
            , $crate::logging::location(file!(), line!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        log::error!(
            concat!($fmt, " {}")
            $(, $crate::logging::log_arg(&$arg))*
            , $crate::logging::location(file!(), line!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use error;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_debug_formats_regular_and_pretty_debug_equally() {
        let value = vec![("error", vec!["first line", "second line"])];
        let expected =
            "[ ( \"error\", [ \"first line\", \"second line\", ], ), ]";

        assert_eq!(
            format!("error occurred: {:?}", log_arg(&value)),
            format!("error occurred: {expected}")
        );
        assert_eq!(
            format!("error here: {:#?}", log_arg(&value)),
            format!("error here: {expected}")
        );

        crate::logging::error!("error occurred: {:?}", value);
        crate::logging::error!("error here: {:#?}", value);
    }

    #[test]
    fn location_formats_file_and_line() {
        assert_eq!(
            location("src/callsign/mod.rs", 84),
            "at src/callsign/mod.rs::84"
        );
    }
}
