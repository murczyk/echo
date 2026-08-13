use anyhow::{Context, Result};
use calamine::{open_workbook, Data, Reader, Xlsx};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Europe::Kyiv;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const ASSOCIATION_EXCEL_TEXT_UNESCAPED_FIELD: &str = "excel_text_unescaped";

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
    #[serde(default)]
    pub excel_text_unescaped: bool,
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

    pub fn dedupe_key(&self) -> String {
        let frequency = normalize_text(self.frequency.clone());
        let coordinates = normalize_text(self.coordinates.clone());
        let note = normalize_text(self.note.clone());
        let source_date_raw = normalize_text(self.source_date_raw.clone());

        if source_date_raw.is_none() {
            if let (Some(frequency), Some(coordinates), Some(note)) =
                (&frequency, &coordinates, &note)
            {
                return format!("{frequency}\n{coordinates}\n{note}");
            }
        }

        json!({
            "v": 2,
            "source_date_raw": source_date_raw,
            "association_type": normalize_text(self.association_type.clone()),
            "frequency": frequency,
            "coordinates": coordinates,
            "note": note,
            "category": normalize_text(self.category.clone()),
            "call_signs": normalize_string_list(&self.call_signs),
            "formation": normalize_text(self.formation.clone()),
            "association_count": self.association_count,
            "sidc": normalize_text(self.sidc.clone()),
            "author": normalize_text(self.author.clone()),
            "palettes": self.palettes.clone(),
        })
        .to_string()
    }

    pub fn source_date(&self) -> Option<DateTime<Utc>> {
        parse_goi_datetime(self.source_date_raw.as_deref()?)
    }

    pub fn excel_unescaped_cells(&self) -> Vec<AssociationCell> {
        self.cells
            .iter()
            .cloned()
            .map(|mut cell| {
                if cell.kind == "string" {
                    if let Value::String(value) = &mut cell.value {
                        *value = unescape_excel_text(value);
                    }
                }
                cell
            })
            .collect()
    }
}

pub fn association_excel_text_is_unescaped(row: &Value) -> bool {
    row.get(ASSOCIATION_EXCEL_TEXT_UNESCAPED_FIELD)
        .and_then(Value::as_bool)
        .unwrap_or(false)
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
    let column_offset = detect_association_column_offset(row);
    let cells = row.iter().map(AssociationCell::from).collect::<Vec<_>>();
    let base = AssociationRow {
        sheet_name: sheet_name.to_string(),
        row_num: (row_idx + 1) as u32,
        cells,
        excel_text_unescaped: true,
        association_type: normalize_text(cell_string(row.first())),
        frequency: normalize_text(cell_string(row.get(1))),
        coordinates: normalize_text(cell_string(row.get(2 + column_offset))),
        note: normalize_text(cell_string(row.get(3 + column_offset))),
        category: normalize_text(cell_string(row.get(4 + column_offset))),
        call_signs: split_list(cell_string(row.get(5 + column_offset))),
        formation: normalize_text(cell_string(row.get(6 + column_offset))),
        association_count: cell_i32(row.get(7 + column_offset)),
        sidc: None,
        author: None,
        source_date_raw: None,
        palettes: None,
    };

    parse_tail_columns(base, row, 8 + column_offset)
}

fn parse_tail_columns(
    mut row_out: AssociationRow,
    row: &[Data],
    base_len: usize,
) -> AssociationRow {
    let tail_len = row.len().saturating_sub(base_len);
    if tail_len == 0 {
        return row_out;
    }
    if tail_len == 1 {
        row_out.author = normalize_text(cell_string(row.get(base_len)));
        return row_out;
    }
    if tail_len == 2 {
        row_out.author = normalize_text(cell_string(row.get(base_len)));
        row_out.source_date_raw =
            normalize_text(cell_string(row.get(base_len + 1)));
        return row_out;
    }

    let col8 = normalize_text(cell_string(row.get(base_len)));
    let col9 = normalize_text(cell_string(row.get(base_len + 1)));
    let col10 = normalize_text(cell_string(row.get(base_len + 2)));
    let col11 = row.get(base_len + 3).and_then(cell_jsonish);

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

fn detect_association_column_offset(row: &[Data]) -> usize {
    let third_col = normalize_text(cell_string(row.get(2)));
    let fourth_col = normalize_text(cell_string(row.get(3)));
    if third_col.is_none() && looks_like_coordinates(fourth_col.as_deref()) {
        1
    } else {
        0
    }
}

fn looks_like_date(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    parse_goi_datetime(value).is_some()
}

fn looks_like_coordinates(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let has_digit = trimmed.chars().any(|char| char.is_ascii_digit());
    let has_letter = trimmed.chars().any(|char| char.is_ascii_alphabetic());
    has_digit && has_letter
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

pub fn unescape_excel_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut idx = 0;
    while idx < value.len() {
        if let Some(ch) = excel_escape_char_at(value, idx) {
            out.push(ch);
            idx += 7;
            continue;
        }
        let ch = value[idx..]
            .chars()
            .next()
            .expect("idx is always on a char boundary");
        out.push(ch);
        idx += ch.len_utf8();
    }
    out.replace("\r\n", "\n").replace('\r', "\n")
}

fn excel_escape_char_at(value: &str, idx: usize) -> Option<char> {
    let bytes = value.as_bytes();
    let token = bytes.get(idx..idx + 7)?;
    if token[0] != b'_'
        || !token[1].eq_ignore_ascii_case(&b'x')
        || token[6] != b'_'
    {
        return None;
    }
    let code = token[2..6].iter().try_fold(0_u32, |code, byte| {
        Some(code * 16 + u32::from(hex_digit(*byte)?))
    })?;
    char::from_u32(code)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
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

fn normalize_string_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| normalize_text(Some(value.clone())))
        .collect()
}

