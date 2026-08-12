use lazy_static::lazy_static;
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZpPelengExtendedFormat {
    pub post_name: String,
    pub pelengation_object: String,
    pub location: String,
    pub coordinate_text: String,
    pub signal_type: String,
    pub unit_name: String,
    pub interception_text: String,
}

pub fn parse(body: &str) -> Option<ZpPelengExtendedFormat> {
    crate::rer_importer::datetime::trailing_datetime(body)?;
    let body = crate::rer_importer::datetime::without_trailing_datetime(body);
    let lines = body.lines().collect::<Vec<_>>();
    if lines.len() < 6 {
        return None;
    }

    lazy_static! {
        static ref POST_RE: Regex =
            Regex::new(r#"(?iu)^\s*пост\s+(?P<post>\S(?:.*\S)?)\s*$"#).unwrap();
        static ref FREQ_OBJECT_RE: Regex =
            Regex::new(r#"^\s*\d{3}[.,]\d{3,5}\s+(?P<object>\S(?:.*\S)?)\s*$"#)
                .unwrap();
        static ref LOCATION_RE: Regex = Regex::new(
            r#"(?iu)^\s*(?P<location>(?:р-н\.?|район)\s+\S(?:.*\S)?)\s*$"#
        )
        .unwrap();
        static ref X_RE: Regex =
            Regex::new(r#"(?i)^\s*x\s*:\s*\d{2}-\d{5}\s*$"#).unwrap();
        static ref Y_RE: Regex =
            Regex::new(r#"(?i)^\s*y\s*:\s*\d{2}-\d{5}\s*$"#).unwrap();
        static ref MGRS_RE: Regex = Regex::new(
            r#"(?i)^\s*(?:MGRS\s+)?\d{2}[A-Z]\s+[A-Z]{2}\s+\d{5}\s+\d{5}\s*$"#
        )
        .unwrap();
        static ref NETWORK_RE: Regex = Regex::new(
            r#"(?iu)^\s*(?P<signal_type>УКХ|КХ|DMRE?|NFM|AM|TETRA|ЦИФРА)\s+(?P<unit_name>\S(?:.*\S)?)\s*$"#
        )
        .unwrap();
    }

    let post_name = POST_RE
        .captures(lines[0])?
        .name("post")?
        .as_str()
        .trim()
        .to_string();
    let pelengation_object = FREQ_OBJECT_RE
        .captures(lines[1])?
        .name("object")?
        .as_str()
        .trim()
        .to_string();
    let location = LOCATION_RE
        .captures(lines[2])?
        .name("location")?
        .as_str()
        .trim()
        .to_string();

    let (coordinate_text, network_line_index) = if X_RE.is_match(lines[3])
        && lines.get(4).is_some_and(|line| Y_RE.is_match(line))
    {
        (format!("{}\n{}", lines[3].trim(), lines[4].trim()), 5)
    } else if MGRS_RE.is_match(lines[3]) {
        (lines[3].trim().to_string(), 4)
    } else {
        return None;
    };

    let network = NETWORK_RE.captures(lines.get(network_line_index)?)?;
    let signal_type = network.name("signal_type")?.as_str().trim().to_string();
    let unit_name = network.name("unit_name")?.as_str().trim().to_string();
    let interception_text = lines[network_line_index + 1..]
        .join("\n")
        .trim()
        .to_string();
    if interception_text.is_empty() {
        return None;
    }

    Some(ZpPelengExtendedFormat {
        post_name,
        pelengation_object,
        location,
        coordinate_text,
        signal_type,
        unit_name,
        interception_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "пост Фокстрот-Наутілус-Дракар\n446.300 TYT назва: ретранслятор\nр-н Верхній Рогачик\nx:52-41410\ny:65-99914\nУКХ радіомережа ППО смуга 49 А\nНВ\nНВ\n\n— Кольцо 22, я техас, прием.\n23:59 31.07.2026";

    #[test]
    fn parses_extended_peleng_format() {
        let parsed = parse(BODY).unwrap();

        assert_eq!(parsed.post_name, "Фокстрот-Наутілус-Дракар");
        assert_eq!(parsed.pelengation_object, "TYT назва: ретранслятор");
        assert_eq!(parsed.location, "р-н Верхній Рогачик");
        assert_eq!(parsed.coordinate_text, "x:52-41410\ny:65-99914");
        assert_eq!(parsed.signal_type, "УКХ");
        assert_eq!(parsed.unit_name, "радіомережа ППО смуга 49 А");
        assert_eq!(
            parsed.interception_text,
            "НВ\nНВ\n\n— Кольцо 22, я техас, прием."
        );
    }

    #[test]
    fn parses_single_line_mgrs_coordinate() {
        let body = BODY.replace("x:52-41410\ny:65-99914", "37U DR 25041 12982");
        let parsed = parse(&body).unwrap();

        assert_eq!(parsed.coordinate_text, "37U DR 25041 12982");
    }

    #[test]
    fn rejects_message_without_interception() {
        let body = "пост Фокстрот\n446.300 TYT назва: ретранслятор\nр-н Верхній Рогачик\n37U DR 25041 12982\nУКХ радіомережа ППО\n23:59 31.07.2026";

        assert!(parse(body).is_none());
    }

    #[test]
    fn rejects_message_without_network_line() {
        let body = "пост Фокстрот\n446.300 TYT назва: ретранслятор\nр-н Верхній Рогачик\n37U DR 25041 12982\n— Кольцо 22, я техас, прием.\n— Прийняв.\n23:59 31.07.2026";

        assert!(parse(body).is_none());
    }
}
