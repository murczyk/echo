use super::*;
use crate::ai_worker::test_support;
use crate::functest::tests::{cleanup, find_test_login};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};

fn counts(total: u64, ok: u64, failed: u64) -> Counts {
    Counts { total, ok, failed }
}

fn observation(
    unhealthy: bool,
    automatic: bool,
    window: Counts,
    recent: Counts,
    idle: bool,
) -> Observation {
    Observation {
        unhealthy,
        automatic,
        window,
        recent,
        idle,
    }
}

#[test]
fn issue_4157_only_provider_failures_count_against_an_engine() {
    assert_eq!(classify("ok"), OutcomeClass::Ok);
    for outcome in [
        "rate_limited",
        "server_error",
        "timeout",
        "connect_error",
        "transport_error",
    ] {
        assert_eq!(classify(outcome), OutcomeClass::Failed, "{outcome}");
    }
    // Our bad request, a call the caller gave up on, a local cooldown or a
    // local error says nothing about the provider.
    for outcome in [
        "client_error",
        "cancelled",
        "cooldown_expired",
        "local_error",
    ] {
        assert_eq!(classify(outcome), OutcomeClass::Neutral, "{outcome}");
    }
}

#[test]
fn issue_4157_marks_more_than_ninety_percent_failures_of_enough_calls() {
    let none = Counts::default();
    let unhealthy =
        |window| decide(&observation(false, false, window, none, false));
    assert_eq!(
        unhealthy(counts(5, 0, 5)),
        Decision::MarkUnhealthy {
            failed: 5,
            calls: 5
        }
    );
    // Exactly 90% is not more than 90%.
    assert_eq!(unhealthy(counts(10, 1, 9)), Decision::Keep);
    assert_eq!(
        unhealthy(counts(12, 1, 11)),
        Decision::MarkUnhealthy {
            failed: 11,
            calls: 12
        }
    );
    // Too few calls to judge, and calls that say nothing about the provider.
    assert_eq!(unhealthy(counts(4, 0, 4)), Decision::Keep);
    assert_eq!(unhealthy(counts(20, 0, 4)), Decision::Keep);
}

#[test]
fn issue_4157_recovers_only_its_own_marks_and_probes_only_idle_engines() {
    let none = Counts::default();
    // Traffic that mostly succeeds brings an automatic mark back.
    assert_eq!(
        decide(&observation(true, true, none, counts(2, 2, 0), false)),
        Decision::MarkHealthy
    );
    assert_eq!(
        decide(&observation(true, true, none, counts(2, 1, 1), false)),
        Decision::MarkHealthy
    );
    assert_eq!(
        decide(&observation(true, true, none, counts(3, 1, 2), false)),
        Decision::Keep
    );
    // Without calls it is probed; with calls, even neutral ones, it is not.
    assert_eq!(
        decide(&observation(true, true, none, none, true)),
        Decision::Probe
    );
    assert_eq!(
        decide(&observation(true, true, none, counts(3, 0, 0), false)),
        Decision::Keep
    );
    // An administrator's mark stays, whatever the traffic.
    assert_eq!(
        decide(&observation(true, false, none, counts(5, 5, 0), true)),
        Decision::Keep
    );
}

async fn reload(env: &Env, id: Uuid) -> ai_engine::Model {
    ai_engine::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
}

async fn record(env: &Env, id: Uuid, outcome: &str, times: usize) {
    record_minutes_ago(env, id, outcome, times, 0).await;
}

async fn record_minutes_ago(
    env: &Env,
    id: Uuid,
    outcome: &str,
    times: usize,
    minutes_ago: i64,
) {
    let mut redis = env.redis.clone();
    for _ in 0..times {
        record_outcome(&mut redis, id, current_minute() - minutes_ago, outcome)
            .await
            .unwrap();
    }
}

