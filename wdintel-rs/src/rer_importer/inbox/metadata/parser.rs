use crate::error::AppError;
use crate::h;
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
        for mut line_metadata in parse_metadata_line_grouped(&normalized_line) {
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
    let result = expand_color_codes(expand_multi_source_ids(result))
        .into_iter()
        .map(WorkingMetadata::into_public)
        .filter(InboxMetadata::has_some_value)
        .collect();
    reduce_metadata_list(result)
}

pub(crate) fn is_metadata_line(line: &str) -> bool {
    let (line, _) = trim_line(line);
    if line.is_empty() {
        return false;
    }
    is_metadata_only_line(&line)
}

fn is_metadata_only_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_METADATA_HEADER_PART: Regex = Regex::new(
            r#"(?ix)
            (?:
                (?:[cс]{2}|🎨)\s*:?\s*(?:(?:\d+\s*,\s*)*\d+|нв|-)
              | код\s+кольору\s*:?\s*(?:\d+|нв|-)
              | [iі]d\s*\(\s*[cс]g\s*\)\s*(?:⬅️?)?\s*:?\s*(?:[xх]\s*:)?(?:\d+|нв|-)(?:\s*\([^)]+\))?
              | [iі]d\s+отримувача\s*:?\s*(?:\d+|нв|-)(?:\s*\([^)]+\))?
              | (?:[cс]g|group\s+id|код\s+групи)\s*:?\s*(?:[xх]\s*:)?(?:\d+|нв|-)(?:\s*\([^)]+\))?
              | [iі]d\s+відправника\s*:?\s*(?:\d+|нв|-)(?:\s*\([^)]+\))?
              | source\s+id\s*:?\s*(?:\d+(?:\s*\([^)]+\))?(?:\s*,\s*\d+(?:\s*\([^)]+\))?)*|нв|-)
              | [iі]d\s*(?:➡️?)?\s*:?\s*(?:\d+(?:\s*\([^)]+\))?(?:\s*,\s*\d+(?:\s*\([^)]+\))?)*|нв|-)
              | [iі]d\s*:\s*[^;\r\n]+;
              | хеш\s+[iі]d\s*:\s*[0-9a-f]+
              | 👥\s*:\s*[^🔐\r\n]+?\s*🔐
              | ⬅️\s*:?\s*(?:\d+|нв|-)(?:\s*\([^)]+\))?
              | ➡️\s*:?\s*(?:\d+(?:\s*\([^)]+\))?(?:\s*,\s*\d+(?:\s*\([^)]+\))?)*|нв|-)
            )
            "#
        )
        .unwrap();
    }
    let line = normalize_metadata_digits(line);
    let rest = RE_METADATA_HEADER_PART.replace_all(&line, "");
    let rest = demoji::demoji(&rest);
    rest.chars()
        .all(|ch| ch.is_whitespace() || matches!(ch, ';' | ','))
}

