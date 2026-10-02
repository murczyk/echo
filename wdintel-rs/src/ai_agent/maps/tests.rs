use super::*;
use std::io::{Cursor, Read};
use std::path::Path;

fn input(x: &str, y: &str) -> AiAgentMapRecordInput {
    AiAgentMapRecordInput {
        sidc: "10062000001209020000".to_string(),
        name: "Подія <A> & B".to_string(),
        observation_datetime: Some("2026-09-28".to_string()),
        coordinate_system: "msk2000".to_string(),
        x: x.to_string(),
        y: y.to_string(),
        comments: vec!["Вантаж \"А\" & <B>\n новий рядок".to_string()],
        sources: Vec::new(),
    }
}

fn document(records: Vec<AiAgentMapRecord>) -> AiAgentMapDocument {
    prepare::canonicalize(AiAgentMapDocument {
        id: Uuid::new_v4().to_string(),
        title: "Мапа & <події>".to_string(),
        is_main: true,
        records,
        warnings: Vec::new(),
        total_count: 0,
        valid_count: 0,
        invalid_count: 0,
    })
    .unwrap()
}

#[test]
fn issue_3064_missing_sidc_uses_the_fallback_symbol() {
    let mut missing = input("5215227", "6548669");
    missing.sidc.clear();
    let record = prepare::prepare_record(missing).unwrap();
    assert_eq!(record.sidc, crate::config::AI_AGENT_MAP_FALLBACK_SIDC);
    assert!(record
        .warnings
        .iter()
        .any(|warning| warning.contains("SIDC")));
    let document = document(vec![record]);
    assert_eq!(
        document.records[0].sidc,
        crate::config::AI_AGENT_MAP_FALLBACK_SIDC
    );
    assert!(document.records[0]
        .warnings
        .iter()
        .any(|warning| warning.contains("SIDC")));
    assert!(document
        .warnings
        .iter()
        .any(|warning| warning.contains("SIDC")));
    assert_eq!(prepare::canonicalize(document.clone()).unwrap(), document);
    let supplied =
        prepare::prepare_record(input("5215227", "6548669")).unwrap();
    assert_eq!(supplied.sidc, "10062000001209020000");
    assert!(supplied.warnings.is_empty());
    let mut invalid = input("5215227", "6548669");
    invalid.sidc = "123".to_string();
    assert!(prepare::prepare_record(invalid).is_err());
}

#[test]
fn issue_3064_keeps_original_coordinates_dates_and_invalid_components() {
    let record =
        prepare::prepare_record(input("52-15227", "65 48669")).unwrap();
    assert_eq!(record.original_x, "52-15227");
    assert_eq!(
        (record.x.as_str(), record.y.as_str()),
        ("5215227", "6548669")
    );
    assert_eq!(
        record.observation_datetime.as_deref(),
        Some("2026-09-28T00:00:00")
    );
    assert!((record.latitude.unwrap() - 47.06899436450063).abs() < 1e-9);
    assert!((record.longitude.unwrap() - 33.63917508028498).abs() < 1e-9);
    assert_eq!(record.comments, ["Вантаж А & <B> новий рядок"]);
    for x in ["521522", "52152270", "-5215227", "521x227"] {
        let mut record = input(x, "6548669");
        record.observation_datetime = Some("10:30".to_string());
        let record = prepare::prepare_record(record).unwrap();
        assert_eq!(record.x, "INVALID");
        assert_eq!(record.original_x, x);
        assert!(record.latitude.is_none() && record.longitude.is_none());
        assert!(record.observation_datetime.is_none());
        assert_eq!(record.warnings.len(), 2);
    }
    let unsupported =
        prepare::prepare_record(input("5215227", "1548669")).unwrap();
    assert!(unsupported.latitude.is_none());
    assert!(!unsupported.warnings.is_empty());
    let anomalous =
        prepare::prepare_record(input("1215227", "6548669")).unwrap();
    assert!(anomalous.latitude.is_some());
    assert!(!anomalous.warnings.is_empty());
}

#[test]
fn issue_3064_csv_preserves_coincident_and_invalid_rows_with_padded_comments() {
    let first = prepare::prepare_record(input("5215227", "6548669")).unwrap();
    let mut second = first.clone();
    second.name = "Друга подія".to_string();
    second.observation_datetime = Some("2026-09-28T11:01:00".to_string());
    second.comments.clear();
    let invalid = prepare::prepare_record(input("5215227", "654866")).unwrap();
    let document = document(vec![first, second, invalid]);
    assert_eq!(
        (
            document.total_count,
            document.valid_count,
            document.invalid_count
        ),
        (3, 2, 1)
    );
    let bytes = export::csv(&document).unwrap();
    assert!(String::from_utf8(bytes.clone()).unwrap().starts_with("\"sidc\",\"name\",\"observation_datetime\",\"platform_type\",\"x\",\"y\",\"comment 1\""));
    let mut reader = csv::Reader::from_reader(bytes.as_slice());
    let rows = reader.records().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(&rows[1][1], "Друга подія");
    assert_eq!(&rows[1][6], "");
    assert_eq!(&rows[2][5], "INVALID");
    assert_eq!(&rows[0][6], "Вантаж А & <B> новий рядок");
}

