use super::types::*;
use crate::config::*;
use crate::h;
use crate::types::ShortContext;
use geoconvert::Mgrs;
use std::sync::LazyLock;

pub(super) const MISSING_SIDC_WARNING: &str =
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
            && input.sources.len() <= AI_AGENT_MAP_MAX_SOURCES
            && input.file_sources.len() <= AI_AGENT_MAP_MAX_SOURCES,
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
    anyhow::ensure!(
        super::super::file_citations::parse(
            &serde_json::json!({"citations":input.file_sources})
        )
        .is_some(),
        "Invalid file source"
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
    let position = resolve_position(
        &input.coordinate_system,
        &input.x,
        &input.y,
        &mut warnings,
    );
    Ok(AiAgentMapRecord {
        id: uuid::Uuid::now_v7().to_string(),
        sidc,
        name: input.name.trim().to_string(),
        observation_datetime,
        platform_type: AI_AGENT_MAP_PLATFORM_TYPE.to_string(),
        coordinate_system: position.system,
        original_x: input.x,
        original_y: input.y,
        x: position.x,
        y: position.y,
        latitude: position.geometry.map(|point| point.0),
        longitude: position.geometry.map(|point| point.1),
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
        file_sources: input.file_sources,
        warnings,
    })
}

/// Where a record's coordinates landed: the system the values were recognized
/// as, the SK-42 grid that CSV exports, and the WGS-84 geometry.
struct ResolvedPosition {
    system: String,
    x: String,
    y: String,
    geometry: Option<(f64, f64)>,
}

enum MgrsReading {
    NotMgrs,
    Malformed,
    Valid(f64, f64),
}

/// The format comes from the values themselves. `label` only settles a decimal
/// pair whose digits also read as a grid position inside Ukraine.
fn resolve_position(
    label: &str,
    x: &str,
    y: &str,
    warnings: &mut Vec<String>,
) -> ResolvedPosition {
    match mgrs_reading(x, y) {
        MgrsReading::Valid(latitude, longitude) => {
            return geodetic_position(
                AI_AGENT_MAP_SYSTEM_MGRS,
                (latitude, longitude),
                warnings,
            )
        }
        MgrsReading::Malformed => return malformed_mgrs(warnings),
        MgrsReading::NotMgrs => {}
    }
    match decimal_degrees(x, y) {
        Some(point)
            if is_wgs84_label(label) || !grid_reading_in_ukraine(x, y) =>
        {
            geodetic_position(AI_AGENT_MAP_SYSTEM_WGS84, point, warnings)
        }
        _ => grid_position(label, x, y, warnings),
    }
}

fn normalize_mgrs(x: &str, y: &str) -> String {
    format!("{x}{y}")
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_uppercase)
        .map(latin_look_alike)
        .collect()
}

fn latin_look_alike(ch: char) -> char {
    match ch {
        'А' => 'A',
        'В' => 'B',
        'С' => 'C',
        'Е' => 'E',
        'Н' => 'H',
        'І' => 'I',
        'К' => 'K',
        'М' => 'M',
        'О' => 'O',
        'Р' => 'P',
        'Т' => 'T',
        'Х' => 'X',
        'У' => 'Y',
        'З' => 'Z',
        other => other,
    }
}

fn mgrs_reading(x: &str, y: &str) -> MgrsReading {
    static SHAPE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d*)$").unwrap()
    });
    let value = normalize_mgrs(x, y);
    let Some(shape) = SHAPE.captures(&value) else {
        return MgrsReading::NotMgrs;
    };
    let digits = shape[1].len();
    // geoconvert walks the digits before checking their count, so a longer
    // reference must not reach it.
    if digits == 0
        || digits % 2 != 0
        || digits > AI_AGENT_MAP_MGRS_MAX_DIGITS
        || !is_mgrs_digit_pair(x, y)
    {
        return MgrsReading::Malformed;
    }
    match Mgrs::parse_str(&value) {
        Ok(mgrs) => {
            let point = mgrs.to_latlon();
            MgrsReading::Valid(point.latitude(), point.longitude())
        }
        Err(_) => MgrsReading::Malformed,
    }
}

/// Digits written as one run or two runs of equal length. Checked on the value
/// as written: without its spaces «7958 6884 12» has a valid count, but it
/// reads as a different place.
fn is_mgrs_digit_pair(x: &str, y: &str) -> bool {
    let written = format!("{x} {y}");
    let runs = written
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|run| !run.is_empty())
        .skip(1) // the zone
        .map(str::len)
        .collect::<Vec<_>>();
    match runs[..] {
        [_] => true,
        [easting, northing] => easting == northing,
        _ => false,
    }
}

