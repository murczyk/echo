use crate::types::*;
use lazy_static::lazy_static;
use regex::Regex;

/// Structure representing parts of a search query.
///
/// Given a search phrase, the query is split into three parts:
/// - `ts_query`: segments for websearch_to_tsquery.
/// - `ilike`: segments for ilike matching.
/// - `not_ilike`: segments for not ilike matching.
///
/// For example: `foo "bar"` becomes
/// `SearchParts { ts_query: "foo", ilike: vec!["bar"], not_ilike: vec![] }`
///
/// Another example: `(foo or bar) and "BA%Z" or -wazz` becomes
/// `SearchParts { ts_query: "(foo or bar) or -wazz", ilike: vec!["BA%Z"], not_ilike: vec![] }`
///
/// Another example: `foo -"bar"` becomes
/// `SearchParts { ts_query: "foo", ilike: vec![], not_ilike: vec!["bar"] }`
pub struct SearchParts {
    pub ts_query: String,
    pub ilike: Vec<String>,
    pub not_ilike: Vec<String>,
    pub freq: Vec<String>,
    pub not_freq: Vec<String>,
    pub message_uids: Vec<String>,
}

lazy_static! {
    static ref RE_QUOTES: Regex = Regex::new(r#""([^"]+)""#).unwrap();
    static ref RE_NEG_QUOTES: Regex = Regex::new(r#"-"([^"]+)""#).unwrap();
    static ref RE_AND: Regex = Regex::new(r"\band\b").unwrap();
    static ref RE_FREQ: Regex =
        Regex::new(r"\b([0-9]{3}(\.|,)[0-9]{2,4})\b").unwrap();
    static ref RE_NEG_FREQ: Regex =
        Regex::new(r"(?:^|\s)(-([0-9]{3}(\.|,)[0-9]{2,4}))\b").unwrap();
    static ref RE_MSG_UID: Regex =
        Regex::new(r"\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b").unwrap();
    static ref RE_TS_PREFIX_TOKEN: Regex =
        Regex::new(r"^[\p{L}\p{N}_]+$").unwrap();
}

fn escape_like_fragment(input: &str, keep_percent_wildcards: bool) -> String {
    input
        .chars()
        .flat_map(|ch| match ch {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '_' => "\\_".chars().collect::<Vec<_>>(),
            '%' if !keep_percent_wildcards => "\\%".chars().collect(),
            _ => vec![ch],
        })
        .collect()
}

fn contains_pattern(value: &str, keep_percent_wildcards: bool) -> String {
    let value = escape_like_fragment(value, keep_percent_wildcards);
    if !value.starts_with('%') && !value.ends_with('%') {
        format!("%{value}%")
    } else if !value.starts_with('%') {
        format!("%{value}")
    } else if !value.ends_with('%') {
        format!("{value}%")
    } else {
        value
    }
}

fn trim_documented_inert_chars(value: &str) -> &str {
    value.trim_matches(|ch| ch == '+' || ch == '*' || ch == '(' || ch == ')')
}

fn has_inner_dot(value: &str) -> bool {
    value.char_indices().any(|(idx, ch)| {
        ch == '.' && idx > 0 && idx + ch.len_utf8() < value.len()
    })
}

fn extract_dotted_literals(inp: &str) -> (String, Vec<String>, Vec<String>) {
    let mut rest = vec![];
    let mut ilike = vec![];
    let mut not_ilike = vec![];

    for original_token in inp.split_whitespace() {
        let (negated, token) = match original_token.strip_prefix('-') {
            Some(token) => (true, token),
            None => (false, original_token),
        };
        let literal = trim_documented_inert_chars(token);
        if has_inner_dot(literal) {
            let pattern = contains_pattern(literal, false);
            if negated {
                not_ilike.push(pattern);
            } else {
                ilike.push(pattern);
            }
        } else {
            rest.push(original_token);
        }
    }

    (rest.join(" "), ilike, not_ilike)
}

fn normalize_ts_query(inp: &str) -> String {
    inp.chars()
        .map(|ch| match ch {
            '+' | '*' | '(' | ')' => ' ',
            _ => ch,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_search_parts(inp: &str) -> anyhow::Result<SearchParts> {
    let mut inp = inp.to_string();
    //extract message UIDs
    let message_uids = RE_MSG_UID
        .find_iter(&inp)
        .map(|m| m.as_str().to_string())
        .collect_vec();
    if !message_uids.is_empty() {
        inp = RE_MSG_UID.replace_all(&inp, "").to_string()
    }
    // Extract negative quoted parts for not_ilike
    let not_ilike: Vec<String> = RE_NEG_QUOTES
        .captures_iter(&inp)
        .map(|cap| {
            let value = cap[1].to_string();
            contains_pattern(&value, true)
        })
        .collect();

    // Remove negative quoted parts before processing regular quotes
    let without_neg = RE_NEG_QUOTES.replace_all(&inp, "");

    // Extract quoted parts for ilike.
    let ilike: Vec<String> = RE_QUOTES
        .captures_iter(&without_neg)
        .map(|cap| {
            let value = cap[1].to_string();
            contains_pattern(&value, true)
        })
        .collect();

    // Remove quoted parts.
    let non_quoted = RE_QUOTES.replace_all(&without_neg, "");

    // Extract negative freq
    let not_freq: Vec<String> = RE_NEG_FREQ
        .captures_iter(&non_quoted)
        .map(|cap| {
            let mut value = cap[2].replace(',', ".");
            if let Some(pos) = value.find('.') {
                let decimals = value.len() - pos - 1;
                if decimals < 4 {
                    value.push_str(&"0".repeat(4 - decimals));
                }
            }
            value
        })
        .collect();
    // Remove negative freq
    let without_neg_freq = RE_NEG_FREQ.replace_all(&non_quoted, "");

    // Extract freq
    let freq: Vec<String> = RE_FREQ
        .captures_iter(&without_neg_freq)
        .map(|cap| {
            let mut value = cap[1].replace(',', ".");
            if let Some(pos) = value.find('.') {
                let decimals = value.len() - pos - 1;
                if decimals < 4 {
                    value.push_str(&"0".repeat(4 - decimals));
                }
            }
            value
        })
        .collect();
    // Remove freq
    let without_freq = RE_FREQ.replace_all(&without_neg_freq, "");

    let (without_dotted_literals, dotted_ilike, dotted_not_ilike) =
        extract_dotted_literals(&without_freq);

    // Remove standalone "and" words.
    let without_and = RE_AND.replace_all(&without_dotted_literals, "");
    let ts_query = normalize_ts_query(&without_and);
    // Collapse multiple spaces.
    let ts_query = trim_ts_query(&ts_query).context(h!())?.unwrap_or_default();
    Ok(SearchParts {
        ts_query,
        ilike: ilike.into_iter().chain(dotted_ilike).collect(),
        not_ilike: not_ilike.into_iter().chain(dotted_not_ilike).collect(),
        freq,
        not_freq,
        message_uids,
    })
}

/// If the leftover ts_query contains only of whitespace and words like "and" or "or" (case insensitive) -- return None
pub fn trim_ts_query(inp: &str) -> anyhow::Result<Option<String>> {
    let trimmed = inp.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let is_only_and_or = trimmed.split_whitespace().all(|word| {
        let lower = word.to_lowercase();
        lower == "and" || lower == "or"
    });
    if is_only_and_or {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub fn ts_prefix_query(inp: &str) -> Option<String> {
    let tokens = inp.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return None;
    }

    let mut prefix_tokens = vec![];
    for token in tokens {
        let lower = token.to_lowercase();
        if lower == "and" || lower == "or" {
            return None;
        }
        if token.chars().count() < 3 {
            return None;
        }
        if !token.chars().any(char::is_alphabetic) {
            return None;
        }
        if !RE_TS_PREFIX_TOKEN.is_match(token) {
            return None;
        }
        prefix_tokens.push(format!("{token}:*"));
    }

    Some(prefix_tokens.join(" & "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple() {
        let input = r#"foo "bar""#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec!["%bar%".to_string()],
            not_ilike: vec![],
            freq: vec![],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_complex() {
        let input = r#"(foo or bar) and "BA%Z" or -wazz"#;
        let expected = SearchParts {
            ts_query: "foo or bar or -wazz".to_string(),
            ilike: vec!["%BA%Z%".to_string()],
            not_ilike: vec![],
            freq: vec![],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_trim_ts_query() {
        // Input with only "and" and "or" should return None.
        assert_eq!(trim_ts_query("  and OR and  ").unwrap(), None);
        // Input with additional tokens returns the trimmed string.
        assert_eq!(
            trim_ts_query("  foo and bar  ").unwrap(),
            Some("foo and bar".to_string())
        );
    }

    #[test]
    fn test_ts_prefix_query() {
        assert_eq!(ts_prefix_query("Берку"), Some("Берку:*".to_string()));
        assert_eq!(
            ts_prefix_query("Берку альфа"),
            Some("Берку:* & альфа:*".to_string())
        );
        assert_eq!(ts_prefix_query("Берку or альфа"), None);
        assert_eq!(ts_prefix_query("-Берку"), None);
        assert_eq!(ts_prefix_query("42"), None);
    }

    #[test]
    fn test_documented_inert_chars() {
        let result = parse_search_parts("+танк").unwrap();
        assert_eq!(result.ts_query, "танк");

        let result = parse_search_parts("танк*").unwrap();
        assert_eq!(result.ts_query, "танк");

        let result = parse_search_parts("(танк or бмп) посадка").unwrap();
        assert_eq!(result.ts_query, "танк or бмп посадка");
    }

    #[test]
    fn test_dotted_text_handling() {
        let result = parse_search_parts("abc.def танк -н.п.").unwrap();
        assert_eq!(result.ts_query, "танк");
        assert_eq!(result.ilike, vec!["%abc.def%".to_string()]);
        assert_eq!(result.not_ilike, vec!["%н.п.%".to_string()]);
        assert_eq!(result.freq, Vec::<String>::new());
    }

    #[test]
    fn test_dotted_text_does_not_capture_freqs() {
        let result = parse_search_parts("abc.def 165.25").unwrap();
        assert_eq!(result.ts_query, "");
        assert_eq!(result.ilike, vec!["%abc.def%".to_string()]);
        assert_eq!(result.freq, vec!["165.2500".to_string()]);
    }

    // Add new test for % handling
    #[test]
    fn test_percent_handling() {
        let tests = vec![
            (r#""test""#, "%test%"),
            (r#""%test""#, "%test%"),
            (r#""test%""#, "%test%"),
            (r#""%test%""#, "%test%"),
        ];

        for (input, expected) in tests {
            let result = parse_search_parts(input).unwrap();
            assert_eq!(result.ilike[0], expected);
        }
    }

    #[test]
    fn test_quoted_literal_escapes_underscore() {
        let result = parse_search_parts(r#""a_b""#).unwrap();
        assert_eq!(result.ilike, vec!["%a\\_b%".to_string()]);
    }

    // Add new test for not_ilike handling
    #[test]
    fn test_not_ilike_handling() {
        let input = r#"foo -"bar""#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec![],
            not_ilike: vec!["%bar%".to_string()],
            freq: vec![],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    // Add new test for freq handling
    #[test]
    fn test_freq_handling_01() {
        let input = r#"440.3567"#;
        let expected = SearchParts {
            ts_query: "".to_string(),
            ilike: vec![],
            not_ilike: vec![],
            freq: vec!["440.3567".to_string()],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_02() {
        let input = r#"440.3567 165.2500"#;
        let expected = SearchParts {
            ts_query: "".to_string(),
            ilike: vec![],
            not_ilike: vec![],
            freq: vec!["440.3567".to_string(), "165.2500".to_string()],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_03() {
        let input = r#"foo 440.3567 165.2500"#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec![],
            not_ilike: vec![],
            freq: vec!["440.3567".to_string(), "165.2500".to_string()],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_04() {
        let input = r#"foo "440.3567" 165.2500"#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec!["%440.3567%".to_string()],
            not_ilike: vec![],
            freq: vec!["165.2500".to_string()],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }
    #[test]
    fn test_freq_handling_05() {
        let input = r#"foo "440.3" 165.25 437.10"#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec!["%440.3%".to_string()],
            not_ilike: vec![],
            freq: vec!["165.2500".to_string(), "437.1000".to_string()],
            not_freq: vec![],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }
    #[test]
    fn test_freq_handling_06() {
        let input = r#"-433.035 foo -158.9000"#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec![],
            not_ilike: vec![],
            freq: vec![],
            not_freq: vec!["433.0350".to_string(), "158.9000".to_string()],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_07() {
        let input = r#"foo bar "440.3" -165.25 437.10"#;
        let expected = SearchParts {
            ts_query: "foo bar".to_string(),
            ilike: vec!["%440.3%".to_string()],
            not_ilike: vec![],
            freq: vec!["437.1000".to_string()],
            not_freq: vec!["165.2500".to_string()],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_08() {
        let input = r#"foo bar "440.3" bus -"поле" -165.25 -445.2300 437.10"#;
        let expected = SearchParts {
            ts_query: "foo bar bus".to_string(),
            ilike: vec!["%440.3%".to_string()],
            not_ilike: vec!["%поле%".to_string()],
            freq: vec!["437.1000".to_string()],
            not_freq: vec!["165.2500".to_string(), "445.2300".to_string()],
            message_uids: vec![],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }

    #[test]
    fn test_freq_handling_09() {
        let input = r#"foo bar "440.3" bus -"поле" -165.25 -445.2300 1208-6734-2879 437.10"#;
        let expected = SearchParts {
            ts_query: "foo bar bus".to_string(),
            ilike: vec!["%440.3%".to_string()],
            not_ilike: vec!["%поле%".to_string()],
            freq: vec!["437.1000".to_string()],
            not_freq: vec!["165.2500".to_string(), "445.2300".to_string()],
            message_uids: vec!["1208-6734-2879".to_string()],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }
    #[test]
    fn test_freq_handling_10() {
        let input = r#"foo "440.3" 165.25 437.10 hgsd-987n-8m3z"#;
        let expected = SearchParts {
            ts_query: "foo".to_string(),
            ilike: vec!["%440.3%".to_string()],
            not_ilike: vec![],
            freq: vec!["165.2500".to_string(), "437.1000".to_string()],
            not_freq: vec![],
            message_uids: vec!["hgsd-987n-8m3z".to_string()],
        };
        let result = parse_search_parts(input).unwrap();
        assert_eq!(result.ts_query, expected.ts_query);
        assert_eq!(result.ilike, expected.ilike);
        assert_eq!(result.not_ilike, expected.not_ilike);
        assert_eq!(result.freq, expected.freq);
    }
}
