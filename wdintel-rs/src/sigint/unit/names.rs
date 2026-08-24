use super::types::{
    ConfirmUnitNameReq, ListUnitNameReviewsReq, ListUnitNameReviewsRsp,
    UnitNameReview, UnitNameReviewCursor, UpdateUnitNameReq,
};
use crate::config::SIGINT_UNIT_NAME_REVIEW_PAGE_SIZE;
use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::types::*;
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::{NaiveDateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::*;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct UnitNameReviewRow {
    id: i64,
    name: String,
    team_or_crew: String,
    section: String,
    squad: String,
    platoon: String,
    company: String,
    battalion: String,
    regiment: String,
    brigade: String,
    division: String,
    corps: String,
    army: String,
    updated_at: NaiveDateTime,
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
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .columns([
            sigint_unit::Column::Id,
            sigint_unit::Column::Name,
            sigint_unit::Column::TeamOrCrew,
            sigint_unit::Column::Section,
            sigint_unit::Column::Squad,
            sigint_unit::Column::Platoon,
            sigint_unit::Column::Company,
            sigint_unit::Column::Battalion,
            sigint_unit::Column::Regiment,
            sigint_unit::Column::Brigade,
            sigint_unit::Column::Division,
            sigint_unit::Column::Corps,
            sigint_unit::Column::Army,
            sigint_unit::Column::UpdatedAt,
        ]);
    if let Some(after) = after {
        let updated_at =
            chrono::DateTime::from_timestamp_micros(after.updated_at_micros)
                .map(|updated_at| updated_at.naive_utc())
                .ok_or_else(|| AppError::BL {
                    msg: "Некоректний курсор списку назв підрозділів"
                        .to_string(),
                })
                .c(h!())?;
        units = units.filter(
            Expr::tuple([
                Expr::col((
                    sigint_unit::Entity,
                    sigint_unit::Column::UpdatedAt,
                )),
                Expr::col((sigint_unit::Entity, sigint_unit::Column::Id)),
            ])
            .gt(Expr::tuple([
                Expr::val(updated_at),
                Expr::val(after.sigint_unit_id),
            ])),
        );
    }
    let mut units = units
        .order_by_asc(sigint_unit::Column::UpdatedAt)
        .order_by_asc(sigint_unit::Column::Id)
        .limit(u64::try_from(page_size.saturating_add(1)).c(h!())?)
        .into_model::<UnitNameReviewRow>()
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
        units: units.into_iter().map(render_unit_name_review_row).collect(),
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
    Ok(Json(render_unit_name_review(unit)))
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
    Ok(Json(render_unit_name_review(unit)))
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

fn render_unit_name_review(unit: sigint_unit::Model) -> UnitNameReview {
    let expected_name = expected_unit_name(&unit);
    UnitNameReview {
        sigint_unit_id: unit.id,
        matches_expected: unit.name == expected_name,
        current_name: unit.name,
        expected_name,
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    }
}

fn render_unit_name_review_row(unit: UnitNameReviewRow) -> UnitNameReview {
    let expected_name = expected_unit_name_from_hierarchy([
        unit.team_or_crew.as_str(),
        unit.section.as_str(),
        unit.squad.as_str(),
        unit.platoon.as_str(),
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.brigade.as_str(),
        unit.division.as_str(),
        unit.corps.as_str(),
        unit.army.as_str(),
    ]);
    UnitNameReview {
        sigint_unit_id: unit.id,
        matches_expected: unit.name == expected_name,
        current_name: unit.name,
        expected_name,
        updated_at: unit.updated_at.and_utc().timestamp_millis(),
    }
}

fn unit_name_review_cursor(unit: &UnitNameReviewRow) -> UnitNameReviewCursor {
    UnitNameReviewCursor {
        updated_at_micros: unit.updated_at.and_utc().timestamp_micros(),
        sigint_unit_id: unit.id,
    }
}

fn expected_unit_name(unit: &sigint_unit::Model) -> String {
    expected_unit_name_from_hierarchy([
        unit.team_or_crew.as_str(),
        unit.section.as_str(),
        unit.squad.as_str(),
        unit.platoon.as_str(),
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.brigade.as_str(),
        unit.division.as_str(),
        unit.corps.as_str(),
        unit.army.as_str(),
    ])
}

fn expected_unit_name_from_hierarchy(hierarchy: [&str; 11]) -> String {
    hierarchy
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_unit_change;
    use crate::functest::tests::{cleanup, mk_sigint_unit};
    use chrono::Duration;
    use serial_test::serial;

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
                team_or_crew: Set("екіпаж".to_string()),
                company: Set("рота".to_string()),
                army: Set("армія".to_string()),
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
        mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                updated_at: Set(now - Duration::days(3)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

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
        assert_eq!(reviews[0].sigint_unit_id, second.id);
        assert_eq!(reviews[1].sigint_unit_id, first.id);
    }
}
