// Regression coverage for https://github.com/echoua/echo/issues/4095.
use super::*;
use crate::ai_worker::test_support::{engine, TestEngine};
use crate::entities::{
    ai_network_match_worker_job, ai_worker_progress, sigint_inbox_item,
    sigint_inbox_item_network, sigint_network,
};
use crate::functest::tests::{
    cleanup_locked, mk_sigint_inbox_item, mk_sigint_inbox_item_network,
    mk_sigint_network,
};
use crate::types::Env;
use sea_orm::{ActiveValue::Set, DatabaseConnection};
use std::sync::Arc;

fn candidate(network_id: i64, certainty: i32) -> NetworkMatchCandidate {
    NetworkMatchCandidate {
        network_id,
        certainty,
        reason: String::new(),
    }
}

#[test]
fn confident_network_needs_high_certainty_and_a_clear_lead_4095() {
    assert_eq!(
        confident_network_id(&[candidate(1, 92), candidate(2, 30)]),
        Some(1)
    );
    assert_eq!(
        confident_network_id(&[candidate(1, 80), candidate(2, 60)]),
        Some(1)
    );
    assert_eq!(
        confident_network_id(&[candidate(1, 79), candidate(2, 0)]),
        None
    );
    assert_eq!(
        confident_network_id(&[candidate(1, 95), candidate(2, 76)]),
        None
    );
    assert_eq!(confident_network_id(&[]), None);
}

#[test]
fn instructions_are_trimmed_cleared_when_blank_and_bounded_4095() {
    assert_eq!(
        normalize_instructions("  CC 3  ".to_string()).unwrap(),
        Some("CC 3".to_string())
    );
    assert_eq!(normalize_instructions(" \n ".to_string()).unwrap(), None);
    let too_long = "ж".repeat(AI_NETWORK_MATCH_INSTRUCTIONS_MAX_CHARS + 1);
    assert!(normalize_instructions(too_long).is_err());
}

async fn set_flag(dbx: &DatabaseConnection, enabled: bool) {
    dbx.execute_raw(sql(
        "insert into system_settings (rer_analysis_units_exact_match_only_default, rer_duty_test_enabled, rer_duty_test_since_ms, rer_duty_test_limit, rer_duty_poll_interval_sec, ai_network_match_enabled, updated_at) values (true, false, 0, 1, 5, $1, now() at time zone 'utc' + interval '1 day')",
        vec![enabled.into()],
    ))
    .await
    .unwrap();
}

async fn set_callsign_worker(
    dbx: &DatabaseConnection,
    enabled: bool,
    engine: &TestEngine,
) {
    dbx.execute_raw(sql(
        "insert into ai_callsign_settings(id,prompt,worker_enabled,worker_ai_engine_id,worker_fallback_ai_engine_id) values(1,'',$1,$2,null) on conflict(id) do update set worker_enabled=$1,worker_ai_engine_id=$2,worker_fallback_ai_engine_id=null",
        vec![enabled.into(), engine.engine.id.into()],
    ))
    .await
    .unwrap();
}

async fn recent_item(
    dbx: &DatabaseConnection,
    body: &str,
) -> sigint_inbox_item::Model {
    let item = mk_sigint_inbox_item(dbx, Default::default()).await.unwrap();
    dbx.execute_raw(sql(
        "update signal_message set body = $2, created_at = now() at time zone 'utc' where id = $1",
        vec![item.id.into(), body.into()],
    ))
    .await
    .unwrap();
    dbx.execute_raw(sql(
        "update sigint_inbox_item set datetime = now() at time zone 'utc' where id = $1",
        vec![item.id.into()],
    ))
    .await
    .unwrap();
    item
}

