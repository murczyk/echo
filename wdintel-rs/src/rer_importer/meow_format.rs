use crate::rer_importer::body_noheader::NoHeadersBody;
use chrono::{
    DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
};
use chrono_tz::{Europe::Kyiv, Tz};
use lazy_static::lazy_static;
use regex::Regex;

#[derive(Debug, Clone)]
pub struct MeowFormat {
    pub datetime: DateTime<Tz>,
    pub body_noheader: NoHeadersBody,
}

struct Line<'a> {
    start: usize,
    text: &'a str,
}

pub fn parse(lnow: DateTime<Tz>, input: &str) -> Option<MeowFormat> {
    parse_meow(lnow, input).or_else(|| parse_meow_7d(input))
}

pub fn parse_kraken_audio(input: &str) -> Option<MeowFormat> {
    let lines = lines_with_offsets(input);
    if lines.len() < 2 {
        return None;
    }
    let (idx, header) = lines.iter().enumerate().find_map(|(idx, line)| {
        parse_kraken_audio_header(line.text).map(|datetime| (idx, datetime))
    })?;
    let body_start = lines.get(idx + 1)?.start;
    let comment =
        normalize_kraken_audio_comment(input.get(..lines[idx].start)?);
    let body_noheader = parse_body_with_comment(input, body_start, comment)?;
    Some(MeowFormat {
        datetime: header,
        body_noheader,
    })
}

fn parse_kraken_audio_header(line: &str) -> Option<DateTime<Tz>> {
    lazy_static! {
        static ref RE: Regex = Regex::new(
            r"^\s*audio\s*\|\s*(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})\s*_\s*(?P<hour>[0-2][0-9])-(?P<minute>[0-5][0-9])-(?P<second>[0-5][0-9])\s*$"
        )
        .unwrap();
    }
    let captures = RE.captures(line)?;
    let year = captures.name("year")?.as_str().parse().ok()?;
    let month = captures.name("month")?.as_str().parse().ok()?;
    let day = captures.name("day")?.as_str().parse().ok()?;
    let hour = captures.name("hour")?.as_str().parse().ok()?;
    let minute = captures.name("minute")?.as_str().parse().ok()?;
    let second = captures.name("second")?.as_str().parse().ok()?;
    let datetime = NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(hour, minute, second)?;
    kyiv_datetime(datetime)
}

fn normalize_kraken_audio_comment(input: &str) -> Option<String> {
    let comment = input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!comment.is_empty()).then_some(comment)
}

fn parse_meow(lnow: DateTime<Tz>, input: &str) -> Option<MeowFormat> {
    let lines = lines_with_offsets(input);
    if lines.len() < 4
        || lines[0].text.trim().is_empty()
        || !lines[2].text.trim().is_empty()
    {
        return None;
    }
    let time = parse_time_line(lines[1].text)?;
    let body_noheader = parse_body(input, lines[3].start)?;
    let datetime = meow_datetime(lnow, time)?;
    Some(MeowFormat {
        datetime,
        body_noheader,
    })
}

fn parse_meow_7d(input: &str) -> Option<MeowFormat> {
    let lines = lines_with_offsets(input);
    if lines.len() < 3 {
        return None;
    }
    let date = parse_meow_7d_unit_date_line(lines[0].text)?;
    let time = parse_meow_7d_time_line(lines[1].text)?;
    let body_noheader = parse_body(input, lines[2].start)?;
    let datetime = kyiv_datetime(NaiveDateTime::new(date, time))?;
    Some(MeowFormat {
        datetime,
        body_noheader,
    })
}

fn lines_with_offsets(input: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for part in input.split_inclusive('\n') {
        let part_start = start;
        start += part.len();
        let text = part.trim_end_matches(['\r', '\n']);
        lines.push(Line {
            start: part_start,
            text,
        });
    }
    lines
}

fn parse_meow_7d_unit_date_line(line: &str) -> Option<NaiveDate> {
    lazy_static! {
        static ref RE: Regex = Regex::new(
            r"^\s*(?P<unit>[^|]+?)\s*\|\s*(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})\s*$"
        )
        .unwrap();
    }
    let captures = RE.captures(line)?;
    if captures.name("unit")?.as_str().trim().is_empty() {
        return None;
    }
    let year = captures.name("year")?.as_str().parse().ok()?;
    let month = captures.name("month")?.as_str().parse().ok()?;
    let day = captures.name("day")?.as_str().parse().ok()?;
    NaiveDate::from_ymd_opt(year, month, day)
}

fn parse_meow_7d_time_line(line: &str) -> Option<NaiveTime> {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r"^\s*(?P<hour>[0-2][0-9])-(?P<minute>[0-5][0-9])\s*$")
                .unwrap();
    }
    let captures = RE.captures(line)?;
    let hour = captures.name("hour")?.as_str().parse().ok()?;
    let minute = captures.name("minute")?.as_str().parse().ok()?;
    NaiveTime::from_hms_opt(hour, minute, 0)
}

