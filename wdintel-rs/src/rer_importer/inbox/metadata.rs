use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use chrono::{NaiveDateTime, Utc};
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use lazy_static::lazy_static;
use regex::Regex;
use sea_orm::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboxMetadata {
    pub cc: Option<String>,
    pub cg: Option<String>,
    pub cg_name: Option<String>,
    pub id: Option<String>,
    pub id_name: Option<String>,
    pub hash_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CgKind {
    Receiver,
    ReceiverGroup,
}

impl InboxMetadata {
    fn has_some_value(&self) -> bool {
        self.cc.is_some()
            || self.cg.is_some()
            || self.cg_name.as_ref().is_some_and(|value| !value.is_empty())
            || self.id.is_some()
            || self.id_name.as_ref().is_some_and(|value| !value.is_empty())
            || self.hash_id.is_some()
    }

    fn matches(&self, other: &Self) -> bool {
        self.has_some_value()
            && matches_option(self.cc.as_ref(), other.cc.as_ref())
            && matches_option(self.cg.as_ref(), other.cg.as_ref())
            && matches_option(self.cg_name.as_ref(), other.cg_name.as_ref())
            && matches_option(self.id.as_ref(), other.id.as_ref())
            && matches_option(self.id_name.as_ref(), other.id_name.as_ref())
            && matches_option(self.hash_id.as_ref(), other.hash_id.as_ref())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct WorkingMetadata {
    cc: Option<String>,
    receiver: Option<String>,
    receiver_name: Option<String>,
    receiver_group: Option<String>,
    receiver_group_name: Option<String>,
    id: Option<String>,
    id_name: Option<String>,
    hash_id: Option<String>,
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
            || self.hash_id.is_some()
    }

    fn conflicts_with(&self, other: &Self) -> bool {
        conflicts_with_option(self.cc.as_ref(), other.cc.as_ref())
            || conflicts_with_option(
                self.receiver.as_ref(),
                other.receiver.as_ref(),
            )
            || conflicts_with_option(
                self.receiver_name.as_ref(),
                other.receiver_name.as_ref(),
            )
            || conflicts_with_option(
                self.receiver_group.as_ref(),
                other.receiver_group.as_ref(),
            )
            || conflicts_with_option(
                self.receiver_group_name.as_ref(),
                other.receiver_group_name.as_ref(),
            )
            || conflicts_with_option(self.id.as_ref(), other.id.as_ref())
            || conflicts_with_option(
                self.id_name.as_ref(),
                other.id_name.as_ref(),
            )
            || conflicts_with_option(
                self.hash_id.as_ref(),
                other.hash_id.as_ref(),
            )
    }

    fn merge_from(&mut self, other: Self) {
        merge_option(&mut self.cc, other.cc);
        merge_option(&mut self.receiver, other.receiver);
        merge_option(&mut self.receiver_name, other.receiver_name);
        merge_option(&mut self.receiver_group, other.receiver_group);
        merge_option(&mut self.receiver_group_name, other.receiver_group_name);
        merge_option(&mut self.id, other.id);
        merge_option(&mut self.id_name, other.id_name);
        merge_option(&mut self.hash_id, other.hash_id);
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
            hash_id: self.hash_id,
        }
    }
}

pub async fn refresh_metadata_for_body<'a, 'async_trait, C>(
    sigint_inbox_item_id: i64,
    body: &str,
    txn: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    sigint_inbox_item_metadata::Entity::delete_many()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    let entries = parse_metadata(body);
    let mut new_entries = vec![];
    for e in entries {
        new_entries.push(sigint_inbox_item_metadata::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            color_code: Set(e.cc),
            call_group_id: Set(e.cg),
            call_group_name: Set(e.cg_name),
            sender_id: Set(e.id),
            sender_name: Set(e.id_name),
            hash_id: Set(e.hash_id),
            created_at: NotSet,
        });
    }
    if new_entries.is_empty() {
        return Ok(());
    }
    sigint_inbox_item_metadata::Entity::insert_many(new_entries)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn refresh_metadata<'a, 'async_trait, C>(
    sigint_inbox_item_id: i64,
    txn: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let body = signal_message::Entity::find_by_id(sigint_inbox_item_id)
        .select_only()
        .column(signal_message::Column::Body)
        .into_tuple::<String>()
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    refresh_metadata_for_body(sigint_inbox_item_id, &body, txn).await
}

#[derive(FromQueryResult)]
struct InboxMetadataRecalcRow {
    id: i64,
}

pub async fn oneoff_reprocess_inbox_metadata(
    mode: Mode,
    ps: &crate::OneoffReprocessInboxMetadataPs,
) -> Result<(), AppError> {
    println!("> oneoff_reprocess_inbox_metadata {ps:?}");
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut since_ts = parse_optional_ts(ps.since_ts.as_deref()).c(h!())?;
    let mut till_ts = parse_optional_ts(ps.till_ts.as_deref()).c(h!())?;
    if since_ts.is_none() && till_ts.is_none() {
        till_ts = Some(Utc::now().naive_utc());
        since_ts = Some(
            till_ts.c(h!())?
                - chrono::Duration::days(
                    crate::config::ONEOFF_REPROCESS_INBOX_METADATA_DEFAULT_DAYS,
                ),
        );
    }
    let q = build_inbox_metadata_recalc_query(since_ts, till_ts);
    let count = q.clone().count(&dbx).await.c(h!())?;
    let mut rows = q
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .into_model::<InboxMetadataRecalcRow>()
        .stream(&dbx)
        .await
        .c(h!())?;
    let pb = ProgressBar::new(count);
    let mut processed = 0_u64;
    while let Some(row) = rows.try_next().await.c(h!())? {
        pb.inc(1);
        refresh_metadata(row.id, &dbx).await.c(h!())?;
        processed += 1;
    }
    println!("> done oneoff_reprocess_inbox_metadata: processed={processed}");
    Ok(())
}

fn build_inbox_metadata_recalc_query(
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> Select<sigint_inbox_item::Entity> {
    let mut q = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Body.is_not_null())
        .order_by_asc(sigint_inbox_item::Column::Id);
    if let Some(since_ts) = since_ts {
        q = q.filter(sigint_inbox_item::Column::Datetime.gte(since_ts));
    }
    if let Some(till_ts) = till_ts {
        q = q.filter(sigint_inbox_item::Column::Datetime.lt(till_ts));
    }
    q
}

fn parse_optional_ts(
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
    reduce_metadata_list(expand_multi_source_ids(result))
}

fn parse_color_code(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_CC: Regex =
            Regex::new(r#"[cCсС]{2}\s*:\s*(\d+)"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_CC])
}

fn parse_mid(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_CG: Regex = Regex::new(r#"➡️\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_ID: Regex = Regex::new(r#"[іІiI]D\s*:\s*(\d+)"#).unwrap();
    }
    lazy_static! {
        static ref RE_SOURCE_ID: Regex =
            Regex::new(r#"SOURCE\s+ID\s*:\s*([\d,\s]+)"#).unwrap();
    }
    parse_numeric_value_from_standalone_regexes(line, &[&RE_ID]).or_else(|| {
        parse_numeric_value_from_regexes(line, &[&RE_CG, &RE_SOURCE_ID])
    })
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
    lazy_static! {
        static ref RE_ID_TEXT: Regex =
            Regex::new(r#"[іІiI]D\s*:\s*([^;]+)\s*;"#).unwrap();
    }
    parse_string_from_standalone_regexes(line, &[&RE_ID], 2)
        .or_else(|| parse_string_from_regexes(line, &[&RE_CG], 2))
        .or_else(|| {
            parse_string_from_standalone_regexes(line, &[&RE_ID_TEXT], 1)
        })
}

fn parse_value_from_regexes(line: &str, regexes: &[&Regex]) -> Option<String> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            if let Some(value) = caps.get(1) {
                if let Some(value) = normalize_metadata_value(value.as_str()) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_numeric_value_from_regexes(
    line: &str,
    regexes: &[&Regex],
) -> Option<String> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            if let Some(value) = caps.get(1) {
                let has_forbidden_suffix = line[value.end()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphanumeric() || ch == '_');
                if has_forbidden_suffix {
                    continue;
                }
                if let Some(value) = normalize_metadata_value(value.as_str()) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_numeric_value_from_standalone_regexes(
    line: &str,
    regexes: &[&Regex],
) -> Option<String> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            let Some(full_match) = caps.get(0) else {
                continue;
            };
            if !has_standalone_prefix(line, full_match.start()) {
                continue;
            }
            if let Some(value) = caps.get(1) {
                let has_forbidden_suffix = line[value.end()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphanumeric() || ch == '_');
                if has_forbidden_suffix {
                    continue;
                }
                if let Some(value) = normalize_metadata_value(value.as_str()) {
                    return Some(value);
                }
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
                if let Some(value) = normalize_metadata_value(value.as_str()) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_string_from_standalone_regexes(
    line: &str,
    regexes: &[&Regex],
    group_idx: usize,
) -> Option<String> {
    for regex in regexes {
        if let Some(caps) = regex.captures(line) {
            let Some(full_match) = caps.get(0) else {
                continue;
            };
            if !has_standalone_prefix(line, full_match.start()) {
                continue;
            }
            if let Some(value) = caps.get(group_idx) {
                if let Some(value) = normalize_metadata_value(value.as_str()) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn has_standalone_prefix(line: &str, match_start: usize) -> bool {
    match line[..match_start]
        .chars()
        .rev()
        .find(|ch| !ch.is_whitespace())
    {
        None => true,
        Some(ch) => !ch.is_alphanumeric() && ch != '_',
    }
}

fn normalize_metadata_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_metadata_digits(line: &str) -> String {
    // fixes shit like 1️⃣   to 1
    lazy_static! {
        static ref RE: Regex = Regex::new(r"(\d)\u{FE0F}\u{20E3}").unwrap();
    }
    RE.replace_all(line, "$1").into_owned()
}

fn parse_hash_id(line: &str) -> Option<String> {
    lazy_static! {
        static ref RE_HASH_ID: Regex =
            Regex::new(r#"ХЕШ\s+[іІiI]D\s*:\s*([0-9A-F]+)"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_HASH_ID])
        .map(|hash_id| hash_id.to_lowercase())
}

fn parse_metadata_line(line: &str) -> Vec<WorkingMetadata> {
    let mut result = vec![WorkingMetadata {
        cc: parse_color_code(line),
        id: parse_mid(line),
        id_name: parse_mid_id(line),
        hash_id: parse_hash_id(line),
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
        static ref RE_RECEIVER_GROUP_EN: Regex =
            Regex::new(r#"GROUP\s+ID\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#).unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_X: Regex =
            Regex::new(r#"[cCсС]G\s*:[xXхХ]\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }

    let mut parts = vec![];

    for regex in [&*RE_RECEIVER_ARROW as &Regex, &*RE_RECEIVER_ID as &Regex] {
        for caps in regex.captures_iter(line) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Some(receiver) = normalize_metadata_value(value.as_str())
            else {
                continue;
            };
            let receiver_name = caps
                .get(2)
                .and_then(|name| normalize_metadata_value(name.as_str()));
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
        &*RE_RECEIVER_GROUP_EN as &Regex,
    ] {
        for caps in regex.captures_iter(line) {
            let Some(value) = caps.get(1) else {
                continue;
            };
            let Some(receiver_group) = normalize_metadata_value(value.as_str())
            else {
                continue;
            };
            let receiver_group_name = caps
                .get(2)
                .and_then(|name| normalize_metadata_value(name.as_str()));
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

    for caps in RE_RECEIVER_GROUP_X.captures_iter(line) {
        let Some(value) = caps.get(1) else {
            continue;
        };
        let receiver_group = format!("x:{}", value.as_str());
        let Some(receiver_group) =
            normalize_metadata_value(receiver_group.as_str())
        else {
            continue;
        };
        let receiver_group_name = caps
            .get(2)
            .and_then(|name| normalize_metadata_value(name.as_str()));
        parts.push((
            value.start(),
            WorkingMetadata {
                receiver_group: Some(receiver_group),
                receiver_group_name,
                ..Default::default()
            },
        ));
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

fn expand_multi_source_ids(items: Vec<InboxMetadata>) -> Vec<InboxMetadata> {
    let mut result = vec![];
    for item in items {
        let Some(ids) = split_multi_source_id(item.id.as_deref()) else {
            result.push(item);
            continue;
        };

        for id in ids {
            let mut item = item.clone();
            item.id = Some(id);
            result.push(item);
        }
    }
    result
}

fn split_multi_source_id(id: Option<&str>) -> Option<Vec<String>> {
    let id = id?;
    if !id.contains(',') {
        return None;
    }

    let ids = id
        .split(',')
        .filter_map(normalize_metadata_value)
        .collect::<Vec<_>>();
    if ids.len() <= 1
        || ids
            .iter()
            .any(|id| !id.chars().all(|ch| ch.is_ascii_digit()))
    {
        return None;
    }

    Some(ids)
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
    left: Option<&T>,
    right: Option<&T>,
) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left != right)
}

fn merge_option<T>(left: &mut Option<T>, right: Option<T>) {
    if left.is_none() {
        *left = right;
    }
}

fn matches_option<T: PartialEq>(left: Option<&T>, right: Option<&T>) -> bool {
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
                cc: Some("14".to_string()),
                cg: Some("50".to_string()),
                cg_name: None,
                id: None,
                id_name: None,
                hash_id: None,
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
                cc: Some("1".to_string()),
                cg: Some("50".to_string()),
                cg_name: None,
                id: Some("110".to_string()),
                id_name: Some("ЯРУС".to_string()),
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_plain_id_variants_without_arrows() {
        let metadata = parse_metadata("СС:8\nІD:21152\nID(CG):395251");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("8".to_string()),
                cg: Some("395251".to_string()),
                cg_name: None,
                id: Some("21152".to_string()),
                id_name: None,
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_textual_id_after_colon_before_semicolon() {
        let metadata = parse_metadata(" Id:96МГ1_1; ");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: None,
                cg: None,
                cg_name: None,
                id: None,
                id_name: Some("96МГ1_1".to_string()),
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_hash_id_with_prefix() {
        let metadata = parse_metadata(" Хеш ID: 2324d327 ");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: None,
                cg: None,
                cg_name: None,
                id: None,
                id_name: None,
                hash_id: Some("2324d327".to_string()),
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_hash_id_with_prefix() {
        let metadata = parse_metadata_line(" ХЕШ ID: 2324D327 ");
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                cc: None,
                receiver: None,
                receiver_name: None,
                receiver_group: None,
                receiver_group_name: None,
                id: None,
                id_name: None,
                hash_id: Some("2324d327".to_string()),
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_source_id_variant() {
        let metadata = parse_metadata(" source id: 0 ");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: None,
                cg: None,
                cg_name: None,
                id: Some("0".to_string()),
                id_name: None,
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_multiple_source_ids_variant() {
        let metadata = parse_metadata("CC:23 SOURCE ID: 1, 33; GROUP ID: 6");
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    cg_name: None,
                    id: Some("1".to_string()),
                    id_name: None,
                    hash_id: None,
                },
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    cg_name: None,
                    id: Some("33".to_string()),
                    id_name: None,
                    hash_id: None,
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_line_handles_source_id_variant() {
        let metadata = parse_metadata_line(" SOURCE ID: 0 ");
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                cc: None,
                receiver: None,
                receiver_name: None,
                receiver_group: None,
                receiver_group_name: None,
                id: Some("0".to_string()),
                id_name: None,
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_multiple_source_ids_variant() {
        let metadata =
            parse_metadata_line(" CC:23 SOURCE ID: 1, 33; GROUP ID: 6 ");
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata {
                    cc: Some("23".to_string()),
                    receiver: None,
                    receiver_name: None,
                    receiver_group: None,
                    receiver_group_name: None,
                    id: Some("1, 33".to_string()),
                    id_name: None,
                    hash_id: None,
                },
                WorkingMetadata {
                    cc: None,
                    receiver: None,
                    receiver_name: None,
                    receiver_group: Some("6".to_string()),
                    receiver_group_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_group_id_variant() {
        let metadata = parse_metadata(" group id: 0 ");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: None,
                cg: Some("0".to_string()),
                cg_name: None,
                id: None,
                id_name: None,
                hash_id: None,
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_group_id_variant() {
        let metadata = parse_metadata_line(" GROUP ID: 0 ");
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata {
                    cc: None,
                    receiver: None,
                    receiver_name: None,
                    receiver_group: None,
                    receiver_group_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                },
                WorkingMetadata {
                    cc: None,
                    receiver: None,
                    receiver_name: None,
                    receiver_group: Some("0".to_string()),
                    receiver_group_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                }
            ]
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
                    cg: Some("10".to_string()),
                    cg_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                },
                InboxMetadata {
                    cc: None,
                    cg: Some("x:12112027".to_string()),
                    cg_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_receiver_group_x_from_fixture_message() {
        let message = load_fixture_message(14627919);

        assert_eq!(
            parse_metadata(&message.content),
            vec![
                InboxMetadata {
                    cc: None,
                    cg: Some("10".to_string()),
                    cg_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
                },
                InboxMetadata {
                    cc: None,
                    cg: Some("x:12112027".to_string()),
                    cg_name: None,
                    id: None,
                    id_name: None,
                    hash_id: None,
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
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            cg_name: None,
            id: None,
            id_name: None,
            hash_id: None,
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            cg_name: None,
            id: None,
            id_name: None,
            hash_id: None,
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
                cg: Some("12112027".to_string()),
                cg_name: None,
                id: None,
                id_name: None,
                hash_id: None,
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
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            cg_name: None,
            id: None,
            id_name: None,
            hash_id: None,
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            cg_name: None,
            id: None,
            id_name: None,
            hash_id: None,
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

    fn load_fixture_message(id: i64) -> FixtureMessage {
        load_fixture_messages()
            .into_iter()
            .find(|message| message.id == id)
            .unwrap_or_else(|| panic!("fixture message {id}"))
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
            || metadata.hash_id.is_some()
    }
}