async fn networks(dbx: &DatabaseConnection, count: usize) -> Vec<i64> {
    let mut ids = vec![];
    for index in 0..count {
        let network = mk_sigint_network(
            dbx,
            sigint_network::ActiveModel {
                name: Set(format!("Мережа {index}")),
                ai_instructions: Set(
                    (index == 0).then(|| "Має CC 3".to_string())
                ),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ids.push(network.id);
    }
    ids
}

async fn link(dbx: &DatabaseConnection, item_id: i64, network_ids: &[i64]) {
    dbx.execute_raw(sql(
        "delete from sigint_inbox_item_network where sigint_inbox_item_id = $1",
        vec![item_id.into()],
    ))
    .await
    .unwrap();
    for network_id in network_ids {
        mk_sigint_inbox_item_network(
            dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(item_id),
                sigint_network_id: Set(*network_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
}

async fn job(
    dbx: &DatabaseConnection,
    item_id: i64,
) -> Option<ai_network_match_worker_job::Model> {
    ai_network_match_worker_job::Entity::find_by_id(item_id)
        .one(dbx)
        .await
        .unwrap()
}

async fn clear_job(dbx: &DatabaseConnection, item_id: i64) {
    ai_network_match_worker_job::Entity::delete_by_id(item_id)
        .exec(dbx)
        .await
        .unwrap();
}

async fn run_once(env: &Arc<Env>) -> bool {
    let mut redis = env.redis.clone();
    worker::process_next(&env.ai_engine_client, &env.dbx, &mut redis)
        .await
        .unwrap()
}

fn scores(item_id: i64, network_ids: &[i64]) -> HashMap<i64, Vec<i64>> {
    HashMap::from([(item_id, network_ids.to_vec())])
}

#[tokio::test]
#[serial_test::serial]
async fn enqueue_follows_flag_worker_and_age_4095() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let dbx = &env.dbx;
    let engine = engine(dbx, 200, "{}", false).await;
    let ids = networks(dbx, 3).await;
    let item = recent_item(dbx, "Позивний Береза").await;
    let pair = scores(item.id, &[ids[1], ids[0]]);

    set_flag(dbx, false).await;
    set_callsign_worker(dbx, true, &engine).await;
    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert!(job(dbx, item.id).await.is_none(), "flag off");

    set_flag(dbx, true).await;
    set_callsign_worker(dbx, false, &engine).await;
    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert!(job(dbx, item.id).await.is_none(), "callsign worker off");

    set_callsign_worker(dbx, true, &engine).await;
    enqueue_for_calculated(dbx, &scores(item.id, &[ids[0]]))
        .await
        .unwrap();
    assert!(job(dbx, item.id).await.is_none(), "single network");

    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert!(job(dbx, item.id).await.is_some(), "two networks");
    clear_job(dbx, item.id).await;

    dbx.execute_raw(sql(
        "insert into ai_network_match_result (sigint_inbox_item_id, candidate_network_ids, input_md5, certainties) values ($1, $2, '', '[]')",
        vec![item.id.into(), candidate_set(&[ids[0], ids[1]]).into()],
    ))
    .await
    .unwrap();
    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert!(
        job(dbx, item.id).await.is_some(),
        "a stored result does not hide a recalculation from the worker"
    );
    clear_job(dbx, item.id).await;

    forget_result(dbx, item.id).await.unwrap();
    dbx.execute_raw(sql(
        "update signal_message set created_at = now() at time zone 'utc' - interval '3 days' where id = $1",
        vec![item.id.into()],
    ))
    .await
    .unwrap();
    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert!(job(dbx, item.id).await.is_none(), "old message");
}

#[tokio::test]
#[serial_test::serial]
async fn worker_stores_scores_and_cards_follow_current_candidates_4095() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let dbx = &env.dbx;
    let engine = engine(
        dbx,
        200,
        r#"{"networks":[{"key":1,"certainty":92,"reason":"CC 3 як в описі"},{"key":2,"certainty":30,"reason":""}]}"#,
        false,
    )
    .await;
    set_flag(dbx, true).await;
    set_callsign_worker(dbx, true, &engine).await;
    let ids = networks(dbx, 3).await;
    let item = recent_item(dbx, "CC3 Береза — Сосна").await;
    link(dbx, item.id, &[ids[1], ids[0]]).await;

    let context = context::load(dbx, item.id, candidate_set(&ids[..2]))
        .await
        .unwrap()
        .unwrap();
    assert!(
        context.input_json.contains("Має CC 3"),
        "instructions reach the model"
    );

    enqueue_for_calculated(dbx, &scores(item.id, &ids[..2]))
        .await
        .unwrap();
    assert!(run_once(&env).await);
    assert!(job(dbx, item.id).await.is_none());
    assert_eq!(engine.calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    let current = scores(item.id, &[ids[1], ids[0]]);
    let found = load_for_messages(dbx, &current).await.unwrap();
    let network_match = found.get(&item.id).unwrap();
    assert_eq!(network_match.confident_network_id, Some(ids[0]));
    assert_eq!(
        network_match
            .candidates
            .iter()
            .map(|c| (c.network_id, c.certainty))
            .collect::<Vec<_>>(),
        vec![(ids[0], 92), (ids[1], 30)]
    );
    let progress = ai_worker_progress::Entity::find_by_id(
        crate::config::AI_NETWORK_MATCH_WORKER_NAME.to_string(),
    )
    .one(dbx)
    .await
    .unwrap()
    .unwrap();
    assert!(progress.last_completed_at.is_some());

    enqueue_for_calculated(dbx, &current).await.unwrap();
    assert!(run_once(&env).await);
    assert!(job(dbx, item.id).await.is_none());
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "an unchanged input is not scored again"
    );

    let before = sigint_network::Entity::find_by_id(ids[0])
        .one(dbx)
        .await
        .unwrap()
        .unwrap();
    let after = sigint_network::Model {
        ai_instructions: Some("Має CC 4".to_string()),
        ..before.clone()
    };
    assert!(!network_input_changed(&before, &before.clone()));
    assert!(network_input_changed(&before, &after));
    dbx.execute_raw(sql(
        "update sigint_network set ai_instructions = 'Має CC 4' where id = $1",
        vec![ids[0].into()],
    ))
    .await
    .unwrap();
    enqueue_for_network(dbx, ids[2]).await.unwrap();
    assert!(job(dbx, item.id).await.is_none(), "unlinked network");
    enqueue_for_network(dbx, ids[0]).await.unwrap();
    assert!(job(dbx, item.id).await.is_some(), "edited network");
    assert!(run_once(&env).await);
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "a changed «Опис для ШІ» is scored again"
    );

    let changed = scores(item.id, &ids);
    assert!(load_for_messages(dbx, &changed).await.unwrap().is_empty());
    set_flag(dbx, false).await;
    assert!(load_for_messages(dbx, &current).await.unwrap().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn worker_retries_bad_replies_and_skips_stale_results_4095() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let dbx = &env.dbx;
    let engine = engine(
        dbx,
        200,
        r#"{"networks":[{"key":7,"certainty":90,"reason":""}]}"#,
        false,
    )
    .await;
    set_flag(dbx, true).await;
    set_callsign_worker(dbx, true, &engine).await;
    let ids = networks(dbx, 2).await;
    let item = recent_item(dbx, "Береза").await;
    link(dbx, item.id, &ids).await;
    enqueue_for_calculated(dbx, &scores(item.id, &ids))
        .await
        .unwrap();

    assert!(run_once(&env).await);
    let failed = job(dbx, item.id).await.unwrap();
    assert_eq!(failed.attempts, 1);
    assert!(failed.last_error.unwrap().contains("unknown key"));
    assert!(failed.next_attempt_at > chrono::Utc::now().naive_utc());
    assert!(!run_once(&env).await, "backoff hides the job");
    let progress = ai_worker_progress::Entity::find_by_id(
        crate::config::AI_NETWORK_MATCH_WORKER_NAME.to_string(),
    )
    .one(dbx)
    .await
    .unwrap()
    .unwrap();
    assert!(progress.last_error.is_some());

    let context = context::load(dbx, item.id, candidate_set(&ids))
        .await
        .unwrap()
        .unwrap();
    dbx.execute_raw(sql(
        "update sigint_inbox_item set freq = '999.0000' where id = $1",
        vec![item.id.into()],
    ))
    .await
    .unwrap();
    let pending = job(dbx, item.id).await.unwrap();
    let stored = worker::complete(
        dbx,
        &pending,
        &context,
        vec![candidate(ids[0], 90), candidate(ids[1], 10)],
        engine.engine.id,
    )
    .await
    .unwrap();
    assert!(!stored, "a metadata edit during the call drops the reply");
    let rescheduled = job(dbx, item.id).await.unwrap();
    assert_eq!(rescheduled.attempts, 1);
    assert!(rescheduled.next_attempt_at <= chrono::Utc::now().naive_utc());
    assert!(load_for_messages(dbx, &scores(item.id, &ids))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn requeue_during_scoring_keeps_the_job_4095() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let dbx = &env.dbx;
    let engine = engine(dbx, 200, "{}", false).await;
    set_flag(dbx, true).await;
    set_callsign_worker(dbx, true, &engine).await;
    let ids = networks(dbx, 2).await;
    let item = recent_item(dbx, "Береза").await;
    link(dbx, item.id, &ids).await;
    let pair = scores(item.id, &ids);
    enqueue_for_calculated(dbx, &pair).await.unwrap();
    let read = job(dbx, item.id).await.unwrap();
    let context = context::load(dbx, item.id, candidate_set(&ids))
        .await
        .unwrap()
        .unwrap();

    enqueue_for_calculated(dbx, &pair).await.unwrap();
    assert_eq!(
        job(dbx, item.id).await.unwrap().generation,
        read.generation + 1
    );
    let stored = worker::complete(
        dbx,
        &read,
        &context,
        vec![candidate(ids[0], 90), candidate(ids[1], 10)],
        engine.engine.id,
    )
    .await
    .unwrap();
    assert!(stored);
    assert!(
        job(dbx, item.id).await.is_some(),
        "a re-queue during scoring keeps the job"
    );

    assert!(run_once(&env).await);
    assert!(job(dbx, item.id).await.is_none());
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the re-run finds the stored scores current"
    );
}
