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
    let body = input.get(start_byte..)?.trim_end_matches(['\r', '\n']);
    if body.trim().is_empty() {
        return None;
    }
    let start = input[..start_byte].chars().count();
    let end = start + body.chars().count();
    Some(NoHeadersBody {
        body: body.to_string(),
        start,
        end,
    })
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
