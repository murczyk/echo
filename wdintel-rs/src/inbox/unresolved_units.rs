use crate::entities::{failed_inbox_unit, orbit_unit};
use crate::error::AppError;
use crate::h;
use crate::sigint::unit::types::{
    OrbitUnitLinkCandidatesRsp, OrbitUnitSearchReq,
};
use crate::types::{Env, ShortContext};
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait,
    FromQueryResult, QueryFilter, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PAGE_SIZE: u64 = 20;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnresolvedUnitLabel {
    pub unit_txt: String,
    pub quantity: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnresolvedUnitLabelsReq {
    pub page: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnresolvedUnitLabelsRsp {
    pub rows: Vec<UnresolvedUnitLabel>,
    pub total_count: i64,
    pub page: u64,
    pub page_size: u64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ClassifyUnresolvedUnitLabelReq {
    pub unit_txt: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ResolveUnresolvedUnitLabelReq {
    pub unit_txt: String,
    pub label: String,
    pub orbit_unit_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateUnresolvedUnitLabelsRsp {
    pub affected_count: u64,
}

#[derive(Debug, sea_orm::FromQueryResult)]
struct UnresolvedUnitLabelRow {
    unit_txt: String,
    quantity: i64,
}

fn normalized_text_sql(table: &str) -> String {
    format!(
        "lower(regexp_replace(btrim({table}.unit_txt), '[[:space:]]+', ' ', 'g'))"
    )
}

async fn list_rows<C>(
    db: &C,
    page: u64,
) -> Result<ListUnresolvedUnitLabelsRsp, AppError>
where
    C: ConnectionTrait,
{
    let normalized = normalized_text_sql("failed_inbox_unit");
    let total_sql = format!(
        "select count(*)::bigint as count from (\
         select 1 from failed_inbox_unit \
         where deleted = false and is_bad_data = false \
         group by {normalized}) grouped"
    );
    let total_count = db
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            total_sql,
        ))
        .await
        .c(h!())?
        .map(|row| row.try_get::<i64>("", "count"))
        .transpose()
        .c(h!())?
        .unwrap_or(0);

    let list_sql = format!(
        "select min(unit_txt) as unit_txt, count(*)::bigint as quantity \
         from failed_inbox_unit \
         where deleted = false and is_bad_data = false \
         group by {normalized} \
         order by quantity desc, {normalized} asc \
         limit $1 offset $2"
    );
    let rows = UnresolvedUnitLabelRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            list_sql,
            [
                i64::try_from(PAGE_SIZE).c(h!())?.into(),
                i64::try_from(page.saturating_mul(PAGE_SIZE))
                    .c(h!())?
                    .into(),
            ],
        ),
    )
    .all(db)
    .await
    .c(h!())?
    .into_iter()
    .map(|row| UnresolvedUnitLabel {
        unit_txt: row.unit_txt,
        quantity: row.quantity,
    })
    .collect();
    Ok(ListUnresolvedUnitLabelsRsp {
        rows,
        total_count,
        page,
        page_size: PAGE_SIZE,
    })
}

async fn ensure_admin_orbit_editor(
    env: &Env,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    ensure_admin(&env.dbx, user).await.c(h!())?;
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    if !crate::sigint::unit::orbit::can_view_orbit_data(&env.dbx, &login)
        .await
        .c(h!())?
    {
        return Err(AppError::Forbidden(
            "ORBIT data access denied".to_string(),
        ));
    }
    Ok(())
}

#[post("/api/admin/unresolved-unit-label/list")]
pub async fn list_unresolved_unit_labels(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ListUnresolvedUnitLabelsReq>,
) -> Result<Json<ListUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(
        list_rows(&env.dbx, req.page.unwrap_or(0)).await.c(h!())?,
    ))
}

