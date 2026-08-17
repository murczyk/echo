use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, Clone, Default)]
pub enum RequiredPatch<T> {
    #[default]
    Missing,
    Value(T),
}

impl<T> RequiredPatch<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    pub(in crate::devices) fn into_option(self) -> Option<T> {
        match self {
            Self::Missing => None,
            Self::Value(value) => Some(value),
        }
    }
}

impl<T: Elm> Elm for RequiredPatch<T> {
    fn elm_type() -> String {
        format!("Maybe ({})", T::elm_type())
    }

    fn elm_definition() -> Option<String> {
        None
    }
}

impl<T: Elm + ElmEncode> ElmEncode for RequiredPatch<T> {
    fn encoder_type() -> String {
        format!(
            "Maybe.withDefault Json.Encode.null << Maybe.map ({})",
            T::encoder_type()
        )
    }

    fn encoder_definition() -> Option<String> {
        None
    }
}

impl<T: Elm + ElmDecode> ElmDecode for RequiredPatch<T> {
    fn decoder_type() -> String {
        format!("Json.Decode.nullable ({})", T::decoder_type())
    }

    fn decoder_definition() -> Option<String> {
        None
    }
}

impl<T: Serialize> Serialize for RequiredPatch<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for RequiredPatch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer)?
            .map(Self::Value)
            .ok_or_else(|| D::Error::custom("field cannot be null"))
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Default)]
pub enum NullablePatch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> NullablePatch<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

impl<T: Elm> Elm for NullablePatch<T> {
    fn elm_type() -> String {
        format!("Maybe ({})", T::elm_type())
    }

    fn elm_definition() -> Option<String> {
        None
    }
}

impl<T: Elm + ElmEncode> ElmEncode for NullablePatch<T> {
    fn encoder_type() -> String {
        format!(
            "Maybe.withDefault Json.Encode.null << Maybe.map ({})",
            T::encoder_type()
        )
    }

    fn encoder_definition() -> Option<String> {
        None
    }
}

impl<T: Elm + ElmDecode> ElmDecode for NullablePatch<T> {
    fn decoder_type() -> String {
        format!("Json.Decode.nullable ({})", T::decoder_type())
    }

    fn decoder_definition() -> Option<String> {
        None
    }
}

impl<T: Serialize> Serialize for NullablePatch<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing | Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for NullablePatch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

fn validate_canonical_uuid<E: DeError>(value: String) -> Result<String, E> {
    let uuid = Uuid::parse_str(&value).map_err(|_| {
        E::custom("must be a canonical lowercase hyphenated UUID")
    })?;
    if uuid.hyphenated().to_string() != value {
        return Err(E::custom("must be a canonical lowercase hyphenated UUID"));
    }
    Ok(value)
}

pub(super) fn deserialize_canonical_uuid<'de, D>(
    deserializer: D,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    validate_canonical_uuid(String::deserialize(deserializer)?)
}

pub(super) fn deserialize_canonical_uuid_vec<'de, D>(
    deserializer: D,
) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .map(validate_canonical_uuid)
        .collect()
}

pub(super) fn deserialize_nullable_canonical_uuid<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .map(validate_canonical_uuid)
        .transpose()
}

pub(super) fn deserialize_optional_datetime<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(value) = &value {
        DateTime::parse_from_rfc3339(value).map_err(|_| {
            D::Error::custom(
                "must be an RFC 3339 timestamp with an explicit timezone",
            )
        })?;
    }
    Ok(value)
}

pub(in crate::devices) fn parse_uuid(value: &str) -> Uuid {
    Uuid::parse_str(value)
        .expect("canonical UUID was validated during decoding")
}

pub(in crate::devices) fn parse_datetime(value: &str) -> NaiveDateTime {
    DateTime::parse_from_rfc3339(value)
        .expect("RFC 3339 timestamp was validated during decoding")
        .with_timezone(&Utc)
        .naive_utc()
}

pub(in crate::devices) fn format_datetime(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}
