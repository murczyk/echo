use std::collections::BTreeSet;
use std::sync::OnceLock;

const DEFAULT_KEYWORD_SET_SEED_SQL: &str = include_str!(
    "../../../../echo-migration/src/seed_data_m20260520_120000_organism_default_keyword_set.sql"
);

fn parse_words_array_from_seed_sql(sql: &str) -> Vec<String> {
    let start = sql
        .find("ARRAY[")
        .map(|idx| idx + "ARRAY[".len())
        .unwrap_or(0);
    let rest = &sql[start..];
    let end = rest
        .find("]::text[]")
        .unwrap_or(rest.len());
    let inner = &rest[..end];
    let mut words = Vec::new();
    let mut chars = inner.char_indices();
    while let Some((_, ch)) = chars.next() {
        if ch != '\'' {
            continue;
        }
        let mut word = String::new();
        loop {
            match chars.next() {
                Some((_, c)) if c == '\'' => {
                    if matches!(chars.clone().next(), Some((_, '\''))) {
                        word.push('\'');
                        chars.next();
                    } else {
                        break;
                    }
                }
                Some((_, c)) => word.push(c),
                None => break,
            }
        }
        if !word.is_empty() {
            words.push(word);
        }
    }
    words
}

fn parsed_default_words() -> &'static Vec<String> {
    static WORDS: OnceLock<Vec<String>> = OnceLock::new();
    WORDS.get_or_init(|| parse_words_array_from_seed_sql(DEFAULT_KEYWORD_SET_SEED_SQL))
}

pub fn default_keyword_words_vec() -> Vec<String> {
    parsed_default_words().clone()
}

pub fn default_keyword_words_set() -> BTreeSet<String> {
    parsed_default_words().iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_sql_parses_to_non_empty_word_list() {
        let words = parse_words_array_from_seed_sql(DEFAULT_KEYWORD_SET_SEED_SQL);
        assert!(words.len() > 50);
        assert!(words.iter().any(|w| w == "птичка"));
    }
}