pub fn parse_color_code(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"[cCсС]{2}\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CC_UA: Regex =
            Regex::new(r#"(?i)код\s+кольору\s*:\s*(\d+|нв|-)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CC_NO_COLON: Regex =
            Regex::new(r#"(?:^|\s)[cCсС]{2}\s+(\d+)"#).unwrap();
    }
    parse_numeric_value_from_standalone_regexes(line, &[&RE_CC_UA])
        .or_else(|| parse_value_from_regexes(line, &[&RE_CC]))
        .or_else(|| parse_numeric_value_from_regexes(line, &[&RE_CC_NO_COLON]))
}

fn parse_color_codes(line: &NormalizedLine) -> Vec<MatchedValue> {
    lazy_static! {
        static ref RE_COLOR_CODES: Regex =
            Regex::new(r#"(?:[cCсС]{2}|🎨)\s*:\s*(\d+(?:\s*,\s*\d+)*)"#)
                .unwrap();
    }

    let color_codes = RE_COLOR_CODES
        .captures_iter(&line.text)
        .filter_map(|captures| {
            line.build_value(captures.get(1)?, normalize_metadata_value)
        })
        .filter_map(|value| split_numeric_metadata_list(&value))
        .flatten()
        .collect::<Vec<_>>();
    if color_codes.is_empty() {
        parse_color_code(line).into_iter().collect()
    } else {
        color_codes
    }
}

pub fn parse_mid(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CG: Regex = Regex::new(r#"➡️?\s*:?\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CG_LIST: Regex =
            Regex::new(
                r#"➡️?\s*:?\s*((?:\d+\s*(?:\([^)]+\))?\s*,\s*)+\d+\s*(?:\([^)]+\))?)"#
            )
            .unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex =
            Regex::new(r#"[іІiI][dD]\s*:?\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_SENDER_ID_UA: Regex =
            Regex::new(r#"(?i)[іІiI][dD]\s+відправника\s*:?\s*(\d+|нв|-)"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_SOURCE_ID: Regex = Regex::new(
            r#"(?i)\bSOURCE\s+ID\s*:?\s*((?:\d+\s*(?:\([^)]+\))?\s*,\s*)+\d+\s*(?:\([^)]+\))?|\d+)"#
        )
        .unwrap();
    }
    parse_numeric_value_from_regexes(line, &[&RE_SOURCE_ID])
        .or_else(|| {
            parse_numeric_value_from_standalone_regexes(
                line,
                &[&RE_SENDER_ID_UA, &RE_ID],
            )
        })
        .or_else(|| {
            parse_numeric_value_from_regexes(line, &[&RE_CG_LIST, &RE_CG])
        })
}

pub fn parse_mid_id(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_CG: Regex =
            Regex::new(r#"➡️?\s*:?\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex =
            Regex::new(r#"[іІiI][dD]\s*:?\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID_TEXT: Regex =
            Regex::new(r#"[іІiI][dD]\s*:\s*([^;]+)\s*;"#).unwrap();
    }
    lazy_static! {
        static ref RE_SENDER_ID_UA: Regex = Regex::new(
            r#"(?i)[іІiI][dD]\s+відправника\s*:?\s*(?:\d+|нв|-)\s*\(([^)]+)\)"#
        )
        .unwrap();
    }
    lazy_static! {
        static ref RE_SOURCE_ID: Regex = Regex::new(
            r#"(?i)\bSOURCE\s+ID\s*:?\s*(?:\d+(?:\s*,\s*\d+)*|нв|-)\s*\(([^)]+)\)"#
        )
        .unwrap();
    }
    parse_string_from_regexes(line, &[&RE_SOURCE_ID], 1)
        .or_else(|| parse_string_from_standalone_regexes(line, &[&RE_ID], 2))
        .or_else(|| {
            parse_string_from_standalone_regexes(line, &[&RE_SENDER_ID_UA], 1)
        })
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
                if let Some(value) =
                    line.build_value(value, normalize_metadata_value)
                {
                    return Some(value);
                }
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
                if let Some(value) =
                    line.build_value(value, normalize_metadata_value)
                {
                    return Some(value);
                }
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
                if let Some(value) =
                    line.build_value(value, normalize_metadata_value)
                {
                    return Some(value);
                }
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
                if let Some(value) =
                    line.build_value(value, normalize_metadata_value)
                {
                    return Some(value);
                }
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
                if let Some(value) =
                    line.build_value(value, normalize_metadata_value)
                {
                    return Some(value);
                }
            }
        }
    }
    None
}

pub fn normalize_metadata_value(value: &str) -> Option<String> {
    let value = value.trim();
    let value_lower = value.to_lowercase();
    if value.is_empty()
        || value == "-"
        || value_lower == "нв"
        || value_lower == "hb"
    {
        return None;
    }

    Some(value.to_string())
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
    lazy_static! {
        static ref RE_HASH_ID_EMOJI: Regex =
            Regex::new(r#"👥\s*:\s*([^🔐\r\n]+?)\s*🔐"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_HASH_ID])
        .or_else(|| parse_value_from_regexes(line, &[&RE_HASH_ID_EMOJI]))
        .map(MatchedValue::lowercase_value)
        .filter(|hash_id| hash_id.value.as_deref() != Some("різні"))
}

#[cfg(test)]
pub fn parse_metadata_line(line: &NormalizedLine) -> Vec<WorkingMetadata> {
    expand_color_codes(parse_metadata_line_grouped(line))
}

fn parse_metadata_line_grouped(line: &NormalizedLine) -> Vec<WorkingMetadata> {
    let common = WorkingMetadata {
        id: parse_mid(line).unwrap_or_default(),
        id_name: parse_mid_id(line).unwrap_or_default(),
        ..Default::default()
    };
    let mut result = if let Some(abonents) = parse_emoji_abonent_lists(line) {
        abonents
            .into_iter()
            .map(|(sender, receiver)| WorkingMetadata {
                id: sender,
                receiver,
                ..common.clone()
            })
            .collect()
    } else {
        vec![WorkingMetadata {
            hash_id: parse_hash_id(line).unwrap_or_default(),
            ..common
        }]
    };
    let mut cg_parts = parse_cg_parts(line);
    cg_parts.sort_by_key(|(start, _)| *start);
    result = apply_cg_parts(result, cg_parts);
    result = attach_color_codes(result, parse_color_codes(line));

    result
}

fn apply_cg_parts(
    items: Vec<WorkingMetadata>,
    cg_parts: Vec<(usize, WorkingMetadata)>,
) -> Vec<WorkingMetadata> {
    if cg_parts.is_empty() {
        return items;
    }

    let mut result = vec![];
    for item in items {
        for (_, cg_part) in &cg_parts {
            let mut item = item.clone();
            item.merge_from(cg_part.clone());
            result.push(item);
        }
    }
    result
}

fn attach_color_codes(
    mut items: Vec<WorkingMetadata>,
    color_codes: Vec<MatchedValue>,
) -> Vec<WorkingMetadata> {
    if color_codes.is_empty() {
        return items;
    }

    let mut color_codes = color_codes.into_iter();
    let Some(color_code) = color_codes.next() else {
        return items;
    };
    let additional_ccs = color_codes.collect::<Vec<_>>();
    for item in &mut items {
        item.cc = color_code.clone();
        item.additional_ccs = additional_ccs.clone();
    }
    items
}

fn parse_emoji_abonent_lists(
    line: &NormalizedLine,
) -> Option<Vec<(MatchedValue, MatchedValue)>> {
    lazy_static! {
        static ref RE_ABONENT_LIST: Regex = Regex::new(
            r#"👥\s*:\s*(?:\d{3}[.,]\d{3,4}\s*(?i:мгц)\s*)?((?:\d+\s*[,/]\s*)+\d+)\s*🔐"#
        )
        .unwrap();
        static ref RE_SEPARATE_ABONENT_LISTS: Regex = Regex::new(
            r#"👥\s*:\s*(?:\d{3}[.,]\d{3,4}\s*(?i:мгц)\s*)?(\d+(?:\s*[,/]\s*\d+)*)\s*[,/]?\s*👥\s*:\s*(?:\d{3}[.,]\d{3,4}\s*(?i:мгц)\s*)?(\d+(?:\s*[,/]\s*\d+)*)\s*🔐"#
        )
        .unwrap();
    }

    let separate_groups =
        parse_separate_emoji_abonent_groups(line, &RE_SEPARATE_ABONENT_LISTS);
    let separate_spans = separate_groups
        .iter()
        .map(|(start, end, _)| (*start, *end))
        .collect::<Vec<_>>();
    let mut groups = separate_groups
        .into_iter()
        .map(|(start, _, abonents)| (start, abonents))
        .collect::<Vec<_>>();
    groups.extend(parse_single_emoji_abonent_groups(
        line,
        &RE_ABONENT_LIST,
        &separate_spans,
    ));
    groups.sort_by_key(|(start, _)| *start);
    let abonents = groups
        .into_iter()
        .flat_map(|(_, abonents)| abonents)
        .collect::<Vec<_>>();
    (!abonents.is_empty()).then_some(abonents)
}

fn parse_separate_emoji_abonent_groups(
    line: &NormalizedLine,
    regex: &Regex,
) -> Vec<(usize, usize, Vec<(MatchedValue, MatchedValue)>)> {
    regex
        .captures_iter(&line.text)
        .filter_map(|captures| {
            let full_match = captures.get(0)?;
            let senders =
                line.build_value(captures.get(1)?, normalize_metadata_value)?;
            let receivers =
                line.build_value(captures.get(2)?, normalize_metadata_value)?;
            let senders = split_numeric_metadata_list(&senders)?;
            let receivers = split_numeric_metadata_list(&receivers)?;
            let mut abonents = vec![];
            for sender in senders {
                for receiver in &receivers {
                    abonents.push((sender.clone(), receiver.clone()));
                }
            }
            Some((full_match.start(), full_match.end(), abonents))
        })
        .collect()
}

fn parse_single_emoji_abonent_groups(
    line: &NormalizedLine,
    regex: &Regex,
    excluded_spans: &[(usize, usize)],
) -> Vec<(usize, Vec<(MatchedValue, MatchedValue)>)> {
    regex
        .captures_iter(&line.text)
        .filter_map(|captures| {
            let full_match = captures.get(0)?;
            if excluded_spans.iter().any(|(start, end)| {
                full_match.start() >= *start && full_match.end() <= *end
            }) {
                return None;
            }
            let list =
                line.build_value(captures.get(1)?, normalize_metadata_value)?;
            let mut abonents = split_numeric_metadata_list(&list)?.into_iter();
            let sender = abonents.next()?;
            Some((
                full_match.start(),
                abonents
                    .map(|receiver| (sender.clone(), receiver))
                    .collect(),
            ))
        })
        .collect()
}

fn split_numeric_metadata_list(
    value: &MatchedValue,
) -> Option<Vec<MatchedValue>> {
    let raw_text = value.raw_text.as_ref()?;
    let start_index = value.start_index?;
    let chars = raw_text.chars().collect::<Vec<_>>();
    let ids = split_source_id_part_ranges(&chars)
        .into_iter()
        .map(|(part_start, part_end)| {
            let raw_part =
                chars[part_start..part_end].iter().collect::<String>();
            parse_source_id_part(&raw_part, part_start, start_index)
                .map(|(id, _)| id)
        })
        .collect::<Option<Vec<_>>>()?;

    (!ids.is_empty()
        && ids.iter().all(|id| {
            id.value.as_ref().is_some_and(|value| {
                value.chars().all(|ch| ch.is_ascii_digit())
            })
        }))
    .then_some(ids)
}

pub fn parse_cg_parts(line: &NormalizedLine) -> Vec<(usize, WorkingMetadata)> {
    lazy_static! {
        static ref RE_RECEIVER_ARROW: Regex =
            Regex::new(r#"⬅️?\s*:?\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_ID: Regex = Regex::new(
            r#"(?i:[iі]d\([cс]g\))\s*(?:⬅️?)?\s*:?\s*(\d+)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_ID_UA: Regex = Regex::new(
            r#"(?i:[iі]d)\s+отримувача\s*:?\s*(\d+|нв|-)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP: Regex =
            Regex::new(r#"(?i:[cс]g)\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_BARE: Regex =
            Regex::new(r#"(?i:[cс]g)\s+(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_EN: Regex =
            Regex::new(r#"(?i)GROUP\s+ID\s*:?\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_UA: Regex = Regex::new(
            r#"(?i)код\s+групи\s*:?\s*(\d+|нв|-)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_X: Regex = Regex::new(
            r#"(?i:[cс]g)\s*:(?i:[xх])\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }

    let mut parts = vec![];

    for regex in [
        &*RE_RECEIVER_ARROW as &Regex,
        &*RE_RECEIVER_ID as &Regex,
        &*RE_RECEIVER_ID_UA as &Regex,
    ] {
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

    for (regex, require_standalone_prefix) in [
        (&*RE_RECEIVER_GROUP as &Regex, false),
        (&*RE_RECEIVER_GROUP_BARE as &Regex, true),
        (&*RE_RECEIVER_GROUP_EN as &Regex, false),
        (&*RE_RECEIVER_GROUP_UA as &Regex, false),
    ] {
        for caps in regex.captures_iter(&line.text) {
            if require_standalone_prefix {
                let Some(full_match) = caps.get(0) else {
                    continue;
                };
                if !line.standalone_prefix(full_match.start()) {
                    continue;
                }
            }
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

fn push_metadata_if_nonempty(
    result: &mut Vec<WorkingMetadata>,
    metadata: WorkingMetadata,
) {
    if metadata.has_some_value() {
        result.push(metadata);
    }
}

fn expand_multi_source_ids(
    items: Vec<WorkingMetadata>,
) -> Vec<WorkingMetadata> {
    let mut result = vec![];
    for mut item in items {
        let Some(ids) = split_multi_source_id(&item.id) else {
            result.push(item);
            continue;
        };

        if let Some(shared_id_name) = trailing_shared_source_id_name(&ids) {
            item.id_name = shared_id_name.clone();
        } else if matched_value_is_within(&item.id_name, &item.id) {
            item.id_name = MatchedValue::default();
        }
        for (id, id_name) in ids {
            let mut item = item.clone();
            item.id = id;
            if id_name.has_value() {
                item.id_name = id_name;
            }
            result.push(item);
        }
    }
    result
}

fn expand_color_codes(items: Vec<WorkingMetadata>) -> Vec<WorkingMetadata> {
    let mut result = vec![];
    for mut item in items {
        let additional_ccs = std::mem::take(&mut item.additional_ccs);
        result.push(item.clone());
        for color_code in additional_ccs {
            let mut item = item.clone();
            item.cc = color_code;
            result.push(item);
        }
    }
    result
}

fn trailing_shared_source_id_name(
    ids: &[(MatchedValue, MatchedValue)],
) -> Option<&MatchedValue> {
    let ((_, trailing_name), preceding_ids) = ids.split_last()?;
    (trailing_name.has_value()
        && preceding_ids
            .iter()
            .all(|(_, id_name)| !id_name.has_value()))
    .then_some(trailing_name)
}

fn matched_value_is_within(
    value: &MatchedValue,
    container: &MatchedValue,
) -> bool {
    match (
        value.start_index,
        value.end_index,
        container.start_index,
        container.end_index,
    ) {
        (
            Some(start),
            Some(end),
            Some(container_start),
            Some(container_end),
        ) => start >= container_start && end <= container_end,
        _ => false,
    }
}

fn split_multi_source_id(
    id: &MatchedValue,
) -> Option<Vec<(MatchedValue, MatchedValue)>> {
    let raw_text = id.raw_text.as_ref()?;
    let start_index = id.start_index?;
    if !raw_text.contains(',') {
        return None;
    }

    let chars = raw_text.chars().collect::<Vec<_>>();
    let ids = split_source_id_part_ranges(&chars)
        .into_iter()
        .map(|(part_start, part_end)| {
            let raw_part =
                chars[part_start..part_end].iter().collect::<String>();
            parse_source_id_part(&raw_part, part_start, start_index)
        })
        .collect::<Option<Vec<_>>>()?;

    if ids.len() <= 1
        || ids.iter().any(|(id, _)| {
            id.value.as_ref().is_none_or(|value| {
                !value.chars().all(|ch| ch.is_ascii_digit())
            })
        })
    {
        return None;
    }

    Some(ids)
}

fn split_source_id_part_ranges(chars: &[char]) -> Vec<(usize, usize)> {
    let mut ranges = vec![];
    let mut part_start = 0_usize;
    let mut in_parentheses = false;
    for idx in 0..=chars.len() {
        if idx < chars.len() {
            match chars[idx] {
                '(' => {
                    in_parentheses = true;
                    continue;
                }
                ')' => {
                    in_parentheses = false;
                    continue;
                }
                ',' | '/' if !in_parentheses => {}
                _ => continue,
            }
        }

        let mut trimmed_start = part_start;
        let mut trimmed_end = idx;
        while trimmed_start < trimmed_end
            && chars[trimmed_start].is_whitespace()
        {
            trimmed_start += 1;
        }
        while trimmed_end > trimmed_start
            && chars[trimmed_end - 1].is_whitespace()
        {
            trimmed_end -= 1;
        }
        if trimmed_start < trimmed_end {
            ranges.push((trimmed_start, trimmed_end));
        }
        part_start = idx + 1;
    }
    ranges
}

fn parse_source_id_part(
    raw_part: &str,
    part_start: usize,
    source_start_index: i32,
) -> Option<(MatchedValue, MatchedValue)> {
    lazy_static! {
        static ref RE_SOURCE_ID_PART: Regex =
            Regex::new(r#"^\s*(\d+)\s*(?:\(([^)]+)\))?\s*$"#).unwrap();
    }

    let normalized_part = NormalizedLine::new(raw_part.to_string());
    let captures = RE_SOURCE_ID_PART.captures(&normalized_part.text)?;
    let id = matched_source_id_part(
        &normalized_part,
        captures.get(1)?,
        part_start,
        source_start_index,
    )?;
    let id_name = captures
        .get(2)
        .and_then(|name| {
            matched_source_id_part(
                &normalized_part,
                name,
                part_start,
                source_start_index,
            )
        })
        .unwrap_or_default();
    Some((id, id_name))
}

fn matched_source_id_part(
    normalized_part: &NormalizedLine,
    value_match: regex::Match<'_>,
    part_start: usize,
    source_start_index: i32,
) -> Option<MatchedValue> {
    let mut value =
        normalized_part.build_value(value_match, normalize_metadata_value)?;
    let offset = source_start_index + part_start as i32;
    value.start_index = value.start_index.map(|index| index + offset);
    value.end_index = value.end_index.map(|index| index + offset);
    Some(value)
}

fn reduce_metadata_list(mut items: Vec<InboxMetadata>) -> Vec<InboxMetadata> {
    loop {
        if items.len() <= 1 {
            return items;
        }

        let mut removed = false;
        'outer: for idx in 0..items.len() {
            for other_idx in 0..items.len() {
                if idx == other_idx {
                    continue;
                }
                if items[idx].matches(&items[other_idx]) {
                    items.remove(idx);
                    removed = true;
                    break 'outer;
                }
            }
        }

        if !removed {
            return items;
        }
    }
}

fn trim_line(line: &str) -> (String, i32) {
    let chars = line.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return (String::new(), 0);
    }

    let mut start = 0_usize;
    let mut end = chars.len();
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }

    (chars[start..end].iter().collect::<String>(), start as i32)
}

fn offset_metadata(metadata: &mut WorkingMetadata, offset: i32) {
    for value in [
        &mut metadata.cc,
        &mut metadata.receiver,
        &mut metadata.receiver_name,
        &mut metadata.receiver_group,
        &mut metadata.receiver_group_name,
        &mut metadata.id,
        &mut metadata.id_name,
        &mut metadata.hash_id,
    ] {
        if let Some(start_index) = value.start_index.as_mut() {
            *start_index += offset;
        }
        if let Some(end_index) = value.end_index.as_mut() {
            *end_index += offset;
        }
    }
    for value in &mut metadata.additional_ccs {
        if let Some(start_index) = value.start_index.as_mut() {
            *start_index += offset;
        }
        if let Some(end_index) = value.end_index.as_mut() {
            *end_index += offset;
        }
    }
}
