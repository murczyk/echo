use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

/// How the window point that maps to "now" at start is chosen. Resolved on
/// the server at the moment of start, so it is never stale.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum MessageReplayShiftMode {
    /// The window start maps to now: the first message arrives immediately.
    WindowStart,
    /// Whole Kyiv calendar days back: replay starts at the earliest window
    /// point with the current local time of day (exact at 1x speed).
    SameTimeOfDay,
    /// Start `manual_shift_ms` back from now.
    Manual,
}

/// Replay speed presets; 1x keeps the original pace.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum MessageReplaySpeed {
    Speed100,
    Speed200,
    Speed300,
    Speed500,
    Speed1000,
}

impl MessageReplaySpeed {
    pub fn pct(&self) -> i32 {
        match self {
            Self::Speed100 => 100,
            Self::Speed200 => 200,
            Self::Speed300 => 300,
            Self::Speed500 => 500,
            Self::Speed1000 => 1000,
        }
    }

    /// Unknown values (never stored by the API) read as the original pace.
    pub fn from_pct(pct: i32) -> Self {
        match pct {
            200 => Self::Speed200,
            300 => Self::Speed300,
            500 => Self::Speed500,
            1000 => Self::Speed1000,
            _ => Self::Speed100,
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplaySpeedReq {
    pub speed: MessageReplaySpeed,
}

/// What happens when the replay reaches the window end. Both rewind to the
/// window start with a fresh shift, so the next cycle looks recent too.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum MessageReplayOnEnd {
    /// Start the next cycle immediately.
    Loop,
    /// Pause at the window start until resumed.
    Pause,
}

impl MessageReplayOnEnd {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Loop => "loop",
            Self::Pause => "pause",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "pause" => Self::Pause,
            _ => Self::Loop,
        }
    }
}

/// Activity histogram bar size. `Day1` (Kyiv days) is the coarse overview
/// for browsing; the finer buckets are for picking the exact window.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum MessageReplayActivityBucket {
    Minutes15,
    Hour1,
    Day1,
}

impl MessageReplayActivityBucket {
    pub fn seconds(&self) -> i64 {
        match self {
            Self::Minutes15 => 15 * 60,
            Self::Hour1 => 60 * 60,
            Self::Day1 => 24 * 60 * 60,
        }
    }

    pub fn max_range_days(&self) -> i64 {
        match self {
            Self::Minutes15 | Self::Hour1 => {
                crate::config::MESSAGE_REPLAY_MAX_RANGE_DAYS
            }
            Self::Day1 => crate::config::MESSAGE_REPLAY_MAX_BROWSE_DAYS,
        }
    }
}

/// First and last replayable message, to position the overview histogram.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayExtentRsp {
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayActivityReq {
    pub from_ms: i64,
    pub to_ms: i64,
    pub bucket: MessageReplayActivityBucket,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayActivityPoint {
    pub ts_ms: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayActivityRsp {
    /// Nominal size; `Day1` buckets are Kyiv days (23 or 25 h on DST days).
    pub bucket_sec: i64,
    /// Only non-empty buckets; missing buckets have no messages.
    pub points: Vec<MessageReplayActivityPoint>,
}

/// Shared by preview and start.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayPlanReq {
    pub from_ms: i64,
    pub to_ms: i64,
    pub shift_mode: MessageReplayShiftMode,
    pub manual_shift_ms: Option<i64>,
    pub speed: MessageReplaySpeed,
    pub on_end: MessageReplayOnEnd,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayPreviewRsp {
    /// Replayable messages in the whole window.
    pub window_count: i64,
    /// Messages before the start position, skipped in the first cycle.
    pub skipped_count: i64,
    /// Messages replayed in the first cycle.
    pub replay_count: i64,
    /// How far back the start position is from now.
    pub offset_ms: i64,
    /// Window point that maps to "now" when the replay starts.
    pub start_position_ms: i64,
    pub first_message_ms: Option<i64>,
    /// Real time until the first message arrives, if started now.
    pub first_message_eta_ms: Option<i64>,
    /// Shown time of the first message.
    pub first_message_shown_ms: Option<i64>,
    /// Real time until the window end, if started now.
    pub cycle_end_eta_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplaySessionRsp {
    pub id: i64,
    pub state: String,
    pub on_end: MessageReplayOnEnd,
    pub speed: MessageReplaySpeed,
    /// Times the window was played to its end (and rewound).
    pub completed_cycles: i64,
    pub window_from_ms: i64,
    pub window_to_ms: i64,
    /// Time mapping: source instant `t` is shown at
    /// `anchor_at + (t - anchor_ts) / speed`.
    pub anchor_ts_ms: i64,
    pub anchor_at_ms: i64,
    pub paused_at_ms: Option<i64>,
    /// Window point that corresponds to now (frozen while paused).
    pub replay_position_ms: i64,
    /// How far back the position is from now.
    pub offset_ms: i64,
    pub cursor_ms: i64,
    /// Across all cycles.
    pub replayed_count: i64,
    /// Left in the current cycle.
    pub remaining_count: i64,
    /// Original time of the next message to replay.
    pub next_message_ms: Option<i64>,
    /// Real time until it arrives (frozen while paused).
    pub next_message_eta_ms: Option<i64>,
    /// Real time until the window end (frozen while paused).
    pub cycle_end_eta_ms: i64,
    pub created_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageReplayStatusRsp {
    pub session: Option<MessageReplaySessionRsp>,
    /// Replayed messages still stored, counted only with no session or while
    /// stopping (purge progress); `None` while a session runs or is paused,
    /// when the session's `replayed_count` stands in for it.
    pub stored_replay_count: Option<i64>,
}
