use super::highlight::CNCallsign;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::types::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::string::*;
use crate::utils::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::prelude::*;
use indicatif::{MultiProgress, ProgressBar};
use lazy_static::lazy_static;
use rand::prelude::*;
use regex::Regex;
use sea_orm::*;
use sea_query::Expr;
use std::collections::{BTreeMap, BTreeSet};

pub fn is_numeric_callsign(callsign: &String) -> bool {
    let Ok(num) = callsign.trim().parse::<i64>() else {
        return false;
    };
    num > 999
}

// /// Callsigns which we don't auto-guess
// fn get_blacklist() -> BTreeSet<String> {
//     let mut res = BTreeSet::new();
//     res.insert("том".to_string());
//     res.insert("по".to_string());
//     res.insert("лес".to_string());
//     res.insert("встреча".to_string());
//     res.insert("франк".to_string());
//     res.insert("точка".to_string());
//     res.insert("окоп".to_string());
//     res.insert("посол".to_string());
//     res.insert("дорога".to_string());
//     res.insert("большой".to_string());
//     res.insert("лева".to_string());
//     res.insert("левадне".to_string());
//     res.insert("цифра".to_string());
//     res.insert("мал".to_string());
//     res.insert("приказ".to_string());
//     res.insert("техник".to_string());
//     res.insert("там".to_string());
//     res.insert("-".to_string());
//     res.insert("малой".to_string());
//     res.insert("небо".to_string());
//     res
// }

pub async fn find_known_callsigns(
    rq: &reqwest::Client,
    body: &str,
) -> Result<Vec<CNCallsign>, AppError> {
    let body_orig = body;
    let res = extract_callsigns(body)?;
    // let mut body = body.to_string();
    // let first_line: &str = body.lines().nth(0).unwrap_or("");
    // let m_freq = crate::rer_importer::frequency::extract_freq(first_line)?;
    // let first_line_contains_freq = m_freq.is_some();
    // let mut skip_chars = 0;
    // if first_line_contains_freq {
    //     skip_chars += cline_len(first_line) + 1;
    //     body = body.lines().skip(1).collect::<Vec<&str>>().join("\n");
    // }
    // body = body
    //     .lines()
    //     .filter(|l| !is_unit_line(l))
    //     .collect::<Vec<&str>>()
    //     .join("\n");
    // println!("> debug: find_known_callsigns: {}", body);
    // let tokens = crate::nlp::tokenize_words(rq, &body).await.c(h!())?;
    // let tokens: Vec<String> = tokens.iter().map(|x| x.to_lowercase()).collect();
    // println!("> debug: find_known_callsigns tokens: {:?}", tokens);
    // let callsign_lexemes: Vec<callsign_lexeme::Model> = CallsignLexeme::find()
    //     .filter(
    //         callsign_lexeme::Column::Lexeme
    //             .is_in(BTreeSet::from_iter(tokens.iter()).into_iter()),
    //     )
    //     .all(dbx)
    //     .await.c(h!())?;
    // let blacklist = get_blacklist();

    // let callsign_lexemes = callsign_lexemes
    //     .iter()
    //     .filter(|x| !blacklist.contains(&x.callsign));
    // for lexeme in callsign_lexemes {
    //     if let Some(ref freq) = m_freq {
    //         let seen_since = Utc::now()
    //             - chrono::Duration::days(
    //                 crate::config::CALLSIGNS_SEEN_LATELY_PERIOD_DAYS,
    //             );
    //         if seen_callsign_on_freq_lately(
    //             dbx,
    //             &freq,
    //             &lexeme.callsign,
    //             seen_since,
    //         )
    //         .await.c(h!())?
    //         {
    //             // lexeme.lexeme must be somewhere in text
    //             for pos in crate::utils::string::cline_word_indices(
    //                 &body,
    //                 &lexeme.lexeme,
    //             ) {
    //                 res.push(CNCallsign {
    //                     begin: skip_chars + pos,
    //                     end: skip_chars
    //                         + pos
    //                         + crate::utils::string::cline_len(&lexeme.lexeme),
    //                     etalon: lexeme.callsign.clone(),
    //                     text: lexeme.lexeme.clone(),
    //                 });
    //             }
    //         }
    //     }
    // }

    // re-highlight to capture more in body
    let callsigns: Vec<String> = res.iter().map(|x| x.etalon.clone()).collect();
    let res = highlight_callsigns(rq, body_orig, &callsigns)
        .await
        .c(h!())?;
    let res = crate::utils::uniq_via_btreeset(&res);
    Ok(res)
}

fn push_if_unique_callsign(
    callsign: &CNCallsign,
    container: &mut Vec<CNCallsign>,
) {
    if !container.iter().any(|c| c.text == callsign.text) {
        container.push(callsign.to_owned());
    }
}

fn extract_callsigns(body: &str) -> Result<Vec<CNCallsign>, AppError> {
    let body = &demoji::demoji(body);
    let mut res: Vec<CNCallsign> = vec![];
    for callsign in extract_kazhanchik_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_buran_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_kharkiv_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_digital_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_non_caps_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_sender_receiver_pair(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    for callsign in extract_avia_callsigns(body)? {
        push_if_unique_callsign(&callsign, &mut res);
    }
    Ok(res)
}

pub fn strip_callsigns_prefix(body: &str, message: &InboxMessage) -> String {
    analyze_callsigns_prefix(body, message).stripped_body
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallsignsPrefixInfo {
    pub stripped_body: String,
    pub callsigns: Vec<String>,
    pub had_placeholder: bool,
}

#[derive(Debug)]
struct ConsumedCallsignsHeader {
    consumed_lines: usize,
    callsigns: Vec<String>,
    had_placeholder: bool,
    header_lines: usize,
}

pub(crate) fn analyze_callsigns_prefix(
    body: &str,
    message: &InboxMessage,
) -> CallsignsPrefixInfo {
    let lines = body.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return CallsignsPrefixInfo {
            stripped_body: body.to_string(),
            callsigns: vec![],
            had_placeholder: false,
        };
    }

    let known_callsigns = message
        .callsigns
        .iter()
        .chain(message.callsigns_alg2.iter())
        .filter_map(|callsign| {
            let normalized = normalize_callsign_header_value(callsign);
            if normalized.is_empty() || normalized == "нв" {
                None
            } else {
                Some((normalized, callsign.clone()))
            }
        })
        .collect::<BTreeMap<_, _>>();
    let known_callsign_keys =
        BTreeSet::from_iter(known_callsigns.keys().cloned());
    let search_limit = lines.len().min(crate::config::CALLSIGNS_MAX_LINES + 4);

    for start_idx in 0..search_limit {
        let Some(header) = consume_callsigns_header(
            &lines[start_idx..],
            &known_callsign_keys,
            &known_callsigns,
        ) else {
            continue;
        };
        if start_idx > 0 && header.header_lines < 2 {
            continue;
        }

        return CallsignsPrefixInfo {
            stripped_body: lines[start_idx + header.consumed_lines..]
                .join("\n"),
            callsigns: header.callsigns,
            had_placeholder: header.had_placeholder,
        };
    }

    CallsignsPrefixInfo {
        stripped_body: body.to_string(),
        callsigns: vec![],
        had_placeholder: false,
    }
}

fn consume_callsigns_header(
    lines: &[&str],
    known_callsigns: &BTreeSet<String>,
    known_callsigns_map: &BTreeMap<String, String>,
) -> Option<ConsumedCallsignsHeader> {
    let mut line_idx = 0;
    let mut callsigns = vec![];
    let mut had_callsign_line = false;
    let mut placeholder_lines = 0;
    let mut header_lines = 0;

    while line_idx < lines.len() {
        let line = lines[line_idx];
        if line.trim().is_empty() {
            if had_callsign_line || placeholder_lines > 0 {
                line_idx += 1;
                continue;
            }
            break;
        }
        if is_callsigns_placeholder_line(line) {
            placeholder_lines += 1;
            header_lines += 1;
            line_idx += 1;
            continue;
        }
        let Some(line_callsigns) = callsigns_from_header_line(
            line,
            known_callsigns,
            known_callsigns_map,
        ) else {
            break;
        };
        had_callsign_line = true;
        header_lines += 1;
        callsigns.extend(line_callsigns);
        line_idx += 1;
    }

    if !had_callsign_line && placeholder_lines < 2 {
        return None;
    }

    Some(ConsumedCallsignsHeader {
        consumed_lines: line_idx,
        callsigns,
        had_placeholder: placeholder_lines > 0,
        header_lines,
    })
}

fn is_callsigns_placeholder_line(line: &str) -> bool {
    lazy_static! {
        static ref RE_PLACEHOLDER: Regex =
            Regex::new(r"(?iu)^\s*(\d+\s*(-|—)\s*)?нв(\s*\([^)]+\))?\s*$")
                .unwrap();
    }

    RE_PLACEHOLDER.is_match(line)
}

fn callsigns_from_header_line(
    line: &str,
    known_callsigns: &BTreeSet<String>,
    known_callsigns_map: &BTreeMap<String, String>,
) -> Option<Vec<String>> {
    if let Ok(callsigns) = extract_kazhanchik_callsigns(line) {
        let callsigns = callsigns
            .into_iter()
            .map(|callsign| callsign.text)
            .collect::<Vec<_>>();
        if let Some(callsigns) = resolve_header_callsigns(
            callsigns,
            known_callsigns,
            known_callsigns_map,
        ) {
            return Some(callsigns);
        }
    }

    fallback_known_header_callsigns(line, known_callsigns, known_callsigns_map)
}

fn fallback_known_header_callsigns(
    line: &str,
    known_callsigns: &BTreeSet<String>,
    known_callsigns_map: &BTreeMap<String, String>,
) -> Option<Vec<String>> {
    if known_callsigns.is_empty() {
        return None;
    }

    let callsigns = line
        .split(|char_| [',', '/', ';'].contains(&char_))
        .map(prepare_callsign_header_candidate)
        .filter(|candidate| !candidate.is_empty())
        .collect::<Vec<_>>();
    if callsigns.is_empty() {
        return None;
    }

    resolve_header_callsigns(callsigns, known_callsigns, known_callsigns_map)
}

fn prepare_callsign_header_candidate(candidate: &str) -> String {
    let candidate = candidate
        .trim()
        .trim_matches(|char_| ['"', '\'', '“', '”'].contains(&char_));
    let candidate = candidate
        .trim_start_matches(|char_: char| {
            char_.is_ascii_digit()
                || char_.is_whitespace()
                || ['.', '-', '—', ')', '('].contains(&char_)
        })
        .trim();
    let candidate = candidate
        .split('(')
        .next()
        .unwrap_or(candidate)
        .trim_end_matches(|char_: char| {
            char_.is_whitespace() || ['.', ',', ';', ':'].contains(&char_)
        })
        .trim();
    candidate.to_string()
}

fn resolve_header_callsigns(
    callsigns: Vec<String>,
    known_callsigns: &BTreeSet<String>,
    known_callsigns_map: &BTreeMap<String, String>,
) -> Option<Vec<String>> {
    let normalized_callsigns = callsigns
        .into_iter()
        .map(|callsign| normalize_callsign_header_value(&callsign))
        .filter(|callsign| !callsign.is_empty())
        .collect::<Vec<_>>();
    if normalized_callsigns.is_empty() {
        return None;
    }
    if !known_callsigns.is_empty()
        && normalized_callsigns
            .iter()
            .any(|callsign| !known_callsigns.contains(callsign))
    {
        return None;
    }

    Some(
        normalized_callsigns
            .into_iter()
            .map(|callsign| {
                known_callsigns_map
                    .get(&callsign)
                    .cloned()
                    .unwrap_or(callsign)
            })
            .collect(),
    )
}

fn normalize_callsign_header_value(callsign: &str) -> String {
    callsign
        .trim()
        .to_lowercase()
        .chars()
        .filter(|char_| char_.is_alphanumeric())
        .collect()
}

pub async fn highlight_callsigns(
    rq: &reqwest::Client,
    body: &str,
    callsigns: &Vec<String>,
) -> Result<Vec<CNCallsign>, AppError> {
    let mut res = vec![];
    let tokens = crate::nlp::tokenize_words(rq, body).await.c(h!())?;
    // println!("> tokens: {tokens:?}");
    let mut callsign_forms = BTreeMap::new();
    for callsign in callsigns.iter() {
        callsign_forms.insert(callsign.clone(), callsign.clone());
        for callsign_form in
            crate::nlp::token_lexemes(rq, callsign).await.c(h!())?
        {
            callsign_forms.insert(callsign_form, callsign.clone());
        }
    }
    // println!("> callsign_forms: {callsign_forms:?}");

    let mut substrings_to_highlight: Vec<(String, String, usize, usize)> =
        vec![];

    // 🔹 Scan n-grams of length 1..=2 (single word, two-word)
    for n in 1..=2 {
        for i in 0..tokens.len().saturating_sub(n - 1) {
            let slice = &tokens[i..i + n];

            // Join token texts with spaces
            let text = slice
                .iter()
                .map(|t| t.text.clone())
                .collect::<Vec<_>>()
                .join(" ");
            let text_lc = text.to_lowercase();

            if let Some(etalon) = callsign_forms.get(&text_lc) {
                if let (Some(first), Some(last)) = (slice.first(), slice.last())
                {
                    substrings_to_highlight.push((
                        etalon.clone(),
                        slice
                            .iter()
                            .map(|t| t.text.clone())
                            .collect::<Vec<_>>()
                            .join(" "),
                        first.start,
                        last.end,
                    ));
                }
            }
        }
    }

    // println!("> substrings_to_highlight: {substrings_to_highlight:?}");

    for (etalon, sub, start, end) in substrings_to_highlight {
        res.push(CNCallsign {
            begin: start,
            end,
            etalon: etalon.clone(),
            text: sub.clone(),
        });
    }

    // Deduplicate and sort
    let mut res = res.clone();
    res.sort();
    res.dedup();

    Ok(res)
}

/// Lines like "УКХ р/м управління БТГр 70 мсп 42 мсд 58 А ((РОБОТИНЕ))"
fn is_unit_line(l: &str) -> bool {
    l.contains("УКХ радіомережа") || l.contains("управління")
}

fn extract_kharkiv_callsigns(input: &str) -> Result<Vec<CNCallsign>, AppError> {
    let mut lines: Vec<String> =
        input.trim().lines().map(|x| x.to_string()).collect();
    lines.truncate(crate::config::CALLSIGNS_MAX_LINES);

    const CALLSIGN_REGEX_STR: &str =
        r"(?P<callsign>[\p{Cyrillic}0-9A-Z-]+([0-9]{1,3})?)(\s?\([^\s]+\))?";

    lazy_static! {
        // Regex for matching a single callsign
        static ref CALLSIGN_REGEX: Regex = Regex::new(CALLSIGN_REGEX_STR).unwrap();

        // Regex for validating an entire line of callsigns separated by commas
        static ref LINE_REGEX: Regex = Regex::new(&format!(
            r"\d{{1,2}}:\d{{2}}\s+({})(,*\s+{})*\s+\d{{3,4}}\.",
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign1>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign2>")
        )).unwrap();
    }
    let mut msg_pos = 0;
    let mut res: Vec<CNCallsign> = vec![];

    for line in lines.iter() {
        if let Some(line_match) = LINE_REGEX.find(line) {
            // Extract the matched part of the line
            let matched_text = line_match.as_str();
            for capture in CALLSIGN_REGEX.captures_iter(matched_text) {
                if capture.name("callsign").is_some() {
                    add_callsign(
                        &capture, "callsign", line, msg_pos, true, &mut res,
                    );
                }
            }
        }
        msg_pos += cline_len(line) + 1;
    }

    Ok(res)
}

/// Extracts callsigns if the text is in "kazhanchik"'s format
fn extract_kazhanchik_callsigns(
    input: &str,
) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> =
        input.trim().lines().map(|x| x.to_string()).collect();
    // println!("> lines: {lines:?}");
    let mut skip_lines = 0;
    let mut msg_pos = 0;

    if first_line_comintify_operator(&lines)? {
        skip_lines += 1;
        msg_pos += cline_len(&lines[0]) + 1;
    }

    // remove freq line
    if !lines.is_empty() {
        let line0 = &lines[0];
        if crate::rer_importer::frequency::extract_freq(line0)?.is_some() {
            skip_lines += 1;
            // println!("> shifting by {}", cline_len(line0) + 1);
            msg_pos += cline_len(line0) + 1;
        }
    }
    if !lines.is_empty() {
        if let Some(line0) = &lines.get(skip_lines) {
            if is_unit_line(line0) {
                skip_lines += 1;
                msg_pos += cline_len(line0) + 1;
                // println!("> shifting by {}", cline_len(line0) + 1);
            }
        }
    }
    // At most three items
    let mut lines = lines
        .iter()
        .skip(skip_lines)
        .cloned()
        .collect::<Vec<String>>();
    lines.truncate(crate::config::CALLSIGNS_MAX_LINES);

    // The regex for matching a single callsign
    // Allowed prefix: 1 - CALLSING (SOME TEXT)
    // CALLSING must have capital letters and possibly numbers as a suffix
    // also allowed digital callsing in format 1-Й, 34-Й (i.e. numbers dash Й)
    // for digitall calllins only there is a extract_digital_callsigns function
    const CALLSIGN_REGEX_STR: &str = r"(\d+\s*(-|—)\s*)??(?P<callsign>(([A-ZА-ЯЁ]+(\s*(-|—)?\s*[0-9]{1,3})?)|([0-9]{1,3}\s*(-|—)?\s*Й)))(\s?\([^\s]+\))?";

    lazy_static! {
        // Regex for matching a single callsign
        static ref CALLSIGN_REGEX: Regex = Regex::new(CALLSIGN_REGEX_STR).unwrap();

        // Regex for validating an entire line of callsigns separated by commas
        static ref LINE_REGEX: Regex = Regex::new(&format!(
            r"^({})(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,\s*{})*(,)?\s*$",
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign1>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign2>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign3>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign4>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign5>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign6>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign7>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign8>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign9>"),
            CALLSIGN_REGEX_STR.replace("?P<callsign>", "?P<callsign10>"),
        )).unwrap();
    }
    let mut res: Vec<CNCallsign> = vec![];

    for line in lines.iter() {
        if let Some(line_match) = LINE_REGEX.find(line) {
            // Extract the matched part of the line
            let matched_text = line_match.as_str();
            for capture in CALLSIGN_REGEX.captures_iter(matched_text) {
                if capture.name("callsign").is_some() {
                    add_callsign(
                        &capture, "callsign", line, msg_pos, true, &mut res,
                    );
                }
            }
        }
        msg_pos += cline_len(line) + 1;
    }
    Ok(res)
}

