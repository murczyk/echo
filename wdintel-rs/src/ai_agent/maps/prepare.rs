use super::types::*;
use crate::config::*;
use crate::h;
use crate::types::ShortContext;

const MISSING_SIDC_WARNING: &str =
    "SIDC не надано; використано стандартну позначку";

fn bounded(value: &str) -> bool {
    value.chars().count() <= AI_AGENT_MAP_TEXT_MAX_CHARS
}

fn validate_record(input: &AiAgentMapRecordInput) -> anyhow::Result<()> {
    anyhow::ensure!(
        !input.name.trim().is_empty()
            && [&input.name, &input.coordinate_system, &input.x, &input.y]
                .into_iter()
                .all(|value| bounded(value))
            && input.observation_datetime.as_deref().is_none_or(bounded)
            && input.comments.len() <= AI_AGENT_MAP_MAX_COMMENTS
            && input.comments.iter().all(|value| bounded(value))
            && input.sources.len() <= AI_AGENT_MAP_MAX_SOURCES,
        "Map record exceeds field limits"
    );
    anyhow::ensure!(
        input.sources.iter().all(|source| {
            source.message_id > 0
                && source.message_id <= 9_007_199_254_740_991
                && !source.message_identifier.trim().is_empty()
                && source.message_identifier.len() <= 512
        }),
        "Invalid map source"
    );
    Ok(())
}

pub fn prepare_record(
    input: AiAgentMapRecordInput,
) -> anyhow::Result<AiAgentMapRecord> {
    validate_record(&input).c(h!())?;
    let mut warnings = Vec::new();
    let sidc = if input.sidc.trim().is_empty() {
        warnings.push(MISSING_SIDC_WARNING.to_string());
        AI_AGENT_MAP_FALLBACK_SIDC.to_string()
    } else {
        anyhow::ensure!(
            input.sidc.len() == 20
                && input.sidc.bytes().all(|byte| byte.is_ascii_digit()),
            "SIDC must contain 20 digits"
        );
        input.sidc.clone()
    };
    let observation_datetime = normalize_datetime(
        input.observation_datetime.as_deref(),
        &mut warnings,
    );
    let x = normalize_component(&input.x);
    let y = normalize_component(&input.y);
    let position =
        prepare_position(&x, &y, &input.coordinate_system, &mut warnings);
    Ok(AiAgentMapRecord {
        sidc,
        name: input.name.trim().to_string(),
        observation_datetime,
        platform_type: AI_AGENT_MAP_PLATFORM_TYPE.to_string(),
        coordinate_system: input.coordinate_system,
        original_x: input.x,
        original_y: input.y,
        x,
        y,
        latitude: position.map(|point| point.0),
        longitude: position.map(|point| point.1),
        comments: input
            .comments
            .into_iter()
            .map(|comment| {
                comment
                    .replace(['"', '“', '”', '«', '»'], "")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect(),
        sources: input.sources,
        warnings,
    })
}

fn prepare_position(
    x: &str,
    y: &str,
    system: &str,
    warnings: &mut Vec<String>,
) -> Option<(f64, f64)> {
    if x == "INVALID" {
        warnings.push(
            "Некоректна координата X; початкове значення збережено".to_string(),
        );
    }
    if y == "INVALID" {
        warnings.push(
            "Некоректна координата Y; початкове значення збережено".to_string(),
        );
    }
    let system = system.trim().to_lowercase();
    let supported = matches!(
        system.as_str(),
        "sk42" | "ск-42" | "msk2000" | "msk-2000" | "мск-2000"
    );
    if !supported {
        warnings.push("Непідтримувана система координат".to_string());
        None
    } else if x == "INVALID" || y == "INVALID" {
        None
    } else {
        match project(x, y) {
            Ok((latitude, longitude)) => {
                if !(AI_AGENT_MAP_UKRAINE_LAT_BOUNDS.0
                    ..=AI_AGENT_MAP_UKRAINE_LAT_BOUNDS.1)
                    .contains(&latitude)
                    || !(AI_AGENT_MAP_UKRAINE_LON_BOUNDS.0
                        ..=AI_AGENT_MAP_UKRAINE_LON_BOUNDS.1)
                        .contains(&longitude)
                {
                    warnings.push("Координати поза очікуваною територією України; перевірте початкові X/Y".to_string());
                }
                Some((latitude, longitude))
            }
            Err(_) => {
                warnings.push(
                    "Не вдалося перетворити координати СК-42 у WGS-84"
                        .to_string(),
                );
                None
            }
        }
    }
}

fn normalize_component(value: &str) -> String {
    if value.trim().starts_with(['-', '–', '—']) {
        return "INVALID".to_string();
    }
    if !value.chars().all(|ch| {
        ch.is_ascii_digit()
            || ch.is_whitespace()
            || matches!(ch, '-' | '–' | '—' | '.' | ',' | '\'' | '_')
    }) {
        return "INVALID".to_string();
    }
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if digits.len() == 7 {
        digits
    } else {
        "INVALID".to_string()
    }
}

fn normalize_datetime(
    value: Option<&str>,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(format!("{date}T00:00:00"));
    }
    if let Ok(datetime) =
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
    {
        return Some(datetime.format("%Y-%m-%dT%H:%M:%S").to_string());
    }
    if let Ok(datetime) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(
            datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        );
    }
    warnings.push(
        "Некоректна дата спостереження або час без дати; дату не вигадано"
            .to_string(),
    );
    None
}

