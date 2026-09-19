// Regression coverage for https://github.com/echoua/echo/issues/3167.
use super::feedback::{
    apply_overrides, record_edit, refine, sql, CallsignEdit,
};
use crate::entities::{ai_engine, login, sigint_inbox_item};
use crate::functest::tests::{cleanup, mk_login, mk_sigint_inbox_item};
use crate::inbox::callsigns::{sync, InboxItemCallsigns};
use sea_orm::{ConnectionTrait, DatabaseConnection, Set, TransactionTrait};
use serial_test::serial;
use uuid::Uuid;

async fn seed(db: &DatabaseConnection, callsigns: &[&str]) -> (Uuid, i64) {
    let actor = mk_login(db, login::ActiveModel::default()).await.unwrap();
    let item = mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            datetime: Set(Some(chrono::Utc::now().naive_utc())),
            reviewed: Set(Some(true)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let system_id = crate::users::system_login_id(db).await.unwrap();
    let transaction = db.begin().await.unwrap();
    sync(
        &transaction,
        item.id,
        item.id_uuid,
        InboxItemCallsigns {
            primary: callsigns.iter().map(|s| (*s).to_string()).collect(),
            alg2: vec![],
        },
        system_id,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    (actor.id, item.id)
}

async fn removal_count(db: &DatabaseConnection, callsign: &str) -> i64 {
    db.query_one_raw(sql("select removal_count from ai_callsign_feedback_summary where callsign = $1", vec![callsign.into()])).await.unwrap().map(|row| row.try_get("", "removal_count").unwrap()).unwrap_or(0)
}

fn edit(id: i64, removed: &[&str], added: &[&str]) -> CallsignEdit {
    CallsignEdit {
        message_id: id,
        action_id: Uuid::new_v4().to_string(),
        removed: removed.iter().map(|s| (*s).into()).collect(),
        added: added.iter().map(|s| (*s).into()).collect(),
    }
}

#[tokio::test]
#[serial]
async fn removal_is_atomic_idempotent_and_preserves_later_user_addition() {
    let env = cleanup().await.unwrap();
    let (actor, id) = seed(&env.dbx, &["фипка", "косой"]).await;
    let removal = edit(id, &[" ФИПКА "], &[]);
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(&transaction, actor, &removal, &[id], "В вашу сторону Фипка")
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    assert_eq!(removal_count(&env.dbx, "фипка").await, 0);
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(&transaction, actor, &removal, &[id], "В вашу сторону Фипка")
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(removal_count(&env.dbx, "фипка").await, 1);
    assert_eq!(
        apply_overrides(&env.dbx, id, vec!["фипка".into(), "косой".into()])
            .await
            .unwrap(),
        vec!["косой"]
    );
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(&transaction, actor, &edit(id, &[], &["фипка"]), &[id], "")
        .await
        .unwrap();
    record_edit(&transaction, actor, &removal, &[id], "different retry body")
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(removal_count(&env.dbx, "фипка").await, 1);
    assert_eq!(
        apply_overrides(&env.dbx, id, vec![]).await.unwrap(),
        vec!["фипка"]
    );
    let body: String = env
        .dbx
        .query_one_raw(sql(
            "select body from ai_callsign_feedback where callsign = 'фипка'",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "body")
        .unwrap();
    assert_eq!(body, "В вашу сторону Фипка");
}

#[tokio::test]
#[serial]
async fn duplicate_propagation_counts_once_and_automatic_sync_is_not_feedback()
{
    let env = cleanup().await.unwrap();
    let (actor, id) = seed(&env.dbx, &["15 01"]).await;
    let (_, duplicate) = seed(&env.dbx, &["15 01"]).await;
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(
        &transaction,
        actor,
        &edit(id, &["15 01"], &[]),
        &[id, duplicate],
        "Направление 15 01, удаление 300 метров",
    )
    .await
    .unwrap();
    let system = crate::users::system_login_id(&transaction).await.unwrap();
    sync(
        &transaction,
        id,
        None,
        InboxItemCallsigns::default(),
        system,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(removal_count(&env.dbx, "15 01").await, 1);
    assert!(apply_overrides(&env.dbx, duplicate, vec!["15 01".into()])
        .await
        .unwrap()
        .is_empty());
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(&transaction, actor, &edit(id, &["absent"], &[]), &[id], "")
        .await
        .unwrap();
    record_edit(&transaction, actor, &edit(id, &[], &[]), &[id], "")
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(removal_count(&env.dbx, "absent").await, 0);
}

fn engine(url: String) -> ai_engine::Model {
    let now = chrono::Utc::now().naive_utc();
    ai_engine::Model {
        id: Uuid::new_v4(),
        name: "fixture".into(),
        url,
        token: None,
        model_name: "fixture".into(),
        created_at: now,
        updated_at: now,
        enabled: true,
        callsign_enabled: true,
        ocr_enabled: false,
        ocr_request_profile: String::new(),
    }
}

async fn serve(
    responses: Vec<&'static str>,
) -> (
    ai_engine::Model,
    tokio::task::JoinHandle<Vec<serde_json::Value>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            loop {
                let mut buffer = [0; 4096];
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                let Some(end) = bytes
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|p| p + 4)
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .filter_map(|s| s.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .unwrap()
                    .1
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() < end + length {
                    continue;
                }
                requests.push(
                    serde_json::from_slice(&bytes[end..end + length]).unwrap(),
                );
                break;
            }
            let body = serde_json::json!({"choices": [{"message": {"content": response}}]}).to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(reply.as_bytes()).await.unwrap();
        }
        requests
    });
    (engine(format!("http://{address}/v1")), server)
}

#[tokio::test]
#[serial]
async fn feedback_requests_are_conditional_contextual_and_bounded() {
    let env = cleanup().await.unwrap();
    let (actor, id) = seed(&env.dbx, &["фипка"]).await;
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(
        &transaction,
        actor,
        &edit(id, &["фипка"], &[]),
        &[id],
        &"Фипка в вашу сторону. ".repeat(500),
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let (engine, server) = serve(vec![
        r#"{"callsigns":["ФИПКА","КОСОЙ"]}"#,
        r#"{"callsigns":["КОСОЙ"]}"#,
    ])
    .await;
    let initial = super::extract_ai_callsigns(
        &engine,
        "extract",
        "Косой, в вашу сторону Фипка",
    )
    .await
    .unwrap();
    let refined = refine(
        &env.dbx,
        &engine,
        "extract",
        "Косой, в вашу сторону Фипка",
        initial,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(refined, vec!["косой"]);
    let requests =
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(requests.len(), 2);
    let input: serde_json::Value = serde_json::from_str(
        requests[1]["messages"][1]["content"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(input["FEEDBACK"][0]["removal_count"], 1);
    assert!(
        input["FEEDBACK"][0]["examples"][0]
            .as_str()
            .unwrap()
            .chars()
            .count()
            <= 1_000
    );
    let offline = engine_record_offline();
    assert_eq!(
        refine(
            &env.dbx,
            &offline,
            "extract",
            "44408 связь установил",
            vec!["44408".into()],
            &["44408".into()]
        )
        .await
        .unwrap(),
        vec!["44408"]
    );
    assert!(refine(
        &env.dbx,
        &offline,
        "extract",
        &"я".repeat(24_001),
        vec!["фипка".into()],
        &[]
    )
    .await
    .is_err());
}

fn engine_record_offline() -> ai_engine::Model {
    engine("http://127.0.0.1:1".into())
}

#[tokio::test]
#[serial]
async fn historical_enumeration_is_targeted_reviewed_and_keeps_new_feedback_pending(
) {
    let env = cleanup().await.unwrap();
    let (actor, id) = seed(&env.dbx, &["фипка", "харитон"]).await;
    let (_, old) = seed(&env.dbx, &["фипка"]).await;
    env.dbx.execute_raw(sql("update sigint_inbox_item set datetime = now() at time zone 'utc' - interval '15 days' where id = $1", vec![old.into()])).await.unwrap();
    let (_, unrelated) = seed(&env.dbx, &["косой"]).await;
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(
        &transaction,
        actor,
        &edit(id, &["фипка", "харитон"], &[]),
        &[id],
        "fixture",
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let run_id = super::reparse::start(&env.dbx, None, 14).await.unwrap();
    assert_eq!(
        super::reparse::start(&env.dbx, Some(actor), 30)
            .await
            .unwrap(),
        run_id
    );
    let transaction = env.dbx.begin().await.unwrap();
    record_edit(
        &transaction,
        actor,
        &edit(id, &["фипка"], &[]),
        &[id],
        "new feedback",
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let row = env.dbx.query_one_raw(sql("select removal_count > scheduled_count as pending from ai_callsign_feedback_summary where callsign = 'фипка'", vec![])).await.unwrap().unwrap();
    assert!(row.try_get::<bool>("", "pending").unwrap());
    super::reparse::enumerate_for_test(&env.dbx, run_id).await;
    let jobs = env.dbx.query_all_raw(sql("select inbox_item_id from ai_callsign_reparse_job where run_id = $1", vec![run_id.into()])).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].try_get::<i64>("", "inbox_item_id").unwrap(), id);
    assert_ne!(id, unrelated);
    env.dbx.execute_raw(sql("update ai_callsign_reparse_run set state = 'completed' where id = $1", vec![run_id.into()])).await.unwrap();
    let manual = super::reparse::start(&env.dbx, Some(actor), 30)
        .await
        .unwrap();
    super::reparse::enumerate_for_test(&env.dbx, manual).await;
    let count: i64 = env.dbx.query_one_raw(sql("select count(*) as n from ai_callsign_reparse_job where run_id = $1", vec![manual.into()])).await.unwrap().unwrap().try_get("", "n").unwrap();
    assert_eq!(count, 2);
    assert!(super::reparse::start(&env.dbx, Some(actor), 0)
        .await
        .is_err());
    assert!(super::reparse::start(&env.dbx, Some(actor), i64::MAX)
        .await
        .is_err());
}

#[test]
fn numeric_template_callsigns_are_kept_independently_of_ai() {
    let body = "Отримано з поста \"34\"\n--------------------------------------\n18.08.2026, 19:54:35\n128.5000\n🟠\nНВ\n44408\n\n— 44408 связь по направлению установил с вами до обратного. Спасибо. +";
    let templates =
        crate::rer_importer::callsigns::extract_callsigns(body).unwrap();
    assert!(templates.iter().any(|callsign| callsign.etalon == "44408"));
    assert_eq!(
        super::worker::merge_current_and_ai_callsigns(
            vec!["44408".into()],
            vec![]
        ),
        vec!["44408"]
    );
}

#[tokio::test]
#[serial]
async fn completion_rejects_stale_body_and_cancelled_run_and_counts_once() {
    use sea_orm::EntityTrait;
    let env = cleanup().await.unwrap();
    let (actor, id) = seed(&env.dbx, &[]).await;
    let body = crate::entities::signal_message::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .body
        .unwrap_or_default();
    assert!(super::worker::complete_job(
        &env.dbx,
        &env.rq,
        id,
        "stale body",
        vec![],
        None
    )
    .await
    .is_err());
    let run_id = super::reparse::start(&env.dbx, Some(actor), 14)
        .await
        .unwrap();
    env.dbx.execute_raw(sql("update ai_callsign_reparse_run set state = 'cancelled', total = 1 where id = $1", vec![run_id.into()])).await.unwrap();
    env.dbx.execute_raw(sql("insert into ai_callsign_reparse_job (run_id, inbox_item_id) values ($1, $2)", vec![run_id.into(), id.into()])).await.unwrap();
    assert!(!super::worker::complete_job(
        &env.dbx,
        &env.rq,
        id,
        &body,
        vec![],
        Some(run_id)
    )
    .await
    .unwrap());
    env.dbx.execute_raw(sql("update ai_callsign_reparse_run set state = 'running' where id = $1", vec![run_id.into()])).await.unwrap();
    let transaction = env.dbx.begin().await.unwrap();
    super::reparse::record_success(&transaction, run_id, id, "changed")
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    super::worker::complete_job(
        &env.dbx,
        &env.rq,
        id,
        &body,
        vec![],
        Some(run_id),
    )
    .await
    .unwrap();
    super::worker::complete_job(
        &env.dbx,
        &env.rq,
        id,
        &body,
        vec![],
        Some(run_id),
    )
    .await
    .unwrap();
    let count: i64 = env.dbx.query_one_raw(sql("select changed + unchanged as n from ai_callsign_reparse_run where id = $1", vec![run_id.into()])).await.unwrap().unwrap().try_get("", "n").unwrap();
    assert_eq!(count, 1);
}
