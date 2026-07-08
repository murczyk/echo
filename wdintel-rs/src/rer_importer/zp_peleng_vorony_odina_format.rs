use chrono::NaiveDateTime;
use lazy_static::lazy_static;
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZpPelengVoronyOdinaFormat {
    pub post_name: String,
    pub location: String,
    pub coordinate_text: String,
    pub timestamp: NaiveDateTime,
}

pub fn parse(body: &str) -> Option<ZpPelengVoronyOdinaFormat> {
    let body = body.trim_end_matches(['\r', '\n']);
    parse_mgrs(body).or_else(|| parse_sk42(body))
}

fn parse_mgrs(body: &str) -> Option<ZpPelengVoronyOdinaFormat> {
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() != 5 {
        return None;
    }
    let common = parse_common(lines[0], lines[1], lines[2])?;
    lazy_static! {
        static ref MGRS_RE: Regex = Regex::new(
            r#"^\s*(?P<mgrs>\d{2}[A-Z]\s+[A-Z]{2}\s+\d{5}\s+\d{5})\s*$"#
        )
        .unwrap();
    }
    let coordinate_text = MGRS_RE
        .captures(lines[3])?
        .name("mgrs")?
        .as_str()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let timestamp =
        NaiveDateTime::parse_from_str(lines[4].trim(), "%d.%m.%Y %H:%M:%S")
            .ok()?;
    Some(common.into_format(coordinate_text, timestamp))
}

fn parse_sk42(body: &str) -> Option<ZpPelengVoronyOdinaFormat> {
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() != 6 {
        return None;
    }
    let common = parse_common(lines[0], lines[1], lines[2])?;
    lazy_static! {
        static ref X_RE: Regex =
            Regex::new(r#"^\s*x:(?P<x>\d{2}-\d{5})\s*$"#).unwrap();
        static ref Y_RE: Regex =
            Regex::new(r#"^\s*y:(?P<y>\d{2}-\d{5})\s*$"#).unwrap();
    }
    let x = X_RE.captures(lines[3])?.name("x")?.as_str();
    let y = Y_RE.captures(lines[4])?.name("y")?.as_str();
    let coordinate_text = format!("x:{x}\ny:{y}");
    let timestamp =
        NaiveDateTime::parse_from_str(lines[5].trim(), "%H:%M %d.%m.%Y")
            .ok()?;
    Some(common.into_format(coordinate_text, timestamp))
}

fn parse_common(post: &str, freq: &str, location: &str) -> Option<Common> {
    lazy_static! {
        static ref POST_RE: Regex =
            Regex::new(r#"^\s*Пост\s+(?P<post>\S(?:.*\S)?)\s*$"#).unwrap();
        static ref FREQ_RE: Regex =
            Regex::new(r#"^\s*\d{3}\.\d{3,5}\s*$"#).unwrap();
        static ref LOCATION_RE: Regex =
            Regex::new(r#"(?i)^\s*(?P<location>р-н\.?\s+\S(?:.*\S)?)\s*$"#)
                .unwrap();
    }
    let post_name = POST_RE
        .captures(post)?
        .name("post")?
        .as_str()
        .trim()
        .to_string();
    if !FREQ_RE.is_match(freq) {
        return None;
    }
    let location = LOCATION_RE
        .captures(location)?
        .name("location")?
        .as_str()
        .trim()
        .to_string();
    Some(Common {
        post_name,
        location,
    })
}

struct Common {
    post_name: String,
    location: String,
}

impl Common {
    fn into_format(
        self,
        coordinate_text: String,
        timestamp: NaiveDateTime,
    ) -> ZpPelengVoronyOdinaFormat {
        ZpPelengVoronyOdinaFormat {
            post_name: self.post_name,
            location: self.location,
            coordinate_text,
            timestamp,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn parses_zp_peleng_vorony_odina_mgrs_format() {
        let body = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let parsed = parse(body).unwrap();
        assert_eq!(parsed.post_name, "Shark 4");
        assert_eq!(parsed.location, "р-н. Шевченка");
        assert_eq!(parsed.coordinate_text, "36T VS 89904 14667");
        assert_eq!(
            parsed.timestamp,
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 7, 42)
                .unwrap()
        );
    }

    #[test]
    fn parses_zp_peleng_vorony_odina_sk42_format() {
        let body = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let parsed = parse(body).unwrap();
        assert_eq!(parsed.post_name, "Танго-Ехо");
        assert_eq!(parsed.location, "Р-н Таврія");
        assert_eq!(parsed.coordinate_text, "x:51-29637\ny:65-01850");
        assert_eq!(
            parsed.timestamp,
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(3, 10, 0)
                .unwrap()
        );
    }

    #[test]
    fn rejects_zp_peleng_vorony_odina_format_with_extra_line() {
        let body = "Пост Shark 4\n447.450\nр-н. Шевченка\n36T VS 89904 14667\n01.07.2026 03:07:42\nextra";
        assert!(parse(body).is_none());
    }

    #[test]
    fn rejects_zp_peleng_vorony_odina_format_without_location_prefix() {
        let body = "Пост Shark 4\n447.450\nШевченка\n36T VS 89904 14667\n01.07.2026 03:07:42";
        assert!(parse(body).is_none());
    }
}
