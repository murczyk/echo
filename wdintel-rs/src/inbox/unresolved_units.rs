use crate::entities::{failed_inbox_unit, sigint_unit};
use crate::error::AppError;
use crate::h;
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
    FromQueryResult, QueryFilter, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};

const PAGE_SIZE: u64 = 20;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnresolvedUnitLabel {
    pub unit_txt: String,
    pub quantity: i64,
    pub note: String,
    pub is_archived: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum UnresolvedUnitLabelArchiveFilter {
    AllUnresolvedUnitLabels,
    NewUnresolvedUnitLabels,
    ArchivedUnresolvedUnitLabels,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnresolvedUnitLabelsReq {
    pub page: Option<u64>,
    pub archive_filter: Option<UnresolvedUnitLabelArchiveFilter>,
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
pub struct ArchiveUnresolvedUnitLabelReq {
    pub unit_txt: String,
    pub archived: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ResolveUnresolvedUnitLabelReq {
    pub unit_txt: String,
    pub label: String,
    pub sigint_unit_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateUnresolvedUnitLabelNoteReq {
    pub unit_txt: String,
    pub note: String,
    pub is_archived: bool,
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
    note: String,
    is_archived: bool,
}

fn normalized_text_sql(table: &str) -> String {
    format!(
        "lower(regexp_replace(btrim({table}.unit_txt), '[[:space:]]+', ' ', 'g'))"
    )
}

fn archive_filter_sql(
    archive_filter: &UnresolvedUnitLabelArchiveFilter,
) -> &'static str {
    match archive_filter {
        UnresolvedUnitLabelArchiveFilter::AllUnresolvedUnitLabels => "",
        UnresolvedUnitLabelArchiveFilter::NewUnresolvedUnitLabels => {
            " and is_bad_data = false"
        }
        UnresolvedUnitLabelArchiveFilter::ArchivedUnresolvedUnitLabels => {
            " and is_bad_data = true"
        }
    }
}

async fn list_rows<C>(
    db: &C,
    page: u64,
    archive_filter: UnresolvedUnitLabelArchiveFilter,
) -> Result<ListUnresolvedUnitLabelsRsp, AppError>
where
    C: ConnectionTrait,
{
    let normalized = normalized_text_sql("failed_inbox_unit");
    let archive_filter_sql = archive_filter_sql(&archive_filter);
    let total_sql = format!(
        "select count(*)::bigint as count from (\
         select 1 from failed_inbox_unit \
         where deleted = false {archive_filter_sql} \
         group by {normalized}, is_bad_data) grouped"
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
        "select min(unit_txt) as unit_txt, count(*)::bigint as quantity, \
         coalesce(max(nullif(note, '')), '') as note, \
         is_bad_data as is_archived \
         from failed_inbox_unit \
         where deleted = false {archive_filter_sql} \
         group by {normalized}, is_bad_data \
         order by is_bad_data asc, quantity desc, {normalized} asc \
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
        note: row.note,
        is_archived: row.is_archived,
    })
    .collect();
    Ok(ListUnresolvedUnitLabelsRsp {
        rows,
        total_count,
        page,
        page_size: PAGE_SIZE,
    })
}

pub(crate) async fn load_new_unresolved_unit_labels<C>(
    db: &C,
) -> anyhow::Result<Vec<UnresolvedUnitLabel>>
where
    C: ConnectionTrait,
{
    let normalized = normalized_text_sql("failed_inbox_unit");
    let sql = format!(
        "select min(unit_txt) as unit_txt, count(*)::bigint as quantity, \
         coalesce(max(nullif(note, '')), '') as note, false as is_archived \
         from failed_inbox_unit \
         where deleted = false and is_bad_data = false \
         group by {normalized} \
         order by quantity desc, {normalized} asc"
    );
    Ok(
        UnresolvedUnitLabelRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            sql,
        ))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| UnresolvedUnitLabel {
            unit_txt: row.unit_txt,
            quantity: row.quantity,
            note: row.note,
            is_archived: row.is_archived,
        })
        .collect(),
    )
}

async fn ensure_admin_unit_editor(
    env: &Env,
    user: &actix_identity::Identity,
) -> Result<uuid::Uuid, AppError> {
    ensure_admin(&env.dbx, user).await.c(h!())?;
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    has_role(&env.dbx, &login, "UnitsEditor").await.c(h!())?;
    Ok(login)
}

async fn mark_resolved_failures_pending<C>(
    db: &C,
    unit_txt: &str,
    label: &str,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    let normalized_unit_txt =
        super::unit_resolution::normalize_unit_label(unit_txt);
    let normalized_label = super::unit_resolution::normalize_unit_label(label);
    let mut affected_count =
        super::unit_resolution::mark_failures_pending_for_text(db, unit_txt)
            .await
            .c(h!())?;
    if normalized_label != normalized_unit_txt {
        affected_count +=
            super::unit_resolution::mark_failures_pending_for_text(
                db,
                &normalized_label,
            )
            .await
            .c(h!())?;
    }
    Ok(affected_count)
}

