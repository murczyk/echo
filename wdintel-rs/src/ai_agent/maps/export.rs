use super::types::*;
use crate::config::AI_AGENT_MAP_FALLBACK_SIDC;
use crate::h;
use crate::types::ShortContext;
use std::collections::BTreeSet;
use std::io::{Cursor, Write};
use std::path::Path;

pub fn csv(document: &AiAgentMapDocument) -> anyhow::Result<Vec<u8>> {
    let comment_count = document
        .records
        .iter()
        .map(|record| record.comments.len())
        .max()
        .unwrap_or(0);
    let mut writer = csv::WriterBuilder::new()
        .quote_style(csv::QuoteStyle::Always)
        .from_writer(Vec::new());
    let mut header = vec![
        "sidc".to_string(),
        "name".to_string(),
        "observation_datetime".to_string(),
        "platform_type".to_string(),
        "x".to_string(),
        "y".to_string(),
    ];
    header.extend((1..=comment_count).map(|index| format!("comment {index}")));
    writer.write_record(header).c(h!())?;
    for record in &document.records {
        let mut cells = vec![
            record.sidc.clone(),
            record.name.clone(),
            record.observation_datetime.clone().unwrap_or_default(),
            record.platform_type.clone(),
            record.x.clone(),
            record.y.clone(),
        ];
        cells.extend(record.comments.iter().cloned());
        cells.resize(6 + comment_count, String::new());
        writer.write_record(cells).c(h!())?;
    }
    writer
        .into_inner()
        .map_err(|error| error.into_error())
        .c(h!())
}

fn xml(value: &str) -> String {
    value
        .chars()
        .filter(|ch| {
            matches!(ch, '\t' | '\n' | '\r')
                || matches!(ch, '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn data(name: &str, value: &str) -> String {
    format!(
        "<Data name=\"{}\"><value>{}</value></Data>",
        xml(name),
        xml(value)
    )
}

fn placemark(
    index: usize,
    record: &AiAgentMapRecord,
    latitude: f64,
    longitude: f64,
) -> String {
    let mut metadata = data("sidc", &record.sidc);
    metadata.push_str(&data("app6d", &record.sidc));
    metadata.push_str(&data("app6d sidc", &record.sidc));
    metadata.push_str(&data(
        "observation_datetime",
        record.observation_datetime.as_deref().unwrap_or_default(),
    ));
    metadata.push_str(&data("platform_type", &record.platform_type));
    metadata.push_str(&data("coordinate_system", &record.coordinate_system));
    metadata.push_str(&data("original_x", &record.original_x));
    metadata.push_str(&data("original_y", &record.original_y));
    metadata.push_str(&data("x", &record.x));
    metadata.push_str(&data("y", &record.y));
    for (index, comment) in record.comments.iter().enumerate() {
        metadata.push_str(&data(&format!("comment {}", index + 1), comment));
    }
    for (index, source) in record.sources.iter().enumerate() {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("m", &source.message_identifier)
            .finish();
        metadata.push_str(&data(
            &format!("source {}", index + 1),
            &format!("/rer-analysis-neo?{query}"),
        ));
    }
    format!("<Placemark id=\"record-{index}\"><name>{}</name><styleUrl>#map-{}</styleUrl><description>{}</description><ExtendedData>{metadata}</ExtendedData><Point><coordinates>{longitude},{latitude},0</coordinates></Point></Placemark>",
        xml(&record.name), record.sidc, xml(&record.comments.join("\n")))
}

fn styles(sidc: &str) -> String {
    format!("<Style id=\"normal-{sidc}\"><IconStyle><Icon><href>{sidc}.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style><Style id=\"highlight-{sidc}\"><IconStyle><Icon><href>{sidc}.png</href></Icon></IconStyle><LabelStyle><scale>1</scale></LabelStyle></Style><StyleMap id=\"map-{sidc}\"><Pair><key>normal</key><styleUrl>#normal-{sidc}</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#highlight-{sidc}</styleUrl></Pair></StyleMap>")
}

pub fn kmz(
    document: &AiAgentMapDocument,
    icon_directory: &Path,
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        document.valid_count > 0,
        "Мапа не містить коректних точок; доступний CSV"
    );
    let mut kml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document><name>{}</name>", xml(&document.title));
    let sidcs: BTreeSet<_> = document
        .records
        .iter()
        .filter(|record| {
            record.latitude.is_some() && record.longitude.is_some()
        })
        .map(|record| record.sidc.as_str())
        .collect();
    for sidc in &sidcs {
        kml.push_str(&styles(sidc));
    }
    for (index, record) in document.records.iter().enumerate() {
        if let (Some(latitude), Some(longitude)) =
            (record.latitude, record.longitude)
        {
            kml.push_str(&placemark(index + 1, record, latitude, longitude));
        }
    }
    kml.push_str("</Document></kml>");
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    archive.start_file("doc.kml", options).c(h!())?;
    archive.write_all(kml.as_bytes()).c(h!())?;
    for sidc in sidcs {
        let icon = std::fs::read(icon_directory.join(format!("{sidc}.png")))
            .or_else(|_| {
                std::fs::read(
                    icon_directory
                        .join(format!("{AI_AGENT_MAP_FALLBACK_SIDC}.png")),
                )
            })
            .c(h!())?;
        archive.start_file(format!("{sidc}.png"), options).c(h!())?;
        archive.write_all(&icon).c(h!())?;
    }
    Ok(archive.finish().c(h!())?.into_inner())
}
