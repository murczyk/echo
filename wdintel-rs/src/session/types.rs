use crate::types::*;
use redis::{
    FromRedisValue, ParsingError, RedisWrite, ToRedisArgs, ToSingleRedisArg,
    Value,
};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct RedisSession {
    pub session_id: Uuid,
    pub account_id: String,
    pub created_at: NaiveDateTime,
    pub heartbeat_at: NaiveDateTime,
}

fn parse_redis_session_str(s: &str) -> Result<RedisSession, ParsingError> {
    serde_json::from_str::<RedisSession>(s).map_err(|err| {
        ParsingError::from(format!(
            "Response type not deserializable to RedisSession: {err}"
        ))
    })
}

fn parse_redis_session_str_allow_redisjson(
    s: &str,
) -> Result<RedisSession, ParsingError> {
    match parse_redis_session_str(s) {
        Ok(session) => Ok(session),
        Err(err) => {
            let mut chars = s.chars();
            if chars.next() == Some('[') && chars.next_back() == Some(']') {
                return serde_json::from_str::<RedisSession>(chars.as_str())
                    .map_err(|err| {
                        ParsingError::from(format!(
                            "Response type not RedisJSON deserializable to RedisSession: {err}"
                        ))
                    });
            }
            Err(err)
        }
    }
}

impl FromRedisValue for RedisSession {
    fn from_redis_value(v: Value) -> Result<Self, ParsingError> {
        match v {
            Value::BulkString(bytes) => {
                let s = std::str::from_utf8(&bytes).map_err(ParsingError::from)?;
                parse_redis_session_str_allow_redisjson(s)
            }
            Value::SimpleString(s) => parse_redis_session_str_allow_redisjson(&s),
            other => Err(ParsingError::from(format!(
                "Response type was not deserializable to RedisSession. (response was {other:?})"
            ))),
        }
    }
}

impl ToRedisArgs for RedisSession {
    fn write_redis_args<W>(&self, out: &mut W)
    where
        W: ?Sized + RedisWrite,
    {
        let buf = serde_json::to_string(&self)
            .expect("RedisSession serialization failed");
        out.write_arg(buf.as_bytes());
    }
}

impl ToSingleRedisArg for RedisSession {}