/// Moves the last health change back, as if minutes had passed since.
async fn age_health_change(env: &Env, engine: ai_engine::Model, minutes: i64) {
    let changed_at = engine.health_updated_at.unwrap();
    let mut engine = engine.into_active_model();
    engine.health_updated_at =
        Set(Some(changed_at - chrono::Duration::minutes(minutes)));
    engine.update(&env.dbx).await.unwrap();
}

#[tokio::test]
#[serial]
async fn issue_4157_an_outage_is_marked_and_recovering_traffic_clears_it() {
    let env = cleanup().await.unwrap();
    let engine = test_support::engine(&env.dbx, 500, "down", false).await;
    let id = engine.engine.id;
    let probes = AtomicUsize::new(0);
    let probe = |probed: ai_engine::Model| {
        // Engines other tests left behind may be probed too.
        if probed.id == id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { false }
    };
    // The outage, a few minutes ago.
    record_minutes_ago(&env, id, "server_error", 4, 3).await;
    record_minutes_ago(&env, id, "rate_limited", 1, 3).await;
    run_round(&env, probe).await.unwrap();
    let marked = reload(&env, id).await;
    assert_eq!(marked.unhealthy, Some(true));
    assert!(marked.health_updated_at.is_some());
    assert!(marked.health_updated_by_login_id.is_none());
    assert!(marked.health_message.as_deref().unwrap().contains("5 з 5"));
    // The failures before the mark do not keep it, and successes in the same
    // minute as the mark do not clear it yet.
    record(&env, id, "ok", 2).await;
    run_round(&env, probe).await.unwrap();
    assert_eq!(reload(&env, id).await.unhealthy, Some(true));
    // Two minutes after the mark the successful calls count, and the
    // failures before it still do not.
    age_health_change(&env, reload(&env, id).await, 2).await;
    run_round(&env, probe).await.unwrap();
    let recovered = reload(&env, id).await;
    assert_eq!(recovered.unhealthy, Some(false));
    assert_eq!(recovered.health_message, None);
    assert!(recovered.health_updated_by_login_id.is_none());
    // Engines with traffic are never probed.
    assert_eq!(probes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[serial]
async fn issue_4157_an_administrators_mark_is_never_reverted() {
    let env = cleanup().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let engine = test_support::engine(&env.dbx, 200, "pong", false).await;
    let id = engine.engine.id;
    let mut manual = engine.engine.clone().into_active_model();
    manual.unhealthy = Set(Some(true));
    manual.health_message = Set(Some("Планове обслуговування".into()));
    manual.health_updated_at =
        Set(Some(Utc::now().naive_utc() - chrono::Duration::minutes(20)));
    manual.health_updated_by_login_id = Set(Some(login.id));
    manual.update(&env.dbx).await.unwrap();
    record(&env, id, "ok", 5).await;
    let probes = AtomicUsize::new(0);
    run_round(&env, |probed: ai_engine::Model| {
        if probed.id == id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { false }
    })
    .await
    .unwrap();
    let kept = reload(&env, id).await;
    assert_eq!(kept.unhealthy, Some(true));
    assert_eq!(kept.health_updated_by_login_id, Some(login.id));
    assert_eq!(probes.load(Ordering::SeqCst), 0);
}

/// An automatic mark made `minutes` ago, with no calls since.
async fn idle_automatic_mark(
    env: &Env,
    status: u16,
) -> test_support::TestEngine {
    let engine = test_support::engine(&env.dbx, status, "pong", false).await;
    let mut marked = engine.engine.clone().into_active_model();
    marked.unhealthy = Set(Some(true));
    marked.health_message = Set(Some(unhealthy_message(5, 5, 30)));
    marked.health_updated_at =
        Set(Some(Utc::now().naive_utc() - chrono::Duration::minutes(20)));
    marked.update(&env.dbx).await.unwrap();
    engine
}

#[tokio::test]
#[serial]
async fn issue_4157_an_idle_engine_is_probed_and_answers_clear_the_mark() {
    let env = cleanup().await.unwrap();
    let client = env.ai_engine_client.without_health();
    let healthy = idle_automatic_mark(&env, 200).await;
    let failing = idle_automatic_mark(&env, 500).await;
    run_round(&env, |engine| {
        let client = &client;
        async move { probe_engine(client, &engine).await }
    })
    .await
    .unwrap();
    assert_eq!(reload(&env, healthy.engine.id).await.unhealthy, Some(false));
    assert_eq!(reload(&env, failing.engine.id).await.unhealthy, Some(true));
    // Each engine got exactly one probe, and the probe is not counted as a
    // user's call.
    assert_eq!(healthy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(failing.calls.load(Ordering::SeqCst), 1);
    let mut redis = env.redis.clone();
    let minute = current_minute();
    let counted =
        read_counts(&mut redis, healthy.engine.id, minute - 1..=minute)
            .await
            .unwrap();
    assert_eq!(counted, Counts::default());
    // The next round within the probe interval does not probe again.
    run_round(&env, |engine| {
        let client = &client;
        async move { probe_engine(client, &engine).await }
    })
    .await
    .unwrap();
    assert_eq!(failing.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[serial]
async fn issue_4157_an_engine_someone_still_calls_is_not_probed() {
    let env = cleanup().await.unwrap();
    let engine = idle_automatic_mark(&env, 200).await;
    record(&env, engine.engine.id, "cancelled", 1).await;
    let probes = AtomicUsize::new(0);
    run_round(&env, |probed: ai_engine::Model| {
        if probed.id == engine.engine.id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { false }
    })
    .await
    .unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    assert_eq!(reload(&env, engine.engine.id).await.unhealthy, Some(true));
}

#[tokio::test]
#[serial]
async fn issue_4157_a_mark_without_login_but_with_its_own_message_stays() {
    // A profile import sets health without a login; only the worker's own
    // message makes a mark automatic.
    let env = cleanup().await.unwrap();
    let engine = test_support::engine(&env.dbx, 200, "pong", false).await;
    let id = engine.engine.id;
    let mut imported = engine.engine.clone().into_active_model();
    imported.unhealthy = Set(Some(true));
    imported.health_message = Set(Some("Шлюз недоступний".into()));
    imported.health_updated_at =
        Set(Some(Utc::now().naive_utc() - chrono::Duration::minutes(20)));
    imported.update(&env.dbx).await.unwrap();
    let probes = AtomicUsize::new(0);
    run_round(&env, |probed: ai_engine::Model| {
        if probed.id == id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { true }
    })
    .await
    .unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    assert_eq!(reload(&env, id).await.unhealthy, Some(true));
}

#[tokio::test]
#[serial]
async fn issue_4157_failures_before_an_imported_change_do_not_mark_again() {
    let env = cleanup().await.unwrap();
    let engine = test_support::engine(&env.dbx, 200, "pong", false).await;
    let id = engine.engine.id;
    record_minutes_ago(&env, id, "server_error", 5, 3).await;
    run_round(&env, |_| async { false }).await.unwrap();
    assert_eq!(reload(&env, id).await.unhealthy, Some(true));
    // A profile import restores it, stamping the time as every writer does.
    let mut imported = reload(&env, id).await.into_active_model();
    imported.unhealthy = Set(Some(false));
    imported.health_message = Set(None);
    imported.health_updated_at = Set(Some(Utc::now().naive_utc()));
    imported.update(&env.dbx).await.unwrap();
    run_round(&env, |_| async { false }).await.unwrap();
    assert_eq!(reload(&env, id).await.unhealthy, Some(false));
}

#[tokio::test]
#[serial]
async fn issue_4157_a_call_still_running_is_not_interrupted_by_a_probe() {
    let env = cleanup().await.unwrap();
    let engine = idle_automatic_mark(&env, 200).await;
    // A call that started but has not ended yet.
    let mut redis = env.redis.clone();
    increment(&mut redis, engine.engine.id, current_minute(), FIELD_TOTAL)
        .await
        .unwrap();
    let probes = AtomicUsize::new(0);
    run_round(&env, |probed: ai_engine::Model| {
        if probed.id == engine.engine.id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { true }
    })
    .await
    .unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
}

/// Waits for spawned counter updates to land.
async fn settled_counts(env: &Env, id: Uuid, expected_total: u64) -> Counts {
    let mut redis = env.redis.clone();
    let minute = current_minute();
    for _ in 0..50 {
        let counts = read_counts(&mut redis, id, minute - 1..=minute)
            .await
            .unwrap();
        if counts.total >= expected_total && counts.decisive() > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            return read_counts(&mut redis, id, minute - 1..=minute)
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("counters did not settle");
}

#[tokio::test]
#[serial]
async fn issue_4157_a_stream_counts_by_how_it_ended_not_its_headers() {
    use super::super::metrics::{
        stream_health_outcome, ProviderCallAttempt, StreamBodyTimer,
    };
    assert_eq!(stream_health_outcome("completed"), Some("ok"));
    assert_eq!(stream_health_outcome("failed"), Some("stream_failed"));
    assert_eq!(stream_health_outcome("cancelled"), None);
    let env = cleanup().await.unwrap();
    let health = HealthSink::new(env.redis.clone());
    let engine = test_support::engine(&env.dbx, 200, "pong", false).await;
    // A real 200 response from the fixture's server.
    let response = || {
        let url = format!("{}/chat/completions", engine.engine.url);
        async move {
            reqwest::Client::new()
                .post(url)
                .json(&serde_json::json!({}))
                .send()
                .await
        }
    };
    // A stream whose headers arrived but which then broke off.
    let mut attempt =
        ProviderCallAttempt::start(None, Some(&health), &engine.engine, true);
    attempt.mark_provider_start();
    let answered = response().await.map_err(anyhow::Error::from);
    assert!(answered.as_ref().unwrap().status().is_success());
    attempt.finish(&answered);
    StreamBodyTimer::start(None, Some(&health), &engine.engine)
        .unwrap()
        .failed();
    let counts = settled_counts(&env, engine.engine.id, 1).await;
    assert_eq!(
        counts,
        Counts {
            total: 1,
            ok: 0,
            failed: 1
        }
    );
    // A plain call counts as soon as its answer arrives.
    let plain = test_support::engine(&env.dbx, 200, "pong", false).await;
    let mut attempt =
        ProviderCallAttempt::start(None, Some(&health), &plain.engine, false);
    attempt.mark_provider_start();
    attempt.finish(&response().await.map_err(anyhow::Error::from));
    let counts = settled_counts(&env, plain.engine.id, 1).await;
    assert_eq!(
        counts,
        Counts {
            total: 1,
            ok: 1,
            failed: 0
        }
    );
}

#[tokio::test]
#[serial]
async fn issue_4157_a_call_running_longer_than_the_idle_window_blocks_the_probe(
) {
    let env = cleanup().await.unwrap();
    let engine = idle_automatic_mark(&env, 200).await;
    let id = engine.engine.id;
    // A call that started long ago, beyond the counters, and still runs.
    let health = HealthSink::new(env.redis.clone());
    health.begin(id);
    let mut redis = env.redis.clone();
    for _ in 0..50 {
        if in_flight(&mut redis, id).await.unwrap() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let probes = AtomicUsize::new(0);
    let probe = |probed: ai_engine::Model| {
        if probed.id == id {
            probes.fetch_add(1, Ordering::SeqCst);
        }
        async { true }
    };
    run_round(&env, probe).await.unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    // Once it ends, the idle engine is probed.
    health.end(id);
    for _ in 0..50 {
        if in_flight(&mut redis, id).await.unwrap() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    run_round(&env, probe).await.unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 1);
    assert_eq!(reload(&env, id).await.unhealthy, Some(false));
}
