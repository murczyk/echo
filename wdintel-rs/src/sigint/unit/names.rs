use super::types::{
    ConfirmUnitNameReq, ListUnitNameReviewsReq, ListUnitNameReviewsRsp,
    UnitNameReview, UnitNameReviewCursor, UpdateUnitNameReq,
};
use crate::config::SIGINT_UNIT_NAME_REVIEW_PAGE_SIZE;
use crate::entities::{orbit_unit, orbit_unit_echelon, sigint_unit};
use crate::error::AppError;
use crate::types::*;
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const CORPS_INDEX: usize = 10;
const FIELD_ARMY_INDEX: usize = 11;

#[derive(Clone, Debug, PartialEq, Eq)]
struct OrbitHierarchyName {
    preferred: String,
    full: String,
}

#[derive(FromQueryResult)]
struct UnitNameReviewRow {
    id: i64,
    name: String,
    updated_at: NaiveDateTime,
    orbit_unit_id: Uuid,
}

#[derive(FromQueryResult)]
struct SingleOrbitLinkRow {
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
}

#[post("/api/admin/unit-names")]
pub async fn list_unit_name_reviews(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<Option<ListUnitNameReviewsReq>>,
) -> Result<Json<ListUnitNameReviewsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    Ok(Json(
        load_unit_name_reviews(
            &env.dbx,
            req.as_ref().and_then(|req| req.after.as_ref()),
            SIGINT_UNIT_NAME_REVIEW_PAGE_SIZE,
        )
        .await
        .c(h!())?,
    ))
}

