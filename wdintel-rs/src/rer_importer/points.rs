use crate::entities::{
    area_of_responsibility, login, organism, organism_aor, palitra,
    palitra_access_aor, palitra_access_login, palitra_access_organism,
    palitra_geometry, palitra_point, palitra_point_lexeme,
};
use crate::error::AppError;
use crate::h;
use crate::palitra::types::PalitraAccess;
use crate::rer_importer::highlight::CNPoint;
use crate::rer_importer::types::{PalitraLexeme, PalitraPattern};
use crate::types::ShortContext;
use crate::utils::string::byte_to_char_index;
use itertools::Itertools;
use sea_orm::prelude::*;
use sea_orm::query::*;
use sea_orm::sea_query::UnionType;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

pub async fn highlight_points(
    rq: &reqwest::Client,
    body: &str,
    patterns: &[PalitraPattern],
) -> Result<HashMap<i64, Vec<CNPoint>>, AppError> {
    let mut res: HashMap<i64, Vec<CNPoint>> = HashMap::new();

    if patterns.is_empty() {
        return Ok(res);
    }
    let body_trim = body.trim_end();
    if body_trim.is_empty() {
        return Ok(res);
    }
    let (body, offset) = cut_body(body);
    let body_chars: Vec<char> = body.chars().collect();
    let tokens = crate::nlp::tokenize_words(rq, body).await.c(h!())?;

    for n in 1..=2 {
        for i in 0..tokens.len().saturating_sub(n - 1) {
            let slice = &tokens[i..i + n];
            let Some(first) = slice.first() else {
                continue;
            };
            let Some(last) = slice.last() else {
                continue;
            };
            if !is_word_boundary(&body_chars, first.start, last.end) {
                continue;
            }
            // Join token texts with spaces
            let text = slice.iter().map(|t| t.text.as_str()).join(" ");
            let text_lc = text.to_lowercase();

            for pattern in patterns {
                if let Some(etalon) = pattern.matcher.get(&text_lc) {
                    if !etalon.is_empty() {
                        let points = res.entry(pattern.palitra_id).or_default();
                        for lexeme in etalon {
                            let point = CNPoint {
                                etalon: lexeme.label.clone(),
                                text: text.clone(),
                                begin: offset + first.start,
                                end: offset + last.end,
                                palitra_ids: vec![],
                            };
                            points.push(point);
                        }
                    }
                }
            }
        }
    }

    for points in res.values_mut() {
        points.sort();
        points.dedup();
    }

    Ok(res)
}

fn cut_body(body: &str) -> (&str, usize) {
    use lazy_static::lazy_static;
    use regex::Regex;

    lazy_static! {
        static ref RE_PREFIX: Vec<Regex> = vec![
            Regex::new(r"(?m)^\s*[-\u{2010}-\u{2015}][^-\u{2010}-\u{2015}]")
                .unwrap(),
            Regex::new(r"(?m)^[0-9]+\W?\s+").unwrap(),
            Regex::new(r"(?m-u)^$").unwrap()
        ];
    }

    let mut result_body = body;
    let mut offset_chars = 0;

    if let Some(m) = RE_PREFIX.iter().find_map(|r| r.find(body)) {
        let start = m.start();
        let new_body = &body[start..];
        if !new_body.is_empty() {
            result_body = new_body;
            offset_chars = byte_to_char_index(body, start);
        }
    }

    (result_body, offset_chars)
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

pub async fn build_palitra_pattern<C>(
    txn: &C,
    palitra_id: i64,
) -> anyhow::Result<PalitraPattern>
where
    C: ConnectionTrait,
{
    let lexemes = palitra_point::Entity::find()
        .join(
            JoinType::InnerJoin,
            palitra_point::Relation::PalitraPointLexeme.def(),
        )
        .join(
            JoinType::InnerJoin,
            palitra_point::Relation::PalitraGeometry.def(),
        )
        .join(
            JoinType::InnerJoin,
            palitra_geometry::Relation::Palitra.def(),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra::Column::Id.eq(palitra_id))
        .select_only()
        .column(palitra_geometry::Column::PalitraId)
        .column(palitra_point::Column::Label)
        .column(palitra_point_lexeme::Column::PalitraPointId)
        .column(palitra_point_lexeme::Column::Lexeme)
        .into_model::<PalitraLexeme>()
        .all(txn)
        .await
        .c(h!())?;

    let build_pattern_result = tokio::task::spawn_blocking(move || {
        let mut matcher: HashMap<String, Vec<PalitraLexeme>> =
            Default::default();
        for palitra_lexeme in lexemes {
            matcher
                .entry(palitra_lexeme.lexeme.clone())
                .or_default()
                .push(palitra_lexeme);
        }

        Ok(PalitraPattern {
            palitra_id,
            matcher: Arc::new(matcher),
        })
    })
    .await?;

    build_pattern_result
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
                    palitra_access_login::Column::LoginId
                        .eq_any(logins.clone()),
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
        .join(
            JoinType::InnerJoin,
            palitra_point::Relation::PalitraPointLexeme.def(),
        )
        .join(
            JoinType::InnerJoin,
            palitra_point::Relation::PalitraGeometry.def(),
        )
        .join(
            JoinType::InnerJoin,
            palitra_geometry::Relation::Palitra.def(),
        )
        .filter(palitra_point::Column::Deleted.eq(false))
        .filter(palitra::Column::Deleted.eq(false))
        .filter(palitra_geometry::Column::Deleted.eq(false))
        .filter(palitra_filter)
        .select_only()
        .column(palitra_geometry::Column::PalitraId)
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
    use super::{cut_body, is_word_boundary};

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
    fn test_cut_body_first_dash() {
        let body = r#"06.10.25 08:32:18
148,30000
УКХ р/м підр. обласних управлінь МНС РБ
МЧС РБ
МОЗЫРЬ
ДРУЖБА
35U PT 33878 06028

-Дружба Мозырь связь
"#;
        let (cut, offset) = cut_body(body);
        assert_eq!(cut, "\n-Дружба Мозырь связь\n");
        assert_eq!(offset, 108);
    }

    #[test]
    fn test_cut_body_empty_line() {
        let body = r#"06.10.25 13:55:32
148,35000
УКХ р/м не визначеного підрозділу
БОБРУЙСК
61-Й

61-й, передайте информацию 065-му, пусть возьмет данные хозяева этого участка
"#;
        let (cut, offset) = cut_body(body);
        assert_eq!(
            cut,
            "\n61-й, передайте информацию 065-му, пусть возьмет данные хозяева этого участка\n"
        );
        assert_eq!(offset, 76);
    }

    #[test]
    fn test_cut_body_numbered() {
        let body = r#"Отримано з поста "Пост 3" Цифра
--------------------------------------
11.04.2025 14:08:30
147.5250
УКХ радіомережі імовірно управління Пінського прикордонного загону (ВЧ1235)
52-й
1. Принял. 52 принял.
"#;
        let (cut, offset) = cut_body(body);
        assert_eq!(cut, "1. Принял. 52 принял.\n");
        assert_eq!(offset, 181);
    }
}
