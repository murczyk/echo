use anyhow::Context;
use chrono::{
    Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone,
};
use chrono_tz::Europe::Kyiv;

pub fn from_date_time_text(
    date: Option<&str>,
    time: Option<&str>,
) -> anyhow::Result<Option<NaiveDateTime>> {
    let (Some(date), Some(time)) = (date, time) else {
        return Ok(None);
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(date, "%d.%m.%Y"))?;
    let time = NaiveTime::parse_from_str(time, "%H:%M:%S%.f")
        .or_else(|_| NaiveTime::parse_from_str(time, "%H:%M"))?;
    let local_datetime = date.and_time(time);
    Ok(Some(kyiv_local_to_utc(local_datetime)?))
}

fn kyiv_local_to_utc(
    local_datetime: NaiveDateTime,
) -> anyhow::Result<NaiveDateTime> {
    match Kyiv.from_local_datetime(&local_datetime) {
        LocalResult::Single(datetime) => Ok(datetime.naive_utc()),
        LocalResult::Ambiguous(first, second) => {
            Ok(std::cmp::Ord::max(first.naive_utc(), second.naive_utc()))
        }
        LocalResult::None => {
            let previous_day = local_datetime - Duration::days(1);
            let previous_offset = Kyiv
                .offset_from_local_datetime(&previous_day)
                .latest()
                .context("missing Kyiv UTC offset")?
                .fix()
                .local_minus_utc();
            Ok(local_datetime - Duration::seconds(i64::from(previous_offset)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_time_text_matches_postgres_kyiv_conversion() {
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), Some("12:34:56")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 56)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2026-07-15"), Some("12:34:56")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 15)
                    .unwrap()
                    .and_hms_opt(9, 34, 56)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2024-03-31"), Some("03:30:00")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2024, 3, 31)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2024-10-27"), Some("03:30:00")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2024, 10, 27)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap()
            )
        );
    }

    #[test]
    fn date_time_text_requires_both_values() {
        assert_eq!(from_date_time_text(None, Some("12:34:56")).unwrap(), None);
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), None).unwrap(),
            None
        );
    }

    #[test]
    fn date_time_text_accepts_minute_precision() {
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), Some("12:34")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 0)
                    .unwrap()
            )
        );
    }

    #[test]
    fn date_time_text_accepts_legacy_date_format() {
        assert_eq!(
            from_date_time_text(Some("25.06.2026"), Some("12:34:56")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 6, 25)
                    .unwrap()
                    .and_hms_opt(9, 34, 56)
                    .unwrap()
            )
        );
    }
}
