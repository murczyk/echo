use crate::error::AppError;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    PartialOrd,
    Ord,
    Hash,
    Eq,
)]
pub struct NoHeadersBody {
    pub body: String,
    pub start: usize,
    pub end: usize,
}

lazy_static! {
    // Remove data from Buran
    static ref RE: Regex = Regex::new(
        r#"^(Район|Частота|Час|Дата/час|Дата|Локація|Мережа|Засічка|Підрозділ|Хто|Кому|Абоненти|Позивні|Коментар|Пост|Координати|Тип|Назва|Ворожий|Зауваження штабу|Тип сигналу|Приналежність|Мітк(?:а|и) перехоплення):"#
    )
    .unwrap();
    // Remove data with line starting as below
    static ref RE0: Regex = Regex::new(
        r#"^\s*Отримано з пост(а|ів)"#
    )
    .unwrap();
    // Remove data time line from Mouse #1
    static ref RE1: Regex = Regex::new(
        r#"^(⚠️)?\s*[0-9]{2}\.[0-9]{2}\.[0-9]{4}_[0-9]{2}:[0-9]{2}"#
    )
    .unwrap();
    // Remove data time line from Mouse #2
    static ref RE2: Regex = Regex::new(
        r#"^(⚠️)?\s*[0-9]{2}.[0-9]{2}\s*,\s*[0-9]{2}:[0-9]{2}:[0-9]{2}"#
    )
    .unwrap();
    // Remove data time line hh:mm dd.mm.yyyy
    static ref RE21: Regex = Regex::new(
        r#"^[0-9]{2}:[0-9]{2}[ \t]+[0-9]{2}\.[0-9]{2}\.[0-9]{4}$"#
    )
    .unwrap();
    // Remove data time line Дата dd.mm.yyyy
    static ref RE22: Regex = Regex::new(
        r#"^Дата [0-9]{2}\.[0-9]{2}\.[0-9]{4}$"#
    )
    .unwrap();
    // Remove data time line Час hh:mm:ss
    static ref RE23: Regex = Regex::new(
        r#"^Час [0-9]{2}:[0-9]{2}:[0-9]{2}$"#
    )
    .unwrap();
    // Remove data time line hh:mm
    static ref RE24: Regex = Regex::new(
        r#"^[0-9]{2}:[0-9]{2}$"#
    )
    .unwrap();
    // Remove data time line dd.mm.yyyy hh:mm:ss
    static ref RE25: Regex = Regex::new(
        r#"^[0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}$"#
    )
    .unwrap();
    // Remove data time + freq line dd.mm.yyyy hh:mm:ss F=123.4567(МГц)
    static ref RE25_FREQ: Regex = Regex::new(
        r#"^[0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}\s+[Ff]\s*=\s*[0-9]{3}(\.|,)[0-9]{3,5}\s*(\(?МГц\)?|MHz)$"#
    )
    .unwrap();
    // Remove frequency line like F=148.175 DMR
    static ref RE_F_DMR: Regex = Regex::new(
        r#"^[Ff]\s*=\s*[0-9]{3}(\.|,)[0-9]{3,5}\s*DMR\s*$"#
    )
    .unwrap();
    // Remove data time line dd.mm.yyyy hh:mm
    static ref RE25A: Regex = Regex::new(
        r#"^[0-9]{2}\.[0-9]{2}\.[0-9]{4}[,\s]+[0-9]{1,2}:[0-9]{2}\s*$"#
    )
    .unwrap();
    // Remove data time line yyyy-mm-dd, hh:mm
    static ref RE26: Regex = Regex::new(
        r#"^[0-9]{4}\-[0-9]{2}\-[0-9]{2}, [0-9]{2}:[0-9]{2}$"#
    )
    .unwrap();
    // Remove data time line dd.mm, hh:mm
    static ref RE27: Regex = Regex::new(
        r#"^[0-9]{2}\.[0-9]{2}, [0-9]{2}:[0-9]{2}$"#
    )
    .unwrap();
    // Remove data time line dd.mm.yyyy, hh:mm:ss
    static ref RE28: Regex = Regex::new(
        r#"^[0-9]{2}\.[0-9]{2}\.[0-9]{4}, [0-9]{2}:[0-9]{2}:[0-9]{2}\s*$"#
    )
    .unwrap();
    // Remove data time line hh:mm:ss dd.mm.yyyy
    static ref RE29: Regex = Regex::new(
        r#"^[0-9]{2}:[0-9]{2}:[0-9]{2}[ \t]+[0-9]{2}\.[0-9]{2}\.[0-9]{4}$"#
    )
    .unwrap();
    // Remove non-RER machine header line
    static ref RE30: Regex = Regex::new(
        r#"^.+\|\s*[0-9]{4}\-[0-9]{2}\-[0-9]{2}(_[0-9]{2}-[0-9]{2}-[0-9]{2})?\s*$"#
    )
    .unwrap();
    // Remove non-RER machine time line
    static ref RE31: Regex =
        Regex::new(r#"^[0-9]{2}-[0-9]{2}(-[0-9]{2})?$"#).unwrap();
    // Remove unit line from Mouse
    static ref RE3: Regex = Regex::new(r#"^[^\p{L}\p{N}]*(?i:new\s+)?(?:[0-9]+\s+)?(?:[0-9]{3}(?:\.|,)[0-9]{3,5}\s*(?:\(?МГц\)?|MHz)\s+)?(?i:(?:\[dmr\]\s*)?(?:укх|управління)|dmre?\s+р/м|р/м|ймовірно\s+.+\s+/\s*(?:район|р-н))\s"#).unwrap();
    // Remove freq line from Mouse
    static ref RE4: Regex = Regex::new(r#"^(?:\*[0-9]{3}(?:\.|,)[0-9]{3,5}\*|[0-9]{3}(?:\.|,)[0-9]{3,5}|[0-9]{3}(?:\.|,)[0-9]{1,5}\s*(?:\(?МГц\)?|(?i:MHz)))(?:\s+[а-яіїА-ЯІЇ]{0,2}(?:П|п)\s*-?\s*\d{1,3})?\s*$"#).unwrap();
    // Remove coordinates line from Mouse
    static ref RE5: Regex = Regex::new(r#"^[0-9]{2}\.[0-9]{5,7}\s*,\s*[0-9]{2}\.[0-9]{5,7}$"#).unwrap();
    // Remove line with ---------------------
    static ref RE6: Regex = Regex::new(r#"^-+$"#).unwrap();
    // Buran-style date/time label line: `Дата: ...` / `Час: ...`
    static ref RE_DT_LABEL: Regex =
        Regex::new(r#"^(Дата/час|Дата|Час)\s*[: ]"#).unwrap();
    static ref RE_UNIT_DIVIDER: Regex =
        Regex::new(r#"(?i)^-+\s*(?:РЕР|РР)\s+\d+\s+[^-]+-+$"#).unwrap();
    static ref UNIT_WATERMARK_LINES: HashSet<String> = ["---- РР 47 ОМБР ----"]
        .into_iter()
        .map(normalize_unit_watermark_line)
        .collect();
}

pub fn is_header_line(line: &str) -> bool {
    is_metadata_header_line(line) || is_non_metadata_header_line(line)
}

fn is_metadata_header_line(line: &str) -> bool {
    crate::rer_importer::inbox::metadata::is_metadata_line(line)
}

fn is_non_metadata_header_line(line: &str) -> bool {
    is_header_line_raw(line)
        || normalize_decorated_header_line(line)
            .is_some_and(|line| is_header_line_raw(&line))
}

fn is_header_line_raw(line: &str) -> bool {
    RE.is_match(line)
        || RE0.is_match(line)
        || RE1.is_match(line)
        || RE2.is_match(line)
        || RE21.is_match(line)
        || RE22.is_match(line)
        || RE23.is_match(line)
        || RE24.is_match(line)
        || RE25.is_match(line)
        || RE25_FREQ.is_match(line)
        || RE_F_DMR.is_match(line)
        || RE25A.is_match(line)
        || RE26.is_match(line)
        || RE27.is_match(line)
        || RE28.is_match(line)
        || RE29.is_match(line)
        || RE30.is_match(line)
        || RE31.is_match(line)
        || RE3.is_match(line)
        || RE4.is_match(line)
        || RE5.is_match(line)
        || RE6.is_match(line)
        || RE_UNIT_DIVIDER.is_match(line)
}

pub fn is_datetime_header_line(line: &str) -> bool {
    is_datetime_header_line_raw(line)
        || normalize_decorated_header_line(line)
            .is_some_and(|line| is_datetime_header_line_raw(&line))
}

fn is_datetime_header_line_raw(line: &str) -> bool {
    RE1.is_match(line)
        || RE2.is_match(line)
        || RE21.is_match(line)
        || RE22.is_match(line)
        || RE23.is_match(line)
        || RE24.is_match(line)
        || RE25.is_match(line)
        || RE25_FREQ.is_match(line)
        || RE25A.is_match(line)
        || RE26.is_match(line)
        || RE27.is_match(line)
        || RE28.is_match(line)
        || RE29.is_match(line)
        || RE30.is_match(line)
        || RE31.is_match(line)
        || RE_DT_LABEL.is_match(line)
}

fn normalize_decorated_header_line(line: &str) -> Option<String> {
    let line = demoji::demoji(line);
    let line = line
        .chars()
        .map(|ch| match ch {
            '[' | ']' | '{' | '}' | '(' | ')' => ' ',
            '╬' => ' ',
            '│' => ' ',
            '\u{200d}' | '\u{fe0e}' | '\u{fe0f}' => ' ',
            _ => ch,
        })
        .collect::<String>();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    Some(line)
}

fn is_unit_watermark_line(line: &str) -> bool {
    UNIT_WATERMARK_LINES.contains(&normalize_unit_watermark_line(line))
}

fn normalize_unit_watermark_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn trim_otrymano_post_header(line: &str) -> Option<String> {
    let marker_start = line.find("Отримано з пост")?;
    Some(line[..marker_start].trim().to_string())
}

pub fn extract_text(input: &str) -> Result<NoHeadersBody, AppError> {
    if let Some(exact_format_text) = extract_exact_format_text(input, input) {
        return Ok(exact_format_text);
    }

    extract_text_excluding_lines(input, &BTreeSet::new())
}

fn extract_exact_format_text(
    input: &str,
    position_input: &str,
) -> Option<NoHeadersBody> {
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(input)
    {
        return Some(no_headers_body_at(
            position_input,
            zp_peleng.coordinate_text,
        ));
    }
    if let Some(zp_digital_post_alt) =
        crate::rer_importer::zp_digital_post_alt_format::parse(input)
    {
        return Some(no_headers_body_at(
            position_input,
            zp_digital_post_alt.network_line,
        ));
    }

    None
}

fn no_headers_body_at(position_input: &str, body: String) -> NoHeadersBody {
    let start_byte = position_input.find(&body).unwrap_or(0);
    let start = position_input[..start_byte].chars().count();
    let end = start + body.chars().count();
    NoHeadersBody { body, start, end }
}

pub(crate) fn extract_text_excluding_lines(
    input: &str,
    excluded_lines: &BTreeSet<usize>,
) -> Result<NoHeadersBody, AppError> {
    let mut lines = positioned_lines(input, excluded_lines);
    let exact_format_input = join_positioned_lines(&lines);
    if let Some(exact_format_text) = extract_exact_format_text(
        exact_format_input.trim_matches(['\r', '\n']),
        input,
    ) {
        return Ok(exact_format_text);
    }

    lines.retain(|line| !is_non_metadata_header_line(&line.text));

    let mut start_line = 0;
    while start_line < lines.len()
        && is_boundary_header_or_empty(&lines[start_line].text)
    {
        start_line += 1;
    }
    let mut end_line = lines.len();
    while end_line > start_line
        && is_boundary_header_or_empty(&lines[end_line - 1].text)
    {
        end_line -= 1;
    }

    let lines = &lines[start_line..end_line];

    Ok(NoHeadersBody {
        body: join_positioned_lines(lines),
        start: lines.first().map_or(0, |line| line.start),
        end: lines.last().map_or(0, |line| line.end),
    })
}

struct PositionedLine {
    text: String,
    start: usize,
    end: usize,
}

fn positioned_lines(
    input: &str,
    excluded_lines: &BTreeSet<usize>,
) -> Vec<PositionedLine> {
    let mut lines = Vec::new();
    let mut line_start = 0;

    for (idx, raw_line) in input.split_inclusive('\n').enumerate() {
        let raw_line_len = raw_line.chars().count();
        if !excluded_lines.contains(&idx) {
            let line = trim_raw_line_end(raw_line);
            if !is_unit_watermark_line(line) {
                lines.push(positioned_line(line, line_start));
            }
        }
        line_start += raw_line_len;
    }

    lines
}

fn positioned_line(line: &str, line_start: usize) -> PositionedLine {
    if let Some(marker_start) = line.find("Отримано з пост") {
        let prefix = &line[..marker_start];
        let text = prefix.trim();
        let trim_start = prefix.find(text).unwrap_or(0);
        let start = line_start + prefix[..trim_start].chars().count();
        let end = start + text.chars().count();
        return PositionedLine {
            text: text.to_string(),
            start,
            end,
        };
    }

    PositionedLine {
        text: line.to_string(),
        start: line_start,
        end: line_start + line.chars().count(),
    }
}

fn trim_raw_line_end(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn join_positioned_lines(lines: &[PositionedLine]) -> String {
    let mut body = String::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            body.push('\n');
        }
        body.push_str(&line.text);
    }
    body
}

fn is_boundary_header_or_empty(line: &str) -> bool {
    line.trim().is_empty() || is_header_line(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_kraken_audio_header() {
        let body = " audio | 2026-07-01_14-47-03 \nПерехоплення\nрядок 2";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення\nрядок 2");
    }

    #[test]
    fn extract_text_metadata_lines_are_headers() {
        let body = "01.07.2026 02:58:08 F=170.0250(МГц)\nСС: 5\nID➡️: 261\nID(CG)⬅️: 8584772\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_bare_receiver_group_metadata_lines_are_headers() {
        let body =
            "01.07.2026 02:58:08\nID(CG):395251\nID(CG) 395252\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_blank_optional_metadata_lines_are_headers() {
        let body = "01.07.2026 02:58:08\nID відправника: -\nКод групи: НВ\nКод кольору: -\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_keeps_dialog_lines_with_inline_metadata() {
        let body = "01.07.2026 02:58:08 F=170.0250(МГц)\nСС: 5\nПрийняв ID: 123 і пішов\nПередай СС: 5 завтра\nID(CG)⬅️: 8584772\nПерехоплення";
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            "Прийняв ID: 123 і пішов\nПередай СС: 5 завтра\nID(CG)⬅️: 8584772\nПерехоплення"
        );
        let start_byte = body.find(&res.body).unwrap();
        assert_eq!(res.start, body[..start_byte].chars().count());
    }

    #[test]
    fn extract_text_crlf_multiline_body_uses_original_positions() {
        let body = "01.07.2026, 02:55:19\r\n155.0250\r\nКоординати: 36U XB 66512 50880\r\nУКХ р/м\r\n\r\nНВ\r\n— репліка";
        let res = extract_text(body).unwrap();
        let body_original = "НВ\r\n— репліка";
        let start_byte = body.find(body_original).unwrap();
        let end_byte = start_byte + body_original.len();

        assert_eq!(res.body, "НВ\n— репліка");
        assert_eq!(res.start, body[..start_byte].chars().count());
        assert_eq!(res.end, body[..end_byte].chars().count());
    }

    #[test]
    fn extract_text_multiline_body_positions_span_removed_middle_header() {
        let body = "01.07.2026, 02:55:19\n— перша\nКоординати: 36U XB 66512 50880\n— друга";
        let res = extract_text(body).unwrap();
        let body_start = body.find("— перша").unwrap();
        let body_end = body.find("— друга").unwrap() + "— друга".len();

        assert_eq!(res.body, "— перша\n— друга");
        assert_eq!(res.start, body[..body_start].chars().count());
        assert_eq!(res.end, body[..body_end].chars().count());
    }

    #[test]
    fn extract_text_decorated_header_lines_are_headers() {
        let body = "🔺(01.07.2026 02:58:08)\n🔺(01.07.2026 02:58:08 F=170.0250(МГц))\n│╬{*123.7586*}\n[УКХ р/м]\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_time_before_date_with_extra_space_is_header() {
        let body = "16:41  25.02.2026\n139.450\nУКХ р/м\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_f_dmr_line_is_header() {
        let body = "F= 148.175 DMR\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_freq_post_line_without_space_inside_post_is_header() {
        let body = "01.07.2026, 03:04:16\n463.4500 ЦФП52\nУКХ р/м НВ підрозділу\nПерехоплення";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_freq_mhz_unit_line_is_header() {
        let body = "02.07.2026, 03:00:04\n446.1500\n446.150 МГц УКХ р/м постів повітряного спостереження (ППС) 80 омсбр 14 АК (ІВАНІВКА, ЧУЛАКІВКА, БЕХТЕРИ)\nНВ\nОРБИТА\n\n— Орбита, Орбита, переходим на этаж выше.\n\nМітки перехоплення: 👆👆👆 - Звернути увагу";
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            "НВ\nОРБИТА\n\n— Орбита, Орбита, переходим на этаж выше."
        );
    }

    #[test]
    fn extract_text_singular_interception_marker_is_header() {
        let body = "18.07.2026, 13:59:56\n143.8150\nПАРОВОЗ\nСОКОЛ\n\n— Сокол, Паровозу\n\nМітка перехоплення: Важливо";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "ПАРОВОЗ\nСОКОЛ\n\n— Сокол, Паровозу");
    }

    #[test]
    fn extract_text_dmr_unit_line_is_header() {
        let body = "Отримано з поста \"Radiotrap_Г-Б4\"\n--------------------------------------\n02.07.2026, 02:58:44\n150.5500\nDMR р/м управління підрозділом протидії БпЛА 245 мсп 3 мсд 20 А 150.550 МГц (БОРИСІВКА, ГРУЗСКОЄ, ЦАПОВКА, КРАСНИЙ ХУТІР)\nГРОМ\nБАЗА\n\n— База, База, я Гром, остановка 7.\n— Гром, Гром, я База, принял.\n\n\nКоментар: Доповідь по обстановці.";
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            "ГРОМ\nБАЗА\n\n— База, База, я Гром, остановка 7.\n— Гром, Гром, я База, принял."
        );
    }

    #[test]
    fn extract_text_decorated_ukh_unit_line_with_inline_cc_is_header() {
        let body = "02.07.2026, 02:58:17\n430.8750\n🐵🪖УКХ ╬ р/м 9мср 3 мсб 1432 мсп ╬ (СТЕЛЬМАХІВКА - НОВОПЛАТОНІВКА) СС:10\nНВ\nАРХИВ, КОНДОР, АДВОКАТ\n\n— 5 малых, 5 малых назад выходили, выходили 1000, 1000 принял?\n— Принял, принял.";
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            "НВ\nАРХИВ, КОНДОР, АДВОКАТ\n\n— 5 малых, 5 малых назад выходили, выходили 1000, 1000 принял?\n— Принял, принял."
        );
    }

    #[test]
    fn extract_text_lowercase_decorated_ukh_unit_line_is_header() {
        let body = "02.07.2026, 02:57:03\n142.2001\n🌊/🏡 укх р/м 31 мсп 67 мсд 25 ЗА (р-н ЯМПОЛІВКА - ЗАРІЧНЕ)\nРУДНИК\nБАБАЙКА\n\n— Бабайка Роднику костлявая прошла.\n— Бабайка, да, принял.";
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            "РУДНИК\nБАБАЙКА\n\n— Бабайка Роднику костлявая прошла.\n— Бабайка, да, принял."
        );
    }

    #[test]
    fn extract_text_new_unit_line_with_trailing_mapping_date_is_header() {
        let body = "07.05.2026, 12:00:00\n155.0250\nnew УКХ р/м ПУ ФСБ рф (р-н ХОДЕЙКОВО- АЛЕКСЕЕВКА - ПОПОВО ЛЕЖАЧИ - ТЕТКИНО Курська область) 07.05\nНВ\n\n— Прийом.";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "НВ\n\n— Прийом.");
    }

    #[test]
    fn extract_text_network_metadata_rows_are_headers() {
        let rows = [
            "7 р/м управління зрбатр 1430 мсп 42 мсд 58 А (ЯБЛУНІВКА)",
            "р/м управління підрозділами 2 мсп (кт) ПКС (КОЗИНКА, ГРАЙВОРОН, БЕЗИМЕННО, НОВОСТРОЄВКА-ВТОРАЯ, БЄЛГОРОДСЬКА ОБЛАСТЬ) 6 хв",
            "р/м ситуаційної обізнаності м/н Грайворонський р-н",
            "ймовірно ПУ ФСБ РФ / район ПОПОВО-ЛЕЖАЧИ (РФ) - ТЕТКИНО (РФ) (19.06)",
            "ймовірно 12 прикз / р-н ГРАЙВОРОН (РФ) (20.06)",
            "Мережа: УКХ р/м НВ підрозділу",
            "Мережа: УКХ р/м 123 мсб 45 мсп 99А (р-н КУКУЄВО (РФ))",
            "Засічка: Тишино",
            "🏡/🪵 укх р/м зрбатр 37 мсп 67 мсд 25 ЗА (р-н ЛИМАН - ТОРСЬКЕ)",
            "new УКХ р/м ПУ ФСБ рф (р-н ХОДЕЙКОВО- АЛЕКСЕЕВКА - ПОПОВО ЛЕЖАЧИ - ТЕТКИНО Курська область) 07.05",
        ];
        for row in rows {
            let body = format!(
                "02.07.2026, 02:57:03\n142.2001\n{row}\nРУДНИК\n\n— Прийом."
            );
            let res = extract_text(&body).unwrap().body;
            assert_eq!(res, "РУДНИК\n\n— Прийом.");
        }
    }

    #[test]
    fn extract_text_removes_unit_watermark_line() {
        let watermark = "----\u{00a0}РР\u{00a0}47\u{00a0}ОМБР\u{00a0}----";
        let body = format!(
            "02.07.2026, 02:58:17\n430.8750\nУКХ р/м 9мср\nНВ\n\n— Прийом.\n{watermark}"
        );
        let res = extract_text(&body).unwrap().body;
        assert_eq!(res, "НВ\n\n— Прийом.");
    }

    #[test]
    fn extract_text_zp_peleng_vorony_odina_mgrs_format_keeps_mgrs() {
        let body = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "36T VS 89904 14667");
    }

    #[test]
    fn extract_text_zp_peleng_vorony_odina_sk42_format_keeps_xy() {
        let body = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "x:51-29637\ny:65-01850");
    }

    #[test]
    fn extract_text_zp_digital_post_alt_format_keeps_network_line() {
        let body = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            "УКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)"
        );
    }

    #[test]
    fn extract_text_otrymano_posts_plural_header() {
        let body = "Отримано з постів \"Пост 10, Пост 6, Пост 8\"\n--------------------------------------\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "— репліка");
    }

    #[test]
    fn extract_text_trims_inline_otrymano_post_header_suffix() {
        let body = "37T BN 88562 95454  Отримано з поста \"П152\"\n--------------------------------------\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let res = extract_text(body).unwrap().body;
        assert_eq!(res, "37T BN 88562 95454\n\n— репліка");
    }

    #[test]
    fn extract_text_mouse_01() {
        let body = r#"29.02.2024_15:50 F=446.1125(МГц) П54
УКХ р/м 70 мсп 42 мсд 58 А (СХ НОВОПРОКОПІВКА)
ЛАВИНА
СЕРБ
ОРЕНБУРГ
ВОЛГОГРАД
- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь  
- (2) -ЛАВИНА ... да сейчас!
- (1) -ОРЕНБУРГ на приёме 
- (2) -ОРЕНБУРГ вызови к себе пожалуйста МАРКА ИРТЫША  и САВУ  и до САВЫ собери всех к САВЕ я сейчас буду там , еду уже с этого населённика про который я тебе говорил  , сейчас переговорим !

47.4067019, 35.8642446"#;
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            r#"ЛАВИНА
СЕРБ
ОРЕНБУРГ
ВОЛГОГРАД
- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь  
- (2) -ЛАВИНА ... да сейчас!
- (1) -ОРЕНБУРГ на приёме 
- (2) -ОРЕНБУРГ вызови к себе пожалуйста МАРКА ИРТЫША  и САВУ  и до САВЫ собери всех к САВЕ я сейчас буду там , еду уже с этого населённика про который я тебе говорил  , сейчас переговорим !"#.to_string()
        );
    }

    #[test]
    fn extract_text_mouse_02() {
        let body = r#"
30.03.2023_20:50 F=420,4250(МГц)
управління мсб 60 омсбр 5 ЗА (МАКАРІВКА, НЕСКУЧНЕ)
МУЗЫКАНТ
НВ (НВ)
"- На 22-й скажите, что крестики-нолики - работают
- (НВ) Я на 420-й разговариваю, так что не переживай"
"#;
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            r#"МУЗЫКАНТ
НВ (НВ)
"- На 22-й скажите, что крестики-нолики - работают
- (НВ) Я на 420-й разговариваю, так что не переживай""#
                .to_string()
        )
    }

    #[test]
    fn extract_text_mouse_03() {
        let body = r#"
⚠️ 18.05, 00:30:50 ЦФП51 
420.4600
УКХ р/м управління 2 мсб 114 мсп 127 мсд 5 А (зх. ЧКАЛОВА)
НВ
МИТЯ, ГНОМ, КУБА, ИМАН
47.46133, 35.51282

1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?????
"#;
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            r#"НВ
МИТЯ, ГНОМ, КУБА, ИМАН

1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?????"#
                .to_string()
        )
    }

    #[test]
    fn extract_text_buran_01() {
        let body = r#"Дата: 2024-02-21;  
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
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            r#"Текст:  
- Чёрный я Змей ответь по керосину  
- ..  
- 3 мсб? правильно?;  
.  "#
                .to_string()
        )
    }

    #[test]
    fn extract_text_buran_02() {
        let body = r#"Час: 16:47
Дата: 23.02.2024
Частота: 412.300
Район: Піски Первомайське Водяне;
Підрозділ: УКХ р/м невизначеного підрозділу
Абоненти:
Позивні:

- выйди на мотор

( Запит на звязок)"#;
        let res = extract_text(body).unwrap().body;
        assert_eq!(
            res,
            r#"- выйди на мотор

( Запит на звязок)"#
                .to_string()
        )
    }

    #[test]
    fn extract_text_and_position_01() {
        let body = r#"Отримано з поста "^^ОКУНЬ^^---142 ОМБр---"
--------------------------------------
08.02, 14:12:24
462.5000
УКХ р/м НВ підрозділу 462.500 МГц
ФАРА
УСТИН, ПОДЛЫЙ

— Устин, Устин, Подлый, Подлый, Фаре."#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"ФАРА
УСТИН, ПОДЛЫЙ

— Устин, Устин, Подлый, Подлый, Фаре."#
                .to_string()
        );
        assert_eq!(res.start, 141);
        assert_eq!(res.end, 198);
    }

    #[test]
    fn extract_text_and_position_02() {
        let body = r#"08.02, 14:15:36
148.2000
УКХ р/м DMR йм ретранаслятор штурм груп +упр. бат йм 3 мсб 5 омсбр  р-н ГРОДІВКА - ІВАНІВКА - ВЕСЕЛЕ
НВ
НВ

— Мазурик, Немец, Немец, Мазурик, будьте на готове, будьте на готове, сейчас пидар хотят к вам прорваться, не дайте им этого сделать, убейте их нахуй всех."#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"НВ
НВ

— Мазурик, Немец, Немец, Мазурик, будьте на готове, будьте на готове, сейчас пидар хотят к вам прорваться, не дайте им этого сделать, убейте их нахуй всех."#
                .to_string()
        );
        assert_eq!(res.start, 126);
        assert_eq!(res.end, 288);
    }

    #[test]
    fn extract_text_and_position_03() {
        let body = r#"16.02, 22:37:00
410.3376 ЦФП 53
 (йм. мінбатр 71 мсп зх. РОБОТИНЕ)
ГУЛЛИВЕР
НВ

— ....я Гулливер....
— ....я Мавик. Принимаю на 5.
— Да, вас принял. Дежурим.
— Гулливер, да."#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#" (йм. мінбатр 71 мсп зх. РОБОТИНЕ)
ГУЛЛИВЕР
НВ

— ....я Гулливер....
— ....я Мавик. Принимаю на 5.
— Да, вас принял. Дежурим.
— Гулливер, да."#
                .to_string()
        );
        assert_eq!(res.start, 32);
        assert_eq!(res.end, 173);
    }

    #[test]
    fn extract_text_and_position_04() {
        let body = r#"Отримано з поста "rer108"
--------------------------------------
16.02, 22:44:57
432.1500
УКХ р/м йм.  65 ОДШБ (НОВОПРОКОПІВКА- ВЕРБОВЕ) 432.150 МГц ЦФП 80
ЛУНА
БОКС

— Бокс, Бокс, Луне.
— Да, связь Бокс.
— Плюс принял."#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"ЛУНА
БОКС

— Бокс, Бокс, Луне.
— Да, связь Бокс.
— Плюс принял."#
                .to_string()
        );
        assert_eq!(res.start, 156);
        assert_eq!(res.end, 219);
    }

    #[test]
    fn extract_text_and_position_05() {
        let body = r#"16:33 20.02.2025
Пост: Foxtrot 1
Частота: 409.250
Повідомлення: -
Координати: 37T CP 45806 02141
Тип сигналу: Цифра
Приналежність: 
УКХ р/м НВ підрозділу"#;
        let res = extract_text(body).unwrap();
        assert_eq!(res.body, r#"Повідомлення: -"#.to_string());
        assert_eq!(res.start, 50);
        assert_eq!(res.end, 65);
    }

    #[test]
    fn extract_text_and_position_06() {
        let body = r#"Частота: 442.585(МГц)
Локація: Новобахмутівка
Підрозділ: УКХ р/ м не визначеного підрозділу
Координати: 37U CP 97168 42114

Зміст:
1:
2:


Дата 20.02.2025
Час 16:16:48"#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"Зміст:
1:
2:"#
            .to_string()
        );
        assert_eq!(res.start, 124);
        assert_eq!(res.end, 136);
    }

    #[test]
    fn extract_text_and_position_07() {
        let body = r#"06.03, 16:41
139.450
БАРС 
БАЛУ 

- три здания пусть осматривает и пойдем на школу  , только хорошо пусть осмотрит, там был завален ТУМАР. Пусть осматривает и как будет готов - доклад и я его сориентирую"#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"БАРС 
БАЛУ 

- три здания пусть осматривает и пойдем на школу  , только хорошо пусть осмотрит, там был завален ТУМАР. Пусть осматривает и как будет готов - доклад и я его сориентирую"#
            .to_string()
        );
        assert_eq!(res.start, 21);
        assert_eq!(res.end, 203);
    }

    #[test]
    fn extract_text_and_position_08() {
        let body = r#"08.03, 10:16:20
445.4550
УКХ р/м ім. 3 мсб 430 мсп (МАЛИЙ КЕРМЕНЧИК)
ТАТАРИН
НВ

— ... я ТАТАРИН, на приеме.
— К Хладу перезжаю.
—Да, плюс, будь там.
— Плюс.


Коментар: ім. переміщення о/с РОВ

Мітки перехоплення: 🛼 - переміщення"#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"ТАТАРИН
НВ

— ... я ТАТАРИН, на приеме.
— К Хладу перезжаю.
—Да, плюс, будь там.
— Плюс."#
                .to_string()
        );
        assert_eq!(res.start, 69);
        assert_eq!(res.end, 157);
    }

    #[test]
    fn extract_text_and_position_09() {
        let body = r#"
2025-03-08, 10:20
422.500
Лозуватське - Воздвіженка, УКХ р/м невизначеного підрозділу
ЛУЧНИК
ПИРОЖЕК

— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет
.
Коментар: ( 🟠 БПЛА СОУ ✈️ ); "#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"Лозуватське - Воздвіженка, УКХ р/м невизначеного підрозділу
ЛУЧНИК
ПИРОЖЕК

— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет
."#
            .to_string()
        );
        assert_eq!(res.start, 27);
        assert_eq!(res.end, 139);
    }

    #[test]
    fn extract_text_and_position_10() {
        let body = r#"
26.07.2025, 09:57:06 
148.1981
УКХ р/м 1432 мсп 2 мсд 1 ТА (ТАБАЇВКА (ПІЩАНЕ)) 148.1981 МГц
НВ
НВ

— Я Артист, безставая постреливает, возможно одноразую в карате.
--Морган плюс.
— Берестовая, шум винтов, возможно глаза."#;
        let res = extract_text(body).unwrap();
        assert_eq!(
            res.body,
            r#"НВ
НВ

— Я Артист, безставая постреливает, возможно одноразую в карате.
--Морган плюс.
— Берестовая, шум винтов, возможно глаза."#
                .to_string()
        );
        assert_eq!(res.start, 93);
        assert_eq!(res.end, 221);
    }

    #[test]
    fn extract_text_non_rer_header_without_machine_id() {
        let body = "50 обрБпС | 2026-06-26\n11-34\nПерехоплення";
        let res = extract_text(body).unwrap().body;

        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_non_rer_header_with_machine_id() {
        let body = "50 обрБпС [33hhfg50d] | 2026-06-26_08-13-12\nПерехоплення";
        let res = extract_text(body).unwrap().body;

        assert_eq!(res, "Перехоплення");
    }

    #[test]
    fn extract_text_full_date_without_seconds_header() {
        let body = "27.06.2026 20:37\nПерехоплення";
        let res = extract_text(body).unwrap().body;

        assert_eq!(res, "Перехоплення");
    }
}
