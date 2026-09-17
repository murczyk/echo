use crate::entities::{failed_unit_label, sigint_unit};
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
pub struct UnresolvedUnitMessage {
    pub id: i64,
    pub group_name: Option<String>,
    pub label: String,
    pub sender: Option<String>,
    pub body: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnresolvedUnitMessagesReq {
    pub title: String,
    pub page: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnresolvedUnitMessagesRsp {
    pub messages: Vec<UnresolvedUnitMessage>,
    pub has_more: bool,
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

#[derive(Debug, sea_orm::FromQueryResult)]
struct UnresolvedUnitMessageRow {
    id: i64,
    group_name: Option<String>,
    label: String,
    sender: Option<String>,
    body: String,
    created_at: chrono::NaiveDateTime,
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
    let normalized = normalized_text_sql("failed_unit_label");
    let archive_filter_sql = archive_filter_sql(&archive_filter);
    let total_sql = format!(
        "select count(*)::bigint as count \
         from failed_unit_label \
         where exists (\
             select 1 from sigint_inbox_item_failed_unit_label link \
             where link.failed_unit_label_id = failed_unit_label.id \
                 and link.deleted = false\
         ) {archive_filter_sql}"
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
        "select unit_txt, count(link.id)::bigint as quantity, note, \
         is_bad_data as is_archived \
         from failed_unit_label \
         join sigint_inbox_item_failed_unit_label link \
             on link.failed_unit_label_id = failed_unit_label.id \
             and link.deleted = false \
         where true {archive_filter_sql} \
         group by failed_unit_label.id \
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

async fn list_message_rows<C>(
    db: &C,
    title: &str,
    page: u64,
) -> Result<ListUnresolvedUnitMessagesRsp, AppError>
where
    C: ConnectionTrait,
{
    let page_size = crate::config::UNRESOLVED_UNIT_MESSAGES_PAGE_SIZE;
    let normalized = normalized_text_sql("failed_unit_label");
    let sender =
        crate::sigint::sender::preferred_sender_sql_snippet(Some("message"));
    let sql = format!(
        "select message.id, \
         coalesce(linked_group.group_name, direct_group.name, \
             direct_datasource_group.name, direct_datasource_group.group_master_key) \
             as group_name, \
         failed_unit_label.unit_txt as label, \
         coalesce({sender}, message.sender) as sender, \
         coalesce(message.body, '') as body, message.created_at \
         from failed_unit_label \
         join sigint_inbox_item_failed_unit_label link \
             on link.failed_unit_label_id = failed_unit_label.id \
             and link.deleted = false \
         join sigint_inbox_item inbox_item on inbox_item.id = link.inbox_item_id \
         join signal_message message on message.id = inbox_item.id \
             and message.deleted = false \
         left join lateral (\
             select coalesce(signal_group.name, datasource_group.name, \
                 message_group.group_master_key) as group_name \
             from signal_message_group message_group \
             left join signal_group \
                 on signal_group.master_key = message_group.group_master_key \
             left join datasource_group \
                 on datasource_group.id = message_group.datasource_group_id \
             where message_group.signal_message_id = message.id \
             order by message_group.id asc \
             limit 1\
         ) linked_group on true \
         left join datasource_group direct_datasource_group \
             on direct_datasource_group.id = message.datasource_group_id \
         left join signal_group direct_group \
             on direct_group.master_key = direct_datasource_group.group_master_key \
         where {normalized} = $1 \
         order by message.created_at desc, message.id desc \
         limit $2 offset $3"
    );
    let mut rows = UnresolvedUnitMessageRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [
                super::unit_resolution::normalize_unit_label(title).into(),
                i64::try_from(page_size + 1).c(h!())?.into(),
                i64::try_from(page.saturating_mul(page_size))
                    .c(h!())?
                    .into(),
            ],
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    let page_size = usize::try_from(page_size).c(h!())?;
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);
    Ok(ListUnresolvedUnitMessagesRsp {
        messages: rows
            .into_iter()
            .map(|row| UnresolvedUnitMessage {
                id: row.id,
                group_name: row.group_name,
                label: row.label,
                sender: row.sender,
                body: row.body,
                created_at: row.created_at.and_utc().timestamp_millis(),
            })
            .collect(),
        has_more,
    })
}

pub(crate) async fn load_new_unresolved_unit_labels<C>(
    db: &C,
) -> anyhow::Result<Vec<UnresolvedUnitLabel>>
where
    C: ConnectionTrait,
{
    let normalized = normalized_text_sql("failed_unit_label");
    let sql = format!(
        "select unit_txt, count(link.id)::bigint as quantity, note, \
         false as is_archived \
         from failed_unit_label \
         join sigint_inbox_item_failed_unit_label link \
             on link.failed_unit_label_id = failed_unit_label.id \
             and link.deleted = false \
         where is_bad_data = false \
         group by failed_unit_label.id \
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

#[post("/api/admin/unresolved-unit-label/messages")]
pub async fn list_unresolved_unit_messages(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ListUnresolvedUnitMessagesReq>,
) -> Result<Json<ListUnresolvedUnitMessagesRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(
        list_message_rows(&env.dbx, &req.title, req.page.unwrap_or(0))
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
    let result = failed_unit_label::Entity::update_many()
        .col_expr(failed_unit_label::Column::IsBadData, Expr::value(true))
        .filter(Expr::cust_with_values(
            format!("{} = $1", normalized_text_sql("failed_unit_label")),
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
    failed_unit_label::Entity::update_many()
        .col_expr(failed_unit_label::Column::IsBadData, Expr::value(archived))
        .filter(failed_unit_label::Column::IsBadData.eq(!archived))
        .filter(Expr::cust_with_values(
            format!("{} = $1", normalized_text_sql("failed_unit_label")),
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
    let result = failed_unit_label::Entity::update_many()
        .col_expr(
            failed_unit_label::Column::Note,
            Expr::value(req.note.trim().to_string()),
        )
        .filter(failed_unit_label::Column::IsBadData.eq(req.is_archived))
        .filter(Expr::cust_with_values(
            format!("{} = $1", normalized_text_sql("failed_unit_label")),
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
    use crate::entities::{
        datasource_group, failed_unit_label, sigint_inbox_item,
        sigint_inbox_item_failed_unit_label, signal_message,
    };
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    async fn insert_failure(
        db: &sea_orm::DatabaseConnection,
        unit_txt: &str,
        deleted: bool,
        is_bad_data: bool,
    ) -> sigint_inbox_item::Model {
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                unit: Set(Some(unit_txt.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        super::super::unit_resolution::upsert_failure(
            db,
            inbox_item.id,
            inbox_item.id_uuid,
            unit_txt,
        )
        .await
        .unwrap();
        if is_bad_data {
            failed_unit_label::Entity::update_many()
                .col_expr(
                    failed_unit_label::Column::IsBadData,
                    Expr::value(true),
                )
                .filter(Expr::cust_with_values(
                    "lower(regexp_replace(btrim(failed_unit_label.unit_txt), '[[:space:]]+', ' ', 'g')) = $1",
                    vec![super::super::unit_resolution::normalize_unit_label(unit_txt)],
                ))
                .exec(db)
                .await
                .unwrap();
        }
        if deleted {
            super::super::unit_resolution::mark_failures_pending_for_text(
                db, unit_txt,
            )
            .await
            .unwrap();
        }
        inbox_item
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
    async fn message_list_loads_five_newest_messages_per_page() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let datasource_group = datasource_group::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let base_time = chrono::NaiveDate::from_ymd_opt(2026, 9, 17)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        for index in 0..6 {
            let inbox_item =
                insert_failure(&env.dbx, "Example Label", false, false).await;
            signal_message::Entity::update_many()
                .col_expr(
                    signal_message::Column::Body,
                    Expr::value(format!("body {index}")),
                )
                .col_expr(
                    signal_message::Column::Sender,
                    Expr::value(format!("sender {index}")),
                )
                .col_expr(
                    signal_message::Column::DatasourceGroupId,
                    Expr::value(datasource_group.id),
                )
                .col_expr(
                    signal_message::Column::CreatedAt,
                    Expr::value(base_time + chrono::Duration::minutes(index)),
                )
                .filter(signal_message::Column::Id.eq(inbox_item.id))
                .exec(&env.dbx)
                .await
                .unwrap();
        }

        let first_page = list_message_rows(&env.dbx, " example   label ", 0)
            .await
            .unwrap();
        assert_eq!(first_page.messages.len(), 5);
        assert!(first_page.has_more);
        assert_eq!(first_page.messages[0].body, "body 5");
        assert_eq!(first_page.messages[0].sender.as_deref(), Some("sender 5"));
        assert_eq!(
            first_page.messages[0].group_name.as_deref(),
            Some("Вухо-Тест")
        );
        assert_eq!(first_page.messages[0].label, "Example Label");

        let second_page = list_message_rows(&env.dbx, "Example Label", 1)
            .await
            .unwrap();
        assert_eq!(second_page.messages.len(), 1);
        assert!(!second_page.has_more);
        assert_eq!(second_page.messages[0].body, "body 0");
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
        let failures = sigint_inbox_item_failed_unit_label::Entity::find()
            .filter(
                sigint_inbox_item_failed_unit_label::Column::Deleted.eq(true),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().all(|failure| failure.deleted));
    }
}
