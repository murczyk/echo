use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::metadata::types::*;
use crate::rer_importer::inbox::metadata::*;
use chrono::NaiveDateTime;
use lazy_static::lazy_static;
use regex::Regex;

pub fn parse_optional_ts(
    m_ts_txt: Option<&str>,
) -> Result<Option<NaiveDateTime>, AppError> {
    Ok(m_ts_txt
        .map(|ts_txt| {
            NaiveDateTime::parse_from_str(ts_txt, "%Y-%m-%dT%H:%M:%S").c(h!())
        })
        .transpose()?)
}

pub fn parse_metadata(message: &str) -> Vec<InboxMetadata> {
    let mut result = vec![];
    let mut current = WorkingMetadata::default();
    let mut last_cg_kind = None;
    let mut line_start_index = 0_i32;
    for line in message.split_inclusive('\n') {
        let line_len = line.chars().count() as i32;
        let line = line.strip_suffix('\n').unwrap_or(line);
        let line = line.strip_suffix('\r').unwrap_or(line);
        let (line, trim_offset) = trim_line(line);
        if line.is_empty() {
            line_start_index += line_len;
            continue;
        }

        let normalized_line = NormalizedLine::new(line);
        for mut line_metadata in parse_metadata_line(&normalized_line) {
            offset_metadata(&mut line_metadata, line_start_index + trim_offset);
            if !line_metadata.has_some_value() {
                continue;
            }

            if last_cg_kind == Some(CgKind::Receiver)
                && line_metadata.cg_kind() == Some(CgKind::ReceiverGroup)
            {
                current.receiver = MatchedValue::default();
                current.receiver_name = MatchedValue::default();
            }

            if current.conflicts_with(&line_metadata) {
                push_metadata_if_nonempty(&mut result, current);
                current = line_metadata;
            } else {
                current.merge_from(line_metadata);
            }

            if let Some(kind) = current.cg_kind() {
                last_cg_kind = Some(kind);
            }
        }

        line_start_index += line_len;
    }

    push_metadata_if_nonempty(&mut result, current);
    let result = expand_multi_source_ids(result)
        .into_iter()
        .map(WorkingMetadata::into_public)
        .filter(InboxMetadata::has_some_value)
        .collect();
    reduce_metadata_list(result)
}

