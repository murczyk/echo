use crate::error::AppError;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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
        r#"^(Район|Частота|Час|Дата|Локація|Підрозділ|Хто|Кому|Абоненти|Позивні|Коментар|Пост|Координати|Тип сигналу|Приналежність|Мітки перехоплення):"#
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
        r#"^[0-9]{2}:[0-9]{2} [0-9]{2}\.[0-9]{2}\.[0-9]{4}$"#
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
        r#"^[0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{2}\.[0-9]{2}\.[0-9]{4}$"#
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
    static ref RE3: Regex = Regex::new(r#"^(\[DMR\] УКХ|УКХ|управління)\s"#).unwrap();
    // Remove freq line from Mouse
    static ref RE4: Regex = Regex::new(r#"^(?:\*[0-9]{3}(\.|,)[0-9]{3,5}\*|[0-9]{3}(\.|,)[0-9]{3,5})\s*(ЦФП [0-9]{2,3})?\s*$"#).unwrap();
    // Remove coordinates line from Mouse
    static ref RE5: Regex = Regex::new(r#"^[0-9]{2}\.[0-9]{5,7}\s*,\s*[0-9]{2}\.[0-9]{5,7}$"#).unwrap();
    // Remove line with ---------------------
    static ref RE6: Regex = Regex::new(r#"^-+$"#).unwrap();
    // Buran-style date/time label line: `Дата: ...` / `Час: ...`
    static ref RE_DT_LABEL: Regex = Regex::new(r#"^(Дата|Час)\s*[: ]"#).unwrap();
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
    // 1. Keep empty lines to avoid breaking `inp.find(&res)`
    let mut lines: Vec<String> = input
        .lines()
        .enumerate()
        .filter(|(idx, _)| !excluded_lines.contains(idx))
        .map(|(_, x)| {
            trim_otrymano_post_header(x).unwrap_or_else(|| x.to_string())
        })
        .collect();
    let exact_format_input = lines.join("\n");
    if let Some(exact_format_text) = extract_exact_format_text(
        exact_format_input.trim_matches(['\r', '\n']),
        input,
    ) {
        return Ok(exact_format_text);
    }

    lines.retain(|line| !is_non_metadata_header_line(line));

    let mut start_line = 0;
    while start_line < lines.len()
        && is_boundary_header_or_empty(&lines[start_line])
    {
        start_line += 1;
    }
    let mut end_line = lines.len();
    while end_line > start_line
        && is_boundary_header_or_empty(&lines[end_line - 1])
    {
        end_line -= 1;
    }

    let mut res = lines[start_line..end_line].join("\n");

    // 2. Find start position in character indices
    let start_byte_pos = input.find(&res).unwrap_or(0);

    // 3. Trim leading empty lines *after* finding `start`
    while res.starts_with('\n') {
        res = res.trim_start_matches('\n').to_string();
    }

    // 4. Trim empty lines from the end
    while res.ends_with('\n') {
        res = res.trim_end_matches('\n').to_string();
    }

    // 5. Adjust `start` after trimming
    let new_start_byte_pos = input.find(&res).unwrap_or(start_byte_pos);
    let new_start = input[..new_start_byte_pos].chars().count(); // Convert bytes to chars

    let end = new_start + res.chars().count();

    Ok(NoHeadersBody {
        body: res,
        start: new_start,
        end,
    })
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
    fn extract_text_decorated_header_lines_are_headers() {
        let body = "🔺(01.07.2026 02:58:08)\n🔺(01.07.2026 02:58:08 F=170.0250(МГц))\n│╬{*123.7586*}\n[УКХ р/м]\nПерехоплення";
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