#[post("/api/admin/unresolved-unit-label/bad-data")]
pub async fn classify_unresolved_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ClassifyUnresolvedUnitLabelReq>,
) -> Result<Json<UpdateUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let result = failed_inbox_unit::Entity::update_many()
        .col_expr(failed_inbox_unit::Column::IsBadData, Expr::value(true))
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            format!("{} = $1", normalized_text_sql("failed_inbox_unit")),
            vec![super::unit_resolution::normalize_unit_label(&req.unit_txt)],
        ))
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(UpdateUnresolvedUnitLabelsRsp {
        affected_count: result.rows_affected,
    }))
}

#[post("/api/admin/unresolved-unit-label/orbit-search")]
pub async fn search_orbit_units(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<OrbitUnitSearchReq>,
) -> Result<Json<OrbitUnitLinkCandidatesRsp>, AppError> {
    ensure_admin_orbit_editor(&env, &user).await.c(h!())?;
    let units = crate::sigint::unit::orbit::manual_orbit_link_candidates(
        &env.dbx,
        &req.search,
    )
    .await
    .c(h!())?;
    Ok(Json(OrbitUnitLinkCandidatesRsp { units }))
}

#[post("/api/admin/unresolved-unit-label/resolve")]
pub async fn resolve_unresolved_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ResolveUnresolvedUnitLabelReq>,
) -> Result<Json<UpdateUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin_orbit_editor(&env, &user).await.c(h!())?;
    let orbit_unit_id = Uuid::parse_str(&req.orbit_unit_id)
        .map_err(|_| AppError::BL {
            msg: "Некоректний ідентифікатор підрозділу ORBIT".to_string(),
        })
        .c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    orbit_unit::Entity::find_by_id(orbit_unit_id)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let sigint_unit_ids =
        super::unit_resolution::active_sigint_unit_ids_for_orbit(
            &transaction,
            orbit_unit_id,
        )
        .await
        .c(h!())?;
    if sigint_unit_ids.len() != 1 {
        return Err(AppError::BL {
            msg: format!(
                "Підрозділ ORBIT повинен мати рівно один активний зв'язок із підрозділом SIGINT; знайдено {}",
                sigint_unit_ids.len()
            ),
        });
    }
    crate::sigint::unit::labels::insert_label(
        &transaction,
        sigint_unit_ids[0],
        &req.label,
    )
    .await
    .c(h!())?;
    let affected_count =
        super::unit_resolution::mark_failures_pending_for_text(
            &transaction,
            &req.unit_txt,
        )
        .await
        .c(h!())?;
    if affected_count == 0 {
        return Err(AppError::NotFound);
    }
    transaction.commit().await.c(h!())?;
    Ok(Json(UpdateUnresolvedUnitLabelsRsp { affected_count }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_inbox_item;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    async fn insert_failure(
        db: &sea_orm::DatabaseConnection,
        unit_txt: &str,
        deleted: bool,
        is_bad_data: bool,
    ) {
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                unit: Set(Some(unit_txt.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        failed_inbox_unit::ActiveModel {
            deleted: Set(deleted),
            is_bad_data: Set(is_bad_data),
            inbox_item_id: Set(inbox_item.id),
            unit_txt: Set(unit_txt.to_string()),
            deleted_at: Set(deleted.then(|| chrono::Utc::now().naive_utc())),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn grouped_list_normalizes_text_and_orders_by_quantity() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        for text in ["Group Alpha", " group   alpha ", "GROUP ALPHA"] {
            insert_failure(&env.dbx, text, false, false).await;
        }
        for text in ["Group Beta", "group beta"] {
            insert_failure(&env.dbx, text, false, false).await;
        }
        insert_failure(&env.dbx, "Group Gamma", false, true).await;
        insert_failure(&env.dbx, "Group Delta", true, false).await;

        let response = list_rows(&env.dbx, 0).await.unwrap();

        assert_eq!(response.total_count, 2);
        assert_eq!(response.page_size, 20);
        assert_eq!(response.rows.len(), 2);
        assert_eq!(response.rows[0].quantity, 3);
        assert_eq!(
            crate::inbox::unit_resolution::normalize_unit_label(
                &response.rows[0].unit_txt
            ),
            "group alpha"
        );
        assert_eq!(response.rows[1].quantity, 2);
    }
}
