use crate::entities::sea_orm_active_enums::EchoMissingMessageStatus;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::Json;
use chrono::{NaiveDateTime, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use log::debug;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseBackend,
    DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};

pub const SYSTEM_SCHEDULED_BY: &str = "system";

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoMissingMessageRow {
    pub id: i64,
    pub message_id: i32,
    pub body: String,
    pub created_at: String,
    pub is_resolved: bool,
    pub resolved_at: Option<String>,
    pub scheduled_by: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoMissingMessageListRsp {
    pub items: Vec<EchoMissingMessageRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoMissingMessageResolveReq {
    pub id: i64,
}

#[derive(Debug, FromQueryResult)]
struct EchoMissingMessageJoinedRow {
    id: i64,
    message_id: i32,
    body: Option<String>,
    created_at: NaiveDateTime,
    is_resolved: bool,
    resolved_at: Option<NaiveDateTime>,
    scheduled_by: Option<String>,
    status: String,
    error: Option<String>,
}

impl EchoMissingMessageJoinedRow {
    fn into_api_row(self) -> EchoMissingMessageRow {
        EchoMissingMessageRow {
            id: self.id,
            message_id: self.message_id,
            body: self.body.unwrap_or_else(|| "???".to_string()),
            created_at: format_dt(self.created_at),
            is_resolved: self.is_resolved,
            resolved_at: self.resolved_at.map(format_dt),
            scheduled_by: self.scheduled_by,
            status: self.status,
            error: self.error,
        }
    }
}

pub async fn record_missing_message(
    dbx: &DatabaseConnection,
    message_id: i32,
    scheduled_by: Option<&str>,
) -> Result<echo_missing_message::Model, AppError> {
    let status = if scheduled_by.is_some() {
        EchoMissingMessageStatus::Scheduled
    } else {
        EchoMissingMessageStatus::Pending
    };
    let missing_message = echo_missing_message::ActiveModel {
        id: sea_orm::ActiveValue::NotSet,
        message_id: Set(message_id),
        created_at: sea_orm::ActiveValue::NotSet,
        is_resolved: Set(false),
        resolved_at: Set(None),
        scheduled_by: Set(scheduled_by.map(str::to_string)),
        status: Set(status),
        error: Set(None),
    };

    match missing_message.insert(dbx).await {
        Ok(missing_message) => Ok(missing_message),
        Err(err) => {
            let existing = echo_missing_message::Entity::find()
                .filter(echo_missing_message::Column::MessageId.eq(message_id))
                .one(dbx)
                .await
                .c(h!())?;
            if let Some(existing) = existing {
                debug!(
                    "echo_missing_message already exists, skipping duplicate insert: message_id={} id={}",
                    message_id, existing.id
                );
                Ok(existing)
            } else {
                let result: Result<
                    echo_missing_message::Model,
                    sea_orm::DbErr,
                > = Err(err);
                Ok(result.c(h!())?)
            }
        }
    }
}

pub async fn schedule_missing_message(
    dbx: &DatabaseConnection,
    missing_message: echo_missing_message::Model,
    scheduled_by: &str,
) -> Result<echo_missing_message::Model, AppError> {
    if missing_message.is_resolved {
        return Ok(missing_message);
    }
    let mut missing_message: echo_missing_message::ActiveModel =
        missing_message.into();
    missing_message.status = Set(EchoMissingMessageStatus::Scheduled);
    missing_message.scheduled_by = Set(Some(scheduled_by.to_string()));
    missing_message.error = Set(None);
    missing_message.resolved_at = Set(None);
    missing_message.is_resolved = Set(false);
    Ok(missing_message.update(dbx).await.c(h!())?)
}

pub async fn load_scheduled_missing_messages(
    dbx: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<echo_missing_message::Model>, AppError> {
    Ok(echo_missing_message::Entity::find()
        .filter(echo_missing_message::Column::IsResolved.eq(false))
        .filter(
            echo_missing_message::Column::Status
                .eq(EchoMissingMessageStatus::Scheduled),
        )
        .order_by_asc(echo_missing_message::Column::CreatedAt)
        .order_by_asc(echo_missing_message::Column::Id)
        .limit(limit)
        .all(dbx)
        .await
        .c(h!())?)
}

pub async fn mark_missing_message_resolved(
    dbx: &DatabaseConnection,
    missing_message: echo_missing_message::Model,
) -> Result<echo_missing_message::Model, AppError> {
    let mut missing_message: echo_missing_message::ActiveModel =
        missing_message.into();
    missing_message.status = Set(EchoMissingMessageStatus::Resolved);
    missing_message.is_resolved = Set(true);
    missing_message.resolved_at = Set(Some(Utc::now().naive_utc()));
    missing_message.error = Set(None);
    Ok(missing_message.update(dbx).await.c(h!())?)
}

pub async fn mark_missing_message_deleted(
    dbx: &DatabaseConnection,
    missing_message: echo_missing_message::Model,
) -> Result<echo_missing_message::Model, AppError> {
    let mut missing_message: echo_missing_message::ActiveModel =
        missing_message.into();
    missing_message.status = Set(EchoMissingMessageStatus::Deleted);
    missing_message.is_resolved = Set(true);
    missing_message.resolved_at = Set(Some(Utc::now().naive_utc()));
    missing_message.error = Set(None);
    Ok(missing_message.update(dbx).await.c(h!())?)
}

pub async fn mark_missing_message_error(
    dbx: &DatabaseConnection,
    missing_message: echo_missing_message::Model,
    error: String,
) -> Result<echo_missing_message::Model, AppError> {
    let mut missing_message: echo_missing_message::ActiveModel =
        missing_message.into();
    missing_message.status = Set(EchoMissingMessageStatus::Error);
    missing_message.is_resolved = Set(false);
    missing_message.resolved_at = Set(None);
    missing_message.error = Set(Some(error));
    Ok(missing_message.update(dbx).await.c(h!())?)
}

pub async fn record_deleted_missing_message(
    dbx: &DatabaseConnection,
    message_id: i32,
) -> Result<echo_missing_message::Model, AppError> {
    let missing_message = record_missing_message(dbx, message_id, None).await?;
    mark_missing_message_deleted(dbx, missing_message).await
}

pub async fn schedule_missing_message_by_id(
    dbx: &DatabaseConnection,
    id: i64,
    scheduled_by: &str,
) -> Result<echo_missing_message::Model, AppError> {
    let missing_message = echo_missing_message::Entity::find_by_id(id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    schedule_missing_message(dbx, missing_message, scheduled_by).await
}

pub(crate) async fn list_missing_messages(
    dbx: &DatabaseConnection,
) -> Result<Vec<EchoMissingMessageRow>, AppError> {
    let sql = r#"
        select
            emm.id,
            emm.message_id,
            eim.body,
            emm.created_at,
            emm.is_resolved,
            emm.resolved_at,
            emm.scheduled_by,
            emm.status::text as status,
            emm.error
        from echo_missing_message emm
        left join echo_inbox_message eim on eim.id = emm.message_id
        order by emm.is_resolved asc, emm.created_at desc, emm.id desc
    "#;
    Ok(
        EchoMissingMessageJoinedRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            sql.to_string(),
        ))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(EchoMissingMessageJoinedRow::into_api_row)
        .collect(),
    )
}

#[post("/api/admin/echo-missing-message/list")]
pub async fn echo_missing_message_list(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<EchoMissingMessageListRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    Ok(Json(EchoMissingMessageListRsp {
        items: list_missing_messages(&env.dbx).await?,
    }))
}

#[post("/api/admin/echo-missing-message/resolve")]
pub async fn echo_missing_message_resolve(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<EchoMissingMessageResolveReq>,
) -> Result<Json<EchoMissingMessageRow>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;
    let missing_message =
        schedule_missing_message_by_id(&env.dbx, req.id, &login).await?;
    Ok(Json(row_by_id(&env.dbx, missing_message.id).await?))
}

async fn row_by_id(
    dbx: &DatabaseConnection,
    id: i64,
) -> Result<EchoMissingMessageRow, AppError> {
    let sql = r#"
        select
            emm.id,
            emm.message_id,
            eim.body,
            emm.created_at,
            emm.is_resolved,
            emm.resolved_at,
            emm.scheduled_by,
            emm.status::text as status,
            emm.error
        from echo_missing_message emm
        left join echo_inbox_message eim on eim.id = emm.message_id
        where emm.id = $1
    "#;
    EchoMissingMessageJoinedRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [id.into()],
        ),
    )
    .one(dbx)
    .await
    .c(h!())?
    .map(EchoMissingMessageJoinedRow::into_api_row)
    .ok_or(AppError::NotFound)
}

fn format_dt(dt: NaiveDateTime) -> String {
    dt.and_utc().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::cleanup;
    use serial_test::serial;

    static TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    #[tokio::test]
    #[serial]
    async fn list_uses_placeholder_when_inbox_body_is_missing() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        echo_missing_message::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let message_id = -12345;
        record_missing_message(&env.dbx, message_id, None)
            .await
            .unwrap();

        let rows = list_missing_messages(&env.dbx).await.unwrap();

        let row = rows
            .into_iter()
            .find(|row| row.message_id == message_id)
            .unwrap();
        assert_eq!(row.body, "???");
        assert_eq!(row.status, "pending");
    }
}