fn add_callsign(
    capts: &regex::Captures,
    name: &str,
    line: &str,
    msg_pos: usize,
    check_capital: bool,
    res: &mut Vec<CNCallsign>,
) -> bool {
    let Some(callsign_match) = capts.name(name) else {
        return false;
    };
    let callsign: String = callsign_match.as_str().to_string();
    if check_capital && callsign != callsign.to_uppercase() {
        return false;
    };
    if cline_len(&callsign) > crate::config::CALLSIGNS_MAX_LEN {
        return false;
    };
    let callsign = callsign.to_lowercase();
    if callsign == "й" || callsign == "нв" || callsign == "укх" {
        return false;
    }
    if !callsign.chars().any(|c| c.is_alphabetic())
        && !is_numeric_callsign(&callsign)
    {
        return false;
    }
    res.push(CNCallsign {
        begin: msg_pos
            + crate::utils::string::byte_to_char_index(
                line,
                callsign_match.start(),
            ),
        end: msg_pos
            + crate::utils::string::byte_to_char_index(
                line,
                callsign_match.end(),
            ),
        etalon: callsign.clone(),
        text: callsign_match.as_str().to_string(),
    });
    true
}

fn first_line_comintify_operator(
    lines: &Vec<String>,
) -> Result<bool, AppError> {
    // first, check if second line looks like: "11.03, 11:25:50"
    if lines.len() < 2 {
        return Ok(false);
    }
    let line2 = &lines[1];
    lazy_static! {
        static ref RE_DATE: Regex =
            Regex::new(r"^\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}$").unwrap();
    }
    if !RE_DATE.is_match(line2) {
        return Ok(false);
    }
    Ok(true)
}

/// Extracts callsigns if the text is in "buran"'s format
fn extract_buran_callsigns(input: &str) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> = input.lines().map(|x| x.to_string()).collect();
    let mut msg_pos = 0;

    lazy_static! {
        static ref RE_CALLSIGN: Regex =
            Regex::new(r"^Хто: (?P<callsign>.*);.*$").unwrap();
        static ref RE_CALLSIGN_2: Regex =
            Regex::new(r"^Кому: (?P<callsign>.*);.*$").unwrap();
        static ref RE_CALLSIGN_3: Regex =
            Regex::new(r"^Позивні: (?P<callsign>[^,\s]*)(\,\s*(?P<callsign2>[^,\s]*))?(\,\s*(?P<callsign3>[^,\s]*))?.*$").unwrap();
    }
    let mut res: Vec<CNCallsign> = vec![];
    // println!("> msg_pos: {msg_pos}");

    for line in lines.iter() {
        '_if: {
            let Some(capts) = RE_CALLSIGN.captures(line) else {
                break '_if;
            };
            let Some(callsign_match) = capts.name("callsign") else {
                break '_if;
            };
            let callsign: String =
                callsign_match.as_str().to_lowercase().trim().to_string();
            if callsign == "нв" {
                break '_if;
            }
            res.push(CNCallsign {
                begin: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.start(),
                    ),
                end: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.end(),
                    ),
                etalon: callsign.clone(),
                text: callsign_match.as_str().to_string(),
            });
        }
        '_if: {
            let Some(capts) = RE_CALLSIGN_2.captures(line) else {
                break '_if;
            };
            let Some(callsign_match) = capts.name("callsign") else {
                break '_if;
            };
            let callsign: String =
                callsign_match.as_str().to_lowercase().trim().to_string();
            if callsign == "нв" {
                break '_if;
            }
            let callsign = callsign.to_lowercase().trim().to_string();
            res.push(CNCallsign {
                begin: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.start(),
                    ),
                end: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.end(),
                    ),
                etalon: callsign.clone(),
                text: callsign_match.as_str().to_string(),
            });
        }
        '_if: {
            let Some(capts) = RE_CALLSIGN_3.captures(line) else {
                break '_if;
            };
            let Some(callsign_match) = capts.name("callsign") else {
                break '_if;
            };
            let callsign: String =
                callsign_match.as_str().to_lowercase().trim().to_string();
            if callsign == "нв" {
                break '_if;
            }
            let callsign = callsign.to_lowercase().trim().to_string();
            res.push(CNCallsign {
                begin: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.start(),
                    ),
                end: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.end(),
                    ),
                etalon: callsign.clone(),
                text: callsign_match.as_str().to_string(),
            });

            let Some(callsign_match) = capts.name("callsign2") else {
                break '_if;
            };
            let callsign: String =
                callsign_match.as_str().to_lowercase().trim().to_string();
            if callsign == "нв" {
                break '_if;
            }
            let callsign = callsign.to_lowercase().trim().to_string();
            res.push(CNCallsign {
                begin: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.start(),
                    ),
                end: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.end(),
                    ),
                etalon: callsign.clone(),
                text: callsign_match.as_str().to_string(),
            });

            let Some(callsign_match) = capts.name("callsign3") else {
                break '_if;
            };
            let callsign: String =
                callsign_match.as_str().to_lowercase().trim().to_string();
            if callsign == "нв" {
                break '_if;
            }
            let callsign = callsign.to_lowercase().trim().to_string();
            res.push(CNCallsign {
                begin: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.start(),
                    ),
                end: msg_pos
                    + crate::utils::string::byte_to_char_index(
                        line,
                        callsign_match.end(),
                    ),
                etalon: callsign.clone(),
                text: callsign_match.as_str().to_string(),
            });
        }
        msg_pos += cline_len(line) + 1;
    }

    Ok(res)
}

