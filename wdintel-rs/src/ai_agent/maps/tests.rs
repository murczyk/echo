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
    let bytes = export::kmz(&document, &icons).unwrap();
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
    assert!(export::kmz(&document, &icons).is_err());
}