fn cell_string(cell: Option<&Data>) -> Option<String> {
    let cell = cell?;
    match cell {
        Data::Int(value) => Some(value.to_string()),
        Data::Float(value) => Some(value.to_string()),
        Data::String(value) => Some(unescape_excel_text(value)),
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
                value: json!(unescape_excel_text(value)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Data;

    #[test]
    fn parses_shifted_association_columns() {
        let row = vec![
            Data::String("TEMPORARY".to_string()),
            Data::String("148.8000".to_string()),
            Data::Empty,
            Data::String("37UDR1590842364".to_string()),
            Data::String("note".to_string()),
            Data::String("LOGISTICS_MANUAL".to_string()),
            Data::String("CALL1, CALL2".to_string()),
            Data::String("111 мсп".to_string()),
            Data::Int(2),
            Data::String("10061000001211000000".to_string()),
            Data::String("Зігі".to_string()),
            Data::String("15.03.2026 14:50:39".to_string()),
        ];
        let row = parse_association_row("Sheet1", 0, &row);

        assert_eq!(row.coordinates.as_deref(), Some("37UDR1590842364"));
        assert_eq!(row.note.as_deref(), Some("note"));
        assert_eq!(row.category.as_deref(), Some("LOGISTICS_MANUAL"));
        assert_eq!(row.call_signs, vec!["CALL1", "CALL2"]);
        assert_eq!(row.formation.as_deref(), Some("111 мсп"));
        assert_eq!(row.association_count, Some(2));
        assert_eq!(row.sidc.as_deref(), Some("10061000001211000000"));
        assert_eq!(row.author.as_deref(), Some("Зігі"));
        assert_eq!(row.source_date_raw.as_deref(), Some("15.03.2026 14:50:39"));
    }

    #[test]
    fn keeps_legacy_dedupe_key_for_undated_complete_rows() {
        let row = AssociationRow {
            sheet_name: "Sheet1".to_string(),
            row_num: 1,
            cells: Vec::new(),
            excel_text_unescaped: true,
            association_type: None,
            frequency: Some("145.1000".to_string()),
            coordinates: Some("37UDR0682401768".to_string()),
            note: Some("note".to_string()),
            category: None,
            call_signs: Vec::new(),
            formation: None,
            association_count: None,
            sidc: None,
            author: None,
            source_date_raw: None,
            palettes: None,
        };

        assert_eq!(
            row.dedupe_key(),
            "145.1000\n37UDR0682401768\nnote".to_string()
        );
    }

    #[test]
    fn persists_partial_rows_via_fallback_dedupe_key() {
        let row = AssociationRow {
            sheet_name: "Sheet1".to_string(),
            row_num: 4,
            cells: Vec::new(),
            excel_text_unescaped: true,
            association_type: None,
            frequency: Some("162.6375".to_string()),
            coordinates: None,
            note: None,
            category: None,
            call_signs: Vec::new(),
            formation: None,
            association_count: None,
            sidc: None,
            author: None,
            source_date_raw: None,
            palettes: None,
        };

        let key = row.dedupe_key();

        assert!(key.contains("\"v\":2"));
        assert!(key.contains("\"frequency\":\"162.6375\""));
    }

    #[test]
    fn includes_source_date_in_dedupe_key_when_present() {
        let row = AssociationRow {
            sheet_name: "Sheet1".to_string(),
            row_num: 19,
            cells: Vec::new(),
            excel_text_unescaped: true,
            association_type: None,
            frequency: Some("173.6750".to_string()),
            coordinates: Some("37UBR9821185404".to_string()),
            note: Some("note".to_string()),
            category: None,
            call_signs: Vec::new(),
            formation: None,
            association_count: None,
            sidc: None,
            author: None,
            source_date_raw: Some("18.03.2026 14:55:21".to_string()),
            palettes: None,
        };

        let key = row.dedupe_key();

        assert!(key.contains("\"v\":2"));
        assert!(key.contains("\"source_date_raw\":\"18.03.2026 14:55:21\""));
    }

    #[test]
    fn unescapes_excel_control_sequences() {
        assert_eq!(
            unescape_excel_text("first_x000d_\nsecond_x000A_third"),
            "first\nsecond\nthird"
        );
        assert_eq!(unescape_excel_text("first_x000D_second"), "first\nsecond");
    }

    #[test]
    fn unescapes_excel_escaped_literal_tokens() {
        assert_eq!(
            unescape_excel_text("literal _x005F_x000D_ token"),
            "literal _x000D_ token"
        );
    }
}
