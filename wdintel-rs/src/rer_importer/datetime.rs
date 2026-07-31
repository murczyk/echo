use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use chrono_tz::Tz;
use lazy_static::lazy_static;
use regex::{Captures, Regex};

type ProcessorFn =
    fn(DateTime<Tz>, &Captures) -> Result<NaiveDateTime, AppError>;

/// Витягує дату та час з тіла повідомлення.
/// ***ВАЖЛИВО:*** при додаванні нових форматів дати та часу
/// потрібно також додати їх у rer_importer::body_noheader::extract_text для коректного виділення тіла повідомлення.
pub fn extract_datetime(
    lnow: DateTime<Tz>,
    body: &str,
) -> Result<Option<NaiveDateTime>, AppError> {
    if let Some(timestamp) = trailing_datetime(body) {
        if let Ok(timestamp) = validate_datetime(lnow, timestamp) {
            return Ok(Some(timestamp));
        }
    }
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(body)
    {
        if let Ok(timestamp) = validate_datetime(lnow, zp_peleng.timestamp) {
            return Ok(Some(timestamp));
        }
    }
    if let Some(zp_digital_post_alt) =
        crate::rer_importer::zp_digital_post_alt_format::parse(body)
    {
        if let Ok(timestamp) =
            validate_datetime(lnow, zp_digital_post_alt.timestamp)
        {
            return Ok(Some(timestamp));
        }
    }

    lazy_static! {
        static ref REGEX_PATTERNS: Vec<(Regex, ProcessorFn)> = vec![
            // Work with formats like DD.MM.YYYY_HH:MI
            (
                Regex::new(r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})_(?P<hour>\d{2})\s*:(?P<minute>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like DD.MM.YYYY, HH:MI:SS
            (
                Regex::new(r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4}), (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like YYYY-MM-DD_HH:MI
            (
                Regex::new(r"(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})_(?P<hour>\d{2})\s*:(?P<minute>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like YYYY-MM-DDTHH:MI:SS
            (
                Regex::new(r"(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})T(?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like YYYY_MM_DD HH-MI-SS
            (
                Regex::new(r"(?P<year>\d{4})_(?P<mon>\d{2})_(?P<day>\d{2}) (?P<hour>\d{2})-(?P<minute>\d{2})-(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like YYYY-MM-DD_HH-MI-SS
            (
                Regex::new(r"(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})_(?P<hour>\d{2})-(?P<minute>\d{2})-(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with non-RER header lines like "50 обрБпС | YYYY-MM-DD\nHH-MI"
            (
                Regex::new(r"\|\s*(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})\s*\n\s*(?P<hour>\d{2})-(?P<minute>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like 17.11, 00:01:49
            (
                Regex::new(r"(?P<day>\d{2})\.(?P<mon>\d{2}),? (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, false, true, true, true) },
            ),
            // Work with formats like Час: 20:09:41
            (
                Regex::new(r"Час: (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, false, false, false, true) },
            ),
            // Work with formats like DD.MM.YYYY HH:MI:SS
            (
                Regex::new(r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4}) (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like DD.MM.YYYY HH:MI
            (
                Regex::new(r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})(?:[ \t]*,[ \t]*|[ \t]+)(?P<hour>\d{1,2})[ \t]*:(?P<minute>\d{2})(?:\s|$)").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like Час: DD.MM.YY HH:MI
            (
                Regex::new(r"Час:\s*(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year2>\d{2})\s+(?P<hour>\d{1,2})\s*:(?P<minute>\d{2})(?:\s|$)").unwrap(),
                parse_datetime_short_year,
            ),
            // Work with formats like HH:MI:SS DD.MM.YYYY
            // Order here is important, see https://github.com/echoua/echo/issues/2538
            (
                Regex::new(r"(?P<hour>\d{2})[ \t]*:(?P<minute>\d{2})[ \t]*:(?P<second>\d{2})[ \t]+(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like HH:MI DD.MM.YYYY
            (
                Regex::new(r"(?P<hour>\d{2})[ \t]*:(?P<minute>\d{2})[ \t]+(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            (
                Regex::new(r"\s+(?P<hour>\d\d?)\s*:(?P<minute>\d{2})\s+").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, false, false, false, false) },
            ),
            // Work with formats like 20-11 16:53:04
            (
                Regex::new(r"(?P<day>\d{2})-(?P<mon>\d{2}) (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})").unwrap(),
                |lnow, capts| { parse_datetime(lnow, capts, false, true, true, true) },
            ),
        ];
    }

    for (regex, processor) in REGEX_PATTERNS.iter() {
        if let Some(capts) = regex.captures(body) {
            match processor(lnow, &capts) {
                Ok(datetime) => return Ok(Some(datetime)),
                Err(_) => {
                    // println!("Error processing pattern {}: {:?}", pattern, e);
                    continue;
                }
            }
        }
    }

    // Special case
    // Work with formats like Дата: 2024-02-21; and Час: 17:28; in different lines
    lazy_static! {
        static ref RE_DATE_BURAN: Regex = Regex::new(
            r"Дата: (?P<year>\d\d\d\d)-(?P<mon>\d\d)-(?P<day>\d\d);?"
        )
        .unwrap();
        static ref RE_TIME_BURAN: Regex =
            Regex::new(r"Час: (?P<hour>\d\d):(?P<minute>\d\d);?").unwrap();
    }
    '_if: {
        if let (Some(capts_ymd), Some(capts_hm)) =
            (RE_DATE_BURAN.captures(body), RE_TIME_BURAN.captures(body))
        {
            let Some(day) = capts_ymd.name("day") else {
                break '_if;
            };
            let day: u32 = day.as_str().parse().c(h!())?;
            let Some(mon) = capts_ymd.name("mon") else {
                break '_if;
            };
            let mon: u32 = mon.as_str().parse().c(h!())?;
            let Some(year) = capts_ymd.name("year") else {
                break '_if;
            };
            let year: i32 = year.as_str().parse().c(h!())?;

            let Some(hour) = capts_hm.name("hour") else {
                break '_if;
            };
            let hour: u32 = hour.as_str().parse().c(h!())?;
            let Some(minute) = capts_hm.name("minute") else {
                break '_if;
            };
            let minute: u32 = minute.as_str().parse().c(h!())?;
            let Some(res) = NaiveDate::from_ymd_opt(year, mon, day) else {
                break '_if;
            };
            let Some(res) = res.and_hms_opt(hour, minute, 0) else {
                break '_if;
            };
            let mut res: NaiveDateTime = res;
            let Some(res_tz) =
                lnow.timezone().from_local_datetime(&res).earliest()
            else {
                break '_if;
            };
            if res_tz > lnow {
                res -= chrono::Duration::days(1);
            }
            let lmax = lnow + chrono::Duration::days(2);
            if res_tz > lmax {
                break '_if;
            }
            return Ok(Some(res));
        }
    };

    Ok(None)
}

pub fn without_trailing_datetime(body: &str) -> &str {
    let body = body.trim_end_matches(['\r', '\n']);
    let Some(last_line_start) = body.rfind('\n') else {
        return body;
    };
    let last_line = body[last_line_start + 1..].trim_end_matches('\r').trim();
    if parse_full_datetime_line(last_line).is_none() {
        return body;
    }
    body[..last_line_start].trim_end_matches(['\r', '\n'])
}

pub fn trailing_datetime(body: &str) -> Option<NaiveDateTime> {
    let body = body.trim_end_matches(['\r', '\n']);
    let last_line = body.rsplit('\n').next()?.trim_end_matches('\r').trim();
    parse_full_datetime_line(last_line)
}

pub fn parse_full_datetime_line(line: &str) -> Option<NaiveDateTime> {
    lazy_static! {
        static ref TIME_DATE_RE: Regex = Regex::new(
            r"^(?P<hour>\d{1,2})\s*:\s*(?P<minute>\d{2})(?:\s*:\s*(?P<second>\d{2}))?\s+(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})$"
        )
        .unwrap();
        static ref DATE_TIME_RE: Regex = Regex::new(
            r"^(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})(?:\s*,\s*|\s+)(?P<hour>\d{1,2})\s*:\s*(?P<minute>\d{2})(?:\s*:\s*(?P<second>\d{2}))?$"
        )
        .unwrap();
    }

    let captures = TIME_DATE_RE
        .captures(line)
        .or_else(|| DATE_TIME_RE.captures(line))?;
    let year = captures.name("year")?.as_str().parse().ok()?;
    let month = captures.name("mon")?.as_str().parse().ok()?;
    let day = captures.name("day")?.as_str().parse().ok()?;
    let hour = captures.name("hour")?.as_str().parse().ok()?;
    let minute = captures.name("minute")?.as_str().parse().ok()?;
    let second = captures
        .name("second")
        .map_or(Ok(0), |second| second.as_str().parse())
        .ok()?;
    NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)
}

fn validate_datetime(
    lnow: DateTime<Tz>,
    res: NaiveDateTime,
) -> Result<NaiveDateTime, AppError> {
    let Some(res_tz) = lnow.timezone().from_local_datetime(&res).earliest()
    else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };

    if res_tz > lnow + chrono::Duration::days(2) {
        return Err(AppError::BL {
            msg: "Date or time too far in future".to_string(),
        });
    }

    Ok(res_tz.naive_local())
}

fn parse_datetime(
    lnow: DateTime<Tz>,
    capts: &regex::Captures,
    has_year: bool,
    has_month: bool,
    has_day: bool,
    has_second: bool,
) -> Result<NaiveDateTime, AppError> {
    let mon: u32 = if has_month {
        capts["mon"].parse().c(h!())?
    } else {
        lnow.month()
    };
    let day: u32 = if has_day {
        capts["day"].parse().c(h!())?
    } else {
        lnow.day()
    };
    let hour: u32 = capts["hour"].parse().c(h!())?;
    let minute: u32 = capts["minute"].parse().c(h!())?;
    let second: u32 = if has_second {
        capts["second"].parse().c(h!())?
    } else {
        0
    };

    let year: i32 = if has_year {
        capts["year"].parse().c(h!())?
    } else {
        lnow.year()
    };

    let Some(res) = NaiveDate::from_ymd_opt(year, mon, day)
        .and_then(|d| d.and_hms_opt(hour, minute, second))
    else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };

    let tz = lnow.timezone();
    let Some(mut res_tz) = tz.from_local_datetime(&res).earliest() else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };

    if !has_month && !has_day && res_tz > lnow {
        res_tz -= chrono::Duration::days(1);
    }

    let lmax = lnow + chrono::Duration::days(2);
    if !has_year {
        let res_tz_prev_year = try_offset_year(res_tz, -1, lmax);
        let res_tz_next_year = try_offset_year(res_tz, 1, lmax);

        if let Some(res_tz_prev_year) = res_tz_prev_year
            .filter(|val| (lnow - val).abs() < (lnow - res_tz).abs())
        {
            res_tz = res_tz_prev_year;
        }
        if let Some(res_tz_next_year) = res_tz_next_year
            .filter(|val| (lnow - val).abs() < (lnow - res_tz).abs())
        {
            res_tz = res_tz_next_year;
        }
    }

    if res_tz > lmax {
        return Err(AppError::BL {
            msg: "Date or time too far in future".to_string(),
        });
    }

    Ok(res_tz.naive_local())
}

fn parse_datetime_short_year(
    lnow: DateTime<Tz>,
    capts: &regex::Captures,
) -> Result<NaiveDateTime, AppError> {
    let year2: i32 = capts["year2"].parse().c(h!())?;
    let year = 2000 + year2;
    let mon: u32 = capts["mon"].parse().c(h!())?;
    let day: u32 = capts["day"].parse().c(h!())?;
    let hour: u32 = capts["hour"].parse().c(h!())?;
    let minute: u32 = capts["minute"].parse().c(h!())?;
    let Some(res) = NaiveDate::from_ymd_opt(year, mon, day)
        .and_then(|d| d.and_hms_opt(hour, minute, 0))
    else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };
    let Some(res_tz) = lnow.timezone().from_local_datetime(&res).earliest()
    else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };
    if res_tz > lnow + chrono::Duration::days(2) {
        return Err(AppError::BL {
            msg: "Date or time too far in future".to_string(),
        });
    }
    Ok(res_tz.naive_local())
}

fn try_offset_year(
    d: DateTime<Tz>,
    offset: i32,
    max: DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    d.with_year(d.year() + offset).filter(|val| val < &max)
}

/// Parses datetime string like "11 грудня 2023 19:46"
pub fn parse_delta_csv_dt(s: &str) -> Result<NaiveDateTime, AppError> {
    println!("s = {s}");
    let s = s
        .replace("січня", "01")
        .replace("лютого", "02")
        .replace("березня", "03")
        .replace("квітня", "04")
        .replace("травня", "05")
        .replace("червня", "06")
        .replace("липня", "07")
        .replace("серпня", "08")
        .replace("вересня", "09")
        .replace("жовтня", "10")
        .replace("листопада", "11")
        .replace("грудня", "12");
    let s = s
        .replace("january", "01")
        .replace("february", "02")
        .replace("march", "03")
        .replace("april", "04")
        .replace("may", "05")
        .replace("june", "06")
        .replace("july", "07")
        .replace("august", "08")
        .replace("september", "09")
        .replace("october", "10")
        .replace("november", "11")
        .replace("december", "12");
    println!("s = {s}");
    Ok(NaiveDateTime::parse_from_str(&s, "%d %m %Y %H:%M").c(h!())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::Kyiv;

    fn fixed_now(tz: chrono_tz::Tz) -> chrono::DateTime<chrono_tz::Tz> {
        tz.with_ymd_and_hms(2025, 12, 30, 10, 15, 30).unwrap()
    }

    #[test]
    fn extract_datetime_test01() {
        let input = r#"08.02.2023_21:00 F=455,5550(МГц)
 ()
НВ (НВ)
НВ (НВ)
"Назвать его Ебаньком он начал атаковать своих, ему пизда, тебе пизда, как принял прием? Принял тебя Заря, ты где сейчас?""#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 2, 8)
                .unwrap()
                .and_hms_opt(21, 0, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_zp_peleng_vorony_odina_mgrs_format() {
        let input = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 7, 42)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_zp_peleng_vorony_odina_sk42_format() {
        let input = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 10, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_prefers_trailing_timestamp() {
        let input =
            "01.07.2026 03:07:42\nнестандартне повідомлення\n23:59 31.07.2026";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 8, 1, 10, 15, 30).unwrap();

        let res = extract_datetime(lnow, input).unwrap();

        assert_eq!(
            res,
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 31)
                    .unwrap()
                    .and_hms_opt(23, 59, 0)
                    .unwrap()
            )
        );
        assert_eq!(
            without_trailing_datetime(input),
            "01.07.2026 03:07:42\nнестандартне повідомлення"
        );
    }

    #[test]
    fn extract_datetime_zp_digital_post_alt_format() {
        let input = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 4, 16)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_zp_peleng_vorony_odina_rejects_far_future() {
        let input = "Пост Shark 4\n447.450\nр-н. Шевченка\n36T VS 89904 14667\n01.07.2099 03:07:42";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_datetime_zp_digital_post_alt_rejects_far_future() {
        let input = "01.07.2099, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_datetime_ts_freq_reporting_format() {
        let input = "01.07.2026 02:58:08 F=170.0250(МГц)\nПерехоплення";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 30, 10, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(2, 58, 8)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test02() {
        let input = r#"17.11, 00:01:49
465.8250
УКХ р/м управління штурмової роти "Шторм Z" 136 омсбр 58 А 
НВ
НВ

1. Дойди до Ахиллеса, посмотри, может там батарейка села на рации.
2. Принял.
1. Ты видишь меня на дороге?"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = lnow.year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 17)
                .unwrap()
                .and_hms_opt(0, 1, 49)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_keeps_time() {
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let dt1: NaiveDateTime =
            extract_datetime(lnow, "16.02.2023_10:55").unwrap().unwrap();
        let dt2 = Kyiv.from_local_datetime(&dt1).unwrap();
        let expected: chrono::DateTime<chrono_tz::Tz> =
            Kyiv.with_ymd_and_hms(2023, 2, 16, 10, 55, 0).unwrap();
        assert_eq!(dt2, expected);
    }

    #[test]
    fn extract_datetime_test03() {
        let input = r#"2023-09-04_20:17:25 F=433.25(МГц)
 ()
НВ (НВ)
НВ (НВ)
"Назвать его Ебаньком он начал атаковать своих, ему пизда, тебе пизда, как принял прием? Принял тебя Заря, ты где сейчас?""#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 9, 4)
                .unwrap()
                .and_hms_opt(20, 17, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_handles_full_date_without_seconds() {
        let input = "Тип: Антена\nНазва: 141.715 МГц\n24.06.2026 17:32\nКоординати: 36U XB 66512 50880";
        let lnow = Kyiv.with_ymd_and_hms(2026, 6, 27, 20, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 6, 24)
                .unwrap()
                .and_hms_opt(17, 32, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_report_125_sample() {
        let input = r#"16.07.2026 11:34:32
Назва: А-50 (А-50У) РЛС з РТК «Шмєль-М»;
Умовні координати для бота: MGRS 37U DR 32515 05505;
Кут: 79.6;
Частота: 3330;"#;
        let lnow = Kyiv.with_ymd_and_hms(2026, 7, 17, 20, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 7, 16)
                .unwrap()
                .and_hms_opt(11, 34, 32)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_handles_antenna_short_year_time_label() {
        let input = "Тип: Антена\nНазва: 136.850 МГц\nЧас: 26.06.26  19:46\nКоординати: 36U XB 70617 18612";
        let lnow = Kyiv.with_ymd_and_hms(2026, 6, 27, 20, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 6, 26)
                .unwrap()
                .and_hms_opt(19, 46, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test04() {
        let input = r#"17.11, 15:56:55
436.1000
УКХ НВ 436.100
НВ
НВ
47.4527, 35.77689

1. Там всё, две фары. Один вот, шуровый, чо жалеть...
"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = lnow.year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 17)
                .unwrap()
                .and_hms_opt(15, 56, 55)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test05() {
        let input = r#"⚠️19.11 11:54:51
402.3550
УКХ НВ
САМУРАЙ
СТУДЕНТ
- 1 Провёл небольшую ротацию. Провели разведку в окопе, где КОСА сидел, я проводил и КОСА, вдвоём. Посадил щас туда 10 человек
- 2 Ты им приборы дал?
- 1 Да, всё дал, похавать дал"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = lnow.year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 19)
                .unwrap()
                .and_hms_opt(11, 54, 51)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test06() {
        let input = r#"⚡⚡⚡ 417.750 - УКХ р/м управління 237 дшп 7 дшд (НОВОПРОКОПІВКА) /

Час: 20:09:41
1. Дом, я Лесник, понаблюдайте, там наши соседи фонарики какие-то наблюдают где-то, посмотрите обтановочку и доложите
"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let now = lnow;
        let dt = lnow;
        let dt = if now.hour() <= 20 {
            if now.hour() == 20 && now.minute() > 9 {
                dt
            } else {
                dt - chrono::Duration::days(1)
            }
        } else {
            dt
        };
        let expected = Some(
            NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
                .unwrap()
                .and_hms_opt(20, 9, 41)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test07() {
        let input = r#"2023-11-06T05:14:54"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 11, 6)
                .unwrap()
                .and_hms_opt(5, 14, 54)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test08() {
        let input = r#"⚠️20.12, 13:45:21
430.000
УКХ р/м ймовірно 237 дшп
НВ
НВ

1 - Батарейки на Азарт заряжение все у вас ?
1 - Давай потихонечку начинай собирать
2 - Да принял да
1 - Через час полтора чтоб все било собрано что сидели на чемодане как понял
1 - Карандашей сколько
1 - ЛЕНКОР Я МОЛЧАН
1 - Через полтора часа все вещи собрании
1 - С первого раза что блять не понятно , не уходишь пока от туда не заберёшь АЗГАРДА и КАБАНА как принял
1 - По закону 20-ть дней как полагается
1 - Ти меня понял нет , это первая партия будет( . . .) выходить я хуй знает пойми короче , твоя задача встретить АЗГАРДА забрать и ЖОСТКОГО з собой , только тогда ти подходишь как меня понял прием
2 - Да я принял тогда я один остаюсь остальных отправляю"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = lnow.year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 12, 20)
                .unwrap()
                .and_hms_opt(13, 45, 21)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test09() {
        let input = r#"2025_01_13 17-02-34
Частота: 274,750 MHz
Канал: Unknown
Напрямок: Суджа, Снагість, Обухівка

— второй 076 Спасибо за прикрытие счастья здоровья"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 1, 13)
                .unwrap()
                .and_hms_opt(17, 2, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test10() {
        let input = r#"24.07.2025, 08:05:21
149.7300
УКХ р/м 60 омсб "Сомалі" 9 омсбр (ЗАТИШОК - сх НОВЕ ШАХОВЕ)
ТРАКТОР
НВ

— Депутат, Депутат Трактору.
— Да, все живы, машине пизда."#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 7, 24)
                .unwrap()
                .and_hms_opt(8, 5, 21)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_commintify_header_2025() {
        let input = r#"Отримано з поста "."
--------------------------------------
20.11.2025, 12:29:18
157.8750
УКХ р/м НВ підрозділу 157.875 МГц
НВ
НВ

— Первый раунд 4, Шапка 1."#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(lnow.year(), 11, 20)
                .unwrap()
                .and_hms_opt(12, 29, 18)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_dash_date_keeps_seconds() {
        let input = r#"20-11 16:53:04
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = lnow.year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 20)
                .unwrap()
                .and_hms_opt(16, 53, 4)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_full_date_space_time() {
        let input = r#"УКХ р/м управління підрозділу противника
ДОРОЗВІДКА
144.581 МГц

20.11.2025 16:56:01

Отримувач(і): ШУТ,
РЯБА
Відправник: НВ

1. Птицы лишние разогнали, если не слышите, блять, прям чухайте по-быстрому к саму дому, Комиком мы работаем.
1. ШУТ, РЯБА , как раз пока по тому дому, где пидары сидят, ебашит слоник, птицы ми разогнали лишние, если никого не слышите, гасите домой, гасите домой.
1. Давай, все у вас видим, давайте, пацаны, быстрее, быстрее, там далеко наша птица, висит другая, давайте быстрее."#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 11, 20)
                .unwrap()
                .and_hms_opt(16, 56, 1)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_time_before_date() {
        let input = r#"11:37 29.11.2025
Пост: КВАНТ
Частота: 143.545
Напрямок: Пн. Дворічна
Координати (MGRS): 37U DR 03349 25624"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 11, 29)
                .unwrap()
                .and_hms_opt(11, 37, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_time_before_date_with_extra_space() {
        let input = r#"16:41  25.02.2026
139.450
УКХ р/м
Перехоплення"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 2, 25, 18, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 2, 25)
                .unwrap()
                .and_hms_opt(16, 41, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_time_before_date_does_not_cross_newline() {
        let input = "Передали`16:41\n25.02.2026 без часу";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 2, 26, 18, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_datetime_time_with_seconds_before_date_does_not_cross_newline() {
        let input = "Передали`16:41:12\n25.02.2026 без часу";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 2, 26, 18, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_datetime_date_before_time_does_not_cross_newline() {
        let input = "Передали 25.02.2026\n16:41 без часу";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 2, 26, 18, 15, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 2, 26)
                .unwrap()
                .and_hms_opt(16, 41, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_23feb24_1() {
        let input = r#"Дата: 2024-02-21;
Частота: 408.500;
Локація: Авдіївка (йм. в напрямку Ласточкине);
Підрозділ: УКХ р/м невизначеного підрозділу;
Час: 17:28;
Хто: Змей;
Кому: Чёрный;
Текст:
- Чёрный я Змей ответь по керосину
- ..
- 3 мсб? правильно?;
.
Коментар: ( запит на зв'язок );"#;
        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 2, 21)
                .unwrap()
                .and_hms_opt(17, 28, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_kupyansk_hms_before_date() {
        // https://github.com/echoua/echo/issues/2538

        let input = r#"13:17:14 14.06.2026
Частота: 408.500;
Локація: Авдіївка (йм. в напрямку Ласточкине);
Підрозділ: УКХ р/м невизначеного підрозділу;
Час: 17:28;
Хто: Змей;
Кому: Чёрный;
Текст:
- Чёрный я Змей ответь по керосину
- ..
- 3 мсб? правильно?;
.
Коментар: ( запит на зв'язок );"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 14, 13, 56, 30).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 6, 14)
                .unwrap()
                .and_hms_opt(13, 17, 14)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_closest_past() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2025, 2, 1, 1, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 12, 31)
                .unwrap()
                .and_hms_opt(19, 31, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_closest_future() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2024, 12, 30, 1, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 12, 31)
                .unwrap()
                .and_hms_opt(19, 31, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_next_year_future() {
        let input = r#"01.01, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2024, 12, 31, 1, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(19, 31, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_toofar_future() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2024, 11, 1, 21, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = None;
        assert_eq!(res, expected);
    }

    #[ignore]
    #[test]
    fn extract_datetime_kharkiv() {
        let body = r#"УКХ р/м управління мінометної батареї зі складу 155 обр МП
( в районі СТРІЛЕЧА)
23:52	МАКИМАК	ЧЕРНЫЙ	444.363
1. Там как СОЧИ до тебя дотянуться, узнай у них обстановку, как, че, кто там остался, и выйдешь на меня.
2. да принял.
(Л)"#;

        let tz = crate::config::get_tz();
        let lnow = fixed_now(tz);
        let res = extract_datetime(lnow, body).unwrap();

        let dt = lnow;
        let dt = if lnow.hour() <= 20 {
            if lnow.hour() == 20 && lnow.minute() > 9 {
                dt
            } else {
                dt - chrono::Duration::days(1)
            }
        } else {
            dt
        };
        let expected = Some(
            NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
                .unwrap()
                .and_hms_opt(23, 52, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_non_rer_header_without_machine_id() {
        let input = "50 обрБпС | 2026-06-26\n11-34\nbody";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 26, 12, 0, 0).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 6, 26)
                .unwrap()
                .and_hms_opt(11, 34, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_non_rer_header_with_machine_id() {
        let input = "50 обрБпС [33hhfg50d] | 2026-06-26_08-13-12";
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2026, 6, 26, 12, 0, 0).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2026, 6, 26)
                .unwrap()
                .and_hms_opt(8, 13, 12)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }
}