/// Extracts callsigns in form 1-Й, 34-Й (i.e. numbers dash Й)
fn extract_digital_callsigns(input: &str) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> =
        input.trim().lines().map(|x| x.to_string()).collect();
    // println!("> lines: {lines:?}");
    let mut skip_lines = 0;
    let mut msg_pos = 0;

    if first_line_comintify_operator(&lines)? {
        skip_lines += 1;
        msg_pos += cline_len(&lines[0]) + 1;
    }

    // remove freq line
    if !lines.is_empty() {
        let line0 = &lines[0];
        if crate::rer_importer::frequency::extract_freq(line0)?.is_some() {
            skip_lines += 1;
            // println!("> shifting by {}", cline_len(line0) + 1);
            msg_pos += cline_len(line0) + 1;
        }
    }
    if !lines.is_empty() {
        if let Some(line0) = &lines.get(skip_lines) {
            if is_unit_line(line0) {
                skip_lines += 1;
                msg_pos += cline_len(line0) + 1;
            }
        }
    }
    // At most three items
    let mut lines = lines
        .iter()
        .skip(skip_lines)
        .cloned()
        .collect::<Vec<String>>();
    lines.truncate(crate::config::CALLSIGNS_MAX_LINES);

    lazy_static! {
        static ref RE_CALLSIGN: Regex =
            Regex::new(r"(?P<callsign>\b[0-9]{1,3}-?Й)(\s?\([^\s]+\))?\b")
                .unwrap();
    }
    let mut res: Vec<CNCallsign> = vec![];
    // println!("> msg_pos: {msg_pos}");

    for line in lines.iter() {
        for capture in RE_CALLSIGN.captures_iter(line) {
            if capture.name("callsign").is_some() {
                add_callsign(
                    &capture, "callsign", line, msg_pos, true, &mut res,
                );
            }
        }
        msg_pos += cline_len(line) + 1;
    }
    Ok(res)
}

/// Extracts callsigns if the text is in "non caps" format
///
fn extract_non_caps_callsigns(
    input: &str,
) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> =
        input.trim().lines().map(|x| x.to_string()).collect();
    // println!("> lines: {lines:?}");

    if !is_non_caps_format(&lines)? {
        return Ok(vec![]);
    }

    let skip_lines = 3;
    let mut msg_pos: usize = lines
        .iter()
        .take(skip_lines)
        .map(|line| cline_len(line))
        .sum::<usize>()
        + 1;

    let max_lines_to_process = match lines
        .iter()
        .skip(skip_lines)
        .position(|line| line.is_empty())
    {
        Some(pos) => pos,
        None => crate::config::CALLSIGNS_MAX_LINES,
    };

    let mut lines = lines
        .iter()
        .skip(skip_lines)
        .cloned()
        .collect::<Vec<String>>();
    lines.truncate(max_lines_to_process);

    lazy_static! {
        static ref RE_CALLSIGN: Regex =
            Regex::new(r"^(?P<callsign>[\p{Cyrillic}0-9A-Z]+(-[0-9]{1,3})?)(\s?\([^\s]+\))?$")
                .unwrap();
    }
    let mut res: Vec<CNCallsign> = vec![];
    for line in lines.iter() {
        '_if: {
            let Some(capts) = RE_CALLSIGN.captures(line) else {
                break '_if;
            };

            if !add_callsign(&capts, "callsign", line, msg_pos, false, &mut res)
            {
                break '_if;
            }
        }
        msg_pos += cline_len(line) + 1;
    }
    Ok(res)
}

/// Extracts callsigns in format  Отримувач(і): БАРС /n Відправник: БОРЕЦ
fn extract_sender_receiver_pair(
    input: &str,
) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> = input.lines().map(|x| x.to_string()).collect();
    let mut msg_pos = 0;

    lazy_static! {
        static ref RE_CALLSIGN: Regex = Regex::new(
            r"^(?:\s*)Отримувач(і|\(і\))?: (?P<callsign>[^,]*).*$(?:,\s*)?"
        )
        .unwrap();
        static ref RE_CALLSIGN_2: Regex = Regex::new(
            r"^(?:\s*)Відправник(и|\(и\))?: (?P<callsign>[^,]*).*$(?:,\s*)?"
        )
        .unwrap();
        static ref RE_CALLSIGN_3: Regex =
            Regex::new(r"^(?:\s*)(?P<callsign>[^,]*).*$(?:,\s*)?").unwrap();
    }
    let mut res: Vec<CNCallsign> = vec![];
    // println!("> msg_pos: {msg_pos}");

    fn try_get_callsign(
        line: &str,
        regex: &Regex,
        msg_pos: usize,
    ) -> Option<CNCallsign> {
        let capts = regex.captures(line)?;
        let callsign_match = capts.name("callsign")?;
        let callsign_raw = callsign_match.as_str();
        let callsign: String = callsign_raw.to_lowercase().trim().to_string();
        let normalized_callsign: String =
            callsign.chars().filter(|c| c.is_alphanumeric()).collect();
        if normalized_callsign == "нв" {
            return None;
        }
        Some(CNCallsign {
            begin: msg_pos
                + crate::utils::string::byte_to_char_index(
                    line,
                    callsign_match.start(),
                ),
            end: msg_pos
                + crate::utils::string::byte_to_char_index(
                    line,
                    callsign_match.end(),
                ),
            etalon: callsign.clone(),
            text: callsign_match.as_str().to_string(),
        })
    }

    let mut has_callsign = false;
    let mut iter = lines.iter();
    loop {
        let Some(line) = iter.next() else {
            break;
        };
        let callsign_1 = try_get_callsign(line, &RE_CALLSIGN, msg_pos);
        let callsign_2 = try_get_callsign(line, &RE_CALLSIGN_2, msg_pos);
        let callsign_3 = if has_callsign {
            try_get_callsign(line, &RE_CALLSIGN_3, msg_pos)
        } else {
            None
        };
        let callsign = callsign_1.or(callsign_2).or(callsign_3);
        msg_pos += cline_len(line) + 1;
        has_callsign = callsign.is_some() && line.trim().ends_with(",");
        let Some(callsign) = callsign else {
            continue;
        };
        res.push(callsign);
    }

    Ok(res)
}

/// Checks that text can have callsigns in non_caps format
/// Message should have there lines header with first like starts from "УКХ "
/// and third line should be like "11:32"
fn is_non_caps_format(lines: &Vec<String>) -> Result<bool, AppError> {
    lazy_static! {
        static ref RE_NETWORK: Regex = Regex::new(r"^УКХ .*").unwrap();
        static ref RE_DATE: Regex = Regex::new(r"^\d{2}:\d{2}$").unwrap();
    }

    if lines.len() < 4 {
        return Ok(false);
    }
    let line0 = &lines[0];
    if !RE_NETWORK.is_match(line0) {
        return Ok(false);
    }
    let line2 = &lines[2];
    if !RE_DATE.is_match(line2) {
        return Ok(false);
    }

    Ok(true)
}

/// Extracts callsigns if the text is in "авіа барʼєр"'s format
fn extract_avia_callsigns(input: &str) -> Result<Vec<CNCallsign>, AppError> {
    let lines: Vec<String> =
        input.trim().lines().map(|x| x.to_string()).collect();

    let skip_lines = avia_format_lines(&lines).unwrap_or(0);
    if skip_lines == 0 {
        return Ok(vec![]);
    }

    let mut msg_pos: usize = lines
        .iter()
        .take(skip_lines)
        .map(|line| cline_len(line))
        .sum::<usize>()
        + 1;

    let mut lines = lines
        .iter()
        .skip(skip_lines)
        .cloned()
        .collect::<Vec<String>>();
    lines.truncate(crate::config::CALLSIGNS_MAX_LINES);

    const LITERAL_CALLSIGN_STR: &str =
        r"[\p{Cyrillic}]+((-[\p{Cyrillic}]+)|(\s+\d{1,2}))?";
    const DIGITAL_CALLSIGN_STR: &str = r"(\d{1,3}[\s-]?[Йй])|(\d{4,5})";

    lazy_static! {
        // Regex for matching a single callsign
        static ref CALLSIGN_REGEX: Regex = Regex::new(&format!(
            r"^\s*(?P<callsign>(({LITERAL_CALLSIGN_STR})|({DIGITAL_CALLSIGN_STR})))\s*$"
        )).unwrap();
    }

    let mut res: Vec<CNCallsign> = vec![];

    for line in lines.iter() {
        for capture in CALLSIGN_REGEX.captures_iter(line) {
            if capture.name("callsign").is_some() {
                add_callsign(
                    &capture, "callsign", line, msg_pos, false, &mut res,
                );
            }
        }
        msg_pos += cline_len(line) + 1;
    }

    Ok(res)
}

fn avia_format_lines(lines: &Vec<String>) -> Result<usize, AppError> {
    //     Отримано з поста 35
    // --------------------------------------
    // 24.08.2025, 10:05:15
    // 128.9000
    // 🟠 УКХ р/м НВ підрозділу 128.900 МГц
    lazy_static! {
        static ref RE_POST: Regex = Regex::new(
            r#"^\s*Отримано з поста\s+[-0-9A-Z\p{Cyrillic}_/ \.\-\*"']+(\s|-)*$"#
        )
        .unwrap();
        static ref RE_SEPARATOR: Regex =
            Regex::new(r"^-{5,}\s*$").unwrap();
        static ref RE_DATE: Regex =
            Regex::new(r"^\s*\d{2}.\d{2}.\d{4},\s+\d{2}:\d{2}:\d{2}\s*$")
                .unwrap();
        static ref RE_FREQ: Regex =
            Regex::new(r"^\s*\d{3}.\d{3,4}\s*$").unwrap();
        static ref RE_NETWORK: Regex =
            Regex::new(r"^(🟠|🔴|🔷|🟡|⚫)|(\s*УКХ р/м).*$").unwrap();
        static ref RE_EMPTY: Regex = Regex::new(r"^\s*$").unwrap();
    }

    // Determine the minimum required lines
    // Minimum 5 lines (Post, Date, Freq, Network + one line after) if no separator
    // Minimum 6 lines (Post, Separator, Date, Freq, Network + one line after) if separator is present
    if lines.len() < 5 {
        return Err(AppError::BL {
            msg: "Not enough lines for avia format".to_string(),
        });
    }

    // 0. Check POST line
    let line0 = &lines[0];
    if !RE_POST.is_match(line0) {
        println!("RE_POST failed on line 0");
        return Err(AppError::BL {
            msg: "First line does not match RE_POST".to_string(),
        });
    }

    let mut line_index = 1;

    // 1. Optional separator
    if RE_SEPARATOR.is_match(&lines[line_index]) {
        line_index += 1;
        if lines.len() < 6 {
            return Err(AppError::BL {
                msg: "Not enough lines for avia format".to_string(),
            });
        }
    }

    // 2. DATE line
    if !RE_DATE.is_match(&lines[line_index]) {
        println!("RE_DATE failed on line {line_index}");
        return Err(AppError::BL {
            msg: "Line does not match RE_DATE".to_string(),
        });
    }
    line_index += 1;

    // 3. FREQ line
    if !RE_FREQ.is_match(&lines[line_index]) {
        println!("RE_FREQ failed on line {line_index}");
        return Err(AppError::BL {
            msg: "Line does not match RE_FREQ".to_string(),
        });
    }
    line_index += 1;

    // 4. NETWORK line OR optional empty line
    let mut check_index = line_index;

    if RE_EMPTY.is_match(&lines[check_index]) {
        // Skip empty line
        check_index += 1;

        if check_index >= lines.len() {
            return Err(AppError::BL {
                msg: "Empty line present but missing RE_NETWORK".to_string(),
            });
        }
    }

    // Now check RE_NETWORK at check_index
    if !RE_NETWORK.is_match(&lines[check_index]) {
        println!("RE_NETWORK failed on line {line_index}",);
        return Err(AppError::BL {
            msg: "Line does not match RE_NETWORK".to_string(),
        });
    }

    Ok(check_index + 1)
}

pub async fn oneoff_reprocess_callsign_tokens(
    mode: Mode,
    ps: &crate::OneoffReprocessCallsignTokensPs,
) -> Result<(), AppError> {
    let mut start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")
            .c(h!())?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S").c(h!())?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();

    while start_dt < end_dt {
        let start_shifted = start_dt + chrono::Duration::hours(1);
        let end_dt_step = if start_shifted > end_dt {
            end_dt
        } else {
            start_shifted
        };
        let txn = dbx.begin().await.c(h!())?;

        let inbox_items: Vec<(
            sigint_inbox_item::Model,
            Option<signal_message::Model>,
        )> = SigintInboxItem::find()
            .find_also_related(SignalMessage)
            // .join(
            //     JoinType::InnerJoin,
            //     sigint_inbox_item::Relation::SignalMessage.def(),
            // )
            .filter(sigint_inbox_item::Column::Datetime.gte(start_dt))
            .filter(sigint_inbox_item::Column::Datetime.lt(end_dt_step))
            .all(&txn)
            .await
            .c(h!())?;

        println!("> {}: processing {} items", start_dt, inbox_items.len());

        for (inbox_item, m_message) in inbox_items.iter() {
            // if i > 0 && i % 100 == 0 {
            //     println!("> i={i}");
            // }
            let Some(message) = m_message else {
                continue;
            };
            let callsigns: Vec<String> = match inbox_item.callsigns.clone() {
                None => vec![],
                Some(jv) => serde_json::from_value(jv).c(h!())?,
            };
            let Some(body) = message.body.clone() else {
                continue;
            };
            let callsign_tokens =
                highlight_callsigns(&rq, &body, &callsigns).await.c(h!())?;
            let mut inbox_item: sigint_inbox_item::ActiveModel =
                inbox_item.clone().into();
            inbox_item.callsign_tokens =
                Set(Some(serde_json::to_value(callsign_tokens).c(h!())?));
            inbox_item.update(&txn).await.c(h!())?;
        }

        txn.commit().await.c(h!())?;
        start_dt += chrono::Duration::hours(1);
    }

    Ok(())
}