fn malformed_mgrs(warnings: &mut Vec<String>) -> ResolvedPosition {
    warnings.push(
        "Некоректна координата MGRS; початкове значення збережено".to_string(),
    );
    ResolvedPosition {
        system: AI_AGENT_MAP_SYSTEM_MGRS.to_string(),
        x: "INVALID".to_string(),
        y: "INVALID".to_string(),
        geometry: None,
    }
}

fn decimal_degrees(x: &str, y: &str) -> Option<(f64, f64)> {
    let trim = |value: &str| {
        value.trim().trim_end_matches([',', ';']).trim().to_string()
    };
    let pair = crate::media_summary::worker::normalize_decimal_wgs84(
        format!("{} {}", trim(x), trim(y)).trim(),
    )?;
    let (latitude, longitude) = pair.split_once(", ")?;
    Some((latitude.parse().ok()?, longitude.parse().ok()?))
}

fn is_wgs84_label(label: &str) -> bool {
    let token = label
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    matches!(
        token.as_str(),
        "wgs84" | "epsg4326" | "latlon" | "latlng" | "latlong"
    )
}

fn inside_ukraine(point: (f64, f64)) -> bool {
    (AI_AGENT_MAP_UKRAINE_LAT_BOUNDS.0..=AI_AGENT_MAP_UKRAINE_LAT_BOUNDS.1)
        .contains(&point.0)
        && (AI_AGENT_MAP_UKRAINE_LON_BOUNDS.0
            ..=AI_AGENT_MAP_UKRAINE_LON_BOUNDS.1)
            .contains(&point.1)
}

fn grid_reading_in_ukraine(x: &str, y: &str) -> bool {
    project(&normalize_component(x), &normalize_component(y))
        .is_ok_and(inside_ukraine)
}

fn warn_outside_ukraine(point: (f64, f64), warnings: &mut Vec<String>) {
    if !inside_ukraine(point) {
        warnings.push("Координати поза очікуваною територією України; перевірте початкові координати".to_string());
    }
}

fn geodetic_position(
    system: &str,
    point: (f64, f64),
    warnings: &mut Vec<String>,
) -> ResolvedPosition {
    warn_outside_ukraine(point, warnings);
    let (x, y) = unproject(point.0, point.1).unwrap_or_else(|_| {
        warnings.push(
            "Не вдалося перетворити координати у СК-42 для CSV".to_string(),
        );
        ("INVALID".to_string(), "INVALID".to_string())
    });
    ResolvedPosition {
        system: system.to_string(),
        x,
        y,
        geometry: Some(point),
    }
}

fn grid_system(label: &str) -> String {
    let token = label.trim().to_lowercase();
    if matches!(
        token.as_str(),
        "sk42" | "ск-42" | "msk2000" | "msk-2000" | "мск-2000"
    ) {
        label.to_string()
    } else {
        AI_AGENT_MAP_SYSTEM_GRID.to_string()
    }
}

fn grid_position(
    label: &str,
    x: &str,
    y: &str,
    warnings: &mut Vec<String>,
) -> ResolvedPosition {
    let (x, y) = (normalize_component(x), normalize_component(y));
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
    let geometry = if x == "INVALID" || y == "INVALID" {
        None
    } else {
        projected_geometry(&x, &y, warnings)
    };
    ResolvedPosition {
        system: grid_system(label),
        x,
        y,
        geometry,
    }
}

fn projected_geometry(
    x: &str,
    y: &str,
    warnings: &mut Vec<String>,
) -> Option<(f64, f64)> {
    match project(x, y) {
        Ok(point) => {
            warn_outside_ukraine(point, warnings);
            Some(point)
        }
        Err(_) => {
            warnings.push(
                "Не вдалося перетворити координати СК-42 у WGS-84".to_string(),
            );
            None
        }
    }
}

/// True when one value alone is a whole position, so it needs no Y.
pub(super) fn is_whole_position(value: &str) -> bool {
    !matches!(mgrs_reading(value, ""), MgrsReading::NotMgrs)
        || decimal_degrees(value, "").is_some()
}

