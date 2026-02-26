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
        res.push(CNPoint {
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