pub async fn oneoff_reprocess_callsigns(
    mode: Mode,
    ps: &crate::OneoffReprocessCallsignsPs,
) -> Result<(), AppError> {
    let mut start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")
            .c(h!())?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S").c(h!())?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();

    let m = MultiProgress::new();
    while start_dt < end_dt {
        let start_shifted = start_dt + chrono::Duration::hours(1);
        let end_dt_step = if start_shifted > end_dt {
            end_dt
        } else {
            start_shifted
        };
        let txn = dbx.begin().await.c(h!())?;

        let inbox_items: Vec<(
            sigint_inbox_item::Model,
            Option<signal_message::Model>,
        )> = SigintInboxItem::find()
            .find_also_related(SignalMessage)
            .filter(sigint_inbox_item::Column::Reviewed.ne(true))
            .filter(sigint_inbox_item::Column::Datetime.gte(start_dt))
            .filter(sigint_inbox_item::Column::Datetime.lt(end_dt_step))
            .all(&txn)
            .await
            .c(h!())?;

        let pb = m.add(ProgressBar::new(inbox_items.len() as u64));
        pb.set_style(crate::utils::get_pb_style()?);
        pb.set_prefix(format!("[{start_dt} / {end_dt}]"));

        for (inbox_item, m_message) in inbox_items.iter() {
            pb.inc(1);
            let Some(message) = m_message else {
                continue;
            };
            let Some(body) = message.body.clone() else {
                continue;
            };
            let callsign_tokens =
                super::callsigns::find_known_callsigns(&rq, &body)
                    .await
                    .c(h!())?;
            let callsigns: Vec<String> = crate::utils::uniq_via_btreeset(
                &callsign_tokens
                    .iter()
                    .map(|x| x.etalon.clone())
                    .collect::<Vec<String>>(),
            );
            let callsign_tokens =
                highlight_callsigns(&rq, &body, &callsigns).await.c(h!())?;
            let mut inbox_item: sigint_inbox_item::ActiveModel =
                inbox_item.clone().into();
            inbox_item.callsigns =
                Set(Some(serde_json::to_value(callsigns).c(h!())?));
            inbox_item.callsign_tokens =
                Set(Some(serde_json::to_value(callsign_tokens).c(h!())?));
            inbox_item.update(&txn).await.c(h!())?;
        }
        pb.finish_with_message("done");

        txn.commit().await.c(h!())?;
        start_dt += chrono::Duration::hours(1);
    }
    m.clear()?;
    Ok(())
}

