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
        Regex::new(r"\b[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}\b")
            .unwrap();
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
            if !value.starts_with('%') && !value.ends_with('%') {
                format!("%{value}%")
            } else if !value.starts_with('%') {
                format!("%{value}")
            } else if !value.ends_with('%') {
                format!("{value}%")
            } else {
                value
            }
        })
        .collect();

    // Remove negative quoted parts before processing regular quotes
    let without_neg = RE_NEG_QUOTES.replace_all(&inp, "");

    // Extract quoted parts for ilike.
    let ilike: Vec<String> = RE_QUOTES
        .captures_iter(&without_neg)
        .map(|cap| {
            let value = cap[1].to_string();
            if !value.starts_with('%') && !value.ends_with('%') {
                format!("%{value}%")
            } else if !value.starts_with('%') {
                format!("%{value}")
            } else if !value.ends_with('%') {
                format!("{value}%")
            } else {
                value
            }
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

    // Remove standalone "and" words.
    let without_and = RE_AND.replace_all(&without_freq, "");
    // Collapse multiple spaces.
    let ts_query = trim_ts_query(
        &without_and.split_whitespace().collect::<Vec<_>>().join(" "),
    )
    .context(h!())?
    .unwrap_or(String::new());
    Ok(SearchParts {
        ts_query,
        ilike,
        not_ilike,
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
            ts_query: "(foo or bar) or -wazz".to_string(),
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
