use super::{
    enqueue_if_enabled, load_next_job, load_worker_config, run_nofail,
    tests::enable_worker,
};
use crate::ai_settlement::{
    groups::GroupFilter, load_page, save_worker_settings,
};
use crate::entities::{
    ai_settlement_worker_job, sigint_inbox_item, signal_group, signal_message,
    signal_message_group,
};
use crate::functest::tests::{
    cleanup_locked, mk_sigint_inbox_item, mk_signal_group, mk_signal_message,
    mk_signal_message_group,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, EntityTrait,
    IntoActiveModel,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

async fn message_in_groups(
    dbx: &DatabaseConnection,
    body: &str,
    groups: &[&str],
) -> i64 {
    let message = mk_signal_message(
        dbx,
        signal_message::ActiveModel {
            body: Set(Some(body.to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item(
        dbx,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location_v2: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for group in groups {
        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    message.id
}

async fn queue_messages(dbx: &DatabaseConnection, ids: &[i64]) {
    ai_settlement_worker_job::Entity::delete_many()
        .exec(dbx)
        .await
        .unwrap();
    for id in ids {
        ai_settlement_worker_job::ActiveModel {
            sigint_inbox_item_id: Set(*id),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
    }
}

async fn drain_eligible_jobs(
    dbx: &DatabaseConnection,
    filter: &GroupFilter,
) -> Vec<i64> {
    let mut ids = Vec::new();
    while let Some(job) = load_next_job(dbx, filter).await.unwrap() {
        ids.push(job.sigint_inbox_item_id);
        ai_settlement_worker_job::Entity::delete_by_id(
            job.sigint_inbox_item_id,
        )
        .exec(dbx)
        .await
        .unwrap();
    }
    ids.sort();
    ids
}

#[tokio::test]
#[serial_test::serial]
async fn restricts_new_and_queued_messages_by_group_membership_3383() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let config = enable_worker(&env.dbx).await;
    let first = mk_signal_group(&env.dbx, Default::default()).await.unwrap();
    let second = mk_signal_group(&env.dbx, Default::default()).await.unwrap();
    let first_id =
        message_in_groups(&env.dbx, "first", &[&first.master_key]).await;
    let second_id =
        message_in_groups(&env.dbx, "second", &[&second.master_key]).await;
    let shared_id = message_in_groups(
        &env.dbx,
        "shared",
        &[&first.master_key, &second.master_key],
    )
    .await;
    let ungrouped_id = message_in_groups(&env.dbx, "ungrouped", &[]).await;
    let all = [first_id, second_id, shared_id, ungrouped_id];
    for (except, keys, mut expected) in [
        (
            false,
            vec![first.master_key.clone()],
            vec![first_id, shared_id],
        ),
        (
            true,
            vec![first.master_key.clone()],
            vec![second_id, ungrouped_id],
        ),
        (false, vec![], all.to_vec()),
        (true, vec![], all.to_vec()),
    ] {
        save_worker_settings(
            &env.dbx,
            true,
            Some(config.ai_engine.id),
            GroupFilter {
                except,
                master_keys: keys.clone(),
            },
        )
        .await
        .unwrap();
        let current = load_worker_config(&env.dbx).await.unwrap().unwrap();
        queue_messages(&env.dbx, &all).await;
        expected.sort();
        assert_eq!(
            drain_eligible_jobs(&env.dbx, &current.group_filter).await,
            expected
        );
        ai_settlement_worker_job::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        for id in all {
            enqueue_if_enabled(&env.dbx, id).await.unwrap();
        }
        assert_eq!(
            drain_eligible_jobs(&env.dbx, &current.group_filter).await,
            expected
        );
        let page = load_page(&env.dbx).await.unwrap();
        assert_eq!(page.worker.groups_except, except);
        assert_eq!(page.worker.group_master_keys, keys);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn excludes_inactive_groups_and_rejects_invalid_selections_3383() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let config = enable_worker(&env.dbx).await;
    let active = mk_signal_group(&env.dbx, Default::default()).await.unwrap();
    let archived = mk_signal_group(
        &env.dbx,
        signal_group::ActiveModel {
            is_archived: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let deleted = mk_signal_group(
        &env.dbx,
        signal_group::ActiveModel {
            deleted: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let page = load_page(&env.dbx).await.unwrap();
    assert!(page
        .groups
        .iter()
        .any(|group| group.master_key == active.master_key));
    assert!(!page
        .groups
        .iter()
        .any(|group| group.master_key == archived.master_key
            || group.master_key == deleted.master_key));
    save_worker_settings(
        &env.dbx,
        true,
        Some(config.ai_engine.id),
        GroupFilter {
            except: false,
            master_keys: vec![active.master_key.clone()],
        },
    )
    .await
    .unwrap();
    for key in [
        archived.master_key,
        deleted.master_key,
        "missing-group".to_string(),
    ] {
        assert!(save_worker_settings(
            &env.dbx,
            true,
            Some(config.ai_engine.id),
            GroupFilter {
                except: true,
                master_keys: vec![key]
            }
        )
        .await
        .is_err());
        assert_eq!(
            load_page(&env.dbx).await.unwrap().worker.group_master_keys,
            vec![active.master_key.clone()]
        );
    }
    let mut active = active.into_active_model();
    active.is_archived = Set(true);
    active.update(&env.dbx).await.unwrap();
    let page = load_page(&env.dbx).await.unwrap();
    assert_eq!(page.worker.group_master_keys.len(), 1);
    assert!(!page.worker.groups_except);
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> serde_json::Value {
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0; 4096];
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&buffer[..read]);
        let Some(end) = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .map(|pos| pos + 4)
        else {
            continue;
        };
        let length: usize = String::from_utf8_lossy(&bytes[..end])
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .unwrap()
            .1
            .trim()
            .parse()
            .unwrap();
        if bytes.len() >= end + length {
            return serde_json::from_slice(&bytes[end..end + length]).unwrap();
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn saving_group_filter_restarts_inflight_worker_request_3383() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let config = enable_worker(&env.dbx).await;
    let first = mk_signal_group(&env.dbx, Default::default()).await.unwrap();
    let second = mk_signal_group(&env.dbx, Default::default()).await.unwrap();
    let first_id =
        message_in_groups(&env.dbx, "old request", &[&first.master_key]).await;
    let second_id =
        message_in_groups(&env.dbx, "new request", &[&second.master_key]).await;
    queue_messages(&env.dbx, &[first_id, second_id]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut engine = config.ai_engine.into_active_model();
    engine.url = Set(format!("http://{}/v1", listener.local_addr().unwrap()));
    let engine = engine.update(&env.dbx).await.unwrap();
    let cancellation = CancellationToken::new();
    let worker = tokio::spawn(run_nofail(env.clone(), cancellation.clone()));
    let (mut old_request, _) =
        tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .unwrap()
            .unwrap();
    let request = read_request(&mut old_request).await;
    assert_eq!(request["messages"][1]["content"], "old request");
    save_worker_settings(
        &env.dbx,
        true,
        Some(engine.id),
        GroupFilter {
            except: false,
            master_keys: vec![second.master_key],
        },
    )
    .await
    .unwrap();
    let (mut new_request, _) =
        tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
    let request = read_request(&mut new_request).await;
    assert_eq!(request["messages"][1]["content"], "new request");
    let body = serde_json::json!({"choices": [{"message": {"content": "{\"settlements\":[]}"}}]}).to_string();
    new_request.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while ai_settlement_worker_job::Entity::find_by_id(second_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
    let old_job = ai_settlement_worker_job::Entity::find_by_id(first_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old_job.attempts, 0);
    assert_eq!(old_job.last_error, None);
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(first_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .location_v2,
        None
    );
}
