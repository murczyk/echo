use anyhow::{Context, Result};
use calamine::{open_workbook, Data, Reader, Xlsx};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnowledgeCell {
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnowledgeRow {
    pub sheet_name: String,
    pub row_num: u32,
    pub cells: Vec<KnowledgeCell>,
    pub name: Option<String>,
    pub key: Option<String>,
    pub knowledge_type: Option<String>,
    pub author: Option<String>,
    pub note: Option<String>,
    pub source_date_raw: Option<String>,
    pub formation: Option<String>,
}

impl KnowledgeRow {
    pub fn is_meaningful(&self) -> bool {
        self.name.is_some()
            || self.key.is_some()
            || self.knowledge_type.is_some()
            || self.author.is_some()
            || self.note.is_some()
            || self.source_date_raw.is_some()
            || self.formation.is_some()
    }

    pub fn dedupe_key(&self) -> Option<String> {
        if !self.is_meaningful() {
            return None;
        }
        Some(format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.name.clone().unwrap_or_default(),
            self.key.clone().unwrap_or_default(),
            self.knowledge_type.clone().unwrap_or_default(),
            self.author.clone().unwrap_or_default(),
            self.note.clone().unwrap_or_default(),
            self.source_date_raw.clone().unwrap_or_default(),
            self.formation.clone().unwrap_or_default(),
        ))
    }

    pub fn source_date(&self) -> Option<DateTime<Utc>> {
        crate::row::parse_goi_datetime(self.source_date_raw.as_deref()?)
    }
}

pub fn read_knowledge_rows(path: &Path) -> Result<Vec<KnowledgeRow>> {
    let mut workbook: Xlsx<_> =
        open_workbook(path).with_context(|| path.display().to_string())?;
    let mut rows = Vec::new();
    for sheet_name in workbook.sheet_names().to_vec() {
        let range = workbook
            .worksheet_range(&sheet_name)
            .with_context(|| format!("worksheet_range({sheet_name})"))?;
        for (row_idx, row) in range.rows().enumerate() {
            let knowledge_row = parse_knowledge_row(&sheet_name, row_idx, row);
            if knowledge_row.is_meaningful() {
                rows.push(knowledge_row);
            }
        }
    }
    Ok(rows)
}

fn parse_knowledge_row(
    sheet_name: &str,
    row_idx: usize,
    row: &[Data],
) -> KnowledgeRow {
    KnowledgeRow {
        sheet_name: sheet_name.to_string(),
        row_num: (row_idx + 1) as u32,
        cells: row.iter().map(KnowledgeCell::from).collect(),
        name: normalize_text(cell_string(row.first())),
        key: normalize_text(cell_string(row.get(1))),
        knowledge_type: normalize_text(cell_string(row.get(2))),
        author: normalize_text(cell_string(row.get(3))),
        note: normalize_text(cell_string(row.get(4))),
        source_date_raw: normalize_text(cell_string(row.get(5))),
        formation: normalize_text(cell_string(row.get(6))),
    }
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

impl From<&Data> for KnowledgeCell {
    fn from(cell: &Data) -> Self {
        let (kind, value) = match cell {
            Data::Int(value) => ("int", json!(value)),
            Data::Float(value) => ("float", json!(value)),
            Data::String(value) => ("string", json!(value)),
            Data::Bool(value) => ("bool", json!(value)),
            Data::DateTime(value) => (
                "datetime",
                value
                    .as_datetime()
                    .map(|datetime| json!(datetime.to_string()))
                    .unwrap_or_else(|| json!(value.as_f64())),
            ),
            Data::DateTimeIso(value) => ("datetime_iso", json!(value)),
            Data::DurationIso(value) => ("duration_iso", json!(value)),
            Data::Error(value) => ("error", json!(value.to_string())),
            Data::Empty => ("empty", Value::Null),
        };
        Self {
            kind: kind.to_string(),
            value,
        }
    }
}
