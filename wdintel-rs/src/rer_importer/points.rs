use crate::entities::{
    area_of_responsibility, login, organism, organism_aor, palitra,
    palitra_access_aor, palitra_access_login, palitra_access_organism,
    palitra_point, palitra_point_lexeme,
};
use crate::error::AppError;
use crate::h;
use crate::palitra::types::PalitraAccess;
use crate::rer_importer::highlight::CNPoint;
use crate::rer_importer::types::{PalitraHighlight, PalitraLexeme};
use crate::types::ShortContext;
use crate::utils::orm::ArrayColumnOps;
use sea_orm::prelude::*;
use sea_orm::query::*;
use sea_orm::sea_query::UnionType;
use std::collections::BTreeMap;

pub async fn highlight_points(
    rq: &reqwest::Client,
    body: &str,
    point_forms: &BTreeMap<String, Vec<PalitraLexeme>>,
    offset: usize,
) -> Result<Vec<PalitraHighlight>, AppError> {
    if point_forms.is_empty() {
        return Ok(vec![]);
    }
    let body_chars: Vec<char> = body.chars().collect();
    let tokens = crate::nlp::tokenize_words(rq, body).await.c(h!())?;
    // println!("> tokens: {tokens:?}");

    let mut highlight: BTreeMap<i64, Vec<CNPoint>> = BTreeMap::new();

    // 🔹 Scan n-grams of length 1..=2 (single word, two-word)
    for n in 1..=2 {
        for i in 0..tokens.len().saturating_sub(n - 1) {
            let slice = &tokens[i..i + n];

            // Join token texts with spaces
            let text = slice
                .iter()
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let text_lc = text.to_lowercase();

            if let Some(palitra_lexemes) = point_forms.get(&text_lc) {
                if let (Some(first), Some(last)) = (slice.first(), slice.last())
                {
                    if is_word_boundary(&body_chars, first.start, last.end) {
                        for palitra_lexeme in palitra_lexemes {
                            let point = CNPoint {
                                etalon: palitra_lexeme.label.clone(),
                                text: text.to_string(),
                                begin: offset + first.start,
                                end: offset + last.end,
                            };
                            highlight
                                .entry(palitra_lexeme.palitra_id)
                                .or_default()
                                .push(point);
                        }
                    }
                }
            }
        }
    }

    let mut res = Vec::with_capacity(highlight.len());
    for (palitra_id, mut points) in highlight {
        points.sort();
        points.dedup();
        let highlight = PalitraHighlight { palitra_id, points };
        res.push(highlight);
    }

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

pub fn build_palitra_access_filter(
    access: PalitraAccess,
    exact: bool,
) -> Condition {
    let mut parts = Vec::new();
    match access {
        PalitraAccess::ByLogins { logins } => {
            let by_login = palitra_access_login::Entity::find()
                .filter(
                    palitra_access_login::Column::Login.eq_any(logins.clone()),
                )
                .join(
                    JoinType::InnerJoin,
                    palitra_access_login::Relation::Login.def(),
                )
                .filter(login::Column::Deleted.eq(false))
                .filter(login::Column::DeletedPermanently.eq(false))
                .filter(
                    Expr::col((
                        palitra_access_login::Entity,
                        palitra_access_login::Column::PalitraId,
                    ))
                    .equals((palitra::Entity, palitra::Column::Id)),
                )
                .select_only()
                .expr(Expr::cust("1"))
                .into_query();
            parts.push(by_login);
            if !exact {
                let by_login_organism = login::Entity::find()
                    .filter(login::Column::Login.eq_any(logins.clone()))
                    .filter(login::Column::Deleted.eq(false))
                    .filter(login::Column::DeletedPermanently.eq(false))
                    .join(JoinType::InnerJoin, login::Relation::Organism.def())
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .filter(organism::Column::Enabled.eq(true))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::PalitraAccessOrganism.def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_organism::Entity,
                            palitra_access_organism::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_login_organism);

                let by_login_aors = login::Entity::find()
                    .filter(login::Column::Login.eq_any(logins.clone()))
                    .filter(login::Column::Deleted.eq(false))
                    .filter(login::Column::DeletedPermanently.eq(false))
                    .join(JoinType::InnerJoin, login::Relation::Organism.def())
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .filter(organism::Column::Enabled.eq(true))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::OrganismAor.def(),
                    )
                    .join(
                        JoinType::InnerJoin,
                        organism_aor::Relation::AreaOfResponsibility.def(),
                    )
                    .filter(area_of_responsibility::Column::Deleted.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        area_of_responsibility::Relation::PalitraAccessAor
                            .def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_aor::Entity,
                            palitra_access_aor::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_login_aors);
            }
        }
        PalitraAccess::ByOrganisms { organism_ids } => {
            let by_organism = palitra_access_organism::Entity::find()
                .filter(
                    palitra_access_organism::Column::OrganismId
                        .eq_any(organism_ids.clone()),
                )
                .join(
                    JoinType::InnerJoin,
                    palitra_access_organism::Relation::Organism.def(),
                )
                .filter(organism::Column::DeletedPermanently.eq(false))
                .filter(organism::Column::Enabled.eq(true))
                .filter(
                    Expr::col((
                        palitra_access_organism::Entity,
                        palitra_access_organism::Column::PalitraId,
                    ))
                    .equals((palitra::Entity, palitra::Column::Id)),
                )
                .select_only()
                .expr(Expr::cust("1"))
                .into_query();
            parts.push(by_organism);
            if !exact {
                let by_organism_logins = login::Entity::find()
                    .filter(
                        login::Column::OrganismId.eq_any(organism_ids.clone()),
                    )
                    .filter(login::Column::Deleted.eq(false))
                    .filter(login::Column::DeletedPermanently.eq(false))
                    .join(JoinType::InnerJoin, login::Relation::Organism.def())
                    .filter(organism::Column::Enabled.eq(true))
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        login::Relation::PalitraAccessLogin.def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_login::Entity,
                            palitra_access_login::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_organism_logins);

                let by_organism_aors = organism::Entity::find()
                    .filter(organism::Column::Id.eq_any(organism_ids.clone()))
                    .filter(organism::Column::Enabled.eq(true))
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::OrganismAor.def(),
                    )
                    .join(
                        JoinType::InnerJoin,
                        organism_aor::Relation::AreaOfResponsibility.def(),
                    )
                    .filter(area_of_responsibility::Column::Deleted.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        area_of_responsibility::Relation::PalitraAccessAor
                            .def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_aor::Entity,
                            palitra_access_aor::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_organism_aors);
            }
        }
        PalitraAccess::ByAor { aor_ids } => {
            let by_aor = palitra_access_aor::Entity::find()
                .filter(
                    palitra_access_aor::Column::AorId.eq_any(aor_ids.clone()),
                )
                .filter(
                    Expr::col((
                        palitra_access_aor::Entity,
                        palitra_access_aor::Column::PalitraId,
                    ))
                    .equals((palitra::Entity, palitra::Column::Id)),
                )
                .select_only()
                .expr(Expr::cust("1"))
                .into_query();
            parts.push(by_aor);

            if !exact {
                let by_aor_logins = login::Entity::find()
                    .filter(login::Column::Deleted.eq(false))
                    .filter(login::Column::DeletedPermanently.eq(false))
                    .join(JoinType::InnerJoin, login::Relation::Organism.def())
                    .filter(organism::Column::Enabled.eq(true))
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::OrganismAor.def(),
                    )
                    .join(
                        JoinType::InnerJoin,
                        organism_aor::Relation::AreaOfResponsibility.def(),
                    )
                    .filter(
                        area_of_responsibility::Column::Id
                            .eq_any(aor_ids.clone()),
                    )
                    .filter(area_of_responsibility::Column::Deleted.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        login::Relation::PalitraAccessLogin.def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_login::Entity,
                            palitra_access_login::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_aor_logins);

                let by_aor_organisms = organism::Entity::find()
                    .filter(organism::Column::Enabled.eq(true))
                    .filter(organism::Column::DeletedPermanently.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::OrganismAor.def(),
                    )
                    .join(
                        JoinType::InnerJoin,
                        organism_aor::Relation::AreaOfResponsibility.def(),
                    )
                    .filter(
                        area_of_responsibility::Column::Id
                            .eq_any(aor_ids.clone()),
                    )
                    .filter(area_of_responsibility::Column::Deleted.eq(false))
                    .join(
                        JoinType::InnerJoin,
                        organism::Relation::PalitraAccessOrganism.def(),
                    )
                    .filter(
                        Expr::col((
                            palitra_access_organism::Entity,
                            palitra_access_organism::Column::PalitraId,
                        ))
                        .equals((palitra::Entity, palitra::Column::Id)),
                    )
                    .select_only()
                    .expr(Expr::cust("1"))
                    .into_query();
                parts.push(by_aor_organisms);
            }
        }
    };

    let q = parts.into_iter().reduce(|mut cur, next| {
        cur.union(UnionType::All, next);
        cur
    });

    let stmt = q.unwrap();

    let expr = Expr::exists(stmt);

    Condition::all().add(expr)
}

pub async fn load_relevant_palitra_point_lexemes<C>(
    txn: &C,
    access: PalitraAccess,
    exact: bool,
) -> Result<BTreeMap<String, Vec<PalitraLexeme>>, AppError>
where
    C: ConnectionTrait,
{
    let palitra_filter = build_palitra_access_filter(access, exact);

    let rows = palitra_point::Entity::find()
        .inner_join(palitra_point_lexeme::Entity)
        .inner_join(palitra::Entity)
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra_filter)
        .select_only()
        .column(palitra_point::Column::PalitraId)
        .column(palitra_point::Column::Label)
        .column(palitra_point_lexeme::Column::PalitraPointId)
        .column(palitra_point_lexeme::Column::Lexeme)
        .into_model::<PalitraLexeme>()
        .all(txn)
        .await
        .c(h!())?;

    let mut res: BTreeMap<String, Vec<PalitraLexeme>> = BTreeMap::new();

    for row in rows {
        let lexeme = row.lexeme.clone();
        res.entry(lexeme).or_default().push(row);
    }

    Ok(res)
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
