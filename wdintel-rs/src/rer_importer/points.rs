use crate::entities::{palitra, palitra_point, palitra_point_lexeme};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::highlight::CNPoint;
use crate::types::ShortContext;
use crate::utils::orm::ArrayColumnOps;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QuerySelect,
};
use std::collections::BTreeMap;

pub async fn highlight_points(
    rq: &reqwest::Client,
    body: &str,
    point_forms: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<CNPoint>, AppError> {
    if point_forms.is_empty() {
        return Ok(vec![]);
    }
    let mut res = vec![];
    let body_chars: Vec<char> = body.chars().collect();
    let tokens = crate::nlp::tokenize_words(rq, body).await.c(h!())?;
    // println!("> tokens: {tokens:?}");

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

            if let Some(etalon) = point_forms.get(&text_lc) {
                if let (Some(first), Some(last)) = (slice.first(), slice.last())
                {
                    for label in etalon {
                        substrings_to_highlight.push((
                            label.clone(),
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
    }

    // println!("> substrings_to_highlight: {substrings_to_highlight:?}");

    for (etalon, sub, start, end) in substrings_to_highlight {
        if is_word_boundary(&body_chars, start, end) {
            res.push(CNPoint {
                begin: start,
                end,
                etalon: etalon.clone(),
                text: sub.clone(),
            });
        }
    }

    // Deduplicate and sort
    let mut res = res.clone();
    res.sort();
    res.dedup();

    Ok(res)
}

fn is_word_boundary(body_chars: &[char], start: usize, end: usize) -> bool {
    let len = body_chars.len();
    if start > len || end > len || start >= end {
        return false;
    }
    let left_ok =
        start == 0 || !is_word_char(body_chars.get(start - 1).copied());
    let right_ok = end >= len || !is_word_char(body_chars.get(end).copied());
    left_ok && right_ok
}

fn is_word_char(ch: Option<char>) -> bool {
    ch.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

pub fn offset_point_tokens(
    tokens: Vec<CNPoint>,
    offset: usize,
) -> Vec<CNPoint> {
    if offset == 0 {
        return tokens;
    }
    tokens
        .into_iter()
        .map(|mut token| {
            token.begin += offset;
            token.end += offset;
            token
        })
        .collect()
}

pub async fn find_known_points<C>(
    txn: &C,
    rq: &reqwest::Client,
    body: &str,
) -> Result<Vec<CNPoint>, AppError>
where
    C: ConnectionTrait,
{
    let point_forms = load_point_lexemes_all(txn).await.c(h!())?;
    highlight_points(rq, body, &point_forms).await
}

pub async fn find_all_palitra_by_author(
    dbx: &DatabaseConnection,
    login: &str,
) -> Result<Vec<i64>, AppError> {
    Ok(palitra::Entity::find()
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra::Column::Author.eq(login))
        .select_only()
        .column(palitra::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}
pub async fn find_points_by_palitra(
    dbx: &DatabaseConnection,
    palitra_ids: Vec<i64>,
) -> Result<Vec<String>, AppError> {
    Ok(palitra_point::Entity::find()
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids))
        .select_only()
        .column(palitra_point::Column::Label)
        .into_tuple::<Option<String>>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .flatten()
        .collect())
}

pub async fn load_point_lexemes_by_palitra_ids<C>(
    txn: &C,
    palitra_ids: Vec<i64>,
) -> Result<BTreeMap<String, Vec<String>>, AppError>
where
    C: ConnectionTrait,
{
    if palitra_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let rows = palitra_point::Entity::find()
        .inner_join(palitra_point_lexeme::Entity)
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_point::Column::PalitraId.eq_any(palitra_ids))
        .select_only()
        .column(palitra_point::Column::Label)
        .column(palitra_point_lexeme::Column::Lexeme)
        .into_tuple::<(Option<String>, String)>()
        .all(txn)
        .await
        .c(h!())?;

    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (label, lexeme) in rows {
        let Some(label) = label else { continue };
        map.entry(lexeme).or_default().push(label);
    }
    Ok(map)
}

pub async fn load_point_lexemes_all<C>(
    txn: &C,
) -> Result<BTreeMap<String, Vec<String>>, AppError>
where
    C: ConnectionTrait,
{
    let rows = palitra_point::Entity::find()
        .inner_join(palitra_point_lexeme::Entity)
        .filter(palitra_point::Column::Deleted.eq(false))
        .select_only()
        .column(palitra_point::Column::Label)
        .column(palitra_point_lexeme::Column::Lexeme)
        .into_tuple::<(Option<String>, String)>()
        .all(txn)
        .await
        .c(h!())?;

    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (label, lexeme) in rows {
        let Some(label) = label else { continue };
        map.entry(lexeme).or_default().push(label);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::{is_word_boundary, offset_point_tokens};
    use crate::rer_importer::highlight::CNPoint;

    #[test]
    fn test_is_word_boundary_allows_whole_word() {
        let body = "по точке идете";
        let body_chars: Vec<char> = body.chars().collect();
        let start = 3;
        let end = 8;
        assert!(is_word_boundary(&body_chars, start, end));
    }

    #[test]
    fn test_is_word_boundary_rejects_substring() {
        let body = "заточка";
        let body_chars: Vec<char> = body.chars().collect();
        let start = 1;
        let end = 6;
        assert!(!is_word_boundary(&body_chars, start, end));
    }

    #[test]
    fn test_offset_point_tokens_shifts_positions() {
        let tokens = vec![CNPoint {
            begin: 2,
            end: 5,
            etalon: "ТОЧКА".to_string(),
            text: "точ".to_string(),
        }];
        let shifted = offset_point_tokens(tokens, 10);
        assert_eq!(shifted[0].begin, 12);
        assert_eq!(shifted[0].end, 15);
    }
}
