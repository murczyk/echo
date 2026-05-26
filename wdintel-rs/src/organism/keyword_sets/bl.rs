use crate::config::{
    ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET, ORGANISM_KEYWORD_SET_MAX_WORD_LEN,
};
use crate::error::AppError;
use sea_orm::DbErr;
use std::collections::BTreeSet;
use std::error::Error as StdError;

pub const KEYWORD_SET_NAME_TAKEN_MSG: &str = "Набір з такою назвою вже існує";

pub fn keyword_set_name_taken_err() -> AppError {
    AppError::BL {
        msg: KEYWORD_SET_NAME_TAKEN_MSG.to_string(),
    }
}

pub fn map_keyword_set_db_err(err: DbErr) -> AppError {
    if is_postgres_unique_violation(&err) {
        keyword_set_name_taken_err()
    } else {
        err.into()
    }
}

fn is_postgres_unique_violation(err: &DbErr) -> bool {
    let mut source: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = source {
        if let Some(sqlx::Error::Database(db)) = e.downcast_ref::<sqlx::Error>()
        {
            if db.code().as_deref() == Some("23505") {
                return true;
            }
        }
        source = e.source();
    }
    false
}

pub fn normalize_keyword_words(
    words: &[String],
) -> Result<Vec<String>, AppError> {
    let mut seen = BTreeSet::new();
    let mut res = vec![];
    for raw in words {
        let w = raw.trim().to_lowercase();
        if w.is_empty() {
            continue;
        }
        if w.chars().count() > ORGANISM_KEYWORD_SET_MAX_WORD_LEN {
            return Err(AppError::BL {
                msg: format!(
                    "Слово перевищує {} символів",
                    ORGANISM_KEYWORD_SET_MAX_WORD_LEN
                ),
            });
        }
        if seen.insert(w.clone()) {
            res.push(w);
        }
        if res.len() > ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET {
            return Err(AppError::BL {
                msg: format!(
                    "Набір не може містити більше {} слів",
                    ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET
                ),
            });
        }
    }
    Ok(res)
}

/// Inflect output: dedupe/lowercase, skip overlong tokens, cap at max words (no error on cap).
pub fn normalize_inflect_output_words(words: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut res = vec![];
    for raw in words {
        let w = raw.trim().to_lowercase();
        if w.is_empty() || w.chars().count() > ORGANISM_KEYWORD_SET_MAX_WORD_LEN
        {
            continue;
        }
        if seen.insert(w.clone()) {
            res.push(w);
            if res.len() >= ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET {
                break;
            }
        }
    }
    res
}

pub fn keyword_set_can_manage(
    author_login: Option<&str>,
    viewer_login: &str,
    viewer_is_admin: bool,
) -> bool {
    viewer_is_admin || author_login == Some(viewer_login)
}

pub fn keyword_set_can_edit(
    author_login: Option<&str>,
    viewer_login: &str,
    viewer_is_admin: bool,
) -> bool {
    keyword_set_can_manage(author_login, viewer_login, viewer_is_admin)
}

pub fn keyword_set_can_delete(
    author_login: Option<&str>,
    viewer_login: &str,
    viewer_is_admin: bool,
) -> bool {
    keyword_set_can_manage(author_login, viewer_login, viewer_is_admin)
}

pub fn merge_lexeme_batches(lexemes_batch: Vec<Vec<String>>) -> Vec<String> {
    let mut merged = vec![];
    for forms in lexemes_batch {
        merged.extend(forms);
    }
    normalize_inflect_output_words(&merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keyword_words_dedupes_and_lowercases() {
        let words = vec![
            "Птичка".to_string(),
            "  птичка ".to_string(),
            "НЕБО".to_string(),
            "".to_string(),
            "  ".to_string(),
        ];
        let out = normalize_keyword_words(&words).unwrap();
        assert_eq!(out, vec!["птичка", "небо"]);
    }

    #[test]
    fn normalize_keyword_words_rejects_too_long_word() {
        let long = "а".repeat(ORGANISM_KEYWORD_SET_MAX_WORD_LEN + 1);
        let err = normalize_keyword_words(&[long]).unwrap_err();
        match err {
            AppError::BL { msg } => assert!(msg.contains("символів")),
            _ => panic!("expected BL error"),
        }
    }

    #[test]
    fn normalize_keyword_words_rejects_too_many_words() {
        let words: Vec<String> = (0..=ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET)
            .map(|i| format!("w{i}"))
            .collect();
        let err = normalize_keyword_words(&words).unwrap_err();
        match err {
            AppError::BL { msg } => assert!(msg.contains("більше")),
            _ => panic!("expected BL error"),
        }
    }

    #[test]
    fn normalize_inflect_output_truncates_at_cap() {
        let words: Vec<String> = (0..ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET
            + 50)
            .map(|i| format!("lemma{i}"))
            .collect();
        let out = normalize_inflect_output_words(&words);
        assert_eq!(out.len(), ORGANISM_KEYWORD_SET_MAX_WORDS_PER_SET);
        assert_eq!(out[0], "lemma0");
    }

    #[test]
    fn normalize_inflect_output_skips_overlong_without_error() {
        let long = "б".repeat(ORGANISM_KEYWORD_SET_MAX_WORD_LEN + 1);
        let out =
            normalize_inflect_output_words(&["коротко".to_string(), long]);
        assert_eq!(out, vec!["коротко"]);
    }

    #[test]
    fn keyword_set_acl_rules() {
        assert!(keyword_set_can_edit(Some("alice"), "alice", false));
        assert!(keyword_set_can_delete(Some("alice"), "alice", false));

        assert!(!keyword_set_can_edit(Some("bob"), "alice", false));
        assert!(!keyword_set_can_delete(Some("bob"), "alice", false));

        assert!(!keyword_set_can_edit(None, "alice", false));
        assert!(!keyword_set_can_delete(None, "alice", false));

        assert!(keyword_set_can_edit(None, "alice", true));
        assert!(keyword_set_can_delete(None, "alice", true));
        assert!(keyword_set_can_edit(Some("bob"), "alice", true));
        assert!(keyword_set_can_delete(Some("bob"), "alice", true));
    }

    #[test]
    fn merge_lexeme_batches_flattens_and_dedupes() {
        let out = merge_lexeme_batches(vec![
            vec!["Летать".to_string(), "летает".to_string()],
            vec!["летает".to_string(), "ПТИЧКА".to_string()],
        ]);
        assert_eq!(out, vec!["летать", "летает", "птичка"]);
    }
}
