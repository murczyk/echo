use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use chrono::{NaiveDateTime, Utc};
use futures_util::TryStreamExt;
use indicatif::ProgressBar;
use lazy_static::lazy_static;
use regex::{Match, Regex};
use sea_orm::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboxMetadata {
    pub cc: Option<String>,
    pub cc_start_index: Option<i32>,
    pub cc_end_index: Option<i32>,
    pub cg: Option<String>,
    pub cg_start_index: Option<i32>,
    pub cg_end_index: Option<i32>,
    pub cg_name: Option<String>,
    pub cg_name_start_index: Option<i32>,
    pub cg_name_end_index: Option<i32>,
    pub id: Option<String>,
    pub id_start_index: Option<i32>,
    pub id_end_index: Option<i32>,
    pub id_name: Option<String>,
    pub id_name_start_index: Option<i32>,
    pub id_name_end_index: Option<i32>,
    pub hash_id: Option<String>,
    pub hash_id_start_index: Option<i32>,
    pub hash_id_end_index: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CgKind {
    Receiver,
    ReceiverGroup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceSpan {
    start_index: i32,
    end_index: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MatchedValue {
    value: Option<String>,
    start_index: Option<i32>,
    end_index: Option<i32>,
    raw_text: Option<String>,
}

impl MatchedValue {
    fn has_value(&self) -> bool {
        self.value.as_ref().is_some_and(|value| !value.is_empty())
    }

    fn conflicts_with(&self, other: &Self) -> bool {
        conflicts_with_option(self.value.as_ref(), other.value.as_ref())
    }

    fn merge_from(&mut self, other: Self) {
        if self.value.is_none() {
            *self = other;
        }
    }

    fn into_parts(self) -> (Option<String>, Option<i32>, Option<i32>) {
        (self.value, self.start_index, self.end_index)
    }

    fn lowercase_value(mut self) -> Self {
        self.value = self.value.map(|value| value.to_lowercase());
        self
    }
}

#[derive(Clone, Debug)]
struct NormalizedLine {
    text: String,
    raw_text: String,
    source_spans: Vec<SourceSpan>,
}

impl NormalizedLine {
    fn new(raw_text: String) -> Self {
        let chars = raw_text.chars().collect::<Vec<_>>();
        let mut text = String::new();
        let mut source_spans = vec![];
        let mut idx = 0_usize;
        while idx < chars.len() {
            if let Some((digit, consumed)) = keycap_digit_at(&chars, idx) {
                text.push(digit);
                source_spans.push(SourceSpan {
                    start_index: idx as i32,
                    end_index: (idx + consumed - 1) as i32,
                });
                idx += consumed;
                continue;
            }

            text.push(chars[idx]);
            source_spans.push(SourceSpan {
                start_index: idx as i32,
                end_index: idx as i32,
            });
            idx += 1;
        }

        Self {
            text,
            raw_text,
            source_spans,
        }
    }

    fn standalone_prefix(&self, match_start: usize) -> bool {
        match self.text[..match_start]
            .chars()
            .rev()
            .find(|ch| !ch.is_whitespace())
        {
            None => true,
            Some(ch) => !ch.is_alphanumeric() && ch != '_',
        }
    }

    fn has_forbidden_suffix(&self, match_end: usize) -> bool {
        self.text[match_end..]
            .chars()
            .next()
            .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
    }

    fn to_char_index(&self, byte_index: usize) -> usize {
        self.text[..byte_index].chars().count()
    }

    fn slice_raw_chars(&self, start: usize, end_exclusive: usize) -> String {
        self.raw_text
            .chars()
            .skip(start)
            .take(end_exclusive - start)
            .collect()
    }

    fn build_value<F>(
        &self,
        value_match: Match<'_>,
        normalize_value: F,
    ) -> Option<MatchedValue>
    where
        F: FnOnce(&str) -> Option<String>,
    {
        let start_char = self.to_char_index(value_match.start());
        let end_char = self.to_char_index(value_match.end());
        if start_char >= end_char || end_char > self.source_spans.len() {
            return None;
        }

        let value = normalize_value(value_match.as_str())?;
        let source_start = self.source_spans[start_char].start_index;
        let source_end = self.source_spans[end_char - 1].end_index;
        let raw_text = self
            .slice_raw_chars(source_start as usize, source_end as usize + 1);

        Some(MatchedValue {
            value: Some(value),
            start_index: Some(source_start),
            end_index: Some(source_end),
            raw_text: Some(raw_text),
        })
    }
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
    cc: MatchedValue,
    receiver: MatchedValue,
    receiver_name: MatchedValue,
    receiver_group: MatchedValue,
    receiver_group_name: MatchedValue,
    id: MatchedValue,
    id_name: MatchedValue,
    hash_id: MatchedValue,
}

impl WorkingMetadata {
    fn has_some_value(&self) -> bool {
        self.cc.has_value()
            || self.receiver.has_value()
            || self.receiver_name.has_value()
            || self.receiver_group.has_value()
            || self.receiver_group_name.has_value()
            || self.id.has_value()
            || self.id_name.has_value()
            || self.hash_id.has_value()
    }

    fn conflicts_with(&self, other: &Self) -> bool {
        self.cc.conflicts_with(&other.cc)
            || self.receiver.conflicts_with(&other.receiver)
            || self.receiver_name.conflicts_with(&other.receiver_name)
            || self.receiver_group.conflicts_with(&other.receiver_group)
            || self
                .receiver_group_name
                .conflicts_with(&other.receiver_group_name)
            || self.id.conflicts_with(&other.id)
            || self.id_name.conflicts_with(&other.id_name)
            || self.hash_id.conflicts_with(&other.hash_id)
    }

    fn merge_from(&mut self, other: Self) {
        self.cc.merge_from(other.cc);
        self.receiver.merge_from(other.receiver);
        self.receiver_name.merge_from(other.receiver_name);
        self.receiver_group.merge_from(other.receiver_group);
        self.receiver_group_name
            .merge_from(other.receiver_group_name);
        self.id.merge_from(other.id);
        self.id_name.merge_from(other.id_name);
        self.hash_id.merge_from(other.hash_id);
    }

    fn into_public(self) -> InboxMetadata {
        let (
            cg,
            cg_start_index,
            cg_end_index,
            cg_name,
            cg_name_start_index,
            cg_name_end_index,
        ) = if self.receiver_group.has_value()
            || self.receiver_group_name.has_value()
        {
            let (cg, cg_start_index, cg_end_index) =
                self.receiver_group.into_parts();
            let (cg_name, cg_name_start_index, cg_name_end_index) =
                self.receiver_group_name.into_parts();
            (
                cg,
                cg_start_index,
                cg_end_index,
                cg_name,
                cg_name_start_index,
                cg_name_end_index,
            )
        } else {
            let (cg, cg_start_index, cg_end_index) = self.receiver.into_parts();
            let (cg_name, cg_name_start_index, cg_name_end_index) =
                self.receiver_name.into_parts();
            (
                cg,
                cg_start_index,
                cg_end_index,
                cg_name,
                cg_name_start_index,
                cg_name_end_index,
            )
        };

        let (cc, cc_start_index, cc_end_index) = self.cc.into_parts();
        let (id, id_start_index, id_end_index) = self.id.into_parts();
        let (id_name, id_name_start_index, id_name_end_index) =
            self.id_name.into_parts();
        let (hash_id, hash_id_start_index, hash_id_end_index) =
            self.hash_id.into_parts();

        InboxMetadata {
            cc,
            cc_start_index,
            cc_end_index,
            cg,
            cg_start_index,
            cg_end_index,
            cg_name,
            cg_name_start_index,
            cg_name_end_index,
            id,
            id_start_index,
            id_end_index,
            id_name,
            id_name_start_index,
            id_name_end_index,
            hash_id,
            hash_id_start_index,
            hash_id_end_index,
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
            color_code_start_index: Set(e.cc_start_index),
            color_code_end_index: Set(e.cc_end_index),
            call_group_id: Set(e.cg),
            call_group_id_start_index: Set(e.cg_start_index),
            call_group_id_end_index: Set(e.cg_end_index),
            call_group_name: Set(e.cg_name),
            call_group_name_start_index: Set(e.cg_name_start_index),
            call_group_name_end_index: Set(e.cg_name_end_index),
            sender_id: Set(e.id),
            sender_id_start_index: Set(e.id_start_index),
            sender_id_end_index: Set(e.id_end_index),
            sender_name: Set(e.id_name),
            sender_name_start_index: Set(e.id_name_start_index),
            sender_name_end_index: Set(e.id_name_end_index),
            hash_id: Set(e.hash_id),
            hash_id_start_index: Set(e.hash_id_start_index),
            hash_id_end_index: Set(e.hash_id_end_index),
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

fn parse_color_code(line: &NormalizedLine) -> Option<MatchedValue> {
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

fn parse_mid(line: &NormalizedLine) -> Option<MatchedValue> {
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

fn parse_mid_id(line: &NormalizedLine) -> Option<MatchedValue> {
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

fn parse_value_from_regexes(
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

fn parse_numeric_value_from_regexes(
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

fn parse_numeric_value_from_standalone_regexes(
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

fn parse_string_from_regexes(
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

fn parse_string_from_standalone_regexes(
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

fn parse_hash_id(line: &NormalizedLine) -> Option<MatchedValue> {
    lazy_static! {
        static ref RE_HASH_ID: Regex =
            Regex::new(r#"(?i)ХЕШ\s+[іІiI][dD]\s*:\s*([0-9a-f]+)"#).unwrap();
    }
    parse_value_from_regexes(line, &[&RE_HASH_ID])
        .map(MatchedValue::lowercase_value)
}

fn parse_metadata_line(line: &NormalizedLine) -> Vec<WorkingMetadata> {
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

fn parse_cg_parts(line: &NormalizedLine) -> Vec<(usize, WorkingMetadata)> {
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
            Regex::new(r#"(?i)GROUP\s+ID\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
                .unwrap();
    }
    lazy_static! {
        static ref RE_RECEIVER_GROUP_X: Regex =
            Regex::new(r#"[cCсС]G\s*:[xXхХ]\s*:\s*(\d+)(?:\s*\(([^)]+)\))?"#)
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

impl WorkingMetadata {
    fn cg_kind(&self) -> Option<CgKind> {
        if self.receiver_group.has_value()
            || self.receiver_group_name.has_value()
        {
            return Some(CgKind::ReceiverGroup);
        }

        if self.receiver.has_value() || self.receiver_name.has_value() {
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

fn expand_multi_source_ids(
    items: Vec<WorkingMetadata>,
) -> Vec<WorkingMetadata> {
    let mut result = vec![];
    for item in items {
        let Some(ids) = split_multi_source_id(&item.id) else {
            result.push(item);
            continue;
        };

        for id in ids {
            let mut item = item.clone();
            item.id = id;
            result.push(item);
        }
    }
    result
}

fn split_multi_source_id(id: &MatchedValue) -> Option<Vec<MatchedValue>> {
    let raw_text = id.raw_text.as_ref()?;
    let start_index = id.start_index?;
    if !raw_text.contains(',') {
        return None;
    }

    let chars = raw_text.chars().collect::<Vec<_>>();
    let mut ids = vec![];
    let mut part_start = 0_usize;
    for idx in 0..=chars.len() {
        if idx < chars.len() && chars[idx] != ',' {
            continue;
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
            let raw_part =
                chars[trimmed_start..trimmed_end].iter().collect::<String>();
            let normalized_part = normalize_metadata_digits(&raw_part);
            let value = normalize_metadata_value(&normalized_part)?;
            ids.push(MatchedValue {
                value: Some(value),
                start_index: Some(start_index + trimmed_start as i32),
                end_index: Some(start_index + trimmed_end as i32 - 1),
                raw_text: Some(raw_part),
            });
        }
        part_start = idx + 1;
    }

    if ids.len() <= 1
        || ids.iter().any(|id| {
            id.value.as_ref().is_none_or(|value| {
                !value.chars().all(|ch| ch.is_ascii_digit())
            })
        })
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
}

fn keycap_digit_at(chars: &[char], idx: usize) -> Option<(char, usize)> {
    let digit = *chars.get(idx)?;
    if !digit.is_ascii_digit() {
        return None;
    }

    let variation_selector = chars.get(idx + 1).copied();
    let combining_keycap = chars.get(idx + 2).copied();
    if variation_selector == Some('\u{FE0F}')
        && combining_keycap == Some('\u{20E3}')
    {
        return Some((digit, 3));
    }

    None
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
        let metadata =
            metadata_without_spans(parse_metadata("СС:1️⃣4️⃣\nCG:5️⃣0️⃣"));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("14".to_string()),
                cg: Some("50".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits2() {
        let metadata = metadata_without_spans(parse_metadata(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
УКХ р/м вБпЛА 121 мсп 68 мсд 6 А 🆓 (ЛИМАН ПЕРШИЙ) СС:1️⃣ CG:5️⃣0️⃣
ID➡️:110(ЯРУС)
ID(CG)⬅️:50📣",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("1".to_string()),
                cg: Some("50".to_string()),
                id: Some("110".to_string()),
                id_name: Some("ЯРУС".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_plain_id_variants_without_arrows() {
        let metadata = metadata_without_spans(parse_metadata(
            "СС:8\nІD:21152\nID(CG):395251",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("8".to_string()),
                cg: Some("395251".to_string()),
                id: Some("21152".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_textual_id_after_colon_before_semicolon() {
        let metadata = metadata_without_spans(parse_metadata(" Id:96МГ1_1; "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                id_name: Some("96МГ1_1".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_hash_id_with_prefix() {
        let metadata =
            metadata_without_spans(parse_metadata(" Хеш ID: 2324d327 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                hash_id: Some("2324d327".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_hash_id_with_prefix() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("ХЕШ ID: 2324D327".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                hash_id: matched_value("2324d327"),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_source_id_variant() {
        let metadata = metadata_without_spans(parse_metadata(" source id: 0 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                id: Some("0".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_multiple_source_ids_variant() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:23 SOURCE ID: 1, 33; GROUP ID: 6",
        ));
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    id: Some("1".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    id: Some("33".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_line_handles_source_id_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("SOURCE ID: 0".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                id: matched_value("0"),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_multiple_source_ids_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new(
                "CC:23 SOURCE ID: 1, 33; GROUP ID: 6".to_string(),
            ),
        ));
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata {
                    cc: matched_value("23"),
                    id: matched_value("1, 33"),
                    ..Default::default()
                },
                WorkingMetadata {
                    receiver_group: matched_value("6"),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_group_id_variant() {
        let metadata = metadata_without_spans(parse_metadata(" group id: 0 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cg: Some("0".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_group_id_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("GROUP ID: 0".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata::default(),
                WorkingMetadata {
                    receiver_group: matched_value("0"),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_double_cg_ocr_variant() {
        let metadata =
            metadata_without_spans(parse_metadata("CG:10 CG:x:12112027"));
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cg: Some("10".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cg: Some("x:12112027".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_receiver_group_x_from_fixture_message() {
        let message = load_fixture_message(14627919);

        assert_eq!(
            metadata_without_spans(parse_metadata(&message.content)),
            vec![
                InboxMetadata {
                    cg: Some("10".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cg: Some("x:12112027".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:1 CG:10
CC:2 CG:20
CC:1 CG:10",
        ));

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            ..Default::default()
        }));
    }

    #[test]
    fn parse_metadata_prefers_receiver_group_over_receiver() {
        let metadata = metadata_without_spans(parse_metadata(
            "ID(CG):50
CG:12112027",
        ));

        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cg: Some("12112027".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates2() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:1 CG:10
CC:1 CG:10
CC:2 CG:20",
        ));

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            ..Default::default()
        }));
    }

    #[test]
    fn parse_metadata_tracks_global_inclusive_spans() {
        let metadata = parse_metadata("hello cc 545\nID:99");

        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("545".to_string()),
                cc_start_index: Some(9),
                cc_end_index: Some(11),
                id: Some("99".to_string()),
                id_start_index: Some(16),
                id_end_index: Some(17),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_tracks_spans_for_split_source_ids() {
        let metadata = parse_metadata("CC:23 SOURCE ID: 1, 33; GROUP ID: 6");

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("23".to_string()),
            cc_start_index: Some(3),
            cc_end_index: Some(4),
            cg: Some("6".to_string()),
            cg_start_index: Some(34),
            cg_end_index: Some(34),
            id: Some("1".to_string()),
            id_start_index: Some(17),
            id_end_index: Some(17),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("23".to_string()),
            cc_start_index: Some(3),
            cc_end_index: Some(4),
            cg: Some("6".to_string()),
            cg_start_index: Some(34),
            cg_end_index: Some(34),
            id: Some("33".to_string()),
            id_start_index: Some(20),
            id_end_index: Some(21),
            ..Default::default()
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

    fn matched_value(value: &str) -> MatchedValue {
        MatchedValue {
            value: Some(value.to_string()),
            ..Default::default()
        }
    }

    fn metadata_without_spans(items: Vec<InboxMetadata>) -> Vec<InboxMetadata> {
        items
            .into_iter()
            .map(|mut item| {
                item.cc_start_index = None;
                item.cc_end_index = None;
                item.cg_start_index = None;
                item.cg_end_index = None;
                item.cg_name_start_index = None;
                item.cg_name_end_index = None;
                item.id_start_index = None;
                item.id_end_index = None;
                item.id_name_start_index = None;
                item.id_name_end_index = None;
                item.hash_id_start_index = None;
                item.hash_id_end_index = None;
                item
            })
            .collect()
    }

    fn working_metadata_without_spans(
        items: Vec<WorkingMetadata>,
    ) -> Vec<WorkingMetadata> {
        items
            .into_iter()
            .map(clear_working_metadata_spans)
            .collect()
    }

    fn clear_working_metadata_spans(
        mut metadata: WorkingMetadata,
    ) -> WorkingMetadata {
        clear_matched_value_spans(&mut metadata.cc);
        clear_matched_value_spans(&mut metadata.receiver);
        clear_matched_value_spans(&mut metadata.receiver_name);
        clear_matched_value_spans(&mut metadata.receiver_group);
        clear_matched_value_spans(&mut metadata.receiver_group_name);
        clear_matched_value_spans(&mut metadata.id);
        clear_matched_value_spans(&mut metadata.id_name);
        clear_matched_value_spans(&mut metadata.hash_id);
        metadata
    }

    fn clear_matched_value_spans(value: &mut MatchedValue) {
        value.start_index = None;
        value.end_index = None;
        value.raw_text = None;
    }
}
