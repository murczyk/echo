use super::*;
use crate::functest::tests::{
    cleanup_locked, find_test_aor, find_test_datasource, mk_datasource_group,
    mk_sigint_network, mk_sigint_network_aor, mk_sigint_network_freq,
    mk_signal_group, mk_signal_group_aor,
};
use sea_orm::sea_query::Expr;

async fn csv_context(env: &Env) -> RerCsvImportContext<'_> {
    let datasource = find_test_datasource(&env.dbx).await.unwrap();
    let group = mk_signal_group(
        &env.dbx,
        signal_group::ActiveModel {
            master_key: Set(Uuid::new_v4().to_string()),
            datasource_id: Set(Some(datasource.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let datasource_group = mk_datasource_group(
        &env.dbx,
        datasource_group::ActiveModel {
            group_master_key: Set(group.master_key.clone()),
            datasource_id: Set(datasource.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    RerCsvImportContext {
        settlements: env.settlements.clone(),
        dbx: &env.dbx,
        rq: &env.rq,
        config: &env.config,
        group_id: group.master_key,
        datasource_group_id: datasource_group.id,
        source_uuid: Uuid::new_v4().to_string(),
        import_as_new: false,
        reconcile_target_group: true,
        lnow: crate::config::get_tz()
            .with_ymd_and_hms(2026, 10, 2, 12, 0, 0)
            .unwrap(),
    }
}

async fn import_bodies(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    bodies: &[&str],
    bgid: Option<i64>,
) -> anyhow::Result<RerCsvImportStats> {
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(vec![]);
    for body in bodies {
        writer.serialize((body,)).unwrap();
    }
    let csv = writer.into_inner().unwrap();
    let records = read_rer_csv_records(csv.as_slice()).unwrap();
    import_rer_csv_records(context, redis, bgid, records)
        .await
        .context(h!())
}

async fn messages(
    dbx: &DatabaseConnection,
    body: &str,
) -> Vec<signal_message::Model> {
    signal_message::Entity::find()
        .filter(signal_message::Column::Body.eq(body))
        .order_by_asc(signal_message::Column::Id)
        .all(dbx)
        .await
        .unwrap()
}

fn assert_counts(
    stats: &RerCsvImportStats,
    imported: usize,
    reused: usize,
    duplicates: usize,
    invalid: usize,
) {
    assert_eq!(stats.imported, imported);
    assert_eq!(stats.reused, reused);
    assert_eq!(stats.duplicates, duplicates);
    assert_eq!(stats.skipped, duplicates + invalid);
    assert_eq!(stats.total, stats.imported + stats.reused + stats.skipped);
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_csv_duplicates_use_exact_body_and_selected_group() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut context = csv_context(&env).await;
    let mut redis = env.redis.clone();
    let first = "Час: 10:15:00\nF=146.5000\nfirst CSV duplicate safeguard";
    let second = "02.10.2026 10:16:00\nsecond CSV duplicate safeguard";
    let third = "02.10.2026 10:17:00\nthird CSV duplicate safeguard";
    let background_task = bgtask::ActiveModel {
        progress: Set(0),
        loglines: Set(serde_json::json!([])),
        running: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let stats = import_bodies(
        &context,
        &mut redis,
        &[first, first, second, "invalid timestamp"],
        Some(background_task.id),
    )
    .await
    .unwrap();
    assert_counts(&stats, 2, 0, 1, 1);
    assert_eq!(stats.missing_timestamp, 1);
    let original = messages(&env.dbx, first).await.remove(0);
    let mut inbox = sigint_inbox_item::Entity::find_by_id(original.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    inbox.reviewed = Set(Some(true));
    inbox.update(&env.dbx).await.unwrap();
    context.lnow += chrono::Duration::days(1);
    let variant = format!(" \r\n{}\r\n ", first.replace('\n', "\r\n"));
    let stats = import_bodies(
        &context,
        &mut redis,
        &[&variant, second],
        Some(background_task.id),
    )
    .await
    .unwrap();
    assert_counts(&stats, 0, 0, 2, 0);
    assert_eq!(messages(&env.dbx, first).await, vec![original.clone()]);
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(original.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .reviewed,
        Some(true)
    );
    let stats = import_bodies(&context, &mut redis, &[second, third], None)
        .await
        .unwrap();
    assert_counts(&stats, 1, 0, 1, 0);
    assert_group_and_content_identity(
        &env,
        &context,
        &mut redis,
        &original,
        [first, second, third],
    )
    .await;
    let loglines: Vec<String> = serde_json::from_value(
        bgtask::Entity::find_by_id(background_task.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .loglines,
    )
    .unwrap();
    assert!(loglines.iter().any(|line| line.contains(&format!(
        "duplicate CSV record 2: existing message id={}",
        original.id
    ))));
    assert!(loglines.iter().any(|line| line.contains("total=2, imported=0, skipped=2, missing_timestamp=0, invalid_message_size=0, duplicates=2, reused=0")));
}

async fn assert_group_and_content_identity(
    env: &Env,
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    original: &signal_message::Model,
    bodies: [&str; 3],
) {
    let [first, second, third] = bodies;
    let other_context = csv_context(env).await;
    let stats = import_bodies(&other_context, redis, &[first], None)
        .await
        .unwrap();
    assert_counts(&stats, 1, 0, 0, 0);
    assert_eq!(messages(&env.dbx, first).await.len(), 2);

    // Group links remain authoritative even after the primary group changes.
    signal_message_group::ActiveModel {
        signal_message_id: Set(original.id),
        signal_message_uuid: Set(original.id_uuid),
        group_master_key: Set(Some(other_context.group_id.clone())),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let mut moved = original.clone().into_active_model();
    moved.datasource_group_id = Set(Some(other_context.datasource_group_id));
    moved.update(&env.dbx).await.unwrap();
    let stats = import_bodies(context, redis, &[first], None).await.unwrap();
    assert_counts(&stats, 0, 0, 1, 0);
    assert_eq!(
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(original.id)
            )
            .count(&env.dbx)
            .await
            .unwrap(),
        2
    );

    for changed in [
        first.replace("first", "First"),
        first.replace("first", "first  "),
        second.replace("10:16:00", "10:16:01"),
    ] {
        let stats = import_bodies(context, redis, &[&changed], None)
            .await
            .unwrap();
        assert_counts(&stats, 1, 0, 0, 0);
    }
    let third_message = messages(&env.dbx, third).await.remove(0);
    let mut deleted = third_message.into_active_model();
    deleted.deleted = Set(true);
    deleted.update(&env.dbx).await.unwrap();
    let stats = import_bodies(context, redis, &[third], None).await.unwrap();
    assert_counts(&stats, 1, 0, 0, 0);
    assert_eq!(messages(&env.dbx, third).await.len(), 2);
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_concurrent_csv_uploads_insert_and_process_once() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let context = csv_context(&env).await;
    let mut left_redis = env.redis.clone();
    let mut right_redis = env.redis.clone();
    let body = "02.10.2026 10:16:00\nconcurrent CSV safeguard";
    let bodies = [body, body];
    let (left, right) = tokio::join!(
        import_bodies(&context, &mut left_redis, &bodies, None),
        import_bodies(&context, &mut right_redis, &bodies, None),
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.imported + right.imported, 1);
    assert_eq!(
        left.reused + right.reused + left.duplicates + right.duplicates,
        3
    );
    let rows = messages(&env.dbx, body).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(rows[0].id)
            )
            .count(&env.dbx)
            .await
            .unwrap(),
        1
    );
    assert!(sigint_inbox_item::Entity::find_by_id(rows[0].id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
    assert!(rer_csv_import_message::Entity::find_by_id(rows[0].id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .completed_at
        .is_some());
}

async fn fail_writes(
    dbx: &DatabaseConnection,
    table: &str,
    event: &str,
    condition: &str,
) {
    dbx.execute_unprepared(&format!(
        "create function csv_test_failure() returns trigger language plpgsql as $$ begin raise exception 'CSV injected failure'; end $$; create trigger csv_test_failure before {event} on {table} for each row when ({condition}) execute function csv_test_failure();"
    )).await.unwrap();
}

async fn allow_writes(dbx: &DatabaseConnection, table: &str) {
    dbx.execute_unprepared(&format!(
        "drop trigger csv_test_failure on {table}; drop function csv_test_failure();"
    )).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_csv_persistence_and_processing_failures_are_recoverable() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let context = csv_context(&env).await;
    let mut redis = env.redis.clone();
    let body = "02.10.2026 10:16:00\nfailed CSV persistence safeguard";
    fail_writes(
        &env.dbx,
        "signal_message_group",
        "insert",
        &format!("new.group_master_key = '{}'", context.group_id),
    )
    .await;
    let failure = import_bodies(&context, &mut redis, &[body], None).await;
    allow_writes(&env.dbx, "signal_message_group").await;
    assert!(failure.is_err());
    assert!(messages(&env.dbx, body).await.is_empty());
    assert_counts(
        &import_bodies(&context, &mut redis, &[body], None)
            .await
            .unwrap(),
        1,
        0,
        0,
        0,
    );

    for table in ["sigint_inbox_item", "sigint_search"] {
        assert_processing_rollback_and_concurrent_recovery(
            &context, &mut redis, table,
        )
        .await;
    }
    assert_recovery_uses_saved_validation_reference(&context, &mut redis).await;
    // Delivery/completion retries must preserve the committed inbox state.
    let body = "02.10.2026 10:16:00\nCSV delivery completion failure";
    fail_writes(
        &env.dbx,
        "rer_csv_import_message",
        "update",
        "new.completed_at is not null",
    )
    .await;
    let failure = import_bodies(&context, &mut redis, &[body], None).await;
    allow_writes(&env.dbx, "rer_csv_import_message").await;
    assert!(failure.is_err());
    let original = messages(&env.dbx, body).await.remove(0);
    let state = rer_csv_import_message::Entity::find_by_id(original.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.inbox_item_ids, Some(vec![original.id]));
    assert!(state.completed_at.is_none());
    let mut inbox = sigint_inbox_item::Entity::find_by_id(original.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    inbox.reviewed = Set(Some(true));
    inbox.update(&env.dbx).await.unwrap();
    assert_counts(
        &import_bodies(&context, &mut redis, &[body], None)
            .await
            .unwrap(),
        0,
        1,
        0,
        0,
    );
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(original.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .reviewed,
        Some(true)
    );
}

async fn assert_recovery_uses_saved_validation_reference(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
) {
    let later = context.lnow + chrono::Duration::days(10);
    let body = format!(
        "{}\n{}\none\ntwo\nthree\n{}\nCSV saved validation reference",
        context.lnow.format("%d.%m.%Y %H:%M:%S"),
        format!("{} ", "x".repeat(99)).repeat(53),
        later.format("%d.%m.%Y %H:%M:%S"),
    );
    let record = RerCsvRecord {
        source_record: 1,
        body: body.clone(),
    };
    assert!(!validate_historical_record(context.lnow, &record).should_skip());
    assert!(validate_historical_record(later, &record).invalid_message_size);
    fail_writes(context.dbx, "sigint_search", "insert", "true").await;
    let failure = import_bodies(context, redis, &[&body], None).await;
    allow_writes(context.dbx, "sigint_search").await;
    assert!(failure.is_err());
    let original = messages(context.dbx, &body).await.remove(0);
    let later_context = RerCsvImportContext {
        settlements: context.settlements.clone(),
        dbx: context.dbx,
        rq: context.rq,
        config: context.config,
        group_id: context.group_id.clone(),
        datasource_group_id: context.datasource_group_id,
        source_uuid: context.source_uuid.clone(),
        import_as_new: context.import_as_new,
        reconcile_target_group: context.reconcile_target_group,
        lnow: later,
    };
    for (reused, duplicates) in [(1, 0), (0, 1)] {
        assert_counts(
            &import_bodies(&later_context, redis, &[&body], None)
                .await
                .unwrap(),
            0,
            reused,
            duplicates,
            0,
        );
        assert_eq!(messages(context.dbx, &body).await, vec![original.clone()]);
    }
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(original.id)
            .one(context.dbx)
            .await
            .unwrap()
            .unwrap()
            .datetime,
        original.timestamp
    );
}

async fn assert_processing_rollback_and_concurrent_recovery(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    table: &str,
) {
    let body = format!("Час: 10:15:00\nfailed CSV processing {table}");
    fail_writes(context.dbx, table, "insert", "true").await;
    let failure = import_bodies(context, redis, &[&body], None).await;
    allow_writes(context.dbx, table).await;
    assert!(failure.is_err());
    let original = messages(context.dbx, &body).await.remove(0);
    assert!(sigint_inbox_item::Entity::find_by_id(original.id)
        .one(context.dbx)
        .await
        .unwrap()
        .is_none());
    let state = rer_csv_import_message::Entity::find_by_id(original.id)
        .one(context.dbx)
        .await
        .unwrap()
        .unwrap();
    assert!(state.inbox_item_ids.is_none());
    assert!(state.completed_at.is_none());
    let later_context = RerCsvImportContext {
        settlements: context.settlements.clone(),
        dbx: context.dbx,
        rq: context.rq,
        config: context.config,
        group_id: context.group_id.clone(),
        datasource_group_id: context.datasource_group_id,
        source_uuid: context.source_uuid.clone(),
        import_as_new: context.import_as_new,
        reconcile_target_group: true,
        lnow: context.lnow + chrono::Duration::days(1),
    };
    let mut concurrent_redis = redis.clone();
    let bodies = [body.as_str()];
    let (left, right) = tokio::join!(
        import_bodies(&later_context, redis, &bodies, None),
        import_bodies(&later_context, &mut concurrent_redis, &bodies, None),
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left.imported + right.imported, 0);
    assert_eq!(left.reused + right.reused, 1);
    assert_eq!(left.duplicates + right.duplicates, 1);
    assert_eq!(messages(context.dbx, &body).await, vec![original.clone()]);
    let inbox = sigint_inbox_item::Entity::find_by_id(original.id)
        .one(context.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(inbox.datetime, original.timestamp);
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_legacy_duplicates_preserve_inboxes_and_reuse_missing_ones()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let context = csv_context(&env).await;
    let mut redis = env.redis.clone();
    let body = "02.10.2026 10:16:00\nlegacy CSV processing safeguard";
    let record = RerCsvRecord {
        source_record: 1,
        body: body.into(),
    };
    let timestamp = validate_historical_record(context.lnow, &record)
        .timestamp
        .unwrap();
    let id = insert_rer_csv_message(&context, body.into(), timestamp, &env.dbx)
        .await
        .unwrap();
    assert!(rer_csv_import_message::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
    assert_counts(
        &import_bodies(&context, &mut redis, &[body], None)
            .await
            .unwrap(),
        0,
        1,
        0,
        0,
    );
    rer_csv_import_message::Entity::delete_by_id(id)
        .exec(&env.dbx)
        .await
        .unwrap();
    let original = sigint_inbox_item::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let extra_id =
        insert_rer_csv_message(&context, body.into(), timestamp, &env.dbx)
            .await
            .unwrap();
    assert!(extra_id > id);
    let outcome = persistence::persist_rer_csv_message(
        &context,
        body.into(),
        Some(timestamp),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(outcome, RerCsvPersistence::Duplicate(existing_id) if existing_id == id)
    );
    assert_counts(
        &import_bodies(&context, &mut redis, &[body], None)
            .await
            .unwrap(),
        0,
        0,
        1,
        0,
    );
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap(),
        original
    );
    assert!(sigint_inbox_item::Entity::find_by_id(extra_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());

    assert_later_legacy_inbox_prevents_recovery(
        &context, &mut redis, body, timestamp, extra_id,
    )
    .await;
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_legacy_recovery_restores_missing_timestamp() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let context = csv_context(&env).await;
    let mut redis = env.redis.clone();
    let body = "02.10.2026 10:16:00\nlegacy CSV missing timestamp";
    let timestamp = validate_historical_record(
        context.lnow,
        &RerCsvRecord {
            source_record: 1,
            body: body.into(),
        },
    )
    .timestamp
    .unwrap();
    let id = insert_rer_csv_message(&context, body.into(), timestamp, &env.dbx)
        .await
        .unwrap();
    let original = messages(&env.dbx, body).await.remove(0);
    assert_legacy_timestamp_recovery(&context, body, id, timestamp, &original)
        .await;
    for (reused, duplicates) in [(1, 0), (0, 1)] {
        assert_counts(
            &import_bodies(&context, &mut redis, &[body], None)
                .await
                .unwrap(),
            0,
            reused,
            duplicates,
            0,
        );
        assert_eq!(messages(&env.dbx, body).await, vec![original.clone()]);
    }
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .datetime,
        Some(timestamp)
    );
}

async fn assert_legacy_timestamp_recovery(
    context: &RerCsvImportContext<'_>,
    body: &str,
    id: i64,
    timestamp: NaiveDateTime,
    original: &signal_message::Model,
) {
    for tracked in [false, true] {
        signal_message::ActiveModel {
            id: Set(id),
            timestamp: Set(None),
            ..Default::default()
        }
        .update(context.dbx)
        .await
        .unwrap();
        assert!(persistence::persist_rer_csv_message(
            context,
            body.into(),
            None,
        )
        .await
        .unwrap()
        .is_none());
        assert_eq!(
            rer_csv_import_message::Entity::find_by_id(id)
                .one(context.dbx)
                .await
                .unwrap()
                .is_some(),
            tracked
        );
        let outcome = persistence::persist_rer_csv_message(
            context,
            body.into(),
            Some(timestamp),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            matches!(outcome, RerCsvPersistence::Reused(existing_id) if existing_id == id)
        );
        assert_eq!(messages(context.dbx, body).await, vec![original.clone()]);
    }
}

async fn assert_later_legacy_inbox_prevents_recovery(
    context: &RerCsvImportContext<'_>,
    redis: &mut redis::aio::ConnectionManager,
    body: &str,
    timestamp: NaiveDateTime,
    extra_id: i64,
) {
    let mut deleted = messages(context.dbx, body)
        .await
        .remove(0)
        .into_active_model();
    deleted.deleted = Set(true);
    deleted.update(context.dbx).await.unwrap();
    let later_id =
        insert_rer_csv_message(context, body.into(), timestamp, context.dbx)
            .await
            .unwrap();
    process_imported_rer_csv_message(context, redis, later_id, timestamp)
        .await
        .unwrap();
    assert!(later_id > extra_id);
    let outcome = persistence::persist_rer_csv_message(
        context,
        body.into(),
        Some(timestamp),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        matches!(outcome, RerCsvPersistence::Duplicate(existing_id) if existing_id == later_id)
    );
    assert_counts(
        &import_bodies(context, redis, &[body], None).await.unwrap(),
        0,
        0,
        1,
        0,
    );
    assert!(sigint_inbox_item::Entity::find_by_id(extra_id)
        .one(context.dbx)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_new_import_recovery_keeps_reference_date_and_mode() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut context = csv_context(&env).await;
    context.import_as_new = true;
    let mut redis = env.redis.clone();
    let body = "Час: 10:15:00\nF=146.5000\nCSV new import recovery reference";
    let expected = validate_historical_record(
        context.lnow,
        &RerCsvRecord {
            source_record: 1,
            body: body.to_string(),
        },
    )
    .timestamp
    .unwrap();
    let outcome = persistence::persist_rer_csv_message(
        &context,
        body.to_string(),
        Some(context.lnow.naive_utc()),
    )
    .await
    .unwrap()
    .unwrap();
    let id = outcome.message_id();
    let original = messages(&env.dbx, body).await.remove(0);
    context.import_as_new = false;
    context.lnow += chrono::Duration::days(1);
    for (reused, duplicates) in [(1, 0), (0, 1)] {
        assert_counts(
            &import_bodies(&context, &mut redis, &[body], None)
                .await
                .unwrap(),
            0,
            reused,
            duplicates,
            0,
        );
        assert_eq!(messages(&env.dbx, body).await, vec![original.clone()]);
        assert_eq!(
            sigint_inbox_item::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .datetime,
            Some(expected)
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3650_split_csv_duplicates_preserve_children_and_recover_delivery(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut context = csv_context(&env).await;
    context.import_as_new = true;
    let network_id = csv_network(&context).await;
    let mut redis = env.redis.clone();
    let body = format!(
        "02.10.2026 10:16:00\nF=146.5000\nfirst CSV header\n{}\n02.10.2026 10:17:00\nF=146.5000\nsecond CSV header\n{}",
        "first split CSV safeguard ".repeat(110),
        "second split CSV safeguard ".repeat(110),
    )
    .trim()
    .to_string();
    fail_writes(
        &env.dbx,
        "rer_csv_import_message",
        "update",
        "new.completed_at is not null",
    )
    .await;
    let failure = import_bodies(&context, &mut redis, &[&body], None).await;
    allow_writes(&env.dbx, "rer_csv_import_message").await;
    assert!(failure.is_err());
    let parent = messages(&env.dbx, &body).await.remove(0);
    assert!(parent.deleted);
    let state = rer_csv_import_message::Entity::find_by_id(parent.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert!(state.completed_at.is_none());
    let mut child_ids = state.inbox_item_ids.unwrap();
    assert_eq!(child_ids.len(), 2);
    assert!(!child_ids.contains(&parent.id));
    assert_csv_children_reconciled(&context, &child_ids, network_id).await;
    let interrupted_id = insert_rer_csv_message(
        &context,
        body.clone(),
        context.lnow.naive_utc(),
        &env.dbx,
    )
    .await
    .unwrap();
    let original_messages = messages(&env.dbx, &body).await;
    sigint_inbox_item::Entity::update_many()
        .col_expr(sigint_inbox_item::Column::Reviewed, Expr::value(true))
        .filter(sigint_inbox_item::Column::Id.is_in(child_ids.clone()))
        .exec(&env.dbx)
        .await
        .unwrap();
    let inboxes = csv_inboxes(&env.dbx).await;
    for (reused, duplicates) in [(1, 0), (0, 1)] {
        assert_counts(
            &import_bodies(&context, &mut redis, &[&body], None)
                .await
                .unwrap(),
            0,
            reused,
            duplicates,
            0,
        );
        assert_eq!(messages(&env.dbx, &body).await, original_messages);
        assert_eq!(csv_inboxes(&env.dbx).await, inboxes);
    }
    child_ids.push(interrupted_id);
    signal_message::Entity::update_many()
        .col_expr(signal_message::Column::Deleted, Expr::value(true))
        .filter(signal_message::Column::Id.is_in(child_ids))
        .exec(&env.dbx)
        .await
        .unwrap();
    assert_counts(
        &import_bodies(&context, &mut redis, &[&body], None)
            .await
            .unwrap(),
        1,
        0,
        0,
        0,
    );
    assert_eq!(messages(&env.dbx, &body).await.len(), 3);
}

async fn csv_network(context: &RerCsvImportContext<'_>) -> i64 {
    let aor = find_test_aor(context.dbx).await.unwrap();
    mk_signal_group_aor(
        context.dbx,
        signal_group_aor::ActiveModel {
            master_key: Set(context.group_id.clone()),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let network = mk_sigint_network(
        context.dbx,
        sigint_network::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_aor(
        context.dbx,
        sigint_network_aor::ActiveModel {
            network_id: Set(network.id),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_freq(
        context.dbx,
        sigint_network_freq::ActiveModel {
            network_id: Set(network.id),
            freq: Set("146.5000".to_string()),
            active_from: Set(
                (context.lnow - chrono::Duration::days(1)).naive_utc()
            ),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    network.id
}

async fn assert_csv_children_reconciled(
    context: &RerCsvImportContext<'_>,
    child_ids: &[i64],
    network_id: i64,
) {
    for id in child_ids {
        let child = signal_message::Entity::find_by_id(*id)
            .one(context.dbx)
            .await
            .unwrap()
            .unwrap();
        let links = signal_message_group::Entity::find()
            .filter(signal_message_group::Column::SignalMessageId.eq(*id))
            .all(context.dbx)
            .await
            .unwrap();
        assert_eq!(links.len(), 1);
        let link = &links[0];
        assert_eq!(
            link.group_master_key.as_deref(),
            Some(context.group_id.as_str())
        );
        assert_eq!(
            child.datasource_group_id,
            Some(context.datasource_group_id)
        );
        assert_eq!(link.datasource_group_id, child.datasource_group_id);
        assert_eq!(link.signal_message_uuid, child.id_uuid);
        assert_eq!(link.sender, child.sender);
        assert_eq!(link.login_id, child.login_id);
        assert_eq!(link.message_uid, child.message_uid);
        assert_eq!(link.created_at, child.created_at);
        assert_eq!(
            sigint_inbox_item_network::Entity::find()
                .filter(
                    sigint_inbox_item_network::Column::SigintInboxItemId
                        .eq(*id)
                )
                .filter(
                    sigint_inbox_item_network::Column::SigintNetworkId
                        .eq(network_id)
                )
                .count(context.dbx)
                .await
                .unwrap(),
            1
        );
    }
}

async fn csv_inboxes(
    dbx: &DatabaseConnection,
) -> Vec<sigint_inbox_item::Model> {
    sigint_inbox_item::Entity::find()
        .order_by_asc(sigint_inbox_item::Column::Id)
        .all(dbx)
        .await
        .unwrap()
}