/// Graph data in D3 format. See [neo4jd3](https://github.com/eisman/neo4jd3)
#[post("/api/rer/analysis/callsigns-graph")]
pub async fn callsigns_graph(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CallsignsGraphReq>,
) -> Result<Json<NetJSONGraphAndMeta>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let req2 = AnalysisStatsReq {
        since_date_inclusive_ms: req.since_date_inclusive_ms,
        till_date_noninclusive_ms: req.till_date_noninclusive_ms,
        selected_groups: req.selected_groups.clone(),
        selected_senders: req.selected_senders.clone(),
        selected_freqs: req.selected_freqs.clone(),
        selected_posts: req.selected_posts.clone(),
        selected_callsigns: req.selected_callsigns.clone(),
        selected_units: req.selected_units.clone(),
        selected_locations: req.selected_locations.clone(),
        selected_networks: req.selected_networks.clone(),
        without_network: req.without_network,
        or_with_extended_form: req.or_with_extended_form,
        or_bookmarked: req.or_bookmarked,
        or_important: req.or_important,
        or_with_coords: req.or_with_coords,
        search: req.search.clone(),
        selected_tags: req.selected_tags.clone(),
        metadata_cc: req.metadata_cc.clone(),
        metadata_sender: req.metadata_sender.clone(),
        metadata_receiver: req.metadata_receiver.clone(),
        metadata_hash: req.metadata_hash.clone(),
        only_with_metadata: req.only_with_metadata,
        without_metadata: req.without_metadata,
        include_peleng_locations: req.include_peleng_locations,
        units_exact_match_only: req.units_exact_match_only,
        filter_tags_option: req.filter_tags_option,
        selected_aors: req.selected_aors.clone(),
        without_model_tags: req.without_model_tags,
        report_tags_only_this_unit: req.report_tags_only_this_unit,
    };

    let summary_table: SummaryTableFreq =
        super::analysis::summary_table_freq_1(&user, &env, &req2)
            .await
            .c(h!())?;
    let freqs: Vec<String> = uniq_via_btreeset(
        &summary_table
            .rows
            .iter()
            .map(|row| row.freq.clone())
            .collect::<Vec<String>>(),
    );
    let summary_table_callsigns = BTreeSet::from_iter(
        summary_table
            .rows
            .iter()
            .flat_map(|row| row.callsigns.clone()),
    );
    // println!("> freqs: {freqs:?}");
    // let all_callsigns: BTreeSet<String> = BTreeSet::from_iter(
    //     summary_table
    //         .rows
    //         .iter()
    //         .flat_map(|row| row.callsigns.clone())
    //         .collect(),
    // );

    #[derive(FromQueryResult, Debug)]
    struct Row {
        callsigns: serde_json::Value,
        count: i64,
    }
    let rows_res = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column_as(Expr::cust("distinct callsigns"), "callsigns")
        .column_as(Expr::col(signal_message::Entity).count(), "count")
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(
                crate::messenger::group::get_identity_sigint_groups(
                    &env.dbx, &login,
                )
                .await
                .c(h!())?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Freq.eq_any(freqs))
        .filter(sigint_inbox_item::Column::Checked.eq(Some(true)))
        .group_by(Expr::cust("1"));

    // println!(
    //     "> rows_res: {}",
    //     rows_res.build(DbBackend::Postgres).to_string()
    // );
    let rows_res: Vec<Row> =
        rows_res.into_model::<Row>().all(&env.dbx).await.c(h!())?;
    // println!("> rows_res: {rows_res:?}");

    let mut per_callsign_count: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows_res {
        let callsigns_jv = row.callsigns;
        let callsigns: Vec<String> =
            serde_json::from_value(callsigns_jv).c(h!())?;
        for callsign in callsigns {
            per_callsign_count
                .entry(callsign)
                .and_modify(|c| *c += row.count)
                .or_insert(row.count);
        }
    }
    let mut callsigns: Vec<AnalysisStatsCallsign> = per_callsign_count
        .iter()
        .filter(|(csgn, _c)| {
            summary_table_callsigns.contains(&csgn.to_string())
        })
        .map(|(csgn, c)| AnalysisStatsCallsign {
            callsign: csgn.clone(),
            count: *c,
        })
        .collect();

    // let mut callsigns = crate::rer_importer::analysis::stats_get_callsigns(
    //     &env,
    //     &,
    //     dt_since,
    //     dt_till,
    // )
    // .await.c(h!())?;

    // callsigns.sort_by(|a, b| b.count.partial_cmp(&a.count).unwrap());
    // let mut callsigns: Vec<crate::rer_importer::AnalysisStatsCallsign> =
    //     callsigns;
    let overall_count = callsigns.len();
    if req.nolimit != Some(true) {
        // limit to top N
        callsigns = callsigns
            .iter()
            .take(crate::config::CALLSIGNS_TO_VISUALISE)
            .cloned()
            .collect();
    }

    let all_callsigns: BTreeSet<String> =
        BTreeSet::from_iter(callsigns.iter().map(|x| x.callsign.clone()));

    #[derive(FromQueryResult)]
    struct Res {
        freq: Option<String>,
        callsigns: Option<serde_json::Value>,
    }
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
    let q = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::Callsigns, "callsigns")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        // .filter(signal_message::Column::DuplicateOf.is_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till));
    // .filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    let q = filter_selected_groups_and_senders_with_access(
        q,
        &req.selected_groups,
        &req.selected_senders,
        &sigint_groups,
    )?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_selected_metadata_for_callsigns_graph(q, &req)?;
    // println!(
    //     "> callsigns_graph q: {}",
    //     q.build(DbBackend::Postgres).to_string()
    // );
    let items: Vec<Res> = q.into_model::<Res>().all(&env.dbx).await.c(h!())?;

    let mut freqs_per_callsign: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for item in items.iter() {
        let Some(freq) = item.freq.clone() else {
            continue;
        };
        let Some(callsigns_jv) = item.callsigns.clone() else {
            continue;
        };
        let callsigns: Vec<String> =
            serde_json::from_value(callsigns_jv).c(h!())?;
        for callsign in callsigns.iter() {
            freqs_per_callsign
                .entry(callsign.to_string().to_lowercase())
                .and_modify(|fs| {
                    if !fs.contains(&freq) {
                        fs.push(freq.clone())
                    }
                })
                .or_insert(vec![freq.clone()]);
        }
    }

    let mut nodes = vec![];
    let mut links = vec![];

    for callsign in callsigns.iter() {
        nodes.push(NetJSONNode {
            id: callsign.callsign.clone(),
            name: callsign.callsign.clone().to_uppercase(),
            count: callsign.count,
            properties: freqs_per_callsign
                .get(&callsign.callsign.to_lowercase())
                .map(|x| NetJSONNodeProperties {
                    freqs: Some(x.clone()),
                }),
        });
    }

    let mut seen_rel = BTreeSet::new();
    let mut seen_freqs = BTreeSet::new();
    let mut link_categories = vec![];
    let colors = crate::config::get_colors();
    let rng = &mut rand::rng();
    for item in items {
        let Some(freq) = item.freq.clone() else {
            continue;
        };
        if !seen_freqs.contains(&freq) {
            seen_freqs.insert(freq.clone());
            link_categories.push(NetJSONLinkCategory {
                name: freq.clone(),
                link_style: NetJSONLinkCategoryLinkStyle {
                    color: colors.choose(rng).cloned(),
                    opacity: None,
                    width: Some(5),
                },
            });
        }
        let callsigns: Vec<String> = match item.callsigns {
            Some(jv) => serde_json::from_value(jv).c(h!())?,
            None => vec![],
        };
        for (i, callsign) in callsigns.iter().enumerate() {
            if !all_callsigns.contains(callsign) {
                continue;
            }
            for callsign2 in callsigns.iter().skip(i + 1) {
                if !all_callsigns.contains(callsign2) {
                    continue;
                }
                let mut callsign_pair =
                    vec![callsign.clone(), callsign2.clone()];
                callsign_pair.sort();
                if !seen_rel.contains(&callsign_pair) {
                    links.push(NetJSONLink {
                        source: callsign_pair[0].clone(),
                        target: callsign_pair[1].clone(),
                        cost: 1.0,
                        category: Some(freq.clone()),
                        properties: Some(NetJSONLinkProperties {
                            freq: Some(freq.clone()),
                        }),
                    });
                    seen_rel.insert(callsign_pair);
                }
            }
        }
    }

    Ok(Json(NetJSONGraphAndMeta {
        graph: NetJSONGraph {
            nodes,
            links,
            type_: "NetworkGraph".to_string(),
            date: "2023-04-23T05:06:54.000Z".to_string(),
        },
        link_categories: Some(link_categories),
        overall_count: Some(overall_count as i64),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_with_callsigns(callsigns: Vec<&str>) -> InboxMessage {
        InboxMessage {
            message_uid: None,
            text: String::new(),
            media: vec![],
            images: vec![],
            image_recognized: vec![],
            date: None,
            time: None,
            freq: None,
            coords: None,
            callsigns: callsigns
                .into_iter()
                .map(|callsign| callsign.to_string())
                .collect(),
            callsigns_alg2: vec![],
            checked: false,
            important: false,
            bookmarked: false,
            timestamp: None,
            group_master_key: None,
            sender: None,
            extended_form: None,
            post: None,
            post_id: None,
            unit: None,
            callsign_tokens: None,
            signal_tokens: None,
            point_tokens: None,
            no_headers_body: None,
            keyword_tokens: None,
            text_marked: None,
            datasource_id: None,
            location: None,
            tags: None,
            network_ids: None,
            inbox_tags: None,
            metadata: vec![],
        }
    }

    #[tokio::test]
    async fn extract_callsigns_nofirstline_01() {
        let rq = reqwest::Client::new();
        let body = r#"27.03.2023_07:04 F=149,0625(МГц)п2
УКХ радіомережа управління 1-й мсб 38 омсбр 35А (УКРАЇНСЬКЕ, ЗАГІРНЕ, КОСТЯНТИНІВКА)
"узнай,  ему довели информацию что документы его у Иваныча должны быть ?""#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert!(!ress.contains(&"1-й".to_string()))
    }

    #[ignore]
    #[tokio::test]
    async fn extract_callsigns_nofirstline_02() {
        let rq = reqwest::Client::new();
        let body = r#"27.03.2023_06:36 F=149,0625(МГц)П2
УКХ радіомережа управління 1-й мсб 38 омсбр 35А (УКРАЇНСЬКЕ, ЗАГІРНЕ, КОСТЯНТИНІВКА)
1-Й (НВ)
НВ (НВ)
"1. там с водой вместе на ноль должны приехать ещё коробочка с блинчиками для нас надо будет помочь
2. их сюда же да разгружать ?
1. ну да
2. принял""#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, vec!["1-Й"])
    }

    #[tokio::test]
    async fn extract_callsigns_03() {
        let rq = reqwest::Client::new();
        let body = r#"01.04.2023_15:00 F=411,7500(МГЦ)
Не встановлено (HB)
ПЕНЗА (HB)
ЛЕЩ (HB)
"1. лещ я пенза прийом.
2. на прийоме.
1. лещ давай на етих установках ищо 1-ну зажегалку атправляй.
2. принял.
2. на 5-м также да.
1. да.
1. как атправиш скажеш.
2. принял.
2. я лещ атправил.
1. да принял."
""#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["ПЕНЗА", "ЛЕЩ"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_04() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:43
УКХ р/м підрозділу артилерії 64 омсбр 35А (Новоселівка) (ЦФП90)
НВ
ДНЕПР, ДЕСНА-1

- Днепр я Десна 1  принял примерку
- ....Муха, 373. Большой черный, 60. ...Фундамент
- 357 056

(💥 Обстріл/планування обстрілу противником
)"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["ДНЕПР", "ДЕСНА-1"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_05() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:42:54
402.4150
УКХ р/м йм мсв мср 1 мсб 1199 мсп (ВОДЯНЕ)
НВ
4-Й

— Бункера...
—4-й принял.
— Вот так , да?"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(1)
                .collect::<Vec<_>>(),
            vec!["4-Й"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_06() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:38:38
400.1250
УКХ р/м НВ підрозділу 400.125 МГц П60
1— ТОСЯ
2— НВ

1— Марс, я Тося. Ты что то не проходишь у меня.
1— Я, да, тебя слышу.
2— А я его еле-еле, как слышу.
2— Понятно, сейчас прошу."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(1)
                .collect::<Vec<_>>(),
            vec!["ТОСЯ"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_07() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:35:42
427.3750
УКХ р/м йм. управління 1 гадн 291 абр (зах ОЧЕРЕТУВАТЕ)  427.375 МГц ЦФП 80
ЦЕНТРАЛЬНЫЙ
1-Й

1) 1-й, я  Центральный, прием.
1)1-й как принимаешь?.
1) Белый, трубку поставь рядом когда с тобой говорю.
1) Ангар, все работает?
2 ..... по светлому его отставлю....потом тут до утра....."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["ЦЕНТРАЛЬНЫЙ", "1-Й"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_08() {
        let rq = reqwest::Client::new();
        let body = r#"Отримано з поста "rer108"
--------------------------------------
09.01, 18:35:57
421.1495
УКХ р/м НВ підрозділу 421.1495 МГц ЦФП 80
КРОНА-45
ГЛАВА-07

— Глава -07, Глава- 07, я Крона- 45.
— Глова -07 не прошло.
— Крона, я Глава.
— Я Крона проверку маршрута совершил. Прием.
— Глава 07, я Крона не прошло."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["КРОНА-45", "ГЛАВА-07"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_09() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:11
УКХ р/м підрозділ зі складу 336 обрмп БВ БФ (Новозлатопіль-Вишневе) (ЦФП93)
НВ
35-Й, КИНДЕР

- Тридцать пятый, принял.
- Киндер заканчивает готовить 35-й"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["35-Й", "КИНДЕР"]
        )
    }
    #[tokio::test]
    async fn extract_callsigns_10() {
        let rq = reqwest::Client::new();
        let body = r#"09.01.2025_18:34 F=446,0810(МГц) ЦФП62
1 загін "Барс"
1- ДЕМОН
2- ВОЛНА

1-Волна, Волна, Демону, коробочка дома.
2-Принял тебя, Демон."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["ДЕМОН", "ВОЛНА"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_11() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 18:40
УКХ р/м підрозділ зі складу 336 обрмп БВ БФ (Новозлатопіль-Вишневе) (ЦФП93)
НВ
КАПЛЯ, 35-Й

- Выйди на Каплю, скажи что бы в готовности были.
- Тридцать пятый, принял."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["КАПЛЯ", "35-Й"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_12() {
        let rq = reqwest::Client::new();
        let body = r#"09.01, 17:07:25
401.9000
УКХ р/м йм мср 1 мсб 1199 мсп
ВОЛНА-7
ВОЛНА-6, ВОЛНА-8

— Волна 6, Волна 8, я Волна 7.
— ... уберите, сейчас через две минуты."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(3)
                .collect::<Vec<_>>(),
            vec!["ВОЛНА-7", "ВОЛНА-6", "ВОЛНА-8"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_13() {
        let rq = reqwest::Client::new();
        let body = r#"03.09.2025_18:52 F=136.2350(МГц) _
УКХ р/м 1843 омсб 68 мсд 6 А (РАДЬКІВКА-КАЛИНОВЕ) 🔑
АВРОРА, ЁЖ, КУРСК
НВ
1. Аврора 21
2. Ёж 22, по небу пока 10
1. Курск, да, принял"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(3)
                .collect::<Vec<_>>(),
            vec!["АВРОРА", "ЁЖ", "КУРСК"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_14() {
        let rq = reqwest::Client::new();
        let body = r#"03.09.2025_18:25 F=154.1580(МГц) _
УКХ р/м 1843 омсб 68 мсд 6 А (РАДЬКІВКА-КАЛИНОВЕ) 🔑
ФРУНЗЕ, КОБА,
СОЛДАТ, СТУДЕНТ,
5. СОЛДАТ на приём, СОЛДАТ на приём блядь!
5. СОЛДАТ обстановку дай обстановку?
1. Так, блядь, еще раз повторяю, Фрунзе, блядь, соображай маленько побыстрее, блядь, быстрее, маленько побыстрее, у Солдата запросить обстановку....
5. Солдат, Солдат, бегом обстановочку, братишка, бегом.
5. Коба 22 обстановка у пацанов
1. Студент я Коба прием
1. Так, Камушек, Камушек, повыше подними, прохожий со мной связь, как ты принял?
2. принял
1. давай соберись,по щекам по ногам....ты же мужик ебаный в рот блядь
1. еще раз открытые места нужно ну очень бегом преодолевать ну очень быыстро,...
1. так а пока я сказал на шевелимся,как принял
1. Студент я Коба прием
1. все братишка одна малая и движем"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(4)
                .collect::<Vec<_>>(),
            vec!["ФРУНЗЕ", "КОБА", "СОЛДАТ", "СТУДЕНТ"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_15() {
        let rq = reqwest::Client::new();
        let body = r#"03.09.2025_18:13 F=136.2350(МГц) _
УКХ р/м 1843 омсб 68 мсд 6 А (РАДЬКІВКА-КАЛИНОВЕ) 🔑
ТАМБОВ, МОСКВА, ИС, ОРЁЛ, ГСМ
НВ
1. Тамбов 22, небо пока +
2. Москва, не прошёл Москва
2. ИС 22, принял. Как слышишь, разбираешь?
2. Орёл 22, принял
3. ГСМ 22"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(5)
                .collect::<Vec<_>>(),
            vec!["ТАМБОВ", "МОСКВА", "ИС", "ОРЁЛ", "ГСМ"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_16() {
        let rq = reqwest::Client::new();
        let body = r#"08.09.2025, 14:05:08
161.2000
🅳🅼🆁УКХ р/м взаємодії 3 мсб 1432 мсп (☀️р-н Володимирівка - Котлярівка) (07.03.25) 🟢 ⚫
ПЛЯЖ
ЗАКУП, ИВА 4

— Я Пляж 409 с запада на восток, по северам.
— Закуп я Ива 4 зимут выхода 280, 290 120й ..."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(3)
                .collect::<Vec<_>>(),
            vec!["ПЛЯЖ", "ЗАКУП", "ИВА 4"]
        )
    }

    #[tokio::test]
    async fn extract_callsigns_17() {
        let rq = reqwest::Client::new();
        let body = r#"Отримано з поста "33_1"
--------------------------------------
08.09.2025, 14:07:06
143.1500
УКХ р/м управління, ймовірно, зрбатр 1 мсп 2 мсд 1 ТА (КАРПІВКА, НОВЕ, ДОНЕЦЬКА ОБЛАСТЬ) 143.150 МГц
ДУБ 3
ГУСАР

— Гусар, Гусар, я Дуб 3. Проверка связи. Как меня слышно?
— Гусар, Гусар, я Дуб 3. Как меня слышишь? Прием."#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            crate::utils::uniq_via_btreeset(&ress)
                .into_iter()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["ДУБ 3", "ГУСАР"]
        )
    }

    #[test]
    fn extract_callsigns_kazhanchik_01() {
        let body = r#"03.04.2023_08:49 F=145,5500(МГц)
УКХ р/м управління БТГр 70 мсп 42 мсд 58 А ((РОБОТИНЕ))
НВ (НВ)
СОКОЛ (НВ)
"1. вийди на правада"
""#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let ress: Vec<String> = res.iter().cloned().map(|x| x.text).collect();
        assert_eq!(ress, vec!["СОКОЛ"]);
        assert_eq!(
            res,
            vec![crate::rer_importer::highlight::CNCallsign {
                begin: 97,
                end: 97 + 5,
                etalon: "сокол".to_string(),
                text: "СОКОЛ".to_string(),
            }]
        )
    }

    #[test]
    fn extract_callsigns_kazhanchik_02() {
        lazy_static! {
            static ref RE_CALLSIGN: Regex =
                Regex::new(r"^(?P<callsign>[^\s]+)$").unwrap();
        }
        let body = "СОКОЛ";
        println!("{:?}", RE_CALLSIGN.captures(body).unwrap());
    }

    #[test]
    fn extract_callsigns_kazhanchik_03() {
        let body = r#"01.04.2023_10:16 F=470,1000(МГц)
НВ(Не встановлено)
КУБАНЬ
КАЗАНЬ
"- По нам прилетело, по середине в поле с задней стороны в Яр!
- (1) Карандаши прибыли.....
- Принял, пусть сразу.."
""#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, vec!["КУБАНЬ", "КАЗАНЬ"])
    }

    #[test]
    fn extract_callsigns_kazhanchik_04() {
        let body = r#"01.04.2023_10:00 F=463,1250(МГц)
ймовірно 1 мсб 291 мсп 42 мсд 58 А (пн зах РОБОТИННЕ).
НВ (НВ)
НВ (НВ)
"- Кто стрелял ??//Я на посту Артик позивний 33 било розрешение взяли пострелять сегодня постреляли успокоилися что за паника если конкретно нада кто стрелял значит можна узнать и поговорить""#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn strip_callsigns_prefix_multiline_header() {
        let body = r#"ЛАВИНА
СЕРБ
ОРЕНБУРГ
ВОЛГОГРАД
- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь
- (2) -ЛАВИНА ... да сейчас!"#;
        let message = message_with_callsigns(vec![
            "ЛАВИНА",
            "СЕРБ",
            "ОРЕНБУРГ",
            "ВОЛГОГРАД",
        ]);

        assert_eq!(
            strip_callsigns_prefix(body, &message),
            r#"- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь
- (2) -ЛАВИНА ... да сейчас!"#
        );
    }

    #[test]
    fn strip_callsigns_prefix_placeholder_and_list() {
        let body = r#"НВ
МИТЯ, ГНОМ, КУБА, ИМАН

1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?????"#;
        let message =
            message_with_callsigns(vec!["МИТЯ", "ГНОМ", "КУБА", "ИМАН"]);

        assert_eq!(
            strip_callsigns_prefix(body, &message),
            "1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?????"
        );
    }

    #[test]
    fn strip_callsigns_prefix_numbered_callsigns() {
        let body = r#"1- ДЕМОН
2- ВОЛНА

1-Волна, Волна, Демону, коробочка дома.
2-Принял тебя, Демон."#;
        let message = message_with_callsigns(vec!["ДЕМОН", "ВОЛНА"]);

        assert_eq!(
            strip_callsigns_prefix(body, &message),
            r#"1-Волна, Волна, Демону, коробочка дома.
2-Принял тебя, Демон."#
        );
    }

    #[test]
    fn strip_callsigns_prefix_drops_preamble_before_callsigns() {
        let body = r#"2 р/м 2 управління зрбатр 1430 мсп 42 мсд 58 А (НОВЕ, СОЛОДКА БАЛКА)
Вафівфів23.02.2026, 07:59:07
НВ
ГНОМ

— Все нормально, все нормально, Залыч, Залыч, там ГНОМ его встречает."#;
        let message = message_with_callsigns(vec!["ГНОМ"]);

        assert_eq!(
            strip_callsigns_prefix(body, &message),
            "— Все нормально, все нормально, Залыч, Залыч, там ГНОМ его встречает."
        );
    }

    #[test]
    fn strip_callsigns_prefix_non_caps_header() {
        let body = r#"УКХ р/м ймов. 352 мсп 1 ТА
(БЕРЕСТОВЕ - СТЕЛЬМАХІВКА)
11:32
Барс
Борец

1.Барс Борцу."#;
        let message = message_with_callsigns(vec!["Барс", "Борец"]);

        assert_eq!(strip_callsigns_prefix(body, &message), "1.Барс Борцу.");
    }

    #[test]
    fn extract_callsigns_kazhanchik_05() {
        let body = r#"02.04.2023_15:46 F=453,2000(МГц)
УКХ р/м 1 мсб 503 мсп 19 мсд 58 ЗА (р-н МИРНЕ)
КИРПИЧ (НВ)
АМПЕР (НВ)
"1.- АМПЕР АМПЕР - прогревайся подьезжай к СЕРОМУ КИРПИЧУ буем загружать""#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, vec!["КИРПИЧ", "АМПЕР"])
    }

    #[test]
    fn extract_callsigns_kazhanchik_06() {
        let body = r#"02.04.2023_21:40 F=450,7250(МГц)
-
КОЛАК11
НВ (НВ)
"- (1) Колак11 стакан полный "
"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, vec!["КОЛАК11"])
    }

    #[test]
    fn extract_callsigns_kazhanchik_07() {
        let body = r#"123,4500
321.4500
Ла ла ла
"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_08() {
        let body = r#"28.10, 09:36:13п33
Не встановлено
МАЛЫШ
КАСПЕР

1.Каспер, я Малыш.
2. Каспер, да.
1.Пост  Краснодар, север на 2 часа. Работает ТАНК,  кладет туда изумительно.
2. Принял."#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["МАЛЫШ".to_string(), "КАСПЕР".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_09() {
        let body = r#"⚠️ 28.10.2023_16:03 F=467.7550(МГц) П51
НВ
НВ
ГЛАДИАТОР
АЗОВ
АЙРОН
- Спрашивают где тело (ГАЙЦА) как принял, ты где находишься ....
- Там еще спрашивают вы сможете помочь .... (тело) эвакуировать!?
- .... как принял!?
- (2) АЗОВ я ГЛАДИАТОР приём
- Тело (ГАЙДУКА) проясни ... находится (ГОНЕЦ) тоже там находится ...
- ..... огромная !
- .... одного, потому что у одного там что-то плечо ....
- (4) ГЛАДИАТОР я АЙРОН как меня принимаешь
- (2) -На 5-ть
- (4) -... АЗОВ шумит ... по утру когда будет смена АЗОВ даст еще одного карандашика , чтобы при смене (по утру) они помогли ... вытащить ГАЙДУКА!
- ..... что это всё будет по утру!
- -Да да  принял!"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "ГЛАДИАТОР".to_string(),
            "АЗОВ".to_string(),
            "АЙРОН".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_10() {
        let body = r#"27.10, 18:02:28
433.3750
Пн. Вербове | підрозділ н.в.

НВ (1)
НВ (2)
ТИХИЙ
СУХОЙ
ЗВЕЗДА

1. Сухому.
2.Она у меня въебала вот здесь тоже. Тихий какраз здесь у меня был.
1. Угомони блядь. Ловушку,  заебал он нахуй прятаться от меня.
2. Как вариант блядь.
1. 300 на 733, как принял?
1. Трое 300 от Звезды на 733. Как принял? Прием."#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "ТИХИЙ".to_string(),
            "СУХОЙ".to_string(),
            "ЗВЕЗДА".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_12() {
        let body = r#"27.10, 18:02:28
433.3750
Пн. Вербове | підрозділ н.в.

НВ
ИРТЫШ 2
ЗОРЯ 2

- Иртыш2, Заря2. Значит цели, 459 и х 201, сегодня максимально популярны. Будем по ним роботать, то по одной то по второй. Значит, в готовности роботать."#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["ИРТЫШ 2".to_string(), "ЗОРЯ 2".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }
    #[test]
    fn extract_callsigns_kazhanchik_commas() {
        let body = r#"23.02, 19:44:18
434.4350
УКХ радіомережа управління 2 мср 1 мсб 28 мсп 70 мсдм західніше КОЗАЧІ ЛАГЕРІ
МАНГОЛ
13Й, АПРЕЛЬ

— Апрель, Монголу.
— Тринадцатый, я выхожу за воздухом.
— Я понял, слежу.
-- Апрель, Апрель, ответь Монголу.
-- На приеме, на приеме.
-- Я выхожу, ты что там?
-- Я тоже уже выхожу."#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "МАНГОЛ".to_string(),
            "13Й".to_string(),
            "АПРЕЛЬ".to_string(),
        ];
        let expected2: Vec<String> = vec![
            "мангол".to_string(),
            "13й".to_string(),
            "апрель".to_string(),
        ];
        let ress: Vec<String> = res.iter().cloned().map(|x| x.text).collect();
        assert_eq!(ress, expected);
        let ress2: Vec<String> =
            res.iter().cloned().map(|x| x.etalon).collect();
        assert_eq!(ress2, expected2);
    }

    #[tokio::test]
    async fn extract_callsigns_kazhanchik_exclude_uhw() {
        let rq = reqwest::Client::new();
        let body = r#"19-09 01:14:12
145.915
УКХ
ЧАО
МОЗДОК

– Продолжает работать вражеский миномет с азимута 240.

Коментар: T2"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let expected: Vec<String> =
            vec!["ЧАО".to_string(), "МОЗДОК".to_string()];
        let ress: Vec<String> =
            res.into_iter().take(2).map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[test]
    fn extract_callsigns_buran_01() {
        let body = r#"Дата: 2024-02-21;
Частота: 408.500;
Локація: Авдіївка (йм. в напрямку Ласточкине);
Підрозділ: УКХ р/м невизначеного підрозділу;
Час: 17:28;
Хто: Змей;
Кому: Чёрный;
Текст:
- Чёрный я Змей ответь по керосину
- ..
- 3 мсб? правильно?;
.
Коментар: ( запит на зв'язок );"#;
        let res = extract_buran_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["Змей".to_string(), "Чёрный".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_buran_02() {
        let body = r#"Час: 21:23
Дата: 27.02.2024
Частота: 420.210;
Локація: в смузі Піски - Первомайське;
Підрозділ: УКХ р/м невизначеного підрозділу;
Абоненти:
Позивні: АМИГА, ТИХИЙ

— Амига Тихому, Амига Тихому, на связь.
— Братись, ты смотри, если он сильно тяжелый, сильно тяжелый, они пусть его с собой не таскают, потому что и сами могут там лечь, рядышком, нахуй, блядь. Они сами двигаются, сами пусть передвигаются. Его куда нибудь, в укромное место, в укромное место.

( у ворога йм. 1 300 )"#;
        let res = extract_buran_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["АМИГА".to_string(), "ТИХИЙ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_with_7_callsigns() {
        let body = r#"30.07.2025, 10:39:23

УКХ р/м очс МВД (МЕЛІТОПОЛЬ) ймовірно ретранслятор ДМР
РУДА
СИЛЬНЫЙ, РЕДУТ, ВЕТЕР, 714 -Й, ВЕТЕР -4, 712-Й

— Внимание, я Руда, объявлена атака БПЛА по всей Запорожской области.
— Ветер -4, Ветру.
-- Внимание всем постам, я Сильный, объявлена опасность БПЛА по всей Запорожской области.
-- 714-й принял.
-- 712-й принял.
-- Внимание всем постам, я Редут, объявлена опасность БПЛА по всей Запорожской области.

Мітки перехоплення: БПЛА - фіксація БПЛА СОУ"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "РУДА".to_string(),
            "СИЛЬНЫЙ".to_string(),
            "РЕДУТ".to_string(),
            "ВЕТЕР".to_string(),
            "714 -Й".to_string(),
            "ВЕТЕР -4".to_string(),
            "712-Й".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_buran_03() {
        let body = r#"Час: 21:23
Дата: 27.02.2024
Частота: 420.210;
Локація: в смузі Піски - Первомайське;
Підрозділ: УКХ р/м невизначеного підрозділу;
Абоненти:
Позивні: АМИГА, ТИХИЙ, ГРОМКИЙ

— Амига Тихому, Амига Тихому, на связь.
— Братись, ты смотри, если он сильно тяжелый, сильно тяжелый, они пусть его с собой не таскают, потому что и сами могут там лечь, рядышком, нахуй, блядь. Они сами двигаются, сами пусть передвигаются. Его куда нибудь, в укромное место, в укромное место.

( у ворога йм. 1 300 )"#;
        let res = extract_buran_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "АМИГА".to_string(),
            "ТИХИЙ".to_string(),
            "ГРОМКИЙ".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[test]
    fn extract_callsigns_kazhanchik_11() {
        let body = r#"⚠️ 01.11.2023_20:03 F=477.8750(МГц) П51
УКХ р/м ймовірно 108 дшп
НВ
ГЛАДИАТОР
РОЩА
- не видно где они находятся ?  а то ЗОРКИЙ с ними в связь не может выйти ,  я им сказал пока в окопах там находиться и впереди ЗОРКОГО, спроси у ДЕСНЫ конкретные повреждения, он сказал всё разьебашили
- впереди ЗОРКОГО?
- закрпеляйтесь в нём сидите, метров 50 у вас до зоркого
- принял, мужики держитесь, закрепитесь в этом окопе
- сидите, там ЗОРКИЙ рядом
- они впереди ЗОРКОГО метров 50 вот и 50 метров начинаеться впереди них кишка где они прошли начали работать там вот, сидят там ждут пока кончиться обстрел
- (2) РОЩА  ГЛАДИАТОР приём
- все целые?
- принял тебя закрепляйтесь"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["ГЛАДИАТОР".to_string(), "РОЩА".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected)
    }

    #[tokio::test]
    async fn test_highlight_callsigns_01() {
        let body = r#"17.04.2023_11:57 F=405,5300(МГц)
2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)
КАНАТ
НВ (НВ)
"- (НВ) Канад ТОП передвижение 10 минут
- Топ передвижений 10 малых""#;
        let rq = reqwest::Client::new();
        let res = highlight_callsigns(&rq, body, &vec!["канат".to_string()])
            .await
            .unwrap();

        assert_eq!(res.len(), 1);
        assert_eq!(res[0].etalon, "канат");
        assert_eq!(res[0].text, "КАНАТ");
        assert_eq!(res[0].begin, 95);
        assert_eq!(res[0].end, 100);
    }

    //     #[tokio::test]
    //     async fn find_known_callsigns_sever() {
    //         let dbx = crate::new_p g_pool_x(Mode::Debug).await.unwrap();
    //         let rq = reqwest::Client::new();
    //         let body = r#"17.04.2023_20:33 F=417,1500(МГц)
    // Не встановлено (НВ)
    // НВ (НВ)
    // НВ (НВ)
    // "1. наблюдаю звьоздачку на вастоке но не над нами а висако очень  такая светица далеко далеко, летит в сторану как би  Белагорье туда на север"""#;
    //         let res = find_known_callsigns(&dbx, &rq, body).await.unwrap();
    //         let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    //         assert_eq!(ress, vec!["север"]);
    //         assert_eq!(
    //             res,
    //             vec![crate::rer_importer::highlight::CNCallsign {
    //                 begin: 206,
    //                 end: 206 + 5,
    //                 etalon: "север".to_string(),
    //                 text: "север".to_string(),
    //             }]
    //         )
    //     }

    #[tokio::test]
    async fn test_highlight_callsigns_02() {
        let body = r#"17.04.2023_14:26 F=441,1625(МГц)
Не встановлено (НВ)
05Й (НВ)
КОПЧЕНЫЙ (НВ)
"1.- Я тебе как поставлю там наблюдательный пост зенитчиков рядом есть , подойди скажи !
2.- понял принял
1.- КРОТУ еще много копать?
2.-0 Да КРОРТУ еще четыре ямы больших
1.- Там где место для сбора раненых , вот такой же возле него нужно выкопать блендаж
1.0- Прийди покажи он как раз будетт в том районе копать , пусть прийдет он как раз в том районе будет копать
2.- да принял сейчас пришлю человека .
1.- МАЛИНА я 05Й место для сбора раненых , которое мы подготовилм , и слева от него где то метров 10ть , там где справа  БЛЕНДАЖИ , там надо такой же выкопать блендаж , КОПЧЕНОМУ подойди покажи место , а ес
ли стоит ТЕХНИКА , от сбора раненых в лесополке пусть выкопает такой же ширины и длины ...""#;
        let rq = reqwest::Client::new();
        let res = highlight_callsigns(
            &rq,
            body,
            &vec!["05й".to_string(), "копченый".to_string()],
        )
        .await
        .unwrap();

        println!("> res: {res:?}");
        assert_eq!(res.len(), 3);
        // assert_eq!(1, 2);
        // assert_eq!(res[0].etalon, "канат");
        // assert_eq!(res[0].text, "КАНАТ");
        // assert_eq!(res[0].begin, 143);
        // assert_eq!(res[0].end, 153);
    }

    #[test]
    fn test_callsign_match_start() {
        let body = "йде НАПАС по полю";
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"^йде (?P<callsign>[\p{Cyrillic}0-9A-Z][^\s]+).*")
                    .unwrap();
        }
        let capts = RE.captures(body).unwrap();
        let callsign_match = capts.name("callsign").unwrap();
        let callsign: String = callsign_match.as_str().to_string();
        assert_eq!(callsign, "НАПАС");
        assert_eq!(
            crate::utils::string::byte_to_char_index(
                body,
                callsign_match.start()
            ),
            4
        );
    }

    #[tokio::test]
    async fn test_highlight_callsigns_03() {
        let body = r#"18.04.2023_10:12 F=436,8500(МГц)
Не встановлено (НВ)
КАКТУС (НВ)
ОСТРОВ (НВ)
"- Кактус Острову. Камаз подъезжает""#;
        let rq = reqwest::Client::new();
        let res = highlight_callsigns(
            &rq,
            body,
            &vec!["кактус".to_string(), "остров".to_string()],
        )
        .await
        .unwrap();

        println!("> res: {res:?}");
        assert_eq!(res.len(), 4);
        assert_eq!(
            res,
            [
                CNCallsign {
                    begin: 53,
                    end: 59,
                    etalon: "кактус".to_string(),
                    text: "КАКТУС".to_string()
                },
                CNCallsign {
                    begin: 65,
                    end: 71,
                    etalon: "остров".to_string(),
                    text: "ОСТРОВ".to_string()
                },
                CNCallsign {
                    begin: 80,
                    end: 86,
                    etalon: "кактус".to_string(),
                    text: "Кактус".to_string()
                },
                CNCallsign {
                    begin: 87,
                    end: 94,
                    etalon: "остров".to_string(),
                    text: "Острову".to_string()
                }
            ]
        );
    }

    #[tokio::test]
    async fn test_highlight_callsigns_04() {
        let body = r#"18.04.2023_10:32 F=463,1250(МГц)
ймовірно 1 мсб 291 мсп 42 мсд 58 А (пн зах РОБОТИННЕ).
КАМЫЗЯК
НВ (НВ)
"- (1) На приеме Камызяк
 -  Принял
 -  Слышу
 -  Птичка наша""#;
        let rq = reqwest::Client::new();
        let res = highlight_callsigns(&rq, body, &vec!["камызяк".to_string()])
            .await
            .unwrap();

        println!("> res: {res:?}");
        assert_eq!(res.len(), 2);
        assert_eq!(
            res,
            [
                CNCallsign {
                    begin: 88,
                    end: 95,
                    etalon: "камызяк".to_string(),
                    text: "КАМЫЗЯК".to_string()
                },
                CNCallsign {
                    begin: 121,
                    end: 128,
                    etalon: "камызяк".to_string(),
                    text: "Камызяк".to_string()
                }
            ]
        );
    }

    #[tokio::test]
    async fn test_extract_callsigns_skip_commintify_01() {
        let body = r#"SER490
11.03, 11:25:50
413.3500
УКХ р/м 3 мсб 123 омсбр (2 омсбр) 2 АК (БІЛОГОРІВКА-ВЕСЕЛЕ)
ЗАЯЦ

- ЗАЯЦ гуляет по левой. ЗАЯЦ гуляет по левой стороне.
"#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec!["ЗАЯЦ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_with_digit() {
        let body = r#"06.04, 08:38:18
445.2500
УКХ р/м НВ підрозділу 445.250 МГц
2- БЕЛКА
3- ДЮШЕС, 1- НВ, 4- НВ

1— Меня вызываешь, не проходит, не слышно, трескотня конкретная.
2— Как принимаешь?.
1— Вот сейчас лучше.
1— Минут 10 назад небо грязное было, прилеты там куда то западнее, думал, хуйня.
2— Да, принял, принял тебя. Дюшес, Белки, Дюшес.
3— На связи, на связи.
2— Что то не уточнил, а броня Ермака у кого? На нем осталось или у Филина?
3— должна быть .....
3— У Филина уточни.
4— .... должен был вернуться, или что?
2— Он у вас на доме, вот там, прилет."#;

        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["БЕЛКА".to_string(), "ДЮШЕС".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_with_4_callsigns() {
        let body = r#"22.04, 12:23:57 п1
420.4500
УКХ р/м управління 2 мсб 114 мсп 127 мсд 5 А (зх. ЧКАЛОВА)
НВ
МИТЯ, ГНОМ, КУБА, ИМАН

1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?"#;

        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "МИТЯ".to_string(),
            "ГНОМ".to_string(),
            "КУБА".to_string(),
            "ИМАН".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_with_7_callsigns() {
        let body = r#"22.04, 12:23:57 п1
420.4500
УКХ р/м управління 2 мсб 114 мсп 127 мсд 5 А (зх. ЧКАЛОВА)
НВ
МИТЯ, ГНОМ, КУБА, ИМАН, КАБАН, ТРАМВАЙ, САМОРЕЗ

1. Митя, Гном, Куба, Иман, Кабан, Трамвай, Саморез. Коса 18. Слышали, да?"#;

        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> = vec![
            "МИТЯ".to_string(),
            "ГНОМ".to_string(),
            "КУБА".to_string(),
            "ИМАН".to_string(),
            "КАБАН".to_string(),
            "ТРАМВАЙ".to_string(),
            "САМОРЕЗ".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[ignore]
    #[tokio::test]
    async fn test_extract_callsigns_zp() {
        let body = r#"28.11, 18:56
УКХ р/м н/в підрозділу артилерії зі складу 127 мсд 5А (ЦфП91)
НВ
РУБИН, КУПОЛ-6

- Рубин 308, 43 22, прием.
- Купол 6, я Рубин 310, 43 22. Прием."#;
        let res = extract_kazhanchik_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["РУБИН".to_string(), "КУПОЛ-6".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[ignore]
    #[tokio::test]
    async fn test_extract_callsigns_emoji_list() {
        let body = r#"26.04, 04:37:43
424.8750
УКХ р/м НВ підрозділу 424.875 МГц
ХЬЮСТОН 1️⃣
ВОЛГА 2️⃣

1️⃣: Волга я Хюстон на приеме.
2️⃣: ... у Спеца, там, давай, смотри, там, небо, блядь, дорогу и забирай его.
1️⃣: Да, принял."#;
        let res = extract_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["РУБИН".to_string(), "КУПОЛ-6".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_kharkiv() {
        let body = r#"УКХ р/м управління Шторм 155 обр МП
 (в районі північна частина дачного масиву ГЛИБОКЕ)
12:45	ПАТРИОТ	ГЮРЗА	452.366	1. Ты из какого хазяйства
2. С 9го полка. Оказал ДОБРОМУ помощь… перебинтовал
1. А нгде находитесь сориентируй
2. Сейчас открою карту и скажу
1. Спроси у ДОБРОГО он должен знать где находится
2. Рядом с МЕДУЗОЙ по правой стороне, вся дорога в лепестках. Как принял?"#;
        let res = extract_kharkiv_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["ПАТРИОТ".to_string(), "ГЮРЗА".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_kharkiv_02() {
        let body = r#"25.08.2024 управління підрозділу зі складу 83 одшбу (район ТИХЕ) 17:28 БАТЯ, СУББОТА ГАЛ 410.325
1. БАТЯ как слишиш, принимаеш...СУББОТА ГАЛУ, 105. БАТЯ я ГАЛ, проверка связи...СУББОТА я слишу...
(нов)"#;
        let res = extract_kharkiv_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["БАТЯ".to_string(), "СУББОТА".to_string(), "ГАЛ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_kharkiv_03() {
        let body = r#"УКХ р/м управління підрозділу противника
(напрямок уточнюється)
10:11 7-Й УРАЛ 446.875 1. Выстрел
2. Выстрел да
(3)"#;
        let res = extract_kharkiv_callsigns(body).unwrap();
        let expected: Vec<String> = vec!["7-Й".to_string(), "УРАЛ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn extract_callsigns_without_freq_01() {
        let rq = reqwest::Client::new();
        let body = r#"УКХ р/м 25 омсбр 6 А (ЛИМАН-1 — ТАВІЛЬЖАНКА)
13:59
МОНАХ
СТАРЫЙ
1. Так, Монах, Монах, я старый, просто ответь, всё, принял, смотри, щас пойдёт наш карандашик, позывной Череп, он мимо тебя пройдёт, мимо тебя, не надо его баранить, там, кричать ему привет, просто мимо тебя пройдёт, как меня принял?"#;
        let res = find_known_callsigns(&rq, body).await.unwrap();
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(
            ress.into_iter().take(2).collect::<Vec<String>>(),
            vec!["МОНАХ", "СТАРЫЙ"]
        )
    }

    #[tokio::test]
    async fn test_extract_callsigns_non_caps_01() {
        let body = r#"УКХ р/м 25 омсбр 6А
(ВІЛЬШАНА — ЛИМАН-1)
11:40
Гранит
Нв

1. Как дела у вас че засухарились?
2. Нет-нет, двигаемся, двигаемся пасут
1. ...карандашик на мотоцикле, чтоб хоть поближе кого-нибудь подвозил, …
2. К точке выгрузки к точк выгрузки
1. Я понял ты через сколько там будешь?
2. Все по небу … максимум 15 малых
1. все я тебя принял хорошо
"#;
        let res = extract_non_caps_callsigns(body).unwrap();
        let expected: Vec<String> = vec!["Гранит".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_non_caps_02() {
        let body = r#"УКХ р/м ймов. 352 мсп 1 ТА
(БЕРЕСТОВЕ - СТЕЛЬМАХІВКА)
11:32
Барс
Борец

1.Барс Борцу.
2.Барс на связи.
1.Барс надо выполнять задачу группа Яндекс.
1.Хоть 400-сотый там они должны быть сегодня это наша задача.
1.Барс ты меня как принял должны быть в 416 точке сегодня группы сейчас где доложи мне обстановку у меня спрашивают."#;
        let res = extract_non_caps_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["Барс".to_string(), "Борец".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor1() {
        let body = r#"352 мсп 1 ТА
р-н БЕРЕСТОВЕ - СТЕЛЬМАХІВКА
555.23 МГц

06.08.2025 15:45.23

Отримувач(і): БАРС
Відправник: БОРЕЦ

1.Барс Борцу.
2.Барс на связи.
1.Барс надо выполнять задачу группа Яндекс.
1.Хоть 400-сотый там они должны быть сегодня это наша задача.
1.Барс ты меня как принял должны быть в 416 точке сегодня группы сейчас где доложи мне обстановку у меня спрашивают."#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> =
            vec!["БАРС".to_string(), "БОРЕЦ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor2() {
        let body = r#"352 мсп 1 ТА
р-н БЕРЕСТОВЕ - СТЕЛЬМАХІВКА
555.23 МГц

06.08.2025 15:45.23

Отримувач: БАРС,
Відправник: БОРЕЦ

1.Барс Борцу.
2.Барс на связи.
1.Барс надо выполнять задачу группа Яндекс.
1.Хоть 400-сотый там они должны быть сегодня это наша задача.
1.Барс ты меня как принял должны быть в 416 точке сегодня группы сейчас где доложи мне обстановку у меня спрашивают."#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> =
            vec!["БАРС".to_string(), "БОРЕЦ".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor3() {
        let body = r#" УКХ р/м зі складу 352 мсп (МВО)
 ОРЛЯНСЬКЕ
 150.500
 11.08.2025 9:56:52
 Відправник: Хитмен
 Отримувач(і): Сибирь
 Перехоплення:
 1. Сибирь Хитмену.
 2. Сибирь, сейчас наша коробочка работает по соседней посадке, ей бы правее, ещё метра на 700, там напротив работал миномёт на  Скорого.
 3. Не в нашу сторону, а вообще в сторону Сокола, туда работал миномёт.
 4. Хитмен Хитмен азимут можешь сказать?   "#;
        let res = extract_callsigns(body).unwrap();
        let expected: Vec<String> =
            vec!["Хитмен".to_string(), "Сибирь".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_sender_receiver_pair_ignores_nv_with_backslash(
    ) {
        let body = r#"⚡⚡⚡10УКХ р/м упр. підрозділом 270 мсп
НОВОФЕДОРІВКА

05.11.2025 15:44:53

Отримувач(і):
Відправник: н\в

1. Наша коробка, приедет, привезет карандаши, встретит, разметишь их и баню надо будет затопить как выйдет я тебе скажу ..."#;
        let res = extract_callsigns(body).unwrap();
        assert!(res.is_empty(), "expected no callsigns, got: {res:?}");
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor4() {
        let body = r#"УКХ р/м зі складу 222 мсп (МВО)
 ОРЛЯНСЬКЕ
 01.01.2025 3:3:03
 Відправник: Бульдог
 Отримувач(і): Псих,
  Люстра
 Перехоплення:
 1. Бульдог Люстра.
 2. Псих, сейчас наша коробочка работает по соседней посадке, ей бы правее, ещё метра на 700, там напротив работал миномёт на  Скорого.
 3. Не в нашу сторону, а вообще в сторону Сокола, туда работал миномёт.
 4. Люстра Люстра азимут можешь сказать?   "#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> = vec![
            "Бульдог".to_string(),
            "Псих".to_string(),
            "Люстра".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor5() {
        let body = r#"УКХ р/м зі складу 222 мсп (МВО)
 ОРЛЯНСЬКЕ
 01.01.2025 3:3:03
 Відправник: Бульдог
 Отримувач(і): Псих,
  1234
 Перехоплення:
 1. Бульдог Люстра.
 2. Псих, сейчас наша коробочка работает по соседней посадке, ей бы правее, ещё метра на 700, там напротив работал миномёт на  Скорого.
 3. Не в нашу сторону, а вообще в сторону Сокола, туда работал миномёт.
 4. Люстра Люстра азимут можешь сказать?   "#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> = vec![
            "Бульдог".to_string(),
            "Псих".to_string(),
            "1234".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_format_hoor6() {
        let body = r#"УКХ р/м управління 52 орб 68 мсд 6 А
ДВОРІЧНА-ЗАПАДНЕ
03.09.2025 17:52:55
Відправник: Тор
Отримувач(і): Топаз,
Тору
Перехоплення:
1. Топаз Тору показывает технику, по главной трасе синей по дороге двигается в сторону Купянска, как принял?
1. Топаз Тору показывает технику, рядом с красней и синей дорогой, ориентир 45, карандаш, техника не двигаеться.
1. Топаз Тору показывает технику, ориентир 21, канат, направление в сторону Кучеровки."#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> =
            vec!["Тор".to_string(), "Топаз".to_string(), "Тору".to_string()];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }

    #[tokio::test]
    async fn test_extract_callsigns_sender_receiver_pair_with_5_callsigns() {
        let body = r#"УКХ р/м зі складу 222 мсп (МВО)
 ОРЛЯНСЬКЕ
 01.01.2025 3:3:03
 Відправник: Бульдог
 Отримувач(і): Псих,
  1234,
  Картон,
  Коробка
 Перехоплення:
 1. Бульдог Люстра.
 2. Псих, сейчас наша коробочка работает по соседней посадке, ей бы правее, ещё метра на 700, там напротив работал миномёт на  Скорого.
 3. Не в нашу сторону, а вообще в сторону Сокола, туда работал миномёт.
 4. Люстра Люстра азимут можешь сказать?   "#;
        let res = extract_sender_receiver_pair(body).unwrap();
        let expected: Vec<String> = vec![
            "Бульдог".to_string(),
            "Псих".to_string(),
            "1234".to_string(),
            "Картон".to_string(),
            "Коробка".to_string(),
        ];
        let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
        assert_eq!(ress, expected);
    }
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_caps_5_digits() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
18.08.2025, 13:32:10
128.500
УКХ р/м НВ підрозділу 128.500 МГц
44307
Саксофон

— Саксофон-контроль 44307 под ваше, следую на правдивый по обратному"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["44307".to_string(), "Саксофон".to_string()];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_nv() {
    let body = r#"Отримано з поста 35
--------------------------------------
24.08.2025, 10:05:15
128.9000
🟠 УКХ р/м НВ підрозділу 128.900 МГц
НВ
НВ

— 50 на 150, 8 точка 5.
— Э, условия принял. Посадочный  2 7 0."#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_3_digits() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 10:34:29
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
669-й
16Й

- с вами контрольная эш 245"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec!["669-й".to_string(), "16Й".to_string()];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_5_digits_caps() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 12:36:35
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["46131".to_string(), "САКСОФОН".to_string()];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_callsign_with_digit() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 12:36:35
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
16-Й
КОРШУН 4

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["16-Й".to_string(), "КОРШУН 4".to_string()];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_callsign_with_defis() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 12:36:35
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
321Й
Саксофон-контроль

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["321Й".to_string(), "Саксофон-контроль".to_string()];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_post_line() {
    let body = r#"--------------------------------------
24.08.2025, 12:36:35
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_date_line() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_unexpected_date_line() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
2025.08.21, 123635
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_sep_line() {
    let body = r#"Отримано з поста 31_1
24.08.2025, 12:36:35
128.5000
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["46131".to_string(), "САКСОФОН".to_string()];
    let ress: Vec<String> = res
        .into_iter()
        .take(2)
        .map(|x: CNCallsign| x.text)
        .collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_freq_line() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 12:36:35
🟠 УКХ р/м управління Московського ЗЦ ЄСУПР (Московського зонального центру Єдиної системи управління повітряним рухом) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_no_net_line() {
    let body = r#"Отримано з поста 31_1
--------------------------------------
24.08.2025, 12:36:35
128.5000
46131
САКСОФОН

— С Ворсовко отработал не возражает проход"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![];
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_net_name_without_uhw() {
    let body = r#"Отримано з поста "31"
--------------------------------------
19.09.2025, 17:13:35
128.5000
🟠 р/м Єдиної системи управління повітряним рухом ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)
12705
САКСОФОН

— Контроль 12705, с Ильменем отработали, пролет зоны разрешений ... 1 8 0.
— Займу эшелон 1 8 0, доложу 12705.."#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["12705".to_string(), "САКСОФОН".to_string()];
    let ress: Vec<String> = res.into_iter().take(2).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_slash_in_post() {
    let body = r#"Отримано з поста "31/1"
--------------------------------------
19.09.2025, 15:31:00
128.500
🟠Єдиної системи управління повітряним рухом ПКС зс рф

61112
ВОРСОВКА
ИЛЬМЕНЬ

— ... канале запрашивают, 61112.
— 61112 день добрый от экипажа курсом Беплу на ЭШ 280 прошу разрешения на пролет вашей зоны
— Разрешили Ворсовка спс до свидание 61...
— Ильмень 61112.
— 61.... Подхожу к точке Беплу. На эшелоне....
— Курсом Готби, разрешите пролет вашей зоны на эшелоне 2 8 0.
— С Ильменем и Ворсовкой установил, пролет зоны на ЭШ 280 не возражает"#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec![
        "61112".to_string(),
        "ВОРСОВКА".to_string(),
        "ИЛЬМЕНЬ".to_string(),
    ];
    let ress: Vec<String> = res.into_iter().take(3).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_catch_four_digits() {
    let body = r#"Отримано з поста "31/1"
--------------------------------------
19.09.2025, 17:51:53
118.900
🟠УКХ р/м НВ підрозділу 118.900 МГц

ДВОР
3346


— Двор, 3346, работу закончил, разрешите по обратному ..."#;
    let res = extract_avia_callsigns(body).unwrap();
    let expected: Vec<String> = vec!["ДВОР".to_string(), "3346".to_string()];
    let ress: Vec<String> = res.into_iter().take(2).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_catch_five_digits_no_separator() {
    let body = r#"Отримано з поста "31/1" --------------------------------------
16.11.2025, 12:10:11
128.3500
🟠УКХ р/м бойового управління авіації ПНА 336 ртп (Орел) 32 д ППО (Ржев) ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР РФ)128.350 МГц

44127
БАРСУК

— Барсук 44127, 500 ... занял 6 500."#;
    let res = extract_avia_callsigns(body).unwrap();
    // let res = extract_callsigns(body).unwrap();
    let expected: Vec<String> = vec!["44127".to_string(), "БАРСУК".to_string()];
    let ress: Vec<String> = res.into_iter().take(2).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_catch_five_digits_asterisk_in_post()
{
    let body = r#"Отримано з поста "**33"
--------------------------------------
18.11.2025, 07:39:45
124.325

⚫ УКХ р/м управління повітряним рухом в зоні відповідальності ае “Центральний” (Ростов-на-Дону) ПКС зс рф

46579
ФИНАЛ
-Финал 46579
-Привет
-46579, доброе утро экипажам ...одиночных площадок, следую к вам, прошел ... Александровка вошел вашу зону, подход ..."#;
    let res = extract_avia_callsigns(body).unwrap();
    // let res = extract_callsigns(body).unwrap();
    let expected: Vec<String> = vec!["46579".to_string(), "ФИНАЛ".to_string()];
    let ress: Vec<String> = res.into_iter().take(2).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_catch_five_digits_single_quote_in_post(
) {
    let body = r#"Отримано з поста " '31/1' Курсант"
-------------------------------
25.11.2025, 10:14:47
128.5000
🟠р/м Єдиної системи управління повітряним рухом ПКС зс рф

САКСОФОН
47578

— Саксофон контроль 47578 с Балтимором ... на ЭШ 190 не возражает
— ... 190 занял ... Инбал"#;
    let res = extract_avia_callsigns(body).unwrap();
    // let res = extract_callsigns(body).unwrap();
    let expected: Vec<String> =
        vec!["САКСОФОН".to_string(), "47578".to_string()];
    let ress: Vec<String> = res.into_iter().take(2).map(|x| x.text).collect();
    assert_eq!(ress, expected);
}

#[tokio::test]
async fn test_extract_callsigns_avia_format_spaces_in_separator() {
    let body = r#"Отримано з поста "31_1"   
--------------------------------------   
23.12.2025, 10:57:24 
128.5000   
🟠 УКХ р/м Єдиної системи управління повітряним рухом ПКС зс рф (ПОВІТРЯНИЙ ПРОСТІР ЗС РФ)  
06969 
КРЕМНИЙ 

- по обратному..."#;
    let res = extract_avia_callsigns(body).unwrap();
    let ress: Vec<String> = res.into_iter().map(|x| x.text).collect();
    assert_eq!(
        crate::utils::uniq_via_btreeset(&ress)
            .into_iter()
            .take(2)
            .collect::<Vec<_>>(),
        vec!["06969", "КРЕМНИЙ"]
    )
}
