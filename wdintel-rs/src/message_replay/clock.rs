//! Replay timing. A replay maps past (source) time onto present time with
//! one affine mapping, anchored at a point:
//!
//! ```text
//! position(now) = anchor_ts + (now - anchor_at) * speed   // past point that is "now"
//! shown_at(t)   = anchor_at + (t - anchor_ts) / speed     // where past instant t lands
//! ```
//!
//! A source message is due once the position passes its timestamp, so it
//! arrives exactly at `shown_at(timestamp)` and the original gaps are kept
//! (divided by the speed). The same mapping moves the date/time stamps in the
//! body, so every past instant lands in exactly one place.
//!
//! All instants are UTC; Kyiv local time is only used to read and write body
//! stamps and to pick "same time of day" anchors (DST-aware). Every state
//! change (pause, resume, speed change, rewind) re-anchors at the current
//! position, so the position never jumps.

use crate::entities::message_replay_session;
use crate::error::AppError;
use crate::message_replay::types::{
    MessageReplayShiftMode, MessageReplaySpeed,
};
use chrono::{Duration, LocalResult, NaiveDateTime, TimeZone};
use chrono_tz::Tz;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayClock {
    pub anchor_ts: NaiveDateTime,
    pub anchor_at: NaiveDateTime,
    pub speed_pct: i32,
    pub paused_at: Option<NaiveDateTime>,
}

impl ReplayClock {
    pub fn from_session(session: &message_replay_session::Model) -> Self {
        Self {
            anchor_ts: session.anchor_ts,
            anchor_at: session.anchor_at,
            speed_pct: session.speed_pct,
            paused_at: session.paused_at,
        }
    }

    /// Wall-clock time the clock is at: frozen while paused.
    fn clock_time(&self, now: NaiveDateTime) -> NaiveDateTime {
        self.paused_at.unwrap_or(now)
    }

    /// Past point that corresponds to `now`; frozen while paused.
    pub fn position(&self, now: NaiveDateTime) -> NaiveDateTime {
        self.anchor_ts
            + scale(self.clock_time(now) - self.anchor_at, self.speed_pct, 100)
    }

    /// Present time a past instant is shown at (and a source message
    /// arrives at, while running).
    pub fn shown_at(&self, source_ts: NaiveDateTime) -> NaiveDateTime {
        self.anchor_at + scale(source_ts - self.anchor_ts, 100, self.speed_pct)
    }

    /// Real time until the position reaches `source_ts`; frozen while
    /// paused.
    pub fn real_time_until(
        &self,
        source_ts: NaiveDateTime,
        now: NaiveDateTime,
    ) -> Duration {
        scale(source_ts - self.position(now), 100, self.speed_pct)
    }

    /// [`Self::real_time_until`] in milliseconds, 0 once reached.
    pub fn eta_ms(&self, source_ts: NaiveDateTime, now: NaiveDateTime) -> i64 {
        self.real_time_until(source_ts, now)
            .num_milliseconds()
            .max(0)
    }

    /// How far back in time the position is.
    pub fn offset(&self, now: NaiveDateTime) -> Duration {
        self.clock_time(now) - self.position(now)
    }

    pub fn paused(&self, now: NaiveDateTime) -> Self {
        Self {
            paused_at: Some(self.paused_at.unwrap_or(now)),
            ..*self
        }
    }

    /// Continues from the frozen position: messages after a pause arrive
    /// later than originally planned, by the length of the pause.
    pub fn resumed(&self, now: NaiveDateTime) -> Self {
        Self {
            anchor_ts: self.position(now),
            anchor_at: now,
            speed_pct: self.speed_pct,
            paused_at: None,
        }
    }

    /// Changes the speed from the current position on; keeps a pause.
    pub fn with_speed(&self, speed_pct: i32, now: NaiveDateTime) -> Self {
        Self {
            anchor_ts: self.position(now),
            anchor_at: self.clock_time(now),
            speed_pct,
            paused_at: self.paused_at,
        }
    }

    /// Next cycle once the window end is reached: `now` maps to the window
    /// start again, so shown times keep moving forward.
    pub fn rewound(
        &self,
        window_from: NaiveDateTime,
        now: NaiveDateTime,
        pause: bool,
    ) -> Self {
        Self {
            anchor_ts: window_from,
            anchor_at: now,
            speed_pct: self.speed_pct,
            paused_at: pause.then_some(now),
        }
    }
}

/// `duration * num / den`, in microseconds (source timestamps carry them).
fn scale(duration: Duration, num: i32, den: i32) -> Duration {
    let micros = duration.num_microseconds().map_or_else(
        || i128::from(duration.num_milliseconds()) * 1000,
        i128::from,
    );
    let scaled = micros * i128::from(num) / i128::from(den);
    Duration::microseconds(i64::try_from(scaled).unwrap_or(if scaled < 0 {
        i64::MIN
    } else {
        i64::MAX
    }))
}

