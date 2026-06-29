use lazy_static::lazy_static;
use milgeo_rs::coordinates::Coords;
use regex::Regex;

pub async fn extract_coords(body: &str) -> Vec<Coords> {
    let body = prepare_body_for_coords(body);
    milgeo_rs::coordinates::rer_extract_coords(&body).await
}

fn prepare_body_for_coords(body: &str) -> String {
    let mut result = String::with_capacity(body.len());
    for line in body.lines() {
        if !is_non_coordinate_header_line(line) {
            result.push_str(line);
        }
        result.push('\n');
    }
    result
}

fn is_non_coordinate_header_line(line: &str) -> bool {
    if line_mentions_coordinates(line) {
        return false;
    }

    is_dmr_metadata_line(line)
        || is_callsign_map_line(line)
        || is_received_from_post_line(line)
}

fn line_mentions_coordinates(line: &str) -> bool {
    let line = line.to_lowercase();
    line.contains("координат")
        || line.contains("coordinate")
        || line.contains("coords")
        || line.contains("mgrs")
        || line.contains("wgs")
}

fn is_dmr_metadata_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"(?i)^\s*(?:[cс]{2}\s*:?\s*|код\s+кольору\s*:?\s*)"#)
                .unwrap();
        static ref RE_ID: Regex = Regex::new(
            r#"(?i)^\s*(?:[iі]d\s*➡️?|source\s+id|[iі]d\s+відправника|[iі]d)\s*:?\s+"#
        )
        .unwrap();
        static ref RE_CG: Regex = Regex::new(
            r#"(?i)^\s*(?:[iі]d\s*\(\s*[cс]g\s*\)\s*⬅️?|[iі]d\s*⬅️?(?:\s*\(\s*[cс]g\s*\))?|[iі]d\s+отримувача|group\s+id|код\s+групи|[cс]g)\s*:?\s+"#
        )
        .unwrap();
    }

    RE_CC.is_match(line) || RE_ID.is_match(line) || RE_CG.is_match(line)
}

fn is_callsign_map_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r#"(?i)^\s*(?:позивні|позывные|callsigns?)\s*:"#)
                .unwrap();
    }
    RE.is_match(line)
}

fn is_received_from_post_line(line: &str) -> bool {
    lazy_static! {
        static ref RE: Regex =
            Regex::new(r#"(?i)^\s*отримано\s+з\s+поста\s+"#).unwrap();
    }
    RE.is_match(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn extract_coords_ignores_sc_transcript_dmr_header_ids() {
        let body = r#"27.06.2026 19:15:21
Отримано з поста "SC1"
*152.365*
СС 13
ID➡️ 1098326, 5366440, 6350404, 287992, 3481020, 5291195, 7275810, 7121109, 3707804, 5267267, 775024
ID⬅️(CG) 1871040, 3106946, 2122380, 1139383, 443796, 3102387, 2626603, 4704746, 5243519, 1095394, 7494299
(УКХ р/м 352 мсп 47 тд 1 ТА (ПЕТРОПАВЛІВКА)🔑СС:13)

`152.365 | 1098326`
`19:15:21` — А да, плюс, плюс, я еще недели 3 назад докладывал.
"#;

        assert!(!milgeo_rs::coordinates::rer_extract_coords(body)
            .await
            .is_empty());
        assert!(extract_coords(body).await.is_empty());
    }

    #[tokio::test]
    async fn extract_coords_keeps_explicit_mgrs_coordinates() {
        let body = r#"Пост: КВАНТ
19:11:49   27.06.2026
143.545 - УКХ р/м НВ підрозділу
СС: 4
ID➡️: НВ
ID(CG)⬅️: НВ
Напрямок: Сх. Дворічна
Координати (MGRS): 37U DR 05997 22279
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UDR0599722279");
    }

    #[tokio::test]
    async fn extract_coords_keeps_standalone_mgrs_after_dmr_headers() {
        let body = r#"27.06.2026 21:28:40 F=139.5660(МГц)
УКХ р/м 122 мсп 68 мсд 6 А 🔑 (ГОЛУБІВКА-КАЛИНОВЕ) СС: 1️⃣5️⃣ 📟📣 139.566
СС:15
ID➡️: 66044
ID(CG)⬅️: 34655

37U DR 01354 12034
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "37UDR0135412034");
    }

    #[tokio::test]
    async fn extract_coords_keeps_antenna_mgrs_coordinates() {
        let body = r#"Тип: Антена
Назва: 141.715 МГц
24.06.2026 17:32
Ворожий
Координати: 36U XB 66512 50880
Пост: 4431
"#;

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].mgrs, "36UXB6651250880");
    }

    #[tokio::test]
    async fn extract_coords_keeps_plain_decimal_coordinates() {
        let body = "145.5524\n47.392477\n36.056984\n10-11";

        let coords = extract_coords(body).await;
        assert_eq!(coords.len(), 1);
        assert_eq!(coords[0].text, "47.392477, 36.056984");
    }

    #[tokio::test]
    async fn extract_coords_keeps_echo_zp2_xy_footer_after_header_stripping() {
        let body = r#"27.06.2026, 07:25:53
403.4250
УКХ р/м НВ підрозділу, р-н н.п. Пшеничне, 403.425 (МГц) ЦФП62
1-НВ
2-ГРАЧ

1— Грач притормози, на западе стреляют
2— Да, принял.
1— Грач, давай.
2— Грач да.


x:52-49185
y:67-14255"#;

        let body_noheader =
            crate::rer_importer::body_noheader::extract_text(body)
                .unwrap()
                .body;
        assert!(body_noheader.contains("x:52-49185"));
        assert!(body_noheader.contains("y:67-14255"));

        let coords = extract_coords(&body_noheader).await;
        assert_eq!(coords.len(), 1);
        assert!(coords[0].capture.contains("x:52-49185"));
        assert!(coords[0].capture.contains("y:67-14255"));
    }
}