pub fn parse_color_code(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"[cCсС]{2}\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CC_NO_COLON: Regex =
            Regex::new(r#"(?:^|\s)[cCсС]{2}\s+(\d+)"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_CC])
        .or_else(|| parse_numeric_value_from_regexes(line, &[&RE_CC_NO_COLON]))
}

pub fn parse_mid(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CG: Regex = Regex::new(r#"➡️\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex =
            Regex::new(r#"[іІiI][dD]\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_SOURCE_ID: Regex =
            Regex::new(r#"(?i)SOURCE\s+ID\s*:\s*([\d,\s]+)"#).unwrap();
    }
    parse_numeric_value_from_standalone_regexes(line, &[&RE_ID]).or_else(|| {
        parse_numeric_value_from_regexes(line, &[&RE_CG, &RE_SOURCE_ID])
    })
}

pub fn parse_mid_id(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CG: Regex =
            Regex::new(r#"➡️\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex =
            Regex::new(r#"[іІiI][dD]\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID_TEXT: Regex =
            Regex::new(r#"[іІiI][dD]\s*:\s*([^;]+)\s*;"#).unwrap();
    }
    parse_string_from_standalone_regexes(line, &[&RE_ID], 2)
        .or_else(|| parse_string_from_regexes(line, &[&RE_CG], 2))
        .or_else(|| {
            parse_string_from_standalone_regexes(line, &[&RE_ID_TEXT], 1)
        })
}

pub fn parse_value_from_regexes(
    line: &NormalizedLine,
    regexes: &[&Regex],
) -> Option<MatchedValue> {
    for regex in regexes {
        if let Some(caps) = regex.captures(&line.text) {
            if let Some(value) = caps.get(1) {
                return line.build_value(value, normalize_metadata_value);
            }
        }
    }
    None
}

pub fn parse_numeric_value_from_regexes(
    line: &NormalizedLine,
    regexes: &[&Regex],
) -> Option<MatchedValue> {
    for regex in regexes {
        if let Some(caps) = regex.captures(&line.text) {
            if let Some(value) = caps.get(1) {
                if line.has_forbidden_suffix(value.end()) {
                    continue;
                }
                return line.build_value(value, normalize_metadata_value);
            }
        }
    }
    None
}

pub fn parse_numeric_value_from_standalone_regexes(
    line: &NormalizedLine,
    regexes: &[&Regex],
) -> Option<MatchedValue> {
    for regex in regexes {
        if let Some(caps) = regex.captures(&line.text) {
            let Some(full_match) = caps.get(0) else {
                continue;
            };
            if !line.standalone_prefix(full_match.start()) {
                continue;
            }
            if let Some(value) = caps.get(1) {
                if line.has_forbidden_suffix(value.end()) {
                    continue;
                }
                return line.build_value(value, normalize_metadata_value);
            }
        }
    }
    None
}

pub fn parse_string_from_regexes(
    line: &NormalizedLine,
    regexes: &[&Regex],
    group_idx: usize,
) -> Option<MatchedValue> {
    for regex in regexes {
        if let Some(caps) = regex.captures(&line.text) {
            if let Some(value) = caps.get(group_idx) {
                return line.build_value(value, normalize_metadata_value);
            }
        }
    }
    None
}

pub fn parse_string_from_standalone_regexes(
    line: &NormalizedLine,
    regexes: &[&Regex],
    group_idx: usize,
) -> Option<MatchedValue> {
    for regex in regexes {
        if let Some(caps) = regex.captures(&line.text) {
            let Some(full_match) = caps.get(0) else {
                continue;
            };
            if !line.standalone_prefix(full_match.start()) {
                continue;
            }
            if let Some(value) = caps.get(group_idx) {
                return line.build_value(value, normalize_metadata_value);
            }
        }
    }
    None
}

pub fn normalize_metadata_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub fn normalize_metadata_digits(line: &str) -> String {
    // fixes shit like 1️⃣   to 1
    lazy_static! {
        static ref RE: Regex = Regex::new(r"(\d)\u{FE0F}\u{20E3}").unwrap();
    }
    RE.replace_all(line, "$1").into_owned()
}

pub fn parse_hash_id(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_HASH_ID: Regex =
            Regex::new(r#"(?i)ХЕШ\s+[іІiI][dD]\s*:\s*([0-9a-f]+)"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_HASH_ID])
        .map(MatchedValue::lowercase_value)
}

pub fn parse_metadata_line(line: &NormalizedLine) -> Vec<WorkingMetadata> {
    let mut result = vec![WorkingMetadata {
        cc: parse_color_code(line).unwrap_or_default(),
        id: parse_mid(line).unwrap_or_default(),
        id_name: parse_mid_id(line).unwrap_or_default(),
        hash_id: parse_hash_id(line).unwrap_or_default(),
        ..Default::default()
    }];

    let mut cg_parts = parse_cg_parts(line);
    cg_parts.sort_by_key(|(start, _)| *start);
    result.extend(cg_parts.into_iter().map(|(_, metadata)| metadata));

    result
}

pub fn parse_cg_parts(line: &NormalizedLine) -> Vec<(usize, WorkingMetadata)> {
    lazy_static! {
        static ref RE_RECEIVER_ARROW: Regex =
            Regex::new(r#"⬅️\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_ID: Regex =
            Regex::new(r#"(?i:[iі]d\([cс]g\))\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP: Regex =
            Regex::new(r#"(?i:[cс]g)\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_EN: Regex =
            Regex::new(r#"(?i)GROUP\s+ID\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_X: Regex = Regex::new(
            r#"(?i:[cс]g)\s*:(?i:[xх])\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }

    let mut parts = vec![];

    for regex in [&*RE_RECEIVER_ARROW as &Regex, &*RE_RECEIVER_ID as &Regex] {
        for caps in regex.captures_iter(&line.text) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Some(receiver) =
                line.build_value(value, normalize_metadata_value)
            else {
                continue;
            };
            let receiver_name = caps.get(2).and_then(|name| {
                line.build_value(name, normalize_metadata_value)
            });
            parts.push((
                line.to_char_index(value.start()),
                WorkingMetadata {
                    receiver,
                    receiver_name: receiver_name.unwrap_or_default(),
                    ..Default::default()
                },
            ));
        }
    }

    for regex in [
        &*RE_RECEIVER_GROUP as &Regex,
        &*RE_RECEIVER_GROUP_EN as &Regex,
    ] {
        for caps in regex.captures_iter(&line.text) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Some(receiver_group) =
                line.build_value(value, normalize_metadata_value)
            else {
                continue;
            };
            let receiver_group_name = caps.get(2).and_then(|name| {
                line.build_value(name, normalize_metadata_value)
            });
            parts.push((
                line.to_char_index(value.start()),
                WorkingMetadata {
                    receiver_group,
                    receiver_group_name: receiver_group_name
                        .unwrap_or_default(),
                    ..Default::default()
                },
            ));
        }
    }

    for caps in RE_RECEIVER_GROUP_X.captures_iter(&line.text) {
        let Some(value) = caps.get(1) else {
            continue;
        };
        let Some(mut receiver_group) =
            line.build_value(value, normalize_metadata_value)
        else {
            continue;
        };
        receiver_group.value =
            receiver_group.value.map(|value| format!("x:{value}"));
        receiver_group.raw_text =
            receiver_group.raw_text.map(|value| format!("x:{value}"));
        let receiver_group_name = caps
            .get(2)
            .and_then(|name| line.build_value(name, normalize_metadata_value));
        parts.push((
            line.to_char_index(value.start()),
            WorkingMetadata {
                receiver_group,
                receiver_group_name: receiver_group_name.unwrap_or_default(),
                ..Default::default()
            },
        ));
    }

    parts
}
