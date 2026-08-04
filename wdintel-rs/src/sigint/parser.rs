use crate::rer_importer::body_noheader::{
    is_datetime_header_line, is_header_line, NoHeadersBody,
};
use crate::types::AppError;
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::BTreeSet;

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct ParsedComments {
    pub top: Option<String>,
    pub bottom: Option<String>,
}

impl ParsedComments {
    pub fn is_empty(&self) -> bool {
        self.top.is_none() && self.bottom.is_none()
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct MarkerComment {
    text: String,
    start: usize,
    end: usize,
    has_inline_rest: bool,
}

impl MarkerComment {
    fn strip_candidates(&self, lines: &[&str]) -> Vec<String> {
        let mut candidates = vec![self.text.clone()];
        if self.has_inline_rest && self.end > self.start + 1 {
            if let Some(continuation) =
                join_block(&lines[self.start + 1..self.end])
            {
                candidates.push(continuation);
            }
        }
        candidates.sort();
        candidates.dedup();
        candidates
    }
}

lazy_static! {
    static ref COMMENT_MARKER: Regex = Regex::new(
        r"^(?:Коментар|Коментарій|Комментарий|Комментар|Comment)\s*[:\-—]\s*(?P<rest>.*)$"
    )
    .unwrap();

    static ref INTERCEPTION_TAG_MARKER: Regex = Regex::new(
        r"^Мітк(?:а|и)\s+перехоплення\s*[:\-—]\s*(?P<rest>.*)$"
    )
    .unwrap();

    static ref DIALOG_LINE: Regex = Regex::new(
        r"^([—–―‒\-]|\d+\s*[\.\)\-:]|\d+\s+[—–―‒\-])"
    )
    .unwrap();

    static ref COORDS_ONLY: Regex = Regex::new(
        r"^-?\d{1,3}[.,]\d+\s*[, ]\s*-?\d{1,3}[.,]\d+\s*$"
    )
    .unwrap();
}

fn normalize_comment_key(text: &str) -> String {
    let mut words = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase())
        .collect::<Vec<_>>();
    if words
        .first()
        .is_some_and(|word| matches!(word.as_str(), "ім" | "йм"))
    {
        words.remove(0);
    }
    words.concat()
}

fn is_blacklisted_comment(text: &str, blacklist: &[String]) -> bool {
    let normalized = normalize_comment_key(text);
    blacklist.iter().any(|blacklisted| {
        let blacklisted_normalized = normalize_comment_key(blacklisted);
        if normalized.is_empty() || blacklisted_normalized.is_empty() {
            text.trim() == blacklisted.trim()
        } else {
            normalized == blacklisted_normalized
        }
    })
}

fn filter_blacklisted_comment(
    comment: Option<String>,
    blacklist: &[String],
) -> Option<String> {
    let comment = comment?;
    let kept = comment
        .lines()
        .map(str::trim)
        .filter(|line| !is_blacklisted_comment(line, blacklist))
        .collect::<Vec<_>>()
        .join("\n");
    if kept.trim().is_empty() {
        None
    } else {
        Some(kept)
    }
}

fn is_dialog_line(line: &str) -> bool {
    DIALOG_LINE.is_match(line.trim())
}

fn is_top_header_or_context_line(
    lines: &[&str],
    idx: usize,
    anchor: usize,
) -> bool {
    is_header_line(lines[idx])
        || is_pre_datetime_location_header_line(lines, idx, anchor)
}

fn is_pre_datetime_location_header_line(
    lines: &[&str],
    idx: usize,
    anchor: usize,
) -> bool {
    idx < anchor
        && has_radio_header_before(lines, idx)
        && is_location_header_line(lines[idx])
}

fn has_radio_header_before(lines: &[&str], idx: usize) -> bool {
    lines[..idx]
        .iter()
        .rev()
        .any(|line| is_radio_header_line(line.trim()))
}

fn is_radio_header_line(line: &str) -> bool {
    let line = line.to_lowercase();
    line.contains("укх") || line.contains("р/м") || line.contains("dmr")
}

fn is_location_header_line(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() || is_dialog_line(line) {
        return false;
    }
    if !(line.contains(" - ") || line.starts_with('(') && line.ends_with(')')) {
        return false;
    }

    let line = crate::location::remove_standard_location_context_terms(line);
    let mut has_uppercase = false;
    for ch in line.chars().filter(|ch| ch.is_alphabetic()) {
        if ch.is_lowercase() {
            return false;
        }
        if ch.is_uppercase() {
            has_uppercase = true;
        }
    }
    has_uppercase
}
fn clean(text: &str) -> String {
    let mut t = text.trim().to_string();
    loop {
        let before = t.len();
        while t.ends_with(';') || t.ends_with('.') {
            t = t[..t.len() - 1].trim_end().to_string();
        }
        for (open, close) in [('"', '"'), ('«', '»'), ('(', ')')] {
            if t.starts_with(open)
                && t.ends_with(close)
                && t.chars().count() > 1
            {
                t = t[open.len_utf8()..t.len() - close.len_utf8()]
                    .trim()
                    .to_string();
            }
        }
        if t.len() == before {
            break;
        }
    }
    t
}

fn join_block(lines: &[&str]) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut blank_run = false;
    for l in lines {
        let l = l.trim();
        if l.is_empty() {
            if !out.is_empty() {
                blank_run = true;
            }
            continue;
        }
        if blank_run {
            out.push(String::new());
            blank_run = false;
        }
        out.push(l.to_string());
    }
    if out.is_empty() {
        return None;
    }
    let joined = clean(&out.join("\n"));
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

pub fn parse_comments(body: &str) -> ParsedComments {
    parse_comments_with_blacklist(body, &[])
}

pub fn parse_comments_with_blacklist(
    body: &str,
    blacklist: &[String],
) -> ParsedComments {
    if crate::rer_importer::zp_peleng_extended_format::parse(body).is_some() {
        return ParsedComments::default();
    }

    let body = if has_zp_peleng_vorony_odina_suffix(body) {
        body
    } else {
        crate::rer_importer::datetime::without_trailing_datetime(body)
    };
    let lines = normalized_body_lines(body);
    let lines: Vec<&str> = lines.iter().map(String::as_str).collect();

    let marker_comment = scan_marker_comment(&lines, blacklist);

    let anchor = lines.iter().position(|l| is_datetime_header_line(l));

    let top =
        anchor.and_then(|a| parse_top(&lines, a, marker_comment.as_ref()));
    let marker_bottom =
        marker_comment.as_ref().map(|comment| comment.text.clone());
    let bottom = marker_bottom
        .or_else(|| anchor.and_then(|a| parse_tail_comment(&lines[a..])));

    ParsedComments {
        top: filter_blacklisted_comment(top, blacklist),
        bottom: filter_blacklisted_comment(bottom, blacklist),
    }
}

pub fn extract_text_without_top_comment(
    body: &str,
) -> Result<NoHeadersBody, AppError> {
    if crate::rer_importer::zp_peleng_extended_format::parse(body).is_some()
        || crate::rer_importer::zp_peleng_vorony_odina_format::parse(body)
            .is_some()
        || crate::rer_importer::zp_digital_post_alt_format::parse(body)
            .is_some()
    {
        return crate::rer_importer::body_noheader::extract_text(body);
    }

    let body = if has_zp_peleng_vorony_odina_suffix(body) {
        body
    } else {
        crate::rer_importer::datetime::without_trailing_datetime(body)
    };

    let lines = normalized_body_lines(body);
    let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
    let mut excluded_lines = top_comment_line_indices(&lines);
    excluded_lines.extend(pre_datetime_context_line_indices(&lines));
    crate::rer_importer::body_noheader::extract_text_excluding_lines(
        body,
        &excluded_lines,
    )
}

pub(crate) fn marker_comment_strip_candidates(body: &str) -> Vec<String> {
    let lines = normalized_body_lines(body);
    let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
    scan_marker_comment(&lines, &[])
        .map(|comment| comment.strip_candidates(&lines))
        .unwrap_or_default()
}

fn normalized_body_lines(body: &str) -> Vec<String> {
    body.lines()
        .map(|line| {
            crate::rer_importer::body_noheader::trim_otrymano_post_header(line)
                .unwrap_or_else(|| line.to_string())
        })
        .collect()
}

fn has_zp_peleng_vorony_odina_suffix(body: &str) -> bool {
    let lines = normalized_body_lines(body);
    let lines = lines.iter().map(String::as_str).collect::<Vec<_>>();
    lines
        .iter()
        .position(|line| is_datetime_header_line(line))
        .is_some_and(|anchor| {
            zp_peleng_vorony_odina_suffix_start(&lines, anchor).is_some()
        })
}

fn scan_marker_comment(
    lines: &[&str],
    blacklist: &[String],
) -> Option<MarkerComment> {
    let comment = scan_marker(lines, &COMMENT_MARKER);
    if comment.as_ref().is_some_and(|comment| {
        filter_blacklisted_comment(Some(comment.text.clone()), blacklist)
            .is_none()
    }) {
        scan_marker(lines, &INTERCEPTION_TAG_MARKER).or(comment)
    } else {
        comment.or_else(|| scan_marker(lines, &INTERCEPTION_TAG_MARKER))
    }
}

fn scan_marker(lines: &[&str], marker: &Regex) -> Option<MarkerComment> {
    for (i, line) in lines.iter().enumerate() {
        if let Some(caps) = marker.captures(line.trim()) {
            let mut block: Vec<&str> = Vec::new();
            let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");
            let has_inline_rest = !rest.trim().is_empty();
            if !rest.trim().is_empty() {
                block.push(rest);
            }
            let mut end = i + 1;
            for (offset, l) in lines[i + 1..].iter().enumerate() {
                if is_marker_comment_boundary(l) {
                    break;
                }
                block.push(l);
                end = i + 2 + offset;
            }
            if let Some(text) = join_block(&block) {
                return Some(MarkerComment {
                    text,
                    start: i,
                    end,
                    has_inline_rest,
                });
            }
        }
    }
    None
}

fn is_marker_comment_boundary(line: &str) -> bool {
    let line = line.trim();
    line.is_empty()
        || COMMENT_MARKER.is_match(line)
        || INTERCEPTION_TAG_MARKER.is_match(line)
        || is_header_line(line)
        || is_datetime_header_line(line)
        || is_dialog_line(line)
}

fn parse_top(
    lines: &[&str],
    anchor: usize,
    marker_comment: Option<&MarkerComment>,
) -> Option<String> {
    let comment_end =
        zp_peleng_vorony_odina_suffix_start(lines, anchor).unwrap_or(anchor);
    let kept: Vec<&str> = lines[..comment_end]
        .iter()
        .enumerate()
        .filter(|(i, _l)| {
            !is_top_header_or_context_line(lines, *i, anchor)
                && !marker_comment
                    .map(|comment| *i >= comment.start && *i < comment.end)
                    .unwrap_or(false)
        })
        .map(|(_, l)| *l)
        .collect();
    join_block(&kept)
        .filter(|comment| !is_whole_message_body_comment(lines, comment))
}

fn is_whole_message_body_comment(lines: &[&str], comment: &str) -> bool {
    let body = lines.join("\n");
    crate::rer_importer::body_noheader::extract_text(&body)
        .ok()
        .and_then(|body| join_block(&body.body.lines().collect::<Vec<_>>()))
        .is_some_and(|body| body == clean(comment))
}

fn top_comment_line_indices(lines: &[&str]) -> BTreeSet<usize> {
    let Some(anchor) = lines.iter().position(|l| is_datetime_header_line(l))
    else {
        return BTreeSet::new();
    };
    let marker_comment = scan_marker_comment(lines, &[]);
    let comment_end =
        zp_peleng_vorony_odina_suffix_start(lines, anchor).unwrap_or(anchor);
    let indices: Vec<usize> = lines[..comment_end]
        .iter()
        .enumerate()
        .filter(|(i, _l)| {
            !is_top_header_or_context_line(lines, *i, anchor)
                && !marker_comment
                    .as_ref()
                    .map(|comment| *i >= comment.start && *i < comment.end)
                    .unwrap_or(false)
        })
        .map(|(i, _)| i)
        .collect();
    let kept: Vec<&str> = indices.iter().map(|i| lines[*i]).collect();
    join_block(&kept)
        .filter(|comment| !is_whole_message_body_comment(lines, comment))
        .map(|_| indices.into_iter().collect())
        .unwrap_or_default()
}

fn pre_datetime_context_line_indices(lines: &[&str]) -> BTreeSet<usize> {
    let Some(anchor) = lines.iter().position(|l| is_datetime_header_line(l))
    else {
        return BTreeSet::new();
    };

    lines[..anchor]
        .iter()
        .enumerate()
        .filter_map(|(i, _l)| {
            is_pre_datetime_location_header_line(lines, i, anchor).then_some(i)
        })
        .collect()
}

fn zp_peleng_vorony_odina_suffix_start(
    lines: &[&str],
    anchor: usize,
) -> Option<usize> {
    if lines[anchor + 1..]
        .iter()
        .any(|line| !line.trim().is_empty())
    {
        return None;
    }

    [6_usize, 5_usize].into_iter().find_map(|line_count| {
        let start = (anchor + 1).checked_sub(line_count)?;
        let body = lines[start..=anchor].join("\n");
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(&body)
            .map(|_| start)
    })
}

fn parse_tail_comment(post: &[&str]) -> Option<String> {
    let mut idx = 0;
    while idx < post.len() && !post[idx].trim().is_empty() {
        idx += 1;
    }
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for l in &post[idx..] {
        if l.trim().is_empty() {
            if !cur.is_empty() {
                blocks.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(l);
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }
    if blocks.len() < 2 {
        return None;
    }

    let last_dialog = blocks
        .iter()
        .rposition(|b| b.iter().any(|l| is_dialog_line(l)))?;
    let tail = &blocks[last_dialog + 1..];
    if tail.is_empty() {
        return None;
    }
    let candidate: Vec<&str> = tail.concat();
    let is_comment = !candidate.iter().any(|l| {
        is_dialog_line(l)
            || is_header_line(l)
            || is_datetime_header_line(l)
            || COORDS_ONLY.is_match(l.trim())
    });
    if !is_comment {
        return None;
    }
    join_block(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEEDED_COMMENT_BLACKLIST: &[&str] = &[
        "Службовий радіообмін",
        "++",
        "+",
        "доповідь по обстановці",
        "доповідь обстановки",
        "повсякденна діяльність",
        "службовий р/о",
        "перевірка зв'язку",
        "доповідь про стан справ",
        "обстановка",
        "виклик",
        "встановлення зв'язку",
        "запит обстановки",
        "доведення інформації",
        "доповідь",
        "доповідав обстановку по позиціям",
        "запитував обстановку",
        "намагався встановити зв'язок",
        "перевірка обстановки",
        "звіт про ситуацію",
        "викликав на зв'язок",
        "здійснював запит обстановки",
        "здійснював перевірку зв'язку",
        "запит та доповідь обстановки",
    ];

    fn parse_comments_with_seeded_blacklist(body: &str) -> ParsedComments {
        parse_comments_with_blacklist(
            body,
            &SEEDED_COMMENT_BLACKLIST
                .iter()
                .map(|text| text.to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn blacklist_matching_ignores_case_affixes_and_symbols() {
        let blacklist = SEEDED_COMMENT_BLACKLIST
            .iter()
            .map(|text| text.to_string())
            .collect::<Vec<_>>();

        for comment in [
            "🚨 ПЕРЕВІРКА ЗВ’ЯЗКУ!!!",
            "йм. Доповідь 🤙",
            "ім. 🔥 ДОПОВІДЬ",
        ] {
            assert!(is_blacklisted_comment(comment, &blacklist), "{comment}");
        }
        assert!(!is_blacklisted_comment(
            "доповідь обстановки противника",
            &blacklist
        ));
    }

    // ── Variant 1: top comment ─────────────────────────────────────

    #[test]
    fn top_single_line() {
        let body = "Запит на зв'язок між підрозділами\n\n24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы.";
        let res = parse_comments(body);
        assert_eq!(
            res.top.as_deref(),
            Some("Запит на зв'язок між підрозділами")
        );
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_multiline() {
        let body = "Перша строка комментарія\nдруга строка\n\n13.11, 21:37:12\n446.0375\nУКХ НВ\nНВ\n\n— текст діалогу";
        let res = parse_comments(body);
        assert_eq!(
            res.top.as_deref(),
            Some("Перша строка комментарія\nдруга строка")
        );
    }

    #[test]
    fn top_comment_before_rer_labeled_header() {
        let body = "Противник зі складу 2 мсб 41 мсп 72 мсд 44 АК (МІЛАЄВКА, Курська обл.) проводить вогневу роботу з власного БпЛА — боєприпаси неефективні, командування вимагає посилення навантаження.\n\n-----------------РЕР 53 ОРБ---------------------\n\nПост: Vodolaz_1\nДата/час: 20.07.2026, 07:08:43\nЧастота: 158.1500 МГц\nМережа: УКХ р/м управління 2 мсб 41 мсп 72 мсд 44 АК 👥: 67200/62485/67204🔐\nПозивні: ТАМБОВ, ГУФ(нвст.)\n— ГУФ, ГУФ, а что это за петарда такая?";
        let comments = parse_comments(body);

        assert_eq!(
            comments.top.as_deref(),
            Some("Противник зі складу 2 мсб 41 мсп 72 мсд 44 АК (МІЛАЄВКА, Курська обл.) проводить вогневу роботу з власного БпЛА — боєприпаси неефективні, командування вимагає посилення навантаження")
        );
        assert_eq!(
            extract_text_without_top_comment(body).unwrap().body,
            "— ГУФ, ГУФ, а что это за петарда такая?"
        );
    }

    #[test]
    fn top_ignores_otrymano_and_divider() {
        let body = "Отримано з поста \".\"\n--------------------------------------\n20.11.2025, 12:29:18\n157.8750\nУКХ р/м НВ\nНВ\nНВ\n\n— Первый раунд 4, Шапка 1.";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_ignores_otrymano_posts_plural_and_divider() {
        let body = "Отримано з постів \"Пост 10, Пост 6, Пост 8\"\n--------------------------------------\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м ПУ ФСБ рф\n\n— репліка";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_ignores_service_radio_exchange_comment() {
        let body = "  СЛУЖБОВИЙ...   радіообмін!!!\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_drops_only_service_radio_exchange_comment_line() {
        let body = "службовий радіообмін\nважливий коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top.as_deref(), Some("важливий коментар"));
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_keeps_service_radio_exchange_as_part_of_comment_line() {
        let body = "службовий радіообмін противника щодо роботи\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(
            res.top.as_deref(),
            Some("службовий радіообмін противника щодо роботи")
        );
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_keeps_prefix_before_inline_otrymano_post_header() {
        let body = "37T BN 88562 95454  Отримано з поста \"П152\"\n--------------------------------------\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("37T BN 88562 95454"));
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_with_otrymano_then_real_comment() {
        let body = "Отримано з поста \"Альфа\"\n--------------------\nважливий коментар оператора\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("важливий коментар оператора"));
    }

    #[test]
    fn body_noheader_without_top_comment_crops_top_block() {
        let body = "верхній коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ р/м\n\n— репліка\n\nнижній коментар";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "— репліка\n\nнижній коментар");
    }

    #[test]
    fn body_noheader_without_top_comment_crops_top_line_without_blank() {
        let body = "верхній коментар\n24.07.2025, 08:05:21\n149.7300\nУКХ р/м\n— репліка";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "— репліка");
    }

    #[test]
    fn body_noheader_without_top_comment_keeps_body_without_top_comment() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ р/м\n\n— репліка";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "— репліка");
    }

    #[test]
    fn body_noheader_without_top_comment_crops_ignored_comment() {
        let body = "службовий радіообмін\n\n24.07.2025, 08:05:21\n149.7300\nУКХ р/м\n\n— репліка";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "— репліка");
    }

    #[test]
    fn body_noheader_without_top_comment_crops_inline_post_prefix() {
        let body = "37T BN 88562 95454  Отримано з поста \"П152\"\n--------------------------------------\n01.07.2026, 02:55:19\n155.0250\nУКХ р/м\n\n— репліка";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "— репліка");
    }

    #[test]
    fn body_noheader_without_top_comment_keeps_zp_peleng_vorony_odina_mgrs_body(
    ) {
        let body = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "36T VS 89904 14667");
    }

    #[test]
    fn body_noheader_without_top_comment_keeps_zp_peleng_vorony_odina_sk42_body(
    ) {
        let body = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "x:51-29637\ny:65-01850");
    }

    #[test]
    fn body_noheader_without_top_comment_crops_only_comment_before_zp_peleng_vorony_odina_mgrs(
    ) {
        let body = "операторський коментар\nПост Shark 4\n447.450\nр-н. Шевченка\n36T VS 89904 14667\n01.07.2026 03:07:42";
        let comments = parse_comments(body);
        assert_eq!(comments.top.as_deref(), Some("операторський коментар"));

        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "36T VS 89904 14667");
    }

    #[test]
    fn body_noheader_without_top_comment_crops_only_comment_before_zp_peleng_vorony_odina_sk42(
    ) {
        let body = "операторський коментар\nПост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let comments = parse_comments(body);
        assert_eq!(comments.top.as_deref(), Some("операторський коментар"));

        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "x:51-29637\ny:65-01850");
    }

    #[test]
    fn body_noheader_without_top_comment_keeps_zp_digital_post_alt_body() {
        let body = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(
            res.body,
            "УКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)"
        );
    }

    // ── Variant 2: bottom comment ──────────────────────────────────────

    #[test]
    fn bottom_plain_block() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы, машине пизда.\n\nпротивник готує наступ";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("противник готує наступ"));
    }

    #[test]
    fn bottom_explicit_marker() {
        let body = "20.11.2025, 16:53:04\n446.000\nУКХ ймовірно, 344 мсп\nНВ\nНВ\n\n– Да, давай синьки.\n\nКоментар: T2";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("T2"));
    }

    #[test]
    fn bottom_parenthesized() {
        let body = "13.11, 19:15:00\n455.2750\nУКХ радіомережа\n\n- Я говорю коробочку запустили?\n- Надо\n- Плюс\n\n(запит чи треба відвозити о/с)";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит чи треба відвозити о/с"));
    }

    #[test]
    fn bottom_marker_multiline() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: перший рядок\nдругий рядок";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("перший рядок\nдругий рядок"));
    }