/// Converts a Kyiv (or other `tz`) wall-clock time to UTC. An ambiguous
/// time (autumn fall-back hour) takes the earlier instant; a time skipped by
/// the spring-forward gap is read with the offset in force before the gap.
pub fn local_to_utc(local: NaiveDateTime, tz: Tz) -> Option<NaiveDateTime> {
    match tz.from_local_datetime(&local) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => {
            Some(dt.naive_utc())
        }
        LocalResult::None => tz
            .from_local_datetime(&(local + Duration::hours(1)))
            .earliest()
            .map(|dt| dt.naive_utc() - Duration::hours(1)),
    }
}

pub fn utc_to_local(utc: NaiveDateTime, tz: Tz) -> NaiveDateTime {
    tz.from_utc_datetime(&utc).naive_local()
}

/// Validated replay window, the window point that maps to the start time,
/// and the speed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayPlan {
    pub window_from: NaiveDateTime,
    pub window_to: NaiveDateTime,
    pub start_position: NaiveDateTime,
    pub speed_pct: i32,
}

impl ReplayPlan {
    /// Sources at or after this point are replayed; earlier ones are
    /// skipped. A start position before the window waits for its start.
    pub fn first_replayed_ts(&self) -> NaiveDateTime {
        self.start_position.max(self.window_from)
    }

    pub fn clock(&self, now: NaiveDateTime) -> ReplayClock {
        ReplayClock {
            anchor_ts: self.start_position,
            anchor_at: now,
            speed_pct: self.speed_pct,
            paused_at: None,
        }
    }
}

pub fn resolve_plan(
    window_from: NaiveDateTime,
    window_to: NaiveDateTime,
    mode: &MessageReplayShiftMode,
    manual_shift_ms: Option<i64>,
    speed: &MessageReplaySpeed,
    now: NaiveDateTime,
) -> Result<ReplayPlan, AppError> {
    validate_window(window_from, window_to, now)?;
    let start_position = resolve_start_position(
        window_from,
        mode,
        manual_shift_ms,
        now,
        crate::config::get_tz(),
    )?;
    if start_position >= window_to {
        return Err(bl_error(
            "Обраний зсув починає відтворення після кінця вікна: немає повідомлень для відтворення",
        ));
    }
    Ok(ReplayPlan {
        window_from,
        window_to,
        start_position,
        speed_pct: speed.pct(),
    })
}

fn validate_window(
    window_from: NaiveDateTime,
    window_to: NaiveDateTime,
    now: NaiveDateTime,
) -> Result<(), AppError> {
    if window_from >= window_to {
        return Err(bl_error("Початок вікна має бути раніше за його кінець"));
    }
    if window_to > now {
        return Err(bl_error("Вікно відтворення має бути в минулому"));
    }
    Ok(())
}

/// The window point that maps to "now" at start.
fn resolve_start_position(
    window_from: NaiveDateTime,
    mode: &MessageReplayShiftMode,
    manual_shift_ms: Option<i64>,
    now: NaiveDateTime,
    tz: Tz,
) -> Result<NaiveDateTime, AppError> {
    match mode {
        MessageReplayShiftMode::WindowStart => Ok(window_from),
        MessageReplayShiftMode::SameTimeOfDay => {
            same_time_of_day_start(window_from, now, tz)
        }
        MessageReplayShiftMode::Manual => {
            manual_start_position(window_from, manual_shift_ms, now)
        }
    }
}

/// How long before the window start a manual shift may put the start
/// position, i.e. how long the first message may wait (at 1x).
const MAX_MANUAL_START_LEAD: Duration = Duration::days(1);

/// `now - shift`, checked: the shift comes straight from the form, and an
/// arbitrary number would overflow the date arithmetic.
fn manual_start_position(
    window_from: NaiveDateTime,
    manual_shift_ms: Option<i64>,
    now: NaiveDateTime,
) -> Result<NaiveDateTime, AppError> {
    let shift_ms = manual_shift_ms
        .filter(|shift_ms| *shift_ms > 0)
        .ok_or_else(|| bl_error("Вкажіть додатний зсув часу"))?;
    Duration::try_milliseconds(shift_ms)
        .and_then(|shift| now.checked_sub_signed(shift))
        .filter(|start| *start >= window_from - MAX_MANUAL_START_LEAD)
        .ok_or_else(|| {
            bl_error(
                "Зсув завеликий: точка старту більш ніж на добу раніше за початок вікна",
            )
        })
}

/// The earliest window point with the current local (Kyiv) time of day:
/// the same wall-clock time a whole number of calendar days back, so the
/// time of day stays realistic across DST changes.
fn same_time_of_day_start(
    window_from: NaiveDateTime,
    now: NaiveDateTime,
    tz: Tz,
) -> Result<NaiveDateTime, AppError> {
    let now_local = utc_to_local(now, tz);
    let from_local = utc_to_local(window_from, tz);
    let mut days = (now_local.date() - from_local.date()).num_days();
    if now_local.time() < from_local.time() {
        days -= 1;
    }
    let start = (days >= 1)
        .then(|| local_to_utc(now_local - Duration::days(days), tz))
        .flatten()
        .ok_or_else(|| {
            bl_error(
                "Зсув на цілі доби можливий, лише якщо вікно почалося щонайменше добу тому",
            )
        })?;
    // The DST gap fallback can land just before the window start.
    Ok(start.max(window_from))
}

fn bl_error(msg: &str) -> AppError {
    AppError::BL {
        msg: msg.to_string(),
    }
}
