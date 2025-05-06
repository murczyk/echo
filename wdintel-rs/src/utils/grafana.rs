use chrono::NaiveDateTime;
use serde::de::{self, Visitor};
use serde::Deserializer;
use std::fmt;

pub fn deserialize_datetime<'de, D>(
    deserializer: D,
) -> Result<Option<NaiveDateTime>, D::Error>
where
    D: Deserializer<'de>,
{
    struct NaiveDateTimeVisitor;

    impl<'de> Visitor<'de> for NaiveDateTimeVisitor {
        type Value = Option<NaiveDateTime>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a string in ISO8601 format with milliseconds")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.ends_with('Z') {
                let naive_date_str = value.trim_end_matches('Z');
                NaiveDateTime::parse_from_str(
                    naive_date_str,
                    "%Y-%m-%dT%H:%M:%S%.f",
                )
                .map(Some)
                .map_err(de::Error::custom)
            } else {
                Err(de::Error::custom("DateTime must end with 'Z' for UTC"))
            }
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }
    }

    deserializer.deserialize_str(NaiveDateTimeVisitor)
}