#[test]
fn issue_3064_preserves_tickets_with_more_than_sixteen_fields() {
    let mut record = input("5215227", "6548669");
    record.comments = (1..=32)
        .map(|index| format!("Поле {index}: значення {index}"))
        .collect();
    let prepared = prepare::prepare_record(record.clone()).unwrap();
    assert_eq!(prepared.comments, record.comments);
    let document = document(vec![prepared]);
    let bytes = export::csv(&document).unwrap();
    let mut reader = csv::Reader::from_reader(bytes.as_slice());
    assert_eq!(reader.headers().unwrap().len(), 38);
    assert_eq!(
        &reader.records().next().unwrap().unwrap()[37],
        "Поле 32: значення 32"
    );
    record.comments.push("Понад ліміт".to_string());
    assert!(prepare::prepare_record(record).is_err());
}

#[test]
fn issue_3064_kmz_escapes_metadata_and_omits_invalid_geometry() {
    let mut record = input("5215227", "6548669");
    record.name.push_str("\u{0}\u{fffe}\u{ffff}");
    let record = prepare::prepare_record(record).unwrap();
    let invalid = prepare::prepare_record(input("521522", "6548669")).unwrap();
    let document = document(vec![record.clone(), record, invalid.clone()]);
    let icons = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../wdintel-web/static/img/google_earth_icons");
    let bytes = export::kmz(&document, &icons, &Default::default()).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert!(archive.by_name("10062000001209020000.png").is_ok());
    let mut kml = String::new();
    archive
        .by_name("doc.kml")
        .unwrap()
        .read_to_string(&mut kml)
        .unwrap();
    assert_eq!(kml.matches("<Placemark ").count(), 2);
    assert!(kml.contains("Подія &lt;A&gt; &amp; B"));
    assert!(!kml.contains(['\u{0}', '\u{fffe}', '\u{ffff}']));
    assert!(
        kml.contains("<Data name=\"sidc\"><value>10062000001209020000</value>")
    );
    assert!(kml
        .contains("<Data name=\"app6d\"><value>10062000001209020000</value>"));
    assert!(kml.contains("<Data name=\"platform_type\"><value>CAPDOC</value>"));
    assert!(kml.contains("<coordinates>33.63917508028498,47.068994364500"));
    let document = self::document(vec![invalid]);
    assert!(export::csv(&document).is_ok());
    assert!(export::kmz(&document, &icons, &Default::default()).is_err());
}

#[test]
fn missing_kmz_icon_is_an_identity_png() {
    let base = prepare::prepare_record(input("5215227", "6548669")).unwrap();
    let mut records = Vec::new();
    for sidc in [
        "10031000001211020000",
        "10051000001211020000",
        "10061000001211020000",
    ] {
        let mut record = base.clone();
        record.sidc = sidc.to_string();
        records.push(record);
    }
    let document = AiAgentMapDocument {
        id: "11111111-1111-4111-8111-111111111111".to_string(),
        title: "Іконки".to_string(),
        is_main: true,
        records,
        warnings: Vec::new(),
        total_count: 3,
        valid_count: 3,
        invalid_count: 0,
    };
    let bytes = export::kmz(
        &document,
        Path::new("/no/such/echo-icons"),
        &Default::default(),
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let friend = png_entry(&mut archive, "10031000001211020000.png");
    let suspect = png_entry(&mut archive, "10051000001211020000.png");
    let hostile = png_entry(&mut archive, "10061000001211020000.png");
    for icon in [&friend, &suspect, &hostile] {
        assert_eq!(&icon[..8], b"\x89PNG\r\n\x1a\n");
    }
    assert!(friend.windows(3).any(|pixel| pixel == [0, 168, 220]));
    assert!(hostile.windows(3).any(|pixel| pixel == [255, 0, 0]));
    assert_ne!(friend, hostile);
    assert_ne!(suspect, hostile);
}

// Regression: https://github.com/echoua/echo/issues/3064
#[test]
fn browser_rendered_icons_take_precedence_and_invalid_images_are_rejected() {
    use base64::Engine;
    let png = b"\x89PNG\r\n\x1a\nrendered".to_vec();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    let icon = |sidc: &str, png_base64: &str| AiAgentMapIcon {
        sidc: sidc.to_string(),
        png_base64: png_base64.to_string(),
    };
    let icons = export::decode_icons(&[icon("10031000001211020000", &encoded)])
        .unwrap();
    assert!(export::decode_icons(&[icon("1003", &encoded)]).is_err());
    assert!(export::decode_icons(&[icon(
        "10031000001211020000",
        &base64::engine::general_purpose::STANDARD.encode(b"<svg/>")
    )])
    .is_err());
    let mut record = prepare::prepare_record(AiAgentMapRecordInput {
        sidc: "10031000001211020000".to_string(),
        name: "Точка".to_string(),
        observation_datetime: None,
        coordinate_system: "msk2000".to_string(),
        x: "5215227".to_string(),
        y: "6548669".to_string(),
        comments: Vec::new(),
        sources: Vec::new(),
    })
    .unwrap();
    record.id = "33333333-3333-4333-8333-333333333333".to_string();
    let document = AiAgentMapDocument {
        id: "11111111-1111-4111-8111-111111111111".to_string(),
        title: "Іконки".to_string(),
        is_main: true,
        records: vec![record],
        warnings: Vec::new(),
        total_count: 1,
        valid_count: 1,
        invalid_count: 0,
    };
    let bytes =
        export::kmz(&document, Path::new("/no/such/dir"), &icons).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert_eq!(png_entry(&mut archive, "10031000001211020000.png"), png);
}

fn png_entry(
    archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>,
    name: &str,
) -> Vec<u8> {
    let mut file = archive.by_name(name).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}
