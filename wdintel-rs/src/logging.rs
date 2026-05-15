use std::fmt;

pub(crate) use log::Level;
pub use log::LevelFilter;

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

#[allow(dead_code)]
pub(crate) fn location_from_h(context: &str) -> String {
    let context = context.strip_prefix("at ").unwrap_or(context);
    let Some((file, rest)) = context.split_once(" line ") else {
        return format!("at {context}");
    };
    let line = rest
        .split_once(" column ")
        .map(|(line, _)| line)
        .unwrap_or(rest);
    location(file, line.parse().unwrap_or_default())
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

impl<T> fmt::Binary for LogArg<'_, T>
where
    T: fmt::Binary + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Binary::fmt(self.value, f)
    }
}

impl<T> fmt::LowerExp for LogArg<'_, T>
where
    T: fmt::LowerExp + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::LowerExp::fmt(self.value, f)
    }
}

impl<T> fmt::LowerHex for LogArg<'_, T>
where
    T: fmt::LowerHex + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::LowerHex::fmt(self.value, f)
    }
}

impl<T> fmt::Octal for LogArg<'_, T>
where
    T: fmt::Octal + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Octal::fmt(self.value, f)
    }
}

impl<T> fmt::Pointer for LogArg<'_, T>
where
    T: fmt::Pointer + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Pointer::fmt(self.value, f)
    }
}

impl<T> fmt::UpperExp for LogArg<'_, T>
where
    T: fmt::UpperExp + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::UpperExp::fmt(self.value, f)
    }
}

impl<T> fmt::UpperHex for LogArg<'_, T>
where
    T: fmt::UpperHex + ?Sized,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::UpperHex::fmt(self.value, f)
    }
}

#[allow(unused_macros)]
macro_rules! log_error {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::error!(
            target: $target,
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::error!(
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use log_error as error;

#[allow(unused_macros)]
macro_rules! log_warn {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::warn!(
            target: $target,
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::warn!(
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use log_warn as warn;

#[allow(unused_macros)]
macro_rules! log_info {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::info!(
            target: $target,
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::info!(
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use log_info as info;

#[allow(unused_macros)]
macro_rules! log_debug {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::debug!(
            target: $target,
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::debug!(
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use log_debug as debug;

#[allow(unused_macros)]
macro_rules! log_trace {
    (target: $target:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::trace!(
            target: $target,
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
    ($fmt:literal $(, $arg:expr)* $(,)?) => {{
        ::log::trace!(
            "{} {}",
            format_args!(
                $fmt
                $(, $crate::logging::log_arg(&$arg))*
            ),
            $crate::logging::location_from_h($crate::h!())
        );
    }};
}

#[allow(unused_imports)]
pub(crate) use log_trace as trace;

#[allow(unused_macros)]
macro_rules! log_log_enabled {
    (target: $target:expr, $level:expr) => {{
        ::log::log_enabled!(target: $target, $level)
    }};
    ($level:expr) => {{
        ::log::log_enabled!($level)
    }};
}

#[allow(unused_imports)]
pub(crate) use log_log_enabled as log_enabled;

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
        assert_eq!(
            location_from_h("at src/callsign/mod.rs line 84 column 12"),
            "at src/callsign/mod.rs::84"
        );
    }

    #[test]
    fn all_logging_levels_compile_with_regular_formatting() {
        let value = vec![("error", vec!["first line", "second line"])];
        let number = 255_u32;

        crate::logging::error!("error occurred: {:?}", value);
        crate::logging::warn!("warning occurred: {:#?}", value);
        crate::logging::info!("info value: {} {number:x}", "ok");
        crate::logging::debug!(target: "logging_test", "debug value: {number:X}");
        crate::logging::trace!("trace value: {:b}", number);
        let _ = crate::logging::log_enabled!(crate::logging::Level::Info);
    }

    #[test]
    fn logging_macros_compile_with_implicit_captures() {
        let value = "captured";

        crate::logging::error!("error value: {value}");
        crate::logging::warn!("warn value: {:?}", value);
        crate::logging::info!("info value: {:#?}", value);
        crate::logging::debug!("debug value: {value}");
        crate::logging::trace!("trace value: {value}");
    }
}
