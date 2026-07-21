use regex::Match;

#[derive(Clone, Debug)]
pub(crate) struct NormalizedLine {
    pub text: String,
    pub raw_text: String,
    pub source_spans: Vec<SourceSpan>,
}

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
pub(crate) struct SourceSpan {
    pub start_index: i32,
    pub end_index: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MatchedValue {
    pub value: Option<String>,
    pub start_index: Option<i32>,
    pub end_index: Option<i32>,
    pub raw_text: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CgKind {
    Receiver,
    ReceiverGroup,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorkingMetadata {
    pub cc: MatchedValue,
    pub additional_ccs: Vec<MatchedValue>,
    pub receiver: MatchedValue,
    pub receiver_name: MatchedValue,
    pub receiver_group: MatchedValue,
    pub receiver_group_name: MatchedValue,
    pub id: MatchedValue,
    pub id_name: MatchedValue,
    pub hash_id: MatchedValue,
}

impl NormalizedLine {
    pub(crate) fn new(raw_text: String) -> Self {
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

    pub(crate) fn standalone_prefix(&self, match_start: usize) -> bool {
        match self.text[..match_start]
            .chars()
            .rev()
            .find(|ch| !ch.is_whitespace())
        {
            None => true,
            Some(ch) => !ch.is_alphanumeric() && ch != '_',
        }
    }

    pub(crate) fn has_forbidden_suffix(&self, match_end: usize) -> bool {
        self.text[match_end..]
            .chars()
            .next()
            .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
    }

    pub(crate) fn to_char_index(&self, byte_index: usize) -> usize {
        self.text[..byte_index].chars().count()
    }

    fn slice_raw_chars(&self, start: usize, end_exclusive: usize) -> String {
        self.raw_text
            .chars()
            .skip(start)
            .take(end_exclusive - start)
            .collect()
    }

    pub(crate) fn build_value<F>(
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
    pub(crate) fn has_some_value(&self) -> bool {
        self.cc.is_some()
            || self.cg.is_some()
            || self.cg_name.as_ref().is_some_and(|value| !value.is_empty())
            || self.id.is_some()
            || self.id_name.as_ref().is_some_and(|value| !value.is_empty())
            || self.hash_id.is_some()
    }

    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.has_some_value()
            && matches_option(self.cc.as_ref(), other.cc.as_ref())
            && matches_option(self.cg.as_ref(), other.cg.as_ref())
            && matches_option(self.cg_name.as_ref(), other.cg_name.as_ref())
            && matches_option(self.id.as_ref(), other.id.as_ref())
            && matches_option(self.id_name.as_ref(), other.id_name.as_ref())
            && matches_option(self.hash_id.as_ref(), other.hash_id.as_ref())
    }
}

impl WorkingMetadata {
    pub(crate) fn has_some_value(&self) -> bool {
        self.cc.has_value()
            || self.receiver.has_value()
            || self.receiver_name.has_value()
            || self.receiver_group.has_value()
            || self.receiver_group_name.has_value()
            || self.id.has_value()
            || self.id_name.has_value()
            || self.hash_id.has_value()
    }

    pub(crate) fn conflicts_with(&self, other: &Self) -> bool {
        self.color_codes_conflict(other)
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

    pub(crate) fn merge_from(&mut self, other: Self) {
        if !self.cc.has_value() {
            self.cc = other.cc;
            self.additional_ccs = other.additional_ccs;
        }
        self.receiver.merge_from(other.receiver);
        self.receiver_name.merge_from(other.receiver_name);
        self.receiver_group.merge_from(other.receiver_group);
        self.receiver_group_name
            .merge_from(other.receiver_group_name);
        self.id.merge_from(other.id);
        self.id_name.merge_from(other.id_name);
        self.hash_id.merge_from(other.hash_id);
    }

    fn color_codes_conflict(&self, other: &Self) -> bool {
        if !self.cc.has_value() || !other.cc.has_value() {
            return false;
        }

        self.color_code_values() != other.color_code_values()
    }

    fn color_code_values(&self) -> Vec<&str> {
        std::iter::once(&self.cc)
            .chain(&self.additional_ccs)
            .filter_map(|cc| cc.value.as_deref())
            .collect()
    }

    pub(crate) fn into_public(self) -> InboxMetadata {
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

impl MatchedValue {
    pub(crate) fn has_value(&self) -> bool {
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

    pub(crate) fn lowercase_value(mut self) -> Self {
        self.value = self.value.map(|value| value.to_lowercase());
        self
    }
}

impl WorkingMetadata {
    pub(crate) fn cg_kind(&self) -> Option<CgKind> {
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

fn conflicts_with_option<T: PartialEq>(
    left: Option<&T>,
    right: Option<&T>,
) -> bool {
    matches!((left, right), (Some(left), Some(right)) if left != right)
}
