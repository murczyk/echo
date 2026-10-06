use super::types::*;
use crate::config::{
    AI_AGENT_MAP_KMZ_ICON_MAX_BYTES, AI_AGENT_MAP_KMZ_MAX_ICONS,
};
use crate::h;
use crate::types::ShortContext;
use base64::Engine;
use std::collections::{BTreeSet, HashMap};
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
    for (index, source) in record.file_sources.iter().enumerate() {
        metadata.push_str(&data(
            &format!("file source {}", index + 1),
            &source.href(),
        ));
    }
    format!("<Placemark id=\"record-{index}\"><name>{}</name><styleUrl>#map-{}</styleUrl><description>{}</description><ExtendedData>{metadata}</ExtendedData><Point><coordinates>{longitude},{latitude},0</coordinates></Point></Placemark>",
        xml(&record.name), record.sidc, xml(&record.comments.join("\n")))
}

fn styles(sidc: &str) -> String {
    format!("<Style id=\"normal-{sidc}\"><IconStyle><Icon><href>{sidc}.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style><Style id=\"highlight-{sidc}\"><IconStyle><Icon><href>{sidc}.png</href></Icon></IconStyle><LabelStyle><scale>1</scale></LabelStyle></Style><StyleMap id=\"map-{sidc}\"><Pair><key>normal</key><styleUrl>#normal-{sidc}</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#highlight-{sidc}</styleUrl></Pair></StyleMap>")
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Validates symbols the browser rendered for this export.
pub fn decode_icons(
    icons: &[AiAgentMapIcon],
) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    anyhow::ensure!(
        icons.len() <= AI_AGENT_MAP_KMZ_MAX_ICONS,
        "Забагато позначок для KMZ"
    );
    let mut decoded = HashMap::new();
    for icon in icons {
        anyhow::ensure!(
            icon.sidc.len() == 20
                && icon.sidc.bytes().all(|byte| byte.is_ascii_digit()),
            "SIDC має містити 20 цифр"
        );
        let png = base64::engine::general_purpose::STANDARD
            .decode(&icon.png_base64)
            .c(h!())?;
        anyhow::ensure!(
            png.len() <= AI_AGENT_MAP_KMZ_ICON_MAX_BYTES
                && png.starts_with(PNG_SIGNATURE),
            "Некоректне зображення позначки"
        );
        decoded.insert(icon.sidc.clone(), png);
    }
    Ok(decoded)
}

pub fn kmz(
    document: &AiAgentMapDocument,
    icon_directory: &Path,
    rendered_icons: &HashMap<String, Vec<u8>>,
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
        let icon = match rendered_icons.get(sidc) {
            Some(icon) => icon.clone(),
            None => std::fs::read(icon_directory.join(format!("{sidc}.png")))
                .unwrap_or_else(|_| identity_icon(sidc)),
        };
        archive.start_file(format!("{sidc}.png"), options).c(h!())?;
        archive.write_all(&icon).c(h!())?;
    }
    Ok(archive.finish().c(h!())?.into_inner())
}

const ICON_PX: usize = 16;

fn identity_digit(sidc: &str) -> u8 {
    sidc.chars()
        .nth(3)
        .and_then(|digit| digit.to_digit(10))
        .unwrap_or(0) as u8
}

fn identity_rgb(digit: u8) -> [u8; 3] {
    match digit {
        2 => [128, 224, 255],
        3 => [0, 168, 220],
        4 => [0, 166, 81],
        5 | 6 => [255, 0, 0],
        _ => [255, 255, 0],
    }
}

fn identity_icon(sidc: &str) -> Vec<u8> {
    let digit = identity_digit(sidc);
    let color = identity_rgb(digit);
    let mut pixels = vec![0_u8; ICON_PX * ICON_PX * 3];
    for y in 0..ICON_PX {
        for x in 0..ICON_PX {
            let border =
                x == 0 || y == 0 || x + 1 == ICON_PX || y + 1 == ICON_PX;
            let mark =
                y == 1 && (1..=3).contains(&x) && digit & (1 << (x - 1)) != 0;
            let rgb = if border || mark { [0, 0, 0] } else { color };
            let offset = (y * ICON_PX + x) * 3;
            pixels[offset..offset + 3].copy_from_slice(&rgb);
        }
    }
    png_rgb(&pixels)
}

fn png_rgb(pixels: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(ICON_PX * (ICON_PX * 3 + 1));
    for row in pixels.chunks(ICON_PX * 3) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(ICON_PX as u32).to_be_bytes());
    ihdr.extend_from_slice(&(ICON_PX as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    png.extend(png_chunk(b"IHDR", &ihdr));
    png.extend(png_chunk(b"IDAT", &zlib_store(&raw)));
    png.extend(png_chunk(b"IEND", &[]));
    png
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(12 + data.len());
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    let crc = png_crc32(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    chunk
}

fn png_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut rest = data;
    while !rest.is_empty() || out.len() == 2 {
        let take = rest.len().min(65535);
        let last = take == rest.len();
        out.push(u8::from(last));
        let len = take as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&rest[..take]);
        rest = &rest[take..];
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1_u32;
    let mut b = 0_u32;
    for byte in data {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}
