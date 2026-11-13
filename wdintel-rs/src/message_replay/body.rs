//! Moves the date/time tokens in a replayed message body through the replay
//! time mapping (`ReplayClock::shown_at`), the same mapping the message
//! timestamp goes through, so the text agrees with the replay timeline.
//!
//! Tokens are local (Kyiv) wall-clock times: each is converted to UTC
//! (DST-aware), mapped, converted back to local time and written in its
//! original format. Every matching token is moved; the patterns are tried
//! from the most specific one, and a text span claimed by one pattern is
//! never rewritten by another.

use crate::message_replay::clock::{local_to_utc, utc_to_local};
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use chrono_tz::Tz;
use lazy_static::lazy_static;
use regex::Regex;
use std::ops::Range;

/// What a token carries besides the time of day.
#[derive(Clone, Copy)]
enum TokenDate {
    /// Full date in the token.
    Full,
    /// Day and month only: the year is taken near the source timestamp.
    NoYear,
}

struct TokenPattern {
    regex: Regex,
    format: &'static str,
    date: TokenDate,
}

impl TokenPattern {
    fn new(regex: &str, format: &'static str, date: TokenDate) -> Self {
        Self {
            regex: Regex::new(regex).unwrap(),
            format,
            date,
        }
    }
}

lazy_static! {
    static ref TOKEN_PATTERNS: Vec<TokenPattern> = vec![
        TokenPattern::new(
            r"\d{2}\.\d{2}\.\d{4}_\d{2}:\d{2}:\d{2}",
            "%d.%m.%Y_%H:%M:%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{2}\.\d{2}\.\d{4}_\d{2}:\d{2}",
            "%d.%m.%Y_%H:%M",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}",
            "%d.%m.%Y, %H:%M:%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}",
            "%Y-%m-%d_%H:%M:%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{4}-\d{2}-\d{2}_\d{2}:\d{2}",
            "%Y-%m-%d_%H:%M",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}",
            "%Y-%m-%dT%H:%M:%S",
            TokenDate::Full,
        ),
        // Claimed before the year-less `dd-mm HH:MM:SS`, which would
        // otherwise match the tail of this token.
        TokenPattern::new(
            r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}",
            "%Y-%m-%d %H:%M:%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{4}_\d{2}_\d{2} \d{2}-\d{2}-\d{2}",
            "%Y_%m_%d %H-%M-%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}",
            "%d.%m.%Y %H:%M:%S",
            TokenDate::Full,
        ),
        // "Дата/час: 18.01.2026 07:02"; the variant with seconds above
        // claims its span first.
        TokenPattern::new(
            r"\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}",
            "%d.%m.%Y %H:%M",
            TokenDate::Full,
        ),
        // Radio interception stamps, e.g. "16.01.26 03:02:01".
        TokenPattern::new(
            r"\b\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}",
            "%d.%m.%y %H:%M:%S",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{2}:\d{2} \d{2}\.\d{2}\.\d{4}",
            "%H:%M %d.%m.%Y",
            TokenDate::Full,
        ),
        TokenPattern::new(
            r"\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}",
            "%d.%m, %H:%M:%S",
            TokenDate::NoYear,
        ),
        TokenPattern::new(
            r"\d{2}-\d{2} \d{2}:\d{2}:\d{2}",
            "%d-%m %H:%M:%S",
            TokenDate::NoYear,
        ),
    ];
    /// "Дата: 2026-01-18" or "Дата: 18.01.2026"; the value is group 1.
    static ref LABELLED_DATE_RE: Regex =
        Regex::new(r"Дата:\s*(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})").unwrap();
    /// "Час: 06:59" or "Час: 06:59:12"; the value is group 1.
    static ref LABELLED_TIME_RE: Regex =
        Regex::new(r"Час:\s*(\d{2}:\d{2}(?::\d{2})?)").unwrap();
}

struct Replacement {
    span: Range<usize>,
    text: String,
}

/// Returns `body` with every recognised date/time token moved by `map`
/// (UTC instant to UTC instant). `source_ts` (UTC) supplies the year or
/// date for tokens that lack it.
pub fn remap_body(
    body: &str,
    map: &dyn Fn(NaiveDateTime) -> NaiveDateTime,
    source_ts: NaiveDateTime,
    tz: Tz,
) -> String {
    let source_local = utc_to_local(source_ts, tz);
    let mut replacements = labelled_replacements(body, map, source_local, tz);
    for pattern in TOKEN_PATTERNS.iter() {
        for found in pattern.regex.find_iter(body) {
            if overlaps_any(&replacements, &found.range()) {
                continue;
            }
            let Some(text) =
                remap_token(found.as_str(), pattern, map, source_local, tz)
            else {
                continue;
            };
            replacements.push(Replacement {
                span: found.range(),
                text,
            });
        }
    }
    apply_replacements(body, replacements)
}

