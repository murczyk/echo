use anyhow::{Context, Result};
use calamine::{open_workbook, Data, Reader, Xlsx};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Europe::Kyiv;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssociationCell {
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssociationRow {
    pub sheet_name: String,
    pub row_num: u32,
    pub cells: Vec<AssociationCell>,
    pub association_type: Option<String>,
    pub frequency: Option<String>,
    pub coordinates: Option<String>,
    pub note: Option<String>,
    pub category: Option<String>,
    pub call_signs: Vec<String>,
    pub formation: Option<String>,
    pub association_count: Option<i32>,
    pub sidc: Option<String>,
    pub author: Option<String>,
    pub source_date_raw: Option<String>,
    pub palettes: Option<Value>,
}

impl AssociationRow {
    pub fn is_meaningful(&self) -> bool {
        self.association_type.is_some()
            || self.frequency.is_some()
            || self.coordinates.is_some()
            || self.note.is_some()
            || self.category.is_some()
            || !self.call_signs.is_empty()
            || self.formation.is_some()
            || self.author.is_some()
            || self.source_date_raw.is_some()
    }

    pub fn dedupe_key(&self) -> Option<String> {
        let frequency = normalize_text(self.frequency.clone())?;
        let coordinates = normalize_text(self.coordinates.clone())?;
        let note = normalize_text(self.note.clone())?;
        Some(format!("{frequency}\n{coordinates}\n{note}"))
    }

    pub fn source_date(&self) -> Option<DateTime<Utc>> {
        parse_goi_datetime(self.source_date_raw.as_deref()?)
    }
}

pub fn parse_goi_datetime(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%d.%m.%Y %H:%M:%S").ok()?;
    Kyiv.from_local_datetime(&naive)
        .single()
        .map(|datetime| datetime.with_timezone(&Utc))
}

pub fn read_association_rows(path: &Path) -> Result<Vec<AssociationRow>> {
    let mut workbook: Xlsx<_> =
        open_workbook(path).with_context(|| path.display().to_string())?;
    let mut rows = Vec::new();
    for sheet_name in workbook.sheet_names().to_vec() {
        let range = workbook
            .worksheet_range(&sheet_name)
            .with_context(|| format!("worksheet_range({sheet_name})"))?;
        for (row_idx, row) in range.rows().enumerate() {
            let association_row =
                parse_association_row(&sheet_name, row_idx, row);
            if association_row.is_meaningful() {
                rows.push(association_row);
            }
        }
    }
    Ok(rows)
}

fn parse_association_row(
    sheet_name: &str,
    row_idx: usize,
    row: &[Data],
) -> AssociationRow {
    let cells = row.iter().map(AssociationCell::from).collect::<Vec<_>>();
    let base = AssociationRow {
        sheet_name: sheet_name.to_string(),
        row_num: (row_idx + 1) as u32,
        cells,
        association_type: normalize_text(cell_string(row.first())),
        frequency: normalize_text(cell_string(row.get(1))),
        coordinates: normalize_text(cell_string(row.get(2))),
        note: normalize_text(cell_string(row.get(3))),
        category: normalize_text(cell_string(row.get(4))),
        call_signs: split_list(cell_string(row.get(5))),
        formation: normalize_text(cell_string(row.get(6))),
        association_count: cell_i32(row.get(7)),
        sidc: None,
        author: None,
        source_date_raw: None,
        palettes: None,
    };

    parse_tail_columns(base, row)
}

fn parse_tail_columns(
    mut row_out: AssociationRow,
    row: &[Data],
) -> AssociationRow {
    let tail_len = row.len().saturating_sub(8);
    if tail_len == 0 {
        return row_out;
    }
    if tail_len == 1 {
        row_out.author = normalize_text(cell_string(row.get(8)));
        return row_out;
    }
    if tail_len == 2 {
        row_out.author = normalize_text(cell_string(row.get(8)));
        row_out.source_date_raw = normalize_text(cell_string(row.get(9)));
        return row_out;
    }

    let col8 = normalize_text(cell_string(row.get(8)));
    let col9 = normalize_text(cell_string(row.get(9)));
    let col10 = normalize_text(cell_string(row.get(10)));
    let col11 = row.get(11).and_then(cell_jsonish);

    if looks_like_date(col9.as_deref()) {
        row_out.author = col8;
        row_out.source_date_raw = col9;
        row_out.palettes =
            col10.as_deref().and_then(parse_jsonish_or_list).or(col11);
        return row_out;
    }

    row_out.sidc = col8;
    row_out.author = col9;
    row_out.source_date_raw = col10;
    row_out.palettes = col11;
    row_out
}

fn looks_like_date(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    parse_goi_datetime(value).is_some()
}

fn parse_jsonish_or_list(value: &str) -> Option<Value> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return Some(parsed);
    }
    let items = split_list(Some(trimmed.to_string()));
    if items.is_empty() {
        None
    } else {
        Some(json!(items))
    }
}

fn cell_jsonish(cell: &Data) -> Option<Value> {
    parse_jsonish_or_list(&cell_string(Some(cell))?)
}

fn split_list(value: Option<String>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    value
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn normalize_text(value: Option<String>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn cell_string(cell: Option<&Data>) -> Option<String> {
    let cell = cell?;
    match cell {
        Data::Int(value) => Some(value.to_string()),
        Data::Float(value) => Some(value.to_string()),
        Data::String(value) => Some(value.clone()),
        Data::Bool(value) => Some(value.to_string()),
        Data::DateTime(value) => value
            .as_datetime()
            .map(|datetime| datetime.format("%d.%m.%Y %H:%M:%S").to_string())
            .or_else(|| Some(value.as_f64().to_string())),
        Data::DateTimeIso(value) | Data::DurationIso(value) => {
            Some(value.clone())
        }
        Data::Error(value) => Some(value.to_string()),
        Data::Empty => None,
    }
}

fn cell_i32(cell: Option<&Data>) -> Option<i32> {
    let cell = cell?;
    match cell {
        Data::Int(value) => i32::try_from(*value).ok(),
        Data::Float(value) => {
            if value.is_finite() {
                i32::try_from(*value as i64).ok()
            } else {
                None
            }
        }
        Data::String(value) => value.trim().parse::<i32>().ok(),
        _ => None,
    }
}

impl From<&Data> for AssociationCell {
    fn from(cell: &Data) -> Self {
        match cell {
            Data::Int(value) => Self {
                kind: "int".to_string(),
                value: json!(value),
            },
            Data::Float(value) => Self {
                kind: "float".to_string(),
                value: json!(value),
            },
            Data::String(value) => Self {
                kind: "string".to_string(),
                value: json!(value),
            },
            Data::Bool(value) => Self {
                kind: "bool".to_string(),
                value: json!(value),
            },
            Data::DateTime(value) => Self {
                kind: if value.is_duration() {
                    "duration".to_string()
                } else {
                    "datetime".to_string()
                },
                value: json!({
                    "excel": value.as_f64(),
                    "rendered": value.as_datetime().map(|datetime| {
                        datetime.format("%d.%m.%Y %H:%M:%S").to_string()
                    }),
                }),
            },
            Data::DateTimeIso(value) => Self {
                kind: "datetime_iso".to_string(),
                value: json!(value),
            },
            Data::DurationIso(value) => Self {
                kind: "duration_iso".to_string(),
                value: json!(value),
            },
            Data::Error(value) => Self {
                kind: "error".to_string(),
                value: json!(value.to_string()),
            },
            Data::Empty => Self {
                kind: "empty".to_string(),
                value: Value::Null,
            },
        }
    }
}
