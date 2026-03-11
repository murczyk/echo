#![allow(dead_code)]

use lazy_static::lazy_static;
use regex::Regex;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboxMetadata {
    pub cc: Option<i64>,
    pub cg: Option<i64>,
    pub cg_name: Option<String>,
    pub id: Option<i64>,
    pub id_name: Option<String>,
}

impl InboxMetadata {
    fn has_some_value(&self) -> bool {
        self.cc.is_some()
            || self.cg.is_some()
            || self.cg_name.as_ref().is_some_and(|value| !value.is_empty())
            || self.id.is_some()
            || self.id_name.as_ref().is_some_and(|value| !value.is_empty())
    }

    fn matches(&self, other: &Self) -> bool {
        self.has_some_value()
            && matches_option(self.cc, other.cc)
            && matches_option(self.cg, other.cg)
            && matches_option(self.cg_name.as_ref(), other.cg_name.as_ref())
            && matches_option(self.id, other.id)
            && matches_option(self.id_name.as_ref(), other.id_name.as_ref())
    }
}

#[derive(Clone, Debug, Default)]
struct WorkingMetadata {
    cc: Option<i64>,
    receiver: Option<i64>,
    receiver_name: Option<String>,
    receiver_group: Option<i64>,
    receiver_group_name: Option<String>,
    id: Option<i64>,
    id_name: Option<String>,
}

impl WorkingMetadata {
    fn has_some_value(&self) -> bool {
        self.cc.is_some()
            || self.receiver.is_some()
            || self
                .receiver_name
                .as_ref()
                .is_some_and(|value| !value.is_empty())
            || self.receiver_group.is_some()
            || self
                .receiver_group_name
                .as_ref()
                .is_some_and(|value| !value.is_empty())
            || self.id.is_some()
            || self.id_name.as_ref().is_some_and(|value| !value.is_empty())
    }

    fn conflicts_with(&self, other: &Self) -> bool {
        conflicts_with_option(self.cc, other.cc)
            || conflicts_with_option(self.receiver, other.receiver)
            || conflicts_with_option(
                self.receiver_name.as_ref(),
                other.receiver_name.as_ref(),
            )
            || conflicts_with_option(
                self.receiver_group,
                other.receiver_group,
            )
            || conflicts_with_option(
                self.receiver_group_name.as_ref(),
                other.receiver_group_name.as_ref(),
            )
            || conflicts_with_option(self.id, other.id)
            || conflicts_with_option(
                self.id_name.as_ref(),
                other.id_name.as_ref(),
            )
    }

    fn merge_from(&mut self, other: Self) {
        merge_option(&mut self.cc, other.cc);
        merge_option(&mut self.receiver, other.receiver);
        merge_option(&mut self.receiver_name, other.receiver_name);
        merge_option(&mut self.receiver_group, other.receiver_group);
        merge_option(
            &mut self.receiver_group_name,
            other.receiver_group_name,
        );
        merge_option(&mut self.id, other.id);
        merge_option(&mut self.id_name, other.id_name);
    }