#[post("/api/admin/unresolved-unit-label/list")]
pub async fn list_unresolved_unit_labels(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ListUnresolvedUnitLabelsReq>,
) -> Result<Json<ListUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(
        list_rows(
            &env.dbx,
            req.page.unwrap_or(0),
            req.archive_filter.clone().unwrap_or(
                UnresolvedUnitLabelArchiveFilter::NewUnresolvedUnitLabels,
            ),
        )
        .await
        .c(h!())?,
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

#[post("/api/admin/unresolved-unit-label/archive")]
pub async fn archive_unresolved_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ArchiveUnresolvedUnitLabelReq>,
) -> Result<Json<UpdateUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let result = set_unresolved_unit_label_archive_state(
        &env.dbx,
        &req.unit_txt,
        req.archived,
    )
    .await
    .c(h!())?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(UpdateUnresolvedUnitLabelsRsp {
        affected_count: result.rows_affected,
    }))
}

pub(crate) async fn archive_unresolved_unit_label_in_transaction<C>(
    db: &C,
    unit_txt: &str,
) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    Ok(set_unresolved_unit_label_archive_state(db, unit_txt, true)
        .await
        .c(h!())?
        .rows_affected)
}

async fn set_unresolved_unit_label_archive_state<C>(
    db: &C,
    unit_txt: &str,
    archived: bool,
) -> anyhow::Result<sea_orm::UpdateResult>
where
    C: ConnectionTrait,
{
    failed_inbox_unit::Entity::update_many()
        .col_expr(failed_inbox_unit::Column::IsBadData, Expr::value(archived))
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .filter(failed_inbox_unit::Column::IsBadData.eq(!archived))
        .filter(Expr::cust_with_values(
            format!("{} = $1", normalized_text_sql("failed_inbox_unit")),
            vec![super::unit_resolution::normalize_unit_label(unit_txt)],
        ))
        .exec(db)
        .await
        .c(h!())
}

#[post("/api/admin/unresolved-unit-label/note")]
pub async fn update_unresolved_unit_label_note(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateUnresolvedUnitLabelNoteReq>,
) -> Result<Json<UpdateUnresolvedUnitLabelsRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let result = failed_inbox_unit::Entity::update_many()
        .col_expr(
            failed_inbox_unit::Column::Note,
            Expr::value(req.note.trim().to_string()),
        )
        .filter(failed_inbox_unit::Column::Deleted.eq(false))
        .filter(failed_inbox_unit::Column::IsBadData.eq(req.is_archived))
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

#[post("/api/admin/unresolved-unit-label/resolve")]
pub async fn resolve_unresolved_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ResolveUnresolvedUnitLabelReq>,
) -> Result<Json<UpdateUnresolvedUnitLabelsRsp>, AppError> {
    let login = ensure_admin_unit_editor(&env, &user).await.c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    let result = resolve_unresolved_unit_label_in_transaction(
        &transaction,
        &login,
        &req.unit_txt,
        &req.label,
        req.sigint_unit_id,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    if result.unit_activated {
        crate::sigint::unit::fanout_unit_changed_data(&env)
            .await
            .c(h!())?;
    }
    Ok(Json(UpdateUnresolvedUnitLabelsRsp {
        affected_count: result.affected_count,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolveUnresolvedUnitLabelOutcome {
    pub affected_count: u64,
    pub unit_activated: bool,
}

pub(crate) async fn resolve_unresolved_unit_label_in_transaction<C>(
    db: &C,
    login: &uuid::Uuid,
    unit_txt: &str,
    label: &str,
    sigint_unit_id: i64,
) -> Result<ResolveUnresolvedUnitLabelOutcome, AppError>
where
    C: ConnectionTrait,
{
    crate::sigint::unit::labels::validate_label(label).c(h!())?;
    crate::sigint::unit::labels::validate_label(unit_txt).c(h!())?;
    let sigint_unit = sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let unit_activated = !sigint_unit.active;
    if unit_activated {
        crate::sigint::unit::activate_unit_for_login(db, login, &sigint_unit)
            .await
            .c(h!())?;
    }
    crate::sigint::unit::labels::insert_label(db, sigint_unit_id, label)
        .await
        .c(h!())?;
    crate::sigint::unit::labels::insert_label(db, sigint_unit_id, unit_txt)
        .await
        .c(h!())?;
    let affected_count = mark_resolved_failures_pending(db, unit_txt, label)
        .await
        .c(h!())?;
    if affected_count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(ResolveUnresolvedUnitLabelOutcome {
        affected_count,
        unit_activated,
    })
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

        let response = list_rows(
            &env.dbx,
            0,
            UnresolvedUnitLabelArchiveFilter::NewUnresolvedUnitLabels,
        )
        .await
        .unwrap();

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

    #[tokio::test]
    #[serial]
    async fn resolving_edited_label_marks_both_failure_groups_pending() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        insert_failure(&env.dbx, "original label", false, false).await;
        insert_failure(&env.dbx, "EDITED   LABEL", false, false).await;

        let affected_count = mark_resolved_failures_pending(
            &env.dbx,
            "original label",
            " edited label ",
        )
        .await
        .unwrap();

        assert_eq!(affected_count, 2);
        let failures = failed_inbox_unit::Entity::find()
            .filter(
                failed_inbox_unit::Column::UnitTxt
                    .is_in(["original label", "EDITED   LABEL"]),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().all(|failure| failure.deleted));
    }
}