#[cfg(feature = "proj")]
fn project(x: &str, y: &str) -> anyhow::Result<(f64, f64)> {
    let northing: f64 = x.parse().c(h!())?;
    let easting: f64 = y.parse().c(h!())?;
    let zone = (easting / 1_000_000.0).trunc() as i32;
    anyhow::ensure!((2..=8).contains(&zone), "Unsupported СК-42 zone");
    let source = format!(
        "+proj=tmerc +lat_0=0 +lon_0={} +k=1 +x_0={} +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs +type=crs",
        zone * 6 - 3, zone * 1_000_000 + 500_000
    );
    let projection =
        proj::Proj::new_known_crs(&source, "EPSG:4326", None).c(h!())?;
    let (longitude, latitude) =
        projection.convert((easting, northing)).c(h!())?;
    anyhow::ensure!(
        latitude.is_finite()
            && longitude.is_finite()
            && (-90.0..=90.0).contains(&latitude)
            && (-180.0..=180.0).contains(&longitude),
        "Invalid projection result"
    );
    Ok((latitude, longitude))
}

#[cfg(not(feature = "proj"))]
fn project(_x: &str, _y: &str) -> anyhow::Result<(f64, f64)> {
    anyhow::bail!("Coordinate projection is unavailable")
}

fn sidc_input(record: &AiAgentMapRecord) -> String {
    if record.sidc.trim().is_empty()
        || record
            .warnings
            .iter()
            .any(|warning| warning == MISSING_SIDC_WARNING)
    {
        String::new()
    } else {
        record.sidc.clone()
    }
}

pub fn canonicalize(
    mut document: AiAgentMapDocument,
) -> anyhow::Result<AiAgentMapDocument> {
    uuid::Uuid::parse_str(&document.id).c(h!())?;
    anyhow::ensure!(
        !document.title.trim().is_empty()
            && bounded(&document.title)
            && !document.records.is_empty()
            && document.records.len() <= AI_AGENT_MAP_MAX_RECORDS,
        "Invalid map document"
    );
    document.records = document
        .records
        .into_iter()
        .map(|record| {
            prepare_record(AiAgentMapRecordInput {
                sidc: sidc_input(&record),
                name: record.name,
                observation_datetime: record.observation_datetime,
                coordinate_system: record.coordinate_system,
                x: record.original_x,
                y: record.original_y,
                comments: record.comments,
                sources: record.sources,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    document.total_count = document.records.len();
    document.valid_count = document
        .records
        .iter()
        .filter(|record| {
            record.latitude.is_some() && record.longitude.is_some()
        })
        .count();
    document.invalid_count = document.total_count - document.valid_count;
    document.warnings = document
        .records
        .iter()
        .enumerate()
        .flat_map(|(index, record)| {
            record
                .warnings
                .iter()
                .map(move |warning| format!("Рядок {}: {warning}", index + 1))
        })
        .collect();
    Ok(document)
}
