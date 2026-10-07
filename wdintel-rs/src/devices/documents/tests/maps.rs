#[tokio::test]
async fn device_document_kml_keeps_named_points_and_line_coordinates_3064() {
    let source=br#"<kml><Document><Placemark><name>Position 9</name><Point><coordinates>35.335,47.55,0</coordinates></Point></Placemark><Placemark><LineString><coordinates>35.335,47.55,0 35.336,47.551,0</coordinates></LineString></Placemark></Document></kml>"#;
    let package = super::super::map_extraction::parse("map.kml", source)
        .await
        .unwrap();
    assert!(package.complete);
    assert_eq!(package.sections.len(), 3);
    assert!(package.sections[0].text.contains("Position 9"));
    for section in package.sections {
        let coordinates = crate::attachments::enrich::coordinates(
            &section.text,
            &section.locator,
        )
        .await
        .unwrap();
        assert!(!coordinates.as_array().unwrap().is_empty());
    }
    use std::io::{Cursor, Write};
    for name in ["doc.kml", "../escape.kml"] {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(source).unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let result =
            super::super::map_extraction::parse("map.kmz", &bytes).await;
        assert_eq!(result.is_ok(), name == "doc.kml");
        if name == "doc.kml" {
            let mut oversized = bytes;
            let header = oversized
                .windows(4)
                .position(|bytes| bytes == b"PK\x01\x02")
                .unwrap();
            oversized[header + 24..header + 28].copy_from_slice(
                &((crate::config::ATTACHMENT_MAX_RESULT_BYTES + 1) as u32)
                    .to_le_bytes(),
            );
            assert!(super::super::map_extraction::parse("map.kmz", &oversized)
                .await
                .is_err());
        }
    }
}