    #[test]
    fn bottom_ignores_service_radio_exchange_comment() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: службовий, радіообмін.";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn top_ignores_marked_service_radio_exchange_comments() {
        for marker in ["Коментарій", "Комментарий", "Comment"]
        {
            let body = format!(
                "{marker}: службовий радіообмін\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка"
            );
            let res = parse_comments_with_seeded_blacklist(&body);
            assert_eq!(res.top, None, "marker: {marker}");
            assert_eq!(res.bottom, None, "marker: {marker}");
        }
    }

    #[test]
    fn bottom_uses_interception_tag_after_ignored_comment() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: службовий радіообмін\n\nМітки перехоплення: 🚙 - Переміщення";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("🚙 - Переміщення"));
    }

    #[test]
    fn bottom_drops_only_service_radio_exchange_comment_line() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: службовий радіообмін\nважливий рядок";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("важливий рядок"));
    }

    #[test]
    fn bottom_keeps_service_radio_exchange_as_part_of_comment_line() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу\n\nКоментар: службовий радіообмін противника щодо роботи";
        let res = parse_comments_with_seeded_blacklist(body);
        assert_eq!(res.top, None);
        assert_eq!(
            res.bottom.as_deref(),
            Some("службовий радіообмін противника щодо роботи")
        );
    }

    #[test]
    fn marker_before_datetime_multiline_is_not_partial_top_comment() {
        let body = "Коментар: перший рядок\nдругий рядок\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("перший рядок\nдругий рядок"));
    }

    #[test]
    fn interception_tag_before_datetime_is_a_comment() {
        let body = "Мітка перехоплення: Важливо\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка діалогу";
        let res = parse_comments(body);
        assert_eq!(res.top, None);
        assert_eq!(res.bottom.as_deref(), Some("Важливо"));
    }

    #[test]
    fn seeded_plus_comments_are_blacklisted() {
        for comment in ["+", "++"] {
            let top = format!(
                "{comment}\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка"
            );
            let bottom = format!(
                "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nКоментар: {comment}"
            );

            assert!(parse_comments_with_seeded_blacklist(&top).is_empty());
            assert!(parse_comments_with_seeded_blacklist(&bottom).is_empty());
        }
    }

    #[test]
    fn yyyy_mm_dd_comma_time_is_anchor() {
        let body = "2025-03-08, 10:20\n422.500\nЛозуватське, УКХ р/м\nЛУЧНИК\nПИРОЖЕК\n\n— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет\n\nКоментар: БПЛА СОУ";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("БПЛА СОУ"));
    }

    #[test]
    fn crlf_yyyy_mm_dd_comma_time_is_anchor() {
        let body = "2025-03-08, 10:20\r\n422.500\r\nЛозуватське, УКХ р/м\r\nЛУЧНИК\r\nПИРОЖЕК\r\n\r\n— ПИРОЖЕК я ЛУЧНИК: ФПВ к нам идет\r\n\r\nКоментар: БПЛА СОУ";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("БПЛА СОУ"));
    }

    #[test]
    fn buran_explicit_comment_marker() {
        let body = "Дата: 2024-02-21;\nЧастота: 408.500;\nЛокація: Авдіївка;\nПідрозділ: УКХ р/м;\nЧас: 17:28;\nХто: Змей;\nКому: Чёрный;\nТекст:\n- Чёрный я Змей ответь по керосину\n- 3 мсб? правильно?;\n.\nКоментар: ( запит на зв'язок );";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит на зв'язок"));
    }

    #[test]
    fn buran_empty_comment_marker_stops_at_header_fields() {
        let body = "Дата: 2024-02-21;\nЧастота: 408.500;\nКоментар:\nПост: Альфа\nКоординати: 48.123, 37.456\nТекст:\n- Чёрный я Змей ответь по керосину\n- 3 мсб? правильно?;";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn buran_date_label_is_anchor() {
        let body = "Дата: 23.02.2024\nЧас: 16:47\nЧастота: 412.300\nРайон: Піски;\nПідрозділ: УКХ р/м;\n\n- выйди на мотор\n\nзапит на звязок";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("запит на звязок"));
    }

    // ── Variant 3: top and bottom comments ──────────────────────────────────────

    #[test]
    fn both_top_and_bottom() {
        let body = "верхній коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n— ще репліка\n\nнижній коментар";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("верхній коментар"));
        assert_eq!(res.bottom.as_deref(), Some("нижній коментар"));
    }

    // ── Variant 4: Without comments ───────────────────────────────────────────────────

    #[test]
    fn no_comment_plain_message() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ р/м 60 омсб\nТРАКТОР\nНВ\n\n— Депутат, Депутат Трактору.\n— Да, все живы.";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn interception_tag_markers_parse_as_bottom_comments() {
        let cases = [
            (
                "Мітки перехоплення",
                "🦧 - Перевірка стану/зв'язку",
                "🦧 - Перевірка стану/зв'язку",
            ),
            (
                "Мітки перехоплення",
                "🚙🏃‍➡️ - Переміщення",
                "🚙🏃‍➡️ - Переміщення",
            ),
            (
                "Мітки перехоплення",
                "❗🚀 - Робота артилерії/ миномету",
                "❗🚀 - Робота артилерії/ миномету",
            ),
            (
                "Мітки перехоплення",
                "Переміщення О/C👣👣👣 - Переміщення особового складу противника",
                "Переміщення О/C👣👣👣 - Переміщення особового складу противника",
            ),
            (
                "Мітки перехоплення",
                "FPV🛸🛸🛸 - Робота FPV СОУ",
                "FPV🛸🛸🛸 - Робота FPV СОУ",
            ),
            (
                "Мітки перехоплення",
                "🛩️ - Застосування БпЛА РОВ",
                "🛩️ - Застосування БпЛА РОВ",
            ),
            (
                "Мітки перехоплення",
                "Обстріл☄️☄️☄️ - Інформація про ураження, обстріл позицій противника",
                "Обстріл☄️☄️☄️ - Інформація про ураження, обстріл позицій противника",
            ),
            (
                "Мітки перехоплення",
                "🧩 - Планування робот",
                "🧩 - Планування робот",
            ),
            (
                "Мітки перехоплення",
                "👁️🛩️ - Спостереження БпЛА",
                "👁️🛩️ - Спостереження БпЛА",
            ),
            (
                "Мітки перехоплення",
                "🛸🛰 - Детектор дронів / йм. ідентифікують роботу БПЛА СОУ",
                "🛸🛰 - Детектор дронів / йм. ідентифікують роботу БПЛА СОУ",
            ),
            (
                "Мітки перехоплення",
                "🔇 - Проблеми зі зв'язком",
                "🔇 - Проблеми зі зв'язком",
            ),
            (
                "Мітки перехоплення",
                "🔌 📡 - Налагодження зв'язку",
                "🔌 📡 - Налагодження зв'язку",
            ),
            (
                "Мітки перехоплення",
                "Звязок📞📞📞 - Інформая про перехід на інші засоби звязку.",
                "Звязок📞📞📞 - Інформая про перехід на інші засоби звязку",
            ),
            (
                "Мітки перехоплення",
                "🛩️🧨 - Робота БпЛА зі скидом/FPV",
                "🛩️🧨 - Робота БпЛА зі скидом/FPV",
            ),
            (
                "Мітки перехоплення",
                "👩‍🦼 - Санітарні втрати",
                "👩‍🦼 - Санітарні втрати",
            ),
            (
                "Мітка перехоплення",
                "Важливо - Важливо !!!",
                "Важливо - Важливо !!!",
            ),
            (
                "Мітки перехоплення",
                "200/300💀💀💀 - Втрати противника",
                "200/300💀💀💀 - Втрати противника",
            ),
            (
                "Мітки перехоплення",
                "🦧 - Перевірка стану/зв'язку, 🚙🏃‍➡️ - Переміщення",
                "🦧 - Перевірка стану/зв'язку, 🚙🏃‍➡️ - Переміщення",
            ),
        ];

        for (marker, value, expected) in cases {
            let body = format!(
                "18.07.2026, 13:59:56\n143.8150\nУКХ р/м управління підрозділу\nПАРОВОЗ\nСОКОЛ\n\n— Сокол, Паровозу\n\n{marker}: {value}"
            );
            let res = parse_comments(&body);
            assert_eq!(res.top, None, "{value}");
            assert_eq!(res.bottom.as_deref(), Some(expected), "{value}");
        }
    }

    #[test]
    fn explicit_comment_after_interception_tags_takes_priority() {
        let body = "18.07.2026, 13:59:56\n143.8150\nУКХ р/м\n\n— Сокол, Паровозу\n\nМітки перехоплення: 🚙 - Переміщення\n\nКоментар: операторське уточнення";

        let res = parse_comments(body);

        assert_eq!(res.bottom.as_deref(), Some("операторське уточнення"));
        assert_eq!(
            marker_comment_strip_candidates(body),
            vec!["операторське уточнення"]
        );
    }

    #[test]
    fn new_inter_csv_rows_do_not_parse_headers_as_comments() {
        let cases = [
            (
                "22577918",
                r#"🤿УКХ р/м управління 1 мсб 423 мсп 4 тд 1 ТА
АНДРІЇВКА - ЛОЗОВА - БОРІВСЬКА АНДРІЇВКА
16.07.2026 15:08:46

Отримувач: НВ
Відправник: НВ

1. Это не в доме, это птичка в спеле, она лежит. Я пошел по другой тропинке и там похоже что-то на мину, на УЗМ-ку похоже, вроде как пустая, но говорят, что ничего там не стояло и ничего там не лежало
2. ... пришел?
1. Да, я тогда перебегал через эту черню и перепрыгнул
2. Хороший. Так, а получается как, если, так им корректно говоря, если в ..., то левая и правая, на какой это будет?
1.  На правой, если с Бобра, птичка, на левой, вот это хуйня"#,
            ),
            (
                "22577927",
                r#"🤿УКХ р/м управління 1 мсб 423 мсп 4 тд 1 ТА
145.799 МГц
АНДРІЇВКА - ЛОЗОВА - БОРІВСЬКА АНДРІЇВКА
16.07.2026 15:08:46

Отримувач: НВ
Відправник: НВ

1. Это не в доме, это птичка в спеле, она лежит. Я пошел по другой тропинке и там похоже что-то на мину, на УЗМ-ку похоже, вроде как пустая, но говорят, что ничего там не стояло и ничего там не лежало
2. ... пришел?
1. Да, я тогда перебегал через эту черню и перепрыгнул
2. Хороший. Так, а получается как, если, так им корректно говоря, если в ..., то левая и правая, на какой это будет?
1.  На правой, если с Бобра, птичка, на левой, вот это хуйня"#,
            ),
            (
                "22577945",
                r#"Тип: Антена
Назва: 136.850  МГц
Час: 16.07.26  14:15
Ворожий:
Зауваження штабу: -
Координати: 36U XB 72799 18684
УКХ р/м управління 19 сб 80 тп 90 тд ЦВО (СТАРОСЄЛЬЄ, ГРАБОВСЬКЕ, РЯСНЕ)"#,
            ),
            (
                "22578075",
                r#"Тип: Антена
Назва: 136.850  МГц
Час: 16.07.26  14:30
Ворожий:
Зауваження штабу: -
Координати: 36U XB 69744 20084
УКХ р/м управління 19 сб 80 тп 90 тд ЦВО (СТАРОСЄЛЬЄ, ГРАБОВСЬКЕ, РЯСНЕ)"#,
            ),
            (
                "22578105",
                r#"🤿УКХ р/м упр. загін "Шторм" 12 тп 4 тд 1 ТА
БОРІВСЬКА АНДРІЇВКА - ЗЕЛЕНИЙ ГАЙ - зах. МЯСОЖАРІВКА
16.07.2026 15:12:33

Отримувач: Олень
Відправник: Гуша

1. Олень, я Гуша, я разместил-разместил людей, выдвигаюсь за крайней-крайней группой
2. Да, ты ... щас видел?
1. Никак нет, никак нет
1. Щас буду, буду, сама собой, щас поднимусь в горку только"#,
            ),
            (
                "22578162",
                r#"🤿УКХ р/м упр. загін "Шторм" 12 тп 4 тд 1 ТА
147.825 МГц
БОРІВСЬКА АНДРІЇВКА - ЗЕЛЕНИЙ ГАЙ - зах. МЯСОЖАРІВКА
16.07.2026 15:12:33

Отримувач: Олень
Відправник: Гуша

1. Олень, я Гуша, я разместил-разместил людей, выдвигаюсь за крайней-крайней группой
2. Да, ты ... щас видел?
1. Никак нет, никак нет
1. Щас буду, буду, сама собой, щас поднимусь в горку только"#,
            ),
            (
                "22578195",
                r#"🧽УКХ р/м управління 1 мсб 122 мсп 68 мсд 6А
(КУП'ЯНСЬК)
16.07.2026 14:48:30

Отримувач: Сизый
Відправник: НВ

1. Сизый, Сизый, приём, приём, смотри, наша птичка там сверху полетает, посмотрит кто там что, где накидывает, если что кто найдет, сразу розебем короче.
2. Да, принял-принял.
2. Что там по посылке, по посылке?
1. Братец, Братец, посылка ещё в пути, посылка в пути, там обстановка не позволяет, посылка движется, она в пути мужики.
2. Да, принял."#,
            ),
        ];

        let parsed_comments: Vec<(&str, ParsedComments)> = cases
            .iter()
            .map(|(id, body)| (*id, parse_comments(body)))
            .filter(|(_, comments)| !comments.is_empty())
            .collect();

        assert_eq!(parsed_comments, Vec::<(&str, ParsedComments)>::new());
    }

    #[test]
    fn new_inter_csv_location_context_is_not_message_body() {
        let body = r#"🤿УКХ р/м управління 1 мсб 423 мсп 4 тд 1 ТА
145.799 МГц
АНДРІЇВКА - ЛОЗОВА - БОРІВСЬКА АНДРІЇВКА
16.07.2026 15:08:46

Отримувач: НВ
Відправник: НВ

1. Це службова перевірка.
2. Прийняв."#;

        let comments = parse_comments(body);
        assert!(comments.is_empty());

        let res = extract_text_without_top_comment(body).unwrap();
        assert!(!res.body.contains("АНДРІЇВКА"));
        assert!(res.body.contains("1. Це службова перевірка."));
    }

    #[test]
    fn pre_datetime_location_with_zx_direction_is_not_top_comment() {
        let body = r#"🤿УКХ р/м управління 1 мсб 423 мсп 4 тд 1 ТА
БОРІВСЬКА АНДРІЇВКА - ЗЕЛЕНИЙ ГАЙ - зх. МЯСОЖАРІВКА
16.07.2026 15:12:33

1. Прийом."#;

        let res = parse_comments(body);

        assert!(res.is_empty());
        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "1. Прийом.");
    }

    #[test]
    fn unit_location_before_datetime_is_not_top_comment() {
        let body = "7 р/м управління зрбатр 1430 мсп 42 мсд 58 А (ЯБЛУНІВКА)\n10.07.2026, 12:33:09\n666.5555\n123.2000\n111.1111\nМИРНЫЙ";
        let comments = parse_comments(body);
        assert!(comments.is_empty());

        let res = extract_text_without_top_comment(body).unwrap();
        assert_eq!(res.body, "МИРНЫЙ");
    }

    #[test]
    fn no_anchor_no_marker_returns_empty() {
        let body = "просто якийсь текст\nбез дати і часу";
        let res = parse_comments(body);
        assert!(res.is_empty());
    }

    #[test]
    fn marker_without_anchor_still_extracted() {
        let body = "якийсь нестандартний заголовок\n\n- репліка\n\nКоментар: важлива примітка";
        let res = parse_comments(body);
        assert_eq!(res.bottom.as_deref(), Some("важлива примітка"));
    }

    #[test]
    fn dialog_with_internal_blank_not_treated_as_comment() {
        let body = "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— перша репліка\n\n— друга репліка після пустого рядка";
        let res = parse_comments(body);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn plus_marker_is_not_a_comment() {
        let body = "18.02.2024, 18:32:00\n432.0150\nУКХ радіомережа\n\n- Лопата прием я Филин\n- 5-ть минут да?\n- Плюс";
        let res = parse_comments(body);
        assert_eq!(res.bottom, None);
    }

    #[test]
    fn emoji_prefixed_date_is_anchor() {
        let body = "коментар зверху\n\n⚠️20.12, 13:45:21\n430.000\nУКХ р/м\nНВ\nНВ\n\n1 - Батарейки заряжені?";
        let res = parse_comments(body);
        assert_eq!(res.top.as_deref(), Some("коментар зверху"));
    }

    #[test]
    fn trailing_timestamp_leaves_unfamiliar_message_as_body_not_comment() {
        let body = "нестандартний перший рядок\nнестандартний другий рядок\n23:59 31.07.2026";

        assert!(parse_comments(body).is_empty());
        assert_eq!(
            extract_text_without_top_comment(body).unwrap().body,
            "нестандартний перший рядок\nнестандартний другий рядок"
        );
    }

    #[test]
    fn extended_peleng_format_has_no_comment() {
        let body = "пост Фокстрот-Наутілус-Дракар\n446.300 TYT назва: ретранслятор\nр-н Верхній Рогачик\nx:52-41410\ny:65-99914\nУКХ радіомережа ППО смуга 49 А\nНВ\nНВ\n\n— Кольцо 22, я техас, прием.\n23:59 31.07.2026";

        assert!(parse_comments(body).is_empty());
        assert_eq!(
            extract_text_without_top_comment(body).unwrap().body,
            "НВ\nНВ\n\n— Кольцо 22, я техас, прием."
        );
    }
}