fn parse_time_line(line: &str) -> Option<NaiveTime> {
    lazy_static! {
        static ref RE: Regex = Regex::new(
            r"^(?P<hour>[0-2][0-9])\.(?P<minute>[0-5][0-9]) \(МСК/Київ\) \+- 10хв$"
        )
        .unwrap();
    }
    let captures = RE.captures(line)?;
    let hour = captures.name("hour")?.as_str().parse().ok()?;
    let minute = captures.name("minute")?.as_str().parse().ok()?;
    NaiveTime::from_hms_opt(hour, minute, 0)
}

fn parse_body(input: &str, start_byte: usize) -> Option<NoHeadersBody> {
    parse_body_with_comment(input, start_byte, None)
}

fn parse_body_with_comment(
    input: &str,
    start_byte: usize,
    comment: Option<String>,
) -> Option<NoHeadersBody> {
    let body = input.get(start_byte..)?.trim_end_matches(['\r', '\n']);
    if body.trim().is_empty() {
        return None;
    }
    let body = match comment {
        Some(comment) => format!("{body}\n(Коментар: {comment})"),
        None => body.to_string(),
    };
    let start = input[..start_byte].chars().count();
    let end = start + body.chars().count();
    Some(NoHeadersBody { body, start, end })
}

fn meow_datetime(lnow: DateTime<Tz>, time: NaiveTime) -> Option<DateTime<Tz>> {
    let now = lnow.with_timezone(&Kyiv);
    let mut date = NaiveDate::from_ymd_opt(now.year(), now.month(), now.day())?;
    let mut datetime = kyiv_datetime(NaiveDateTime::new(date, time))?;
    if datetime > now {
        date = date.pred_opt()?;
        datetime = kyiv_datetime(NaiveDateTime::new(date, time))?;
    }
    Some(datetime)
}

fn kyiv_datetime(datetime: NaiveDateTime) -> Option<DateTime<Tz>> {
    Kyiv.from_local_datetime(&datetime).earliest()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kraken_audio_format() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 2, 12, 0, 0).unwrap();
        let input = " audio  |  2026-07-01_14-47-03 \nПерехоплення\nрядок 2";

        assert!(parse(now, input).is_none());
        let parsed = parse_kraken_audio(input).unwrap();

        assert_eq!(
            parsed.datetime,
            Kyiv.with_ymd_and_hms(2026, 7, 1, 14, 47, 3).unwrap()
        );
        assert_eq!(parsed.body_noheader.body, "Перехоплення\nрядок 2");
        let body_start = input.find("Перехоплення").unwrap();
        assert_eq!(
            parsed.body_noheader.start,
            input[..body_start].chars().count()
        );
    }

    #[test]
    fn parses_kraken_audio_preface_as_comment() {
        let input = "оператор\n\n  уточнення  \n audio | 2026-07-01_14-47-03\nПерехоплення";

        let parsed = parse_kraken_audio(input).unwrap();

        assert_eq!(
            parsed.datetime,
            Kyiv.with_ymd_and_hms(2026, 7, 1, 14, 47, 3).unwrap()
        );
        assert_eq!(
            parsed.body_noheader.body,
            "Перехоплення\n(Коментар: оператор уточнення)"
        );
        let body_start = input.find("Перехоплення").unwrap();
        assert_eq!(
            parsed.body_noheader.start,
            input[..body_start].chars().count()
        );
    }

    #[test]
    fn parses_meow_format() {
        let now = Kyiv.with_ymd_and_hms(2026, 6, 28, 12, 0, 0).unwrap();
        let input =
            "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення\nрядок 2";

        let parsed = parse(now, input).unwrap();

        assert_eq!(
            parsed.datetime,
            Kyiv.with_ymd_and_hms(2026, 6, 28, 5, 58, 0).unwrap()
        );
        assert_eq!(parsed.body_noheader.body, "Перехоплення\nрядок 2");
        let body_start = input.find("Перехоплення").unwrap();
        assert_eq!(
            parsed.body_noheader.start,
            input[..body_start].chars().count()
        );
    }

    #[test]
    fn parses_meow_7d_format() {
        let now = Kyiv.with_ymd_and_hms(2026, 7, 2, 12, 0, 0).unwrap();
        let input = "50 обрБпС | 2026-07-01\n01-12\nПерехоплення\nрядок 2";

        let parsed = parse(now, input).unwrap();

        assert_eq!(
            parsed.datetime,
            Kyiv.with_ymd_and_hms(2026, 7, 1, 1, 12, 0).unwrap()
        );
        assert_eq!(parsed.body_noheader.body, "Перехоплення\nрядок 2");
        let body_start = input.find("Перехоплення").unwrap();
        assert_eq!(
            parsed.body_noheader.start,
            input[..body_start].chars().count()
        );
    }

    #[test]
    fn meow_format_future_time_is_yesterday() {
        let now = Kyiv.with_ymd_and_hms(2026, 6, 28, 4, 0, 0).unwrap();
        let input = "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення";

        let parsed = parse(now, input).unwrap();

        assert_eq!(
            parsed.datetime,
            Kyiv.with_ymd_and_hms(2026, 6, 27, 5, 58, 0).unwrap()
        );
    }

    #[test]
    fn meow_format_requires_empty_line_before_body() {
        let now = Kyiv.with_ymd_and_hms(2026, 6, 28, 12, 0, 0).unwrap();
        let input = "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\nПерехоплення";

        assert!(parse(now, input).is_none());
    }
}
