use super::types::{
    AiIntelReportAttemptItem, AiIntelReportAttemptListReq,
    AiIntelReportAttemptListRsp,
};
use crate::config::AI_INTEL_REPORT_ADMIN_ATTEMPT_PAGE_SIZE;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use uuid::Uuid;

#[derive(FromQueryResult)]
struct AttemptRow {
    id: Uuid,
    login_id: Uuid,
    login: String,
    ai_engine_id: Option<Uuid>,
    ai_engine_name: Option<String>,
    source_message_id: i64,
    outcome: String,
    suggestions: serde_json::Value,
    raw_response: Option<String>,
    error: Option<String>,
    duration_ms: i64,
    created_at: chrono::NaiveDateTime,
}

#[post("/api/admin/ai-intel-report/attempts/list")]
pub async fn list_attempts(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiIntelReportAttemptListReq>,
) -> Result<Json<AiIntelReportAttemptListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(list_attempt_page(&env.dbx, &req).await.c(h!())?))
}

async fn list_attempt_page(
    db: &impl ConnectionTrait,
    req: &AiIntelReportAttemptListReq,
) -> anyhow::Result<AiIntelReportAttemptListRsp> {
    let page_start_id = req
        .page_start_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    let mut rows = load_attempt_rows(db, page_start_id).await.c(h!())?;
    let mut page_start_ids = page_start_id
        .or_else(|| rows.first().map(|row| row.id))
        .map(|id| id.to_string())
        .into_iter()
        .collect::<Vec<_>>();
    let total = if rows.len() > AI_INTEL_REPORT_ADMIN_ATTEMPT_PAGE_SIZE as usize
    {
        page_start_ids.push(rows.pop().c(h!())?.id.to_string());
        None
    } else {
        page_start_id.is_none().then_some(rows.len() as i64)
    };
    let items = rows
        .into_iter()
        .map(attempt_item)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    Ok(AiIntelReportAttemptListRsp {
        items,
        page_size: AI_INTEL_REPORT_ADMIN_ATTEMPT_PAGE_SIZE,
        total,
        page_start_ids: Some(page_start_ids),
    })
}

async fn load_attempt_rows(
    db: &impl ConnectionTrait,
    page_start_id: Option<Uuid>,
) -> anyhow::Result<Vec<AttemptRow>> {
    let cursor = if page_start_id.is_some() {
        "where (attempt.created_at, attempt.id) <= (
            select created_at, id from ai_intel_report_attempt where id = $2
        )"
    } else {
        ""
    };
    let sql = format!(
        r#"
select attempt.id, attempt.login_id, actor.login,
       attempt.ai_engine_id, engine.name as ai_engine_name,
       attempt.source_message_id, attempt.outcome, attempt.suggestions,
       attempt.raw_response, attempt.error, attempt.duration_ms,
       attempt.created_at
from ai_intel_report_attempt attempt
inner join login actor on actor.id = attempt.login_id
left join ai_engine engine on engine.id = attempt.ai_engine_id
{cursor}
order by attempt.created_at desc, attempt.id desc
limit $1
"#,
    );
    let mut values = vec![(AI_INTEL_REPORT_ADMIN_ATTEMPT_PAGE_SIZE + 1).into()];
    if let Some(id) = page_start_id {
        values.push(id.into());
    }
    AttemptRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(db)
    .await
    .c(h!())
}

fn attempt_item(row: AttemptRow) -> anyhow::Result<AiIntelReportAttemptItem> {
    Ok(AiIntelReportAttemptItem {
        id: row.id.to_string(),
        login_id: row.login_id.to_string(),
        login: row.login,
        ai_engine_id: row.ai_engine_id.map(|id| id.to_string()),
        ai_engine_name: row.ai_engine_name,
        source_message_id: row.source_message_id,
        outcome: row.outcome,
        suggestions: serde_json::from_value(row.suggestions).c(h!())?,
        raw_response: row.raw_response,
        error: row.error,
        duration_ms: row.duration_ms,
        created_at: row.created_at.and_utc().timestamp_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::ai_intel_report_attempt;
    use chrono::{Duration, Utc};
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
        QueryFilter, TransactionTrait,
    };

    #[tokio::test]
    #[serial_test::serial]
    async fn attempt_pages_keep_time_order_and_do_not_overlap_after_insert() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let login = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut req = AiIntelReportAttemptListReq {
            page_start_id: None,
        };
        let empty = list_attempt_page(&txn, &req).await.unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, Some(0));
        assert_eq!(empty.page_start_ids, Some(Vec::new()));

        let now = Utc::now().naive_utc();
        let mut expected = Vec::new();
        for index in 0..45 {
            let id = Uuid::now_v7();
            ai_intel_report_attempt::ActiveModel {
                id: Set(id),
                login_id: Set(login.id),
                source_message_id: Set(index),
                outcome: Set("success".to_string()),
                suggestions: Set(serde_json::json!(["Перевірка обладнання"])),
                duration_ms: Set(100),
                created_at: Set(now - Duration::seconds(index / 3)),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .unwrap();
            expected.push((now - Duration::seconds(index / 3), id));
        }
        expected.sort_by(|left, right| right.cmp(left));
        let first = list_attempt_page(&txn, &req).await.unwrap();
        assert_eq!(first.total, None);
        assert_eq!(first.page_size, 20);
        assert_eq!(first.items.len(), 20);
        let mut starts = first.page_start_ids.unwrap();
        assert_eq!(
            starts,
            vec![expected[0].1.to_string(), expected[20].1.to_string()]
        );
        ai_intel_report_attempt::ActiveModel {
            id: Set(Uuid::now_v7()),
            login_id: Set(login.id),
            source_message_id: Set(100),
            outcome: Set("failed".to_string()),
            duration_ms: Set(200),
            created_at: Set(now + Duration::seconds(1)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let mut loaded = first.items;
        while starts.len() == 2 {
            req.page_start_id = starts.pop();
            let next = list_attempt_page(&txn, &req).await.unwrap();
            assert_eq!(
                next.items.len(),
                if loaded.len() == 20 { 20 } else { 5 }
            );
            assert_eq!(next.total, None);
            starts = next.page_start_ids.unwrap();
            assert_eq!(starts.first(), next.items.first().map(|item| &item.id));
            loaded.extend(next.items);
        }
        assert_eq!(starts.len(), 1);
        assert_eq!(
            loaded
                .into_iter()
                .map(|attempt| attempt.id)
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|(_, id)| id.to_string())
                .collect::<Vec<_>>()
        );
        req.page_start_id = None;
        let refreshed = list_attempt_page(&txn, &req).await.unwrap();
        assert_eq!(refreshed.total, None);
        assert_eq!(refreshed.items[0].source_message_id, 100);
        ai_intel_report_attempt::Entity::delete_many()
            .filter(
                ai_intel_report_attempt::Column::Id
                    .is_not_in(expected[25..].iter().map(|(_, id)| *id)),
            )
            .exec(&txn)
            .await
            .unwrap();
        let full = list_attempt_page(&txn, &req).await.unwrap();
        assert_eq!(full.items.len(), 20);
        assert_eq!(full.total, Some(20));
        assert_eq!(full.page_start_ids, Some(vec![expected[25].1.to_string()]));
        let missing = Uuid::now_v7().to_string();
        req.page_start_id = Some(missing.clone());
        let empty = list_attempt_page(&txn, &req).await.unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, None);
        assert_eq!(empty.page_start_ids, Some(vec![missing]));
        txn.rollback().await.unwrap();
    }
}