async fn load_unit_name_reviews(
    dbx: &DatabaseConnection,
    after: Option<&UnitNameReviewCursor>,
    page_size: usize,
) -> Result<ListUnitNameReviewsRsp, AppError> {
    let mut values: Vec<Value> = Vec::new();
    let cursor_filter = if let Some(after) = after {
        let updated_at =
            chrono::DateTime::from_timestamp_micros(after.updated_at_micros)
                .map(|updated_at| updated_at.naive_utc())
                .ok_or_else(|| AppError::BL {
                    msg: "Некоректний курсор списку назв підрозділів"
                        .to_string(),
                })
                .c(h!())?;
        values.push(updated_at.into());
        values.push(after.sigint_unit_id.into());
        r#"and (sigint.updated_at, sigint.id) > ($1::timestamp, $2::bigint)"#
    } else {
        ""
    };
    let limit = i64::try_from(page_size.saturating_add(1)).c(h!())?;
    let limit_param = values.len() + 1;
    values.push(limit.into());
    let sql = format!(
        r#"
        with valid_links as (
            select link.sigint_unit_id, link.orbit_unit_id
            from orbit_unit_sigint_unit link
            inner join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
            where link.is_suppressed = false
                and orbit.deleted = false
        ), single_links as (
            select
                sigint_unit_id,
                (array_agg(orbit_unit_id))[1] as orbit_unit_id
            from valid_links
            group by sigint_unit_id
            having count(*) = 1
        )
        select
            sigint.id,
            sigint.name,
            sigint.updated_at,
            single_links.orbit_unit_id
        from sigint_unit sigint
        inner join single_links on single_links.sigint_unit_id = sigint.id
        where sigint.active = true
            and sigint.deleted = false
            {cursor_filter}
        order by sigint.updated_at, sigint.id
        limit ${limit_param}::bigint
        "#,
    );
    let mut units = UnitNameReviewRow::find_by_statement(
        Statement::from_sql_and_values(dbx.get_database_backend(), sql, values),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let has_more = units.len() > page_size;
    if has_more {
        units.pop();
    }
    let next_cursor = has_more
        .then(|| units.last().map(unit_name_review_cursor))
        .flatten();
    Ok(ListUnitNameReviewsRsp {
        units: render_unit_name_review_rows(dbx, units).await.c(h!())?,
        next_cursor,
    })
}

#[post("/api/admin/unit-name/update")]
pub async fn update_unit_name(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateUnitNameReq>,
) -> Result<Json<UnitNameReview>, AppError> {
    let login = ensure_unit_name_editor(&env.dbx, &user).await.c(h!())?;
    let unit = touch_unit_name(
        &env.dbx,
        &login,
        req.sigint_unit_id,
        Some(req.name.clone()),
    )
    .await
    .c(h!())?;
    super::fanout_unit_changed_data(&env).await.c(h!())?;
    Ok(Json(render_unit_name_review(&env.dbx, unit).await.c(h!())?))
}

#[post("/api/admin/unit-name/confirm")]
pub async fn confirm_unit_name(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ConfirmUnitNameReq>,
) -> Result<Json<UnitNameReview>, AppError> {
    let login = ensure_unit_name_editor(&env.dbx, &user).await.c(h!())?;
    let unit = touch_unit_name(&env.dbx, &login, req.sigint_unit_id, None)
        .await
        .c(h!())?;
    super::fanout_unit_changed_data(&env).await.c(h!())?;
    Ok(Json(render_unit_name_review(&env.dbx, unit).await.c(h!())?))
}

async fn ensure_unit_name_editor(
    dbx: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<Uuid, AppError> {
    ensure_admin(dbx, user).await.c(h!())?;
    ensure_rer_role(dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    has_role(dbx, &login, "UnitsEditor").await.c(h!())?;
    Ok(login)
}

async fn touch_unit_name(
    dbx: &DatabaseConnection,
    login: &Uuid,
    sigint_unit_id: i64,
    name: Option<String>,
) -> Result<sigint_unit::Model, AppError> {
    let name = name.map(|name| name.trim().to_string());
    if name.as_deref() == Some("") {
        return Err(AppError::BL {
            msg: "Назва підрозділу не може бути порожньою".to_string(),
        });
    }
    let transaction = dbx.begin().await.c(h!())?;
    super::changelog::set_author(&transaction, login)
        .await
        .c(h!())?;
    let unit = sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let mut unit = unit.into_active_model();
    let name_updated = name.is_some();
    if let Some(name) = name {
        unit.name = Set(name);
    }
    unit.updated_at = Set(Utc::now().naive_utc());
    let unit = unit.update(&transaction).await.c(h!())?;
    if name_updated {
        super::unit_after_insert_update(&transaction, unit.id)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(unit)
}

async fn render_unit_name_review(
    dbx: &DatabaseConnection,
    unit: sigint_unit::Model,
) -> Result<UnitNameReview, AppError> {
    let expected_name = expected_unit_name(dbx, unit.id).await.c(h!())?;
    Ok(UnitNameReview {
        sigint_unit_id: unit.id,
        matches_expected: unit.name == expected_name,
        current_name: unit.name,
        expected_name,
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    })
}

async fn render_unit_name_review_rows(
    dbx: &DatabaseConnection,
    units: Vec<UnitNameReviewRow>,
) -> Result<Vec<UnitNameReview>, AppError> {
    let orbit_units = load_orbit_units(
        dbx,
        &units
            .iter()
            .map(|unit| unit.orbit_unit_id)
            .collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    let mut reviews = Vec::with_capacity(units.len());
    for unit in units {
        reviews
            .push(render_unit_name_review_row(dbx, &orbit_units, unit).await?);
    }
    Ok(reviews)
}

async fn render_unit_name_review_row(
    dbx: &DatabaseConnection,
    orbit_units: &HashMap<Uuid, orbit_unit::Model>,
    unit: UnitNameReviewRow,
) -> Result<UnitNameReview, AppError> {
    let expected_name = match orbit_units.get(&unit.orbit_unit_id) {
        Some(orbit_unit) => {
            expected_unit_name_from_orbit(dbx, orbit_unit).await?
        }
        None => String::new(),
    };
    Ok(UnitNameReview {
        sigint_unit_id: unit.id,
        matches_expected: unit.name == expected_name,
        current_name: unit.name,
        expected_name,
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    })
}

fn unit_name_review_cursor(unit: &UnitNameReviewRow) -> UnitNameReviewCursor {
    UnitNameReviewCursor {
        updated_at_micros: unit.updated_at.and_utc().timestamp_micros(),
        sigint_unit_id: unit.id,
    }
}

async fn expected_unit_name(
    dbx: &DatabaseConnection,
    sigint_unit_id: i64,
) -> Result<String, AppError> {
    let orbit_units = load_single_linked_orbit_units(dbx, &[sigint_unit_id])
        .await
        .c(h!())?;
    match orbit_units.get(&sigint_unit_id) {
        Some(orbit_unit) => {
            expected_unit_name_from_orbit(dbx, orbit_unit).await
        }
        None => Ok(String::new()),
    }
}

async fn load_single_linked_orbit_units(
    dbx: &DatabaseConnection,
    sigint_unit_ids: &[i64],
) -> Result<HashMap<i64, orbit_unit::Model>, AppError> {
    let links = load_single_orbit_links(dbx, sigint_unit_ids)
        .await
        .c(h!())?;
    let orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id)
        .collect::<Vec<_>>();
    let orbit_units = load_orbit_units(dbx, &orbit_unit_ids).await.c(h!())?;
    Ok(links
        .into_iter()
        .filter_map(|link| {
            orbit_units
                .get(&link.orbit_unit_id)
                .cloned()
                .map(|orbit_unit| (link.sigint_unit_id, orbit_unit))
        })
        .collect())
}

async fn load_orbit_units(
    dbx: &DatabaseConnection,
    orbit_unit_ids: &[Uuid],
) -> Result<HashMap<Uuid, orbit_unit::Model>, AppError> {
    if orbit_unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(orbit_unit::Entity::find()
        .filter(orbit_unit::Column::UnitId.is_in(orbit_unit_ids.to_vec()))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect())
}

async fn load_single_orbit_links(
    dbx: &DatabaseConnection,
    sigint_unit_ids: &[i64],
) -> Result<Vec<SingleOrbitLinkRow>, AppError> {
    if sigint_unit_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(
        SingleOrbitLinkRow::find_by_statement(Statement::from_sql_and_values(
            dbx.get_database_backend(),
            r#"
        with valid_links as (
            select link.sigint_unit_id, link.orbit_unit_id
            from orbit_unit_sigint_unit link
            inner join orbit_unit orbit on orbit.unit_id = link.orbit_unit_id
            where link.is_suppressed = false
                and orbit.deleted = false
                and link.sigint_unit_id = any($1::bigint[])
        )
        select
            sigint_unit_id,
            (array_agg(orbit_unit_id))[1] as orbit_unit_id
        from valid_links
        group by sigint_unit_id
        having count(*) = 1
        "#,
            [sigint_unit_ids.to_vec().into()],
        ))
        .all(dbx)
        .await
        .c(h!())?,
    )
}

async fn expected_unit_name_from_orbit(
    dbx: &DatabaseConnection,
    orbit_unit: &orbit_unit::Model,
) -> Result<String, AppError> {
    let mut hierarchy = std::array::from_fn(|_| None::<OrbitHierarchyName>);
    fill_orbit_hierarchy_level(dbx, orbit_unit, &mut hierarchy).await?;
    fill_orbit_parent_chain(
        dbx,
        orbit_unit,
        OrbitParentKind::Operational,
        &mut hierarchy,
    )
    .await?;
    fill_orbit_parent_chain(
        dbx,
        orbit_unit,
        OrbitParentKind::Generative,
        &mut hierarchy,
    )
    .await?;
    Ok(expected_unit_name_from_orbit_hierarchy(&hierarchy))
}

#[derive(Clone, Copy)]
enum OrbitParentKind {
    Generative,
    Operational,
}

impl OrbitParentKind {
    fn parent_id(self, unit: &orbit_unit::Model) -> Option<Uuid> {
        match self {
            Self::Generative => unit.generative_parent_unit_id,
            Self::Operational => unit.operational_parent_unit_id,
        }
    }
}

async fn fill_orbit_parent_chain(
    dbx: &DatabaseConnection,
    root: &orbit_unit::Model,
    parent_kind: OrbitParentKind,
    hierarchy: &mut [Option<OrbitHierarchyName>; 14],
) -> Result<(), AppError> {
    let mut seen = HashSet::from([root.unit_id]);
    let mut parent_id = parent_kind.parent_id(root);
    while let Some(unit_id) = parent_id {
        if !seen.insert(unit_id) {
            return Err(AppError::BL {
                msg: "ORBIT unit hierarchy contains a cycle".to_string(),
            });
        }
        let parent = find_available_orbit_unit(dbx, unit_id).await.c(h!())?;
        parent_id = parent_kind.parent_id(&parent);
        fill_orbit_hierarchy_level(dbx, &parent, hierarchy).await?;
    }
    Ok(())
}

async fn find_available_orbit_unit(
    dbx: &DatabaseConnection,
    unit_id: Uuid,
) -> Result<orbit_unit::Model, AppError> {
    orbit_unit::Entity::find_by_id(unit_id)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn fill_orbit_hierarchy_level(
    dbx: &DatabaseConnection,
    unit: &orbit_unit::Model,
    hierarchy: &mut [Option<OrbitHierarchyName>; 14],
) -> Result<(), AppError> {
    let Some(echelon_id) = unit.unit_echelon_id else {
        return Ok(());
    };
    let Some(echelon) = orbit_unit_echelon::Entity::find_by_id(echelon_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let Some(index) = unit_name_review_echelon_index(&echelon.key) else {
        return Ok(());
    };
    let Some(preferred_name) = preferred_orbit_unit_name(unit) else {
        return Ok(());
    };
    set_orbit_hierarchy_name(
        hierarchy,
        index,
        OrbitHierarchyName {
            full: orbit_unit_full_name(unit, &preferred_name),
            preferred: preferred_name,
        },
    );
    Ok(())
}

fn set_orbit_hierarchy_name(
    hierarchy: &mut [Option<OrbitHierarchyName>; 14],
    index: usize,
    name: OrbitHierarchyName,
) {
    match &hierarchy[index] {
        None => hierarchy[index] = Some(name),
        Some(existing)
            if should_replace_hierarchy_name(index, existing, &name) =>
        {
            hierarchy[index] = Some(name)
        }
        Some(_) => {}
    }
}

fn should_replace_hierarchy_name(
    index: usize,
    existing: &OrbitHierarchyName,
    candidate: &OrbitHierarchyName,
) -> bool {
    index == CORPS_INDEX
        && !contains_word(&existing.full, "корпус")
        && contains_word(&candidate.full, "корпус")
}

fn unit_name_review_echelon_index(key: &str) -> Option<usize> {
    match key {
        "teamOrCrew" => Some(1),
        "section" => Some(2),
        "squad" => Some(3),
        "platoon" => Some(4),
        "company" => Some(5),
        "battalion" => Some(6),
        "regiment" => Some(7),
        "brigade" => Some(8),
        "division" => Some(9),
        "corps" => Some(CORPS_INDEX),
        "fieldArmy" => Some(FIELD_ARMY_INDEX),
        _ => None,
    }
}

fn preferred_orbit_unit_name(unit: &orbit_unit::Model) -> Option<String> {
    [
        unit.unit_name_short.as_deref(),
        unit.unit_name.as_deref(),
        unit.unit_name_original.as_deref(),
        unit.unit_number.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|name| !name.is_empty())
    .map(ToString::to_string)
}

fn orbit_unit_full_name(
    unit: &orbit_unit::Model,
    preferred_name: &str,
) -> String {
    unit.unit_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(preferred_name)
        .to_string()
}

fn expected_unit_name_from_orbit_hierarchy(
    hierarchy: &[Option<OrbitHierarchyName>; 14],
) -> String {
    let mut parts = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .into_iter()
        .filter_map(|index| {
            hierarchy[index]
                .as_ref()
                .map(|name| name.preferred.as_str())
        })
        .collect::<Vec<_>>();
    if let Some(name) = field_army_or_corps_name(hierarchy) {
        parts.push(name.preferred.as_str());
    }
    parts.join(" ")
}

fn field_army_or_corps_name(
    hierarchy: &[Option<OrbitHierarchyName>; 14],
) -> Option<&OrbitHierarchyName> {
    let field_army = hierarchy[FIELD_ARMY_INDEX].as_ref()?;
    if !contains_word(&field_army.full, "армія") {
        if let Some(corps) = hierarchy[CORPS_INDEX].as_ref() {
            if contains_word(&corps.full, "корпус") {
                return Some(corps);
            }
        }
    }
    Some(field_army)
}

fn contains_word(value: &str, word: &str) -> bool {
    let word = word.to_lowercase();
    value
        .to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .any(|part| part == word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{orbit_unit_sigint_unit, sigint_unit_change};
    use crate::functest::tests::{cleanup, mk_sigint_unit};
    use chrono::Duration;
    use serial_test::serial;

    async fn orbit_echelon(
        dbx: &DatabaseConnection,
        key: &str,
    ) -> orbit_unit_echelon::Model {
        let name = format!("Unit name review test {key}");
        if let Some(echelon) = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq(key))
            .filter(orbit_unit_echelon::Column::Name.eq(&name))
            .one(dbx)
            .await
            .unwrap()
        {
            return echelon;
        }
        orbit_unit_echelon::ActiveModel {
            id: Set(Uuid::new_v4()),
            key: Set(key.to_string()),
            name: Set(name),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_orbit_unit(
        dbx: &DatabaseConnection,
        name: &str,
        echelon_key: &str,
        operational_parent_unit_id: Option<Uuid>,
        generative_parent_unit_id: Option<Uuid>,
    ) -> orbit_unit::Model {
        let echelon = orbit_echelon(dbx, echelon_key).await;
        orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name: Set(Some(format!("Повна назва {name}"))),
            unit_name_short: Set(Some(name.to_string())),
            unit_echelon_id: Set(Some(echelon.id)),
            generative_parent_unit_id: Set(generative_parent_unit_id),
            operational_parent_unit_id: Set(operational_parent_unit_id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn link_orbit_unit(
        dbx: &DatabaseConnection,
        orbit_unit_id: Uuid,
        sigint_unit_id: i64,
        is_suppressed: bool,
    ) {
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(sigint_unit_id),
            is_manual: Set(true),
            is_suppressed: Set(is_suppressed),
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    fn hierarchy_name(preferred: &str, full: &str) -> OrbitHierarchyName {
        OrbitHierarchyName {
            preferred: preferred.to_string(),
            full: full.to_string(),
        }
    }

    #[test]
    fn expected_name_uses_corps_when_field_army_is_not_an_army() {
        let mut hierarchy = std::array::from_fn(|_| None::<OrbitHierarchyName>);
        hierarchy[7] = Some(hierarchy_name("9 мсп", "9 мотострілецький полк"));
        hierarchy[9] =
            Some(hierarchy_name("18 мсд", "18 мотострілецька дивізія"));
        hierarchy[CORPS_INDEX] =
            Some(hierarchy_name("11 АК", "11 армійський корпус"));
        hierarchy[FIELD_ARMY_INDEX] =
            Some(hierarchy_name("УВ “Курск”", "Угруповання військ “Курск”"));

        assert_eq!(
            expected_unit_name_from_orbit_hierarchy(&hierarchy),
            "9 мсп 18 мсд 11 АК"
        );
    }

    #[test]
    fn expected_name_keeps_field_army_when_it_is_an_army() {
        let mut hierarchy = std::array::from_fn(|_| None::<OrbitHierarchyName>);
        hierarchy[7] = Some(hierarchy_name("9 мсп", "9 мотострілецький полк"));
        hierarchy[9] =
            Some(hierarchy_name("18 мсд", "18 мотострілецька дивізія"));
        hierarchy[CORPS_INDEX] =
            Some(hierarchy_name("11 АК", "11 армійський корпус"));
        hierarchy[FIELD_ARMY_INDEX] =
            Some(hierarchy_name("18 ЗВА", "18 загальновійськова армія"));

        assert_eq!(
            expected_unit_name_from_orbit_hierarchy(&hierarchy),
            "9 мсп 18 мсд 18 ЗВА"
        );
    }

    #[test]
    fn expected_name_keeps_field_army_when_corps_is_not_a_corps() {
        let mut hierarchy = std::array::from_fn(|_| None::<OrbitHierarchyName>);
        hierarchy[7] = Some(hierarchy_name("9 мсп", "9 мотострілецький полк"));
        hierarchy[CORPS_INDEX] = Some(hierarchy_name(
            "ТН “Сумський”",
            "Тактичний напрямок “Сумський”",
        ));
        hierarchy[FIELD_ARMY_INDEX] =
            Some(hierarchy_name("УВ “Курск”", "Угруповання військ “Курск”"));

        assert_eq!(
            expected_unit_name_from_orbit_hierarchy(&hierarchy),
            "9 мсп УВ “Курск”"
        );
    }

    #[test]
    fn corps_slot_prefers_real_corps_over_non_corps_parent() {
        let mut hierarchy = std::array::from_fn(|_| None::<OrbitHierarchyName>);
        set_orbit_hierarchy_name(
            &mut hierarchy,
            CORPS_INDEX,
            hierarchy_name("ТН “Сумський”", "Тактичний напрямок “Сумський”"),
        );
        set_orbit_hierarchy_name(
            &mut hierarchy,
            CORPS_INDEX,
            hierarchy_name("11 АК", "11 армійський корпус"),
        );

        assert_eq!(
            hierarchy[CORPS_INDEX]
                .as_ref()
                .map(|name| name.preferred.as_str()),
            Some("11 АК")
        );
    }

    #[tokio::test]
    #[serial]
    async fn reviews_include_active_units_in_confirmation_order() {
        // Regression: https://github.com/echoua/echo/issues/3113
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let review_updated_at = now - Duration::days(2);
        let first = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("custom".to_string()),
                team_or_crew: Set("sigint crew".to_string()),
                company: Set("sigint company".to_string()),
                corps: Set("sigint corps".to_string()),
                army: Set("sigint army".to_string()),
                updated_at: Set(review_updated_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("second".to_string()),
                updated_at: Set(review_updated_at),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unlinked = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                updated_at: Set(now - Duration::days(3)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let multi_linked = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                updated_at: Set(now - Duration::days(3)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let only_suppressed = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                updated_at: Set(now - Duration::days(3)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inactive = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                updated_at: Set(now - Duration::days(3)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let army =
            insert_orbit_unit(&env.dbx, "армія", "fieldArmy", None, None).await;
        let corps = insert_orbit_unit(
            &env.dbx,
            "корпус",
            "corps",
            Some(army.unit_id),
            None,
        )
        .await;
        let company = insert_orbit_unit(
            &env.dbx,
            "рота",
            "company",
            Some(corps.unit_id),
            None,
        )
        .await;
        let crew = insert_orbit_unit(
            &env.dbx,
            "екіпаж",
            "teamOrCrew",
            Some(company.unit_id),
            None,
        )
        .await;
        link_orbit_unit(&env.dbx, crew.unit_id, first.id, false).await;

        let second_orbit =
            insert_orbit_unit(&env.dbx, "second-orbit", "regiment", None, None)
                .await;
        link_orbit_unit(&env.dbx, second_orbit.unit_id, second.id, false).await;

        for name in ["multi-a", "multi-b"] {
            let orbit_unit =
                insert_orbit_unit(&env.dbx, name, "regiment", None, None).await;
            link_orbit_unit(
                &env.dbx,
                orbit_unit.unit_id,
                multi_linked.id,
                false,
            )
            .await;
        }
        let suppressed_orbit =
            insert_orbit_unit(&env.dbx, "suppressed", "regiment", None, None)
                .await;
        link_orbit_unit(
            &env.dbx,
            suppressed_orbit.unit_id,
            only_suppressed.id,
            true,
        )
        .await;
        let inactive_orbit =
            insert_orbit_unit(&env.dbx, "inactive", "regiment", None, None)
                .await;
        link_orbit_unit(&env.dbx, inactive_orbit.unit_id, inactive.id, false)
            .await;

        let first_page =
            load_unit_name_reviews(&env.dbx, None, 1).await.unwrap();
        assert_eq!(first_page.units[0].sigint_unit_id, first.id);
        let reviews = load_unit_name_reviews(
            &env.dbx,
            first_page.next_cursor.as_ref(),
            SIGINT_UNIT_NAME_REVIEW_PAGE_SIZE,
        )
        .await
        .unwrap()
        .units;
        assert_eq!(
            reviews
                .iter()
                .map(|review| review.sigint_unit_id)
                .collect::<Vec<_>>(),
            vec![second.id]
        );
        assert_eq!(first_page.units[0].expected_name, "екіпаж рота армія");
        assert!(!first_page.units[0].matches_expected);
        assert!(!reviews
            .iter()
            .any(|review| review.sigint_unit_id == unlinked.id));
        assert!(!reviews
            .iter()
            .any(|review| review.sigint_unit_id == multi_linked.id));
        assert!(!reviews
            .iter()
            .any(|review| review.sigint_unit_id == only_suppressed.id));
        assert!(!reviews
            .iter()
            .any(|review| review.sigint_unit_id == inactive.id));

        let change_count = sigint_unit_change::Entity::find()
            .filter(sigint_unit_change::Column::SigintUnitId.eq(first.id))
            .count(&env.dbx)
            .await
            .unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let confirmed = touch_unit_name(&env.dbx, &login, first.id, None)
            .await
            .unwrap();
        assert_eq!(confirmed.name, "custom");
        assert!(confirmed.updated_at > now - Duration::days(1));
        assert_eq!(
            sigint_unit_change::Entity::find()
                .filter(sigint_unit_change::Column::SigintUnitId.eq(first.id))
                .count(&env.dbx)
                .await
                .unwrap(),
            change_count
        );

        let reviews = load_unit_name_reviews(
            &env.dbx,
            None,
            SIGINT_UNIT_NAME_REVIEW_PAGE_SIZE,
        )
        .await
        .unwrap()
        .units;
        assert_eq!(
            reviews
                .iter()
                .map(|review| review.sigint_unit_id)
                .collect::<Vec<_>>(),
            vec![second.id, first.id]
        );
    }
}