    fn into_public(self) -> InboxMetadata {
        let (cg, cg_name) = if self.receiver_group.is_some()
            || self.receiver_group_name.is_some()
        {
            (self.receiver_group, self.receiver_group_name)
        } else {
            (self.receiver, self.receiver_name)
        };

        InboxMetadata {
            cc: self.cc,
            cg,
            cg_name,
            id: self.id,
            id_name: self.id_name,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CgKind {
    Receiver,
    ReceiverGroup,
}

pub fn parse_metadata(message: &str) -> Vec<InboxMetadata> {
    let mut result = vec![];
    let mut current = WorkingMetadata::default();
    let mut last_cg_kind = None;
    let lines = message.lines().collect::<Vec<&str>>();
    for line in lines {
        let line = normalize_metadata_digits(&line.trim().to_uppercase());

        for line_metadata in parse_metadata_line(&line) {
            if !line_metadata.has_some_value() {
                continue;
            }

            if last_cg_kind == Some(CgKind::Receiver)
                && line_metadata.cg_kind() == Some(CgKind::ReceiverGroup)
            {
                current.receiver = None;
                current.receiver_name = None;
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
    }

    push_metadata_if_nonempty(&mut result, current);
    let result = result
        .into_iter()
        .map(WorkingMetadata::into_public)
        .filter(InboxMetadata::has_some_value)
        .collect();
    reduce_metadata_list(result)
}

fn parse_color_code(line: &str) -> Option<i64> {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"[cCсС]{2}\s*:\s*(\d+)"#).unwrap();
    }
    parse_i64_from_regexes(line, &[&RE_CC])
}

fn parse_receiver(line: &str) -> Option<i64> {
    lazy_static! {
        static ref RE_CG2: Regex = Regex::new(r#"⬅️\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CG_WITH_ID_PREFIX: Regex =
            Regex::new(r#"[іІiI]D\([cCсС]G\)\s*:\s*(\d+)"#).unwrap();
    }
    parse_i64_from_regexes(line, &[&RE_CG_WITH_ID_PREFIX, &RE_CG2])
}

fn parse_receiver_name(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_CG2: Regex =
            Regex::new(r#"⬅️\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CG_WITH_ID_PREFIX: Regex =
            Regex::new(r#"[іІiI]D\([cCсС]G\)\s*:\s*(\d+)\s*\(([^)]+)\)"#)
                .unwrap();
    }
    parse_string_from_regexes(line, &[&RE_CG_WITH_ID_PREFIX, &RE_CG2], 2)
}

fn parse_receiver_group(line: &str) -> Option<i64> {
    lazy_static! {
        static ref RE_CG: Regex = Regex::new(r#"[cCсС]G\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_CGX: Regex =
            Regex::new(r#"[cCсС]G\s*:[xXхХ]\s*:\s*(\d+)"#).unwrap();
    }
    parse_i64_from_regexes(line, &[&RE_CG, &RE_CGX])
}

fn parse_receiver_group_name(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_CG: Regex =
            Regex::new(r#"[cCсС]G\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    parse_string_from_regexes(line, &[&RE_CG], 2)
}

fn parse_mid(line: &str) -> Option<i64> {
    lazy_static! {
        static ref RE_CG: Regex = Regex::new(r#"➡️\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex = Regex::new(r#"[іІiI]D\s*:\s*(\d+)"#).unwrap();
    }
    parse_i64_from_regexes(line, &[&RE_ID, &RE_CG])
}

fn parse_mid_id(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_CG: Regex =
            Regex::new(r#"➡️\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex =
            Regex::new(r#"[іІiI]D\s*:\s*(\d+)\s*\(([^)]+)\)"#).unwrap();
    }
    parse_string_from_regexes(line, &[&RE_ID, &RE_CG], 2)
}

fn parse_i64_from_regexes(line: &str, regexes: &[&Regex]) -> Option<i64> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            if let Ok(value) = caps[1].parse() {
                return Some(value);
            }
        }
    }
    None
}

fn parse_string_from_regexes(
    line: &str,
    regexes: &[&Regex],
    group_idx: usize,
) -> Option<String> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            if let Some(value) = caps.get(group_idx) {
                return Some(value.as_str().to_string());
            }
        }
    }
    None
}

fn normalize_metadata_digits(line: &str) -> String {
    // fixes shit like 1️⃣   to 1
    lazy_static! {
        static ref RE: Regex = Regex::new(r"(\d)\u{FE0F}\u{20E3}").unwrap();
    }
    RE.replace_all(line, "$1").into_owned()
}

fn parse_metadata_line(line: &str) -> Vec<WorkingMetadata> {
    let mut result = vec![WorkingMetadata {
        cc: parse_color_code(line),
        id: parse_mid(line),
        id_name: parse_mid_id(line),
        ..Default::default()
    }];

    let mut cg_parts = parse_cg_parts(line);
    cg_parts.sort_by_key(|(start, _)| *start);
    result.extend(cg_parts.into_iter().map(|(_, metadata)| metadata));

    result
}

fn parse_cg_parts(line: &str) -> Vec<(usize, WorkingMetadata)> {
    lazy_static! {
        static ref RE_RECEIVER_ARROW: Regex =
            Regex::new(r#"⬅️\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_ID: Regex =
            Regex::new(r#"[іІiI]D\([cCсС]G\)\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP: Regex =
            Regex::new(r#"[cCсС]G\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_X: Regex = Regex::new(
            r#"[cCсС]G\s*:[xXхХ]\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#
        )
        .unwrap();
    }

    let mut parts = vec![];

    for regex in [
        &*RE_RECEIVER_ARROW as &Regex,
        &*RE_RECEIVER_ID as &Regex,
    ] {
        for caps in regex.captures_iter(line) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Ok(receiver) = value.as_str().parse() else {
                continue;
            };
            let receiver_name = caps.get(2).map(|name| name.as_str().to_string());
            parts.push((
                value.start(),
                WorkingMetadata {
                    receiver: Some(receiver),
                    receiver_name,
                    ..Default::default()
                },
            ));
        }
    }

    for regex in [
        &*RE_RECEIVER_GROUP as &Regex,
        &*RE_RECEIVER_GROUP_X as &Regex,
    ] {
        for caps in regex.captures_iter(line) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Ok(receiver_group) = value.as_str().parse() else {
                continue;
            };
            let receiver_group_name =
                caps.get(2).map(|name| name.as_str().to_string());
            parts.push((
                value.start(),
                WorkingMetadata {
                    receiver_group: Some(receiver_group),
                    receiver_group_name,
                    ..Default::default()
                },
            ));
        }
    }

    parts
}

impl WorkingMetadata {
    fn cg_kind(&self) -> Option<CgKind> {
        if self.receiver_group.is_some() || self.receiver_group_name.is_some() {
            return Some(CgKind::ReceiverGroup);
        }

        if self.receiver.is_some() || self.receiver_name.is_some() {
            return Some(CgKind::Receiver);
        }

        None
    }
}

fn push_metadata_if_nonempty(
    result: &mut Vec<WorkingMetadata>,
    metadata: WorkingMetadata,
) {
    if metadata.has_some_value() {
        result.push(metadata);
    }
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

fn conflicts_with_option<T: PartialEq>(
    left: Option<T>,
    right: Option<T>,
) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left != right)
}

fn merge_option<T>(left: &mut Option<T>, right: Option<T>) {
    if left.is_none() {
        *left = right;
    }
}

fn matches_option<T: PartialEq>(left: Option<T>, right: Option<T>) -> bool {
    match left {
        Some(left) => right.is_some_and(|right| left == right),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Debug, Deserialize)]
    struct FixtureMessage {
        id: i64,
        content: String,
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits() {
        let metadata = parse_metadata("СС:1️⃣4️⃣\nCG:5️⃣0️⃣");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some(14),
                cg: Some(50),
                cg_name: None,
                id: None,
                id_name: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits2() {
        let metadata = parse_metadata(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
УКХ р/м вБпЛА 121 мсп 68 мсд 6 А 🆓 (ЛИМАН ПЕРШИЙ) СС:1️⃣ CG:5️⃣0️⃣
ID➡️:110(ЯРУС)
ID(CG)⬅️:50📣",
        );
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some(1),
                cg: Some(50),
                cg_name: None,
                id: Some(110),
                id_name: Some("ЯРУС".to_string()),
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_plain_id_variants_without_arrows() {
        let metadata = parse_metadata("СС:8\nІD:21152\nID(CG):395251");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some(8),
                cg: Some(395251),
                cg_name: None,
                id: Some(21152),
                id_name: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_double_cg_ocr_variant() {
        let metadata = parse_metadata("CG:10 CG:x:12112027");
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: None,
                    cg: Some(10),
                    cg_name: None,
                    id: None,
                    id_name: None,
                },
                InboxMetadata {
                    cc: None,
                    cg: Some(12112027),
                    cg_name: None,
                    id: None,
                    id_name: None,
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates() {
        let metadata = parse_metadata(
            "CC:1 CG:10
CC:2 CG:20
CC:1 CG:10",
        );

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some(1),
            cg: Some(10),
            cg_name: None,
            id: None,
            id_name: None,
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some(2),
            cg: Some(20),
            cg_name: None,
            id: None,
            id_name: None,
        }));
    }

    #[test]
    fn parse_metadata_prefers_receiver_group_over_receiver() {
        let metadata = parse_metadata(
            "ID(CG):50
CG:12112027",
        );

        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: None,
                cg: Some(12112027),
                cg_name: None,
                id: None,
                id_name: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates2() {
        let metadata = parse_metadata(
            "CC:1 CG:10
CC:1 CG:10
CC:2 CG:20",
        );

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some(1),
            cg: Some(10),
            cg_name: None,
            id: None,
            id_name: None,
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some(2),
            cg: Some(20),
            cg_name: None,
            id: None,
            id_name: None,
        }));
    }

    #[test]
    fn parse_metadata_extracts_some_value_from_fixture_messages() {
        let messages = load_fixture_messages();
        let missing_metadata = messages
            .into_iter()
            .filter(|message| message.id != 14677154)
            .filter_map(|message| {
                let metadata = parse_metadata(&message.content);
                (metadata.is_empty()
                    || metadata
                        .iter()
                        .any(|item| !metadata_has_some_value(item)))
                .then_some(message.id)
            })
            .collect::<Vec<_>>();

        assert!(
            missing_metadata.is_empty(),
            "messages without parsed metadata: {missing_metadata:?}"
        );
    }

    #[test]
    fn parse_metadata_keeps_known_blank_cc_fixture_message_empty() {
        let message = load_fixture_messages()
            .into_iter()
            .find(|message| message.id == 14677154)
            .expect("fixture message 14677154");

        assert!(parse_metadata(&message.content).is_empty());
    }

    fn load_fixture_messages() -> Vec<FixtureMessage> {
        let fixture_path = fixture_path();
        let fixture = fs::read_to_string(&fixture_path).unwrap_or_else(|err| {
            panic!("failed to read {fixture_path:?}: {err}")
        });
        fixture
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter(|line| line.trim() != "json_build_object")
            .map(parse_fixture_message)
            .collect()
    }

    fn parse_fixture_message(line: &str) -> FixtureMessage {
        let json = line
            .trim()
            .strip_prefix('"')
            .and_then(|line| line.strip_suffix('"'))
            .expect("quoted sql json row")
            .replace("\"\"", "\"");

        serde_json::from_str(&json)
            .unwrap_or_else(|err| panic!("failed to parse fixture row: {err}"))
    }

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../deploy/message_with_metadata.json")
    }

    fn metadata_has_some_value(metadata: &InboxMetadata) -> bool {
        metadata.cc.is_some()
            || metadata.cg.is_some()
            || metadata.cg_name.as_ref().is_some_and(|src| !src.is_empty())
            || metadata.id.is_some()
            || metadata
                .id_name
                .as_ref()
                .is_some_and(|dest| !dest.is_empty())
    }
}
