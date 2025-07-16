use crate::types::*;
use redis_macros::{FromRedisValue, ToRedisArgs};

#[derive(
    Serialize, Deserialize, FromRedisValue, ToRedisArgs, Debug, PartialEq,
)]
pub struct RedisSession {
    pub session_id: Uuid,
    pub account_id: String,
    pub created_at: NaiveDateTime,
    pub heartbeat_at: NaiveDateTime,
}
