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
    marked.health_message = Set(Some("Автоматично".into()));
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
