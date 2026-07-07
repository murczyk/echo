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
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseBackend, DatabaseConnection, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};

pub const SYSTEM_SCHEDULED_BY: &str = "system";

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoMissingMessageRow {
    pub id: i64,
    pub message_id: i32,
    pub group_names: String,
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
    group_names: Option<String>,
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
        let error = match self.status.as_str() {
            "deleted" | "duplicate" => None,
            _ => self.error,
        };
        EchoMissingMessageRow {
            id: self.id,
            message_id: self.message_id,
            group_names: self.group_names.unwrap_or_default(),
            body: self.body.unwrap_or_else(|| "???".to_string()),
            created_at: format_dt(self.created_at),
            is_resolved: self.is_resolved,
            resolved_at: self.resolved_at.map(format_dt),
            scheduled_by: self.scheduled_by,
            status: self.status,
            error,
        }
    }
}

pub async fn record_missing_message(
    dbx: &impl ConnectionTrait,
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
    dbx: &impl ConnectionTrait,
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
    dbx: &impl ConnectionTrait,
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
    dbx: &impl ConnectionTrait,
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

pub async fn mark_missing_message_duplicate(
    dbx: &impl ConnectionTrait,
    missing_message: echo_missing_message::Model,
) -> Result<echo_missing_message::Model, AppError> {
    let mut missing_message: echo_missing_message::ActiveModel =
        missing_message.into();
    missing_message.status = Set(EchoMissingMessageStatus::Duplicate);
    missing_message.is_resolved = Set(true);
    missing_message.resolved_at = Set(Some(Utc::now().naive_utc()));
    missing_message.error = Set(None);
    Ok(missing_message.update(dbx).await.c(h!())?)
}

pub async fn mark_missing_message_error(
    dbx: &impl ConnectionTrait,
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
    dbx: &impl ConnectionTrait,
    message_id: i32,
) -> Result<echo_missing_message::Model, AppError> {
    let missing_message =
        find_or_record_missing_message(dbx, message_id).await?;
    mark_missing_message_deleted(dbx, missing_message).await
}

pub async fn record_duplicate_missing_message(
    dbx: &impl ConnectionTrait,
    message_id: i32,
) -> Result<echo_missing_message::Model, AppError> {
    let missing_message =
        find_or_record_missing_message(dbx, message_id).await?;
    mark_missing_message_duplicate(dbx, missing_message).await
}

async fn find_or_record_missing_message(
    dbx: &impl ConnectionTrait,
    message_id: i32,
) -> Result<echo_missing_message::Model, AppError> {
    let missing_message = echo_missing_message::Entity::find()
        .filter(echo_missing_message::Column::MessageId.eq(message_id))
        .one(dbx)
        .await
        .c(h!())?;
    if let Some(missing_message) = missing_message {
        return Ok(missing_message);
    }
    record_missing_message(dbx, message_id, None).await
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
            echo_groups.group_names,
            eim.body,
            emm.created_at,
            emm.is_resolved,
            emm.resolved_at,
            emm.scheduled_by,
            emm.status::text as status,
            emm.error
        from echo_missing_message emm
        left join echo_inbox_message eim on eim.id = emm.message_id
        left join lateral (
            select string_agg(
                distinct coalesce(nullif(eg.name, ''), eg.group_id),
                ', ' order by coalesce(nullif(eg.name, ''), eg.group_id)
            ) as group_names
            from echo_inbox_message eim_group
            join echo_group eg on eg.id = eim_group.group_id
            where eim_group.id = emm.message_id
        ) echo_groups on true
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
            echo_groups.group_names,
            eim.body,
            emm.created_at,
            emm.is_resolved,
            emm.resolved_at,
            emm.scheduled_by,
            emm.status::text as status,
            emm.error
        from echo_missing_message emm
        left join echo_inbox_message eim on eim.id = emm.message_id
        left join lateral (
            select string_agg(
                distinct coalesce(nullif(eg.name, ''), eg.group_id),
                ', ' order by coalesce(nullif(eg.name, ''), eg.group_id)
            ) as group_names
            from echo_inbox_message eim_group
            join echo_group eg on eg.id = eim_group.group_id
            where eim_group.id = emm.message_id
        ) echo_groups on true
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
    use crate::entities::sea_orm_active_enums::EchoMessageSource;
    use crate::functest::tests::cleanup;
    use sea_orm::ActiveValue::NotSet;
    use serial_test::serial;
    use uuid::Uuid;

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
        assert_eq!(row.group_names, "");
        assert_eq!(row.status, "pending");
    }

    #[tokio::test]
    #[serial]
    async fn list_includes_inbox_echo_group_names() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        echo_missing_message::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let account = mk_echo_account(&env.dbx).await;
        let group = mk_echo_group(&env.dbx, account.id, "Missing Group").await;
        let inbox_message =
            mk_inbox_message(&env.dbx, account.id, group.id).await;
        record_missing_message(&env.dbx, inbox_message.id, None)
            .await
            .unwrap();

        let rows = list_missing_messages(&env.dbx).await.unwrap();

        let row = rows
            .into_iter()
            .find(|row| row.message_id == inbox_message.id)
            .unwrap();
        assert_eq!(row.group_names, "Missing Group");
    }

    #[tokio::test]
    #[serial]
    async fn list_hides_errors_for_deleted_and_duplicate_statuses() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        echo_missing_message::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let deleted = record_deleted_missing_message(&env.dbx, -12346)
            .await
            .unwrap();
        let duplicate = record_duplicate_missing_message(&env.dbx, -12347)
            .await
            .unwrap();
        for missing_message in [deleted, duplicate] {
            let mut missing_message: echo_missing_message::ActiveModel =
                missing_message.into();
            missing_message.error = Set(Some("stale error".to_string()));
            missing_message.update(&env.dbx).await.unwrap();
        }

        let rows = list_missing_messages(&env.dbx).await.unwrap();

        let terminal_rows = rows
            .into_iter()
            .filter(|row| [-12346, -12347].contains(&row.message_id))
            .collect::<Vec<_>>();
        assert_eq!(terminal_rows.len(), 2);
        assert!(terminal_rows.iter().all(|row| row.error.is_none()));
    }

    async fn mk_echo_account(dbx: &DatabaseConnection) -> echo_account::Model {
        let now = Utc::now().naive_utc();
        let phone_seed = Uuid::new_v4().simple().to_string();
        echo_account::ActiveModel {
            id: NotSet,
            source: Set(EchoMessageSource::Signal),
            phone_number: Set(format!("+{}", &phone_seed[..12])),
            is_linked: Set(true),
            created_at: Set(now),
            synced_at: Set(None),
            last_trusted_at: Set(None),
            linked_at: Set(Some(now)),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_echo_group(
        dbx: &DatabaseConnection,
        account_id: i32,
        name: &str,
    ) -> echo_group::Model {
        let now = Utc::now().naive_utc();
        let group_id = format!("test-group-{}", Uuid::new_v4());
        echo_group::ActiveModel {
            id: NotSet,
            group_id: Set(group_id.clone()),
            internal_id: Set(Some(format!("internal-{group_id}"))),
            name: Set(Some(name.to_string())),
            account_id: Set(account_id),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_by_messanger: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_inbox_message(
        dbx: &DatabaseConnection,
        account_id: i32,
        group_id: i32,
    ) -> echo_inbox_message::Model {
        let now = Utc::now().naive_utc();
        echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(format!("body {}", Uuid::new_v4())),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(None),
            sender_id: Set(None),
            group_id: Set(Some(group_id)),
            account_id: Set(account_id),
            created_at: Set(now),
            timestamp: Set(Some(now)),
            updated_at: Set(now),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }
}
