use chrono::NaiveDateTime;
use lazy_static::lazy_static;
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZpDigitalPostAltFormat {
    pub post_name: String,
    pub network_line: String,
    pub timestamp: NaiveDateTime,
}

pub fn parse(body: &str) -> Option<ZpDigitalPostAltFormat> {
    let body = body.trim_end_matches(['\r', '\n']);
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() != 3 {
        return None;
    }

    lazy_static! {
        static ref TIMESTAMP_RE: Regex =
            Regex::new(r#"^\s*\d{2}\.\d{2}\.\d{4},\s+\d{2}:\d{2}:\d{2}\s*$"#)
                .unwrap();
        static ref FREQ_POST_RE: Regex =
            Regex::new(r#"^\s*\d{3}\.\d{3,5}\s+(?P<post>ЦФП\d+)\s*$"#).unwrap();
        static ref NETWORK_RE: Regex =
            Regex::new(r#"^\s*(?P<network>УКХ\s+р/м\s+.+\(.+\))\s*$"#).unwrap();
    }

    if !TIMESTAMP_RE.is_match(lines[0]) {
        return None;
    }
    let timestamp =
        NaiveDateTime::parse_from_str(lines[0].trim(), "%d.%m.%Y, %H:%M:%S")
            .ok()?;
    let post_name = FREQ_POST_RE
        .captures(lines[1])?
        .name("post")?
        .as_str()
        .trim()
        .to_string();
    let network_line = NETWORK_RE
        .captures(lines[2])?
        .name("network")?
        .as_str()
        .trim()
        .to_string();

    Some(ZpDigitalPostAltFormat {
        post_name,
        network_line,
        timestamp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn parses_zp_digital_post_alt_format() {
        let body = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let parsed = parse(body).unwrap();
        assert_eq!(parsed.post_name, "ЦФП55");
        assert_eq!(
            parsed.network_line,
            "УКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)"
        );
        assert_eq!(
            parsed.timestamp,
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 4, 16)
                .unwrap()
        );
    }

    #[test]
    fn rejects_zp_digital_post_alt_format_with_extra_line() {
        let body = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)\nextra";
        assert!(parse(body).is_none());
    }

    #[test]
    fn rejects_zp_digital_post_alt_format_without_post() {
        let body = "01.07.2026, 03:04:16\n167.3000\nУКХ р/м управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        assert!(parse(body).is_none());
    }
}
