use super::*;
use crate::event_stream::{
    fanout,
    types::{EventMsg, EventType},
};
use crate::functest::tests::{cleanup_locked, mk_sigint_unit};
use redis::AsyncCommands;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};

async fn clear_cache(env: &Env) {
    let _: () = env
        .redis
        .clone()
        .del(&[SIGINT_UNIT_TREE_REDIS_KEY, SIGINT_UNIT_TREE_DIRTY_REDIS_KEY])
        .await
        .unwrap();
}

async fn notify_change(env: &Env) {
    fanout(
        &mut env.redis.clone(),
        EventMsg::new(EventType::ETUnitChanged),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn regression_3527_cached_tree_tracks_committed_creates_edits_and_deletes(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    clear_cache(&env).await;
    let child = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            name: Set("Child".to_string()),
            army: Set("6 А|3:1 АК".to_string()),
            brigade: Set("27 омсбр".to_string()),
            company: Set("1 мср".to_string()),
            active: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    notify_change(&env).await;
    let first = load(&env).await.unwrap();
    let unit = first.units.iter().find(|unit| unit.id == child.id).unwrap();
    let group = &first.groups[unit.group_index.unwrap() as usize];
    assert_eq!(group.label, "1 мср");
    assert!(group.id.starts_with("group:2:6 А%7C3:1 АК|3:__EMPTY__"));
    assert_eq!(load(&env).await.unwrap().revision, first.revision);
    assert_eq!(
        env.redis
            .clone()
            .get::<_, Option<bool>>(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
            .await
            .unwrap(),
        Some(false)
    );

    let mut child = child.into_active_model();
    child.name = Set("Renamed".to_string());
    child.army = Set("7 А".to_string());
    let child = child.update(&env.dbx).await.unwrap();
    notify_change(&env).await;
    assert!(env
        .redis
        .clone()
        .get::<_, bool>(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
        .await
        .unwrap());
    let edited = load(&env).await.unwrap();
    assert_ne!(edited.revision, first.revision);
    assert_eq!(
        edited
            .units
            .iter()
            .find(|unit| unit.id == child.id)
            .unwrap()
            .name,
        "Renamed"
    );
    assert!(edited.groups.iter().any(|group| group.label == "7 А"));

    let child_id = child.id;
    let mut child = child.into_active_model();
    child.deleted = Set(true);
    child.update(&env.dbx).await.unwrap();
    notify_change(&env).await;
    let deleted = load(&env).await.unwrap();
    assert!(!deleted.units.iter().any(|unit| unit.id == child_id));
    let _: () = env
        .redis
        .clone()
        .del(SIGINT_UNIT_TREE_REDIS_KEY)
        .await
        .unwrap();
    assert_eq!(load(&env).await.unwrap().revision, deleted.revision);
    clear_cache(&env).await;
}

#[tokio::test]
#[serial_test::serial]
async fn regression_3527_expired_tree_reconciles_missed_unit_changes() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    clear_cache(&env).await;
    let original = load(&env).await.unwrap();
    let ttl: i64 = env
        .redis
        .clone()
        .ttl(SIGINT_UNIT_TREE_REDIS_KEY)
        .await
        .unwrap();
    assert!(ttl > 0 && ttl <= SIGINT_UNIT_TREE_RECONCILE_SECS as i64);
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            name: Set("Missed notification".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(load(&env).await.unwrap().revision, original.revision);
    let _: bool = env
        .redis
        .clone()
        .expire(SIGINT_UNIT_TREE_REDIS_KEY, 0)
        .await
        .unwrap();
    let reconciled = load(&env).await.unwrap();
    assert_ne!(reconciled.revision, original.revision);
    assert!(reconciled.units.iter().any(|entry| entry.id == unit.id));
    mark_dirty(&mut env.redis.clone()).await.unwrap();
    assert_eq!(load(&env).await.unwrap(), reconciled);
    clear_cache(&env).await;
}

#[tokio::test]
#[serial_test::serial]
async fn regression_3527_rebuild_cannot_clear_a_concurrent_dirty_write() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    clear_cache(&env).await;
    let original = load(&env).await.unwrap();
    mark_dirty(&mut env.redis.clone()).await.unwrap();
    let mut rebuilding =
        env.redisb.get_multiplexed_async_connection().await.unwrap();
    redis::cmd("WATCH")
        .arg(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
        .query_async::<()>(&mut rebuilding)
        .await
        .unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            name: Set("Concurrent insertion".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    notify_change(&env).await;
    assert!(publish(&mut rebuilding, &original).await.unwrap().is_none());
    assert!(env
        .redis
        .clone()
        .get::<_, bool>(SIGINT_UNIT_TREE_DIRTY_REDIS_KEY)
        .await
        .unwrap());
    let refreshed = load(&env).await.unwrap();
    assert!(refreshed.units.iter().any(|entry| entry.id == unit.id));
    assert_ne!(refreshed.revision, original.revision);
    clear_cache(&env).await;
}

#[tokio::test]
#[serial_test::serial]
async fn regression_3527_concurrent_callers_share_one_rebuild() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    clear_cache(&env).await;
    let (first, second, third) =
        tokio::join!(load(&env), load(&env), load(&env));
    let first = first.unwrap();
    assert_eq!(first.revision, second.unwrap().revision);
    assert_eq!(first.revision, third.unwrap().revision);
    clear_cache(&env).await;
}

#[tokio::test]
#[serial_test::serial]
async fn regression_3527_invalid_or_unbounded_cache_is_rebuilt_from_units() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    clear_cache(&env).await;
    let original = load(&env).await.unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            name: Set("Legacy cache missed this unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let _: () = env
        .redis
        .clone()
        .set(
            SIGINT_UNIT_TREE_REDIS_KEY,
            serde_json::to_string(&original).unwrap(),
        )
        .await
        .unwrap();
    let upgraded = load(&env).await.unwrap();
    assert!(upgraded.units.iter().any(|entry| entry.id == unit.id));
    assert_ne!(upgraded.revision, original.revision);
    let _: () = env
        .redis
        .clone()
        .set_ex(
            SIGINT_UNIT_TREE_REDIS_KEY,
            "invalid JSON",
            SIGINT_UNIT_TREE_RECONCILE_SECS,
        )
        .await
        .unwrap();
    assert_eq!(load(&env).await.unwrap(), upgraded);
    clear_cache(&env).await;
}