/// Messages that carry the date and the time as separate labelled values
/// ("Дата: …" and "Час: …", e.g. Buran and WhatsApp reports). Each "Час:"
/// is paired with the closest "Дата:" before it (and after the previous
/// "Час:"), and both are moved together, so a move crossing midnight changes
/// the date too. A "Час:" without a date takes the local date that puts it
/// closest to the source message ("Час: 23:58" in a message sent at 00:01
/// is the previous evening). A "Дата:" without "Час:" is left to the token
/// patterns, which also cover a time on the same line ("Дата: 18.01.2026
/// 07:02").
fn labelled_replacements(
    body: &str,
    map: &dyn Fn(NaiveDateTime) -> NaiveDateTime,
    source_local: NaiveDateTime,
    tz: Tz,
) -> Vec<Replacement> {
    let dates: Vec<LabelledValue<NaiveDate>> = LABELLED_DATE_RE
        .captures_iter(body)
        .filter_map(|captures| {
            let value = captures.get(1)?;
            let format = if value.as_str().contains('-') {
                "%Y-%m-%d"
            } else {
                "%d.%m.%Y"
            };
            let date =
                NaiveDate::parse_from_str(value.as_str(), format).ok()?;
            Some(LabelledValue {
                span: value.range(),
                format,
                value: date,
            })
        })
        .collect();
    let mut replacements = vec![];
    let mut previous_time_end = 0;
    for captures in LABELLED_TIME_RE.captures_iter(body) {
        let Some(value) = captures.get(1) else {
            continue;
        };
        let format = if value.len() > "00:00".len() {
            "%H:%M:%S"
        } else {
            "%H:%M"
        };
        let Ok(time) = NaiveTime::parse_from_str(value.as_str(), format) else {
            continue;
        };
        let date = dates.iter().rev().find(|date| {
            date.span.start >= previous_time_end
                && date.span.end <= value.start()
        });
        previous_time_end = value.end();
        let local = match date {
            Some(date) => date.value.and_time(time),
            None => nearest_local(time, source_local),
        };
        let Some(shifted) = remap_local(local, map, tz) else {
            continue;
        };
        replacements.extend(
            date.map(|date| (date.span.clone(), date.format))
                .into_iter()
                .chain(Some((value.range(), format)))
                .map(|(span, format)| Replacement {
                    span,
                    text: shifted.format(format).to_string(),
                }),
        );
    }
    replacements
}

struct LabelledValue<T> {
    span: Range<usize>,
    format: &'static str,
    value: T,
}

/// The time of day on the local date (the source's, or a day either side)
/// closest to the source timestamp.
fn nearest_local(
    time: NaiveTime,
    source_local: NaiveDateTime,
) -> NaiveDateTime {
    let date = source_local.date();
    [date.pred_opt(), Some(date), date.succ_opt()]
        .into_iter()
        .flatten()
        .map(|date| date.and_time(time))
        .min_by_key(|candidate| (*candidate - source_local).num_seconds().abs())
        .unwrap_or_else(|| date.and_time(time))
}

fn remap_token(
    token: &str,
    pattern: &TokenPattern,
    map: &dyn Fn(NaiveDateTime) -> NaiveDateTime,
    source_local: NaiveDateTime,
    tz: Tz,
) -> Option<String> {
    let local = parse_token(token, pattern, source_local)?;
    let shifted = remap_local(local, map, tz)?;
    Some(shifted.format(pattern.format).to_string())
}

fn parse_token(
    token: &str,
    pattern: &TokenPattern,
    source_local: NaiveDateTime,
) -> Option<NaiveDateTime> {
    match pattern.date {
        TokenDate::Full => {
            NaiveDateTime::parse_from_str(token, pattern.format).ok()
        }
        TokenDate::NoYear => {
            parse_yearless(token, pattern.format, source_local)
        }
    }
}

/// Picks the year that puts the token closest to the source timestamp, so a
/// "31.12" token in a message sent on 1 January resolves to last year.
fn parse_yearless(
    token: &str,
    format: &str,
    source_local: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let year = source_local.year();
    [year - 1, year, year + 1]
        .into_iter()
        .filter_map(|year| {
            NaiveDateTime::parse_from_str(
                &format!("{year} {token}"),
                &format!("%Y {format}"),
            )
            .ok()
        })
        .min_by_key(|candidate| (*candidate - source_local).num_seconds().abs())
}

/// Local wall-clock time through the UTC mapping, back to local time.
fn remap_local(
    local: NaiveDateTime,
    map: &dyn Fn(NaiveDateTime) -> NaiveDateTime,
    tz: Tz,
) -> Option<NaiveDateTime> {
    Some(utc_to_local(map(local_to_utc(local, tz)?), tz))
}

fn overlaps_any(replacements: &[Replacement], span: &Range<usize>) -> bool {
    replacements.iter().any(|replacement| {
        replacement.span.start < span.end && span.start < replacement.span.end
    })
}

fn apply_replacements(
    body: &str,
    mut replacements: Vec<Replacement>,
) -> String {
    replacements.sort_by_key(|replacement| replacement.span.start);
    let mut result = String::with_capacity(body.len());
    let mut copied_until = 0;
    for replacement in replacements {
        result.push_str(&body[copied_until..replacement.span.start]);
        result.push_str(&replacement.text);
        copied_until = replacement.span.end;
    }
    result.push_str(&body[copied_until..]);
    result
}