/// Whether `x` alone replaces the record's pair. A record stored as split MGRS
/// keeps its Y while the new X still reads with it.
pub(super) fn replaces_y(x: &str, record: &AiAgentMapRecord) -> bool {
    let stays_split = record.coordinate_system == AI_AGENT_MAP_SYSTEM_MGRS
        && matches!(
            mgrs_reading(x, &record.original_y),
            MgrsReading::Valid(..)
        );
    is_whole_position(x) && !stays_split
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
fn sk42_crs(zone: i32) -> String {
    format!(
        "+proj=tmerc +lat_0=0 +lon_0={} +k=1 +x_0={} +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs +type=crs",
        zone * 6 - 3, zone * 1_000_000 + 500_000
    )
}

#[cfg(feature = "proj")]
fn project(x: &str, y: &str) -> anyhow::Result<(f64, f64)> {
    let northing: f64 = x.parse().c(h!())?;
    let easting: f64 = y.parse().c(h!())?;
    let zone = (easting / 1_000_000.0).trunc() as i32;
    anyhow::ensure!((2..=8).contains(&zone), "Unsupported СК-42 zone");
    let projection =
        proj::Proj::new_known_crs(&sk42_crs(zone), "EPSG:4326", None)
            .c(h!())?;
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

/// The SK-42 grid position of a WGS-84 point, as CSV's seven-digit X and Y.
#[cfg(feature = "proj")]
fn unproject(
    latitude: f64,
    longitude: f64,
) -> anyhow::Result<(String, String)> {
    let zone = (longitude / 6.0).floor() as i32 + 1;
    anyhow::ensure!((2..=8).contains(&zone), "Unsupported СК-42 zone");
    let projection =
        proj::Proj::new_known_crs("EPSG:4326", &sk42_crs(zone), None)
            .c(h!())?;
    let (easting, northing) =
        projection.convert((longitude, latitude)).c(h!())?;
    let x = normalize_component(&format!("{northing:.0}"));
    let y = normalize_component(&format!("{easting:.0}"));
    anyhow::ensure!(
        x != "INVALID" && y != "INVALID",
        "Invalid projection result"
    );
    Ok((x, y))
}

#[cfg(not(feature = "proj"))]
fn project(_x: &str, _y: &str) -> anyhow::Result<(f64, f64)> {
    anyhow::bail!("Coordinate projection is unavailable")
}

#[cfg(not(feature = "proj"))]
fn unproject(
    _latitude: f64,
    _longitude: f64,
) -> anyhow::Result<(String, String)> {
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

pub(super) fn refresh_coordinates(
    record: &mut AiAgentMapRecord,
    coordinate_system: &str,
    original_x: &str,
    original_y: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        bounded(coordinate_system)
            && bounded(original_x)
            && bounded(original_y),
        "Map record exceeds field limits"
    );
    let mut warnings = record
        .warnings
        .iter()
        .filter(|warning| !is_coordinate_warning(warning))
        .cloned()
        .collect::<Vec<_>>();
    let position = resolve_position(
        coordinate_system,
        original_x,
        original_y,
        &mut warnings,
    );
    record.coordinate_system = position.system;
    record.original_x = original_x.to_string();
    record.original_y = original_y.to_string();
    record.x = position.x;
    record.y = position.y;
    record.latitude = position.geometry.map(|point| point.0);
    record.longitude = position.geometry.map(|point| point.1);
    record.warnings = warnings;
    Ok(())
}

pub(super) fn normalize_comments(
    comments: Vec<String>,
) -> anyhow::Result<Vec<String>> {
    anyhow::ensure!(
        comments.len() <= AI_AGENT_MAP_MAX_COMMENTS
            && comments.iter().all(|value| bounded(value)),
        "Map record exceeds field limits"
    );
    Ok(comments
        .into_iter()
        .map(|comment| {
            comment
                .replace(['"', '“', '”', '«', '»'], "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect())
}

fn is_coordinate_warning(warning: &str) -> bool {
    warning.starts_with("Некоректна координата ")
        || warning == "Непідтримувана система координат"
        || warning.starts_with("Координати поза очікуваною територією")
        || warning.starts_with("Не вдалося перетворити координати")
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
    let ids = document
        .records
        .iter()
        .map(|record| record.id.clone())
        .collect::<Vec<_>>();
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
                file_sources: record.file_sources,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    for (record, id) in document.records.iter_mut().zip(ids) {
        if !id.is_empty() {
            record.id = id;
        }
    }
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
