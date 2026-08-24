use super::types::{
    ConfirmUnitNameReq, ListUnitNameReviewsRsp, UnitNameReview,
    UpdateUnitNameReq,
};
use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::types::*;
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::Utc;
use sea_orm::*;
use uuid::Uuid;

#[post("/api/admin/unit-names")]
pub async fn list_unit_name_reviews(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<ListUnitNameReviewsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(ListUnitNameReviewsRsp {
        units: load_unit_name_reviews(&env.dbx).await.c(h!())?,
    }))
}

async fn load_unit_name_reviews(
    dbx: &DatabaseConnection,
) -> Result<Vec<UnitNameReview>, AppError> {
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::UpdatedAt)
        .order_by_asc(sigint_unit::Column::Id)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_unit_name_review)
        .collect())
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
        unit.name = Set(name.trim().to_string());
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

    #[test]
    fn expected_name_uses_non_empty_hierarchy_in_order() {
        assert_eq!(
            expected_unit_name_from_hierarchy([
                " екіпаж ",
                "",
                "ланка",
                " ",
                "рота",
                "",
                "полк",
                "бригада",
                "",
                "корпус",
                "армія",
            ]),
            "екіпаж ланка рота полк бригада корпус армія"
        );
    }

    #[tokio::test]
    #[serial]
    async fn reviews_include_active_units_in_confirmation_order() {
        // Regression: https://github.com/echoua/echo/issues/3113
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();
        let first = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("custom".to_string()),
                team_or_crew: Set("екіпаж".to_string()),
                company: Set("рота".to_string()),
                army: Set("армія".to_string()),
                updated_at: Set(now - Duration::days(2)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("second".to_string()),
                updated_at: Set(now - Duration::days(1)),
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

        let reviews = load_unit_name_reviews(&env.dbx).await.unwrap();
        assert_eq!(
            reviews
                .iter()
                .map(|review| review.sigint_unit_id)
                .collect::<Vec<_>>(),
            vec![first.id, second.id]
        );
        assert_eq!(reviews[0].expected_name, "екіпаж рота армія");
        assert!(!reviews[0].matches_expected);

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

        let reviews = load_unit_name_reviews(&env.dbx).await.unwrap();
        assert_eq!(reviews[0].sigint_unit_id, second.id);
        assert_eq!(reviews[1].sigint_unit_id, first.id);
    }
}
