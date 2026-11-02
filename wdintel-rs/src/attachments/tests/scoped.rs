use super::*;
use crate::attachments::analytics::{
    ensure_search_coverage_scoped, reconcile_search_changes,
    AttachmentSearchCoverageError, SearchCoverageScope, SearchTimeBasis,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};

fn assert_requires_source(result: anyhow::Result<()>) {
    let error = result.unwrap_err();
    assert!(
        error
            .downcast_ref::<AttachmentSearchCoverageError>()
            .is_some(),
        "{error:#}"
    );
}

async fn query_ids(source: &DatabaseConnection, sql: &str) -> Vec<i64> {
    source
        .query_all_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            sql,
        ))
        .await
        .unwrap()
        .iter()
        .map(|row| row.try_get_by_index(0).unwrap())
        .collect()
}

async fn ready_coverage(source: &DatabaseConnection) {
    execute(source, "CREATE TABLE IF NOT EXISTS public.echo_analytics_attachment_search(singleton boolean PRIMARY KEY CHECK(singleton), started_at timestamp NOT NULL, history_complete boolean NOT NULL DEFAULT false)", vec![]).await.unwrap();
    execute(source, "INSERT INTO public.echo_analytics_attachment_search VALUES(true,now() AT TIME ZONE 'UTC',true) ON CONFLICT(singleton) DO UPDATE SET history_complete=true", vec![]).await.unwrap();
    execute(source, "UPDATE attachment_search_change SET tracked_from=(now() AT TIME ZONE 'UTC')-interval '1 day',changed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE singleton", vec![]).await.unwrap();
    execute(
        source,
        "DELETE FROM attachment_search_message_change",
        vec![],
    )
    .await
    .unwrap();
}

async fn scoped_coverage(
    source: &DatabaseConnection,
    analytics: &DatabaseConnection,
    groups: &[String],
    search: &str,
    since: Option<chrono::NaiveDateTime>,
) -> anyhow::Result<()> {
    ensure_search_coverage_scoped(
        source,
        analytics,
        &Some(search.into()),
        None,
        90_000,
        SearchCoverageScope {
            since,
            till: None,
            till_inclusive: false,
            time_basis: SearchTimeBasis::Creation,
            groups,
            media_presence_filtered: false,
        },
    )
    .await
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_scopes_changes_and_ignores_processing_updates_3780()
{
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let job = attachment(&env, message, "scoped.txt").await;
    publish(&env, &job, package("Береза"), vec![1])
        .await
        .unwrap();
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    let groups = [group];
    execute(source, "UPDATE attachment_document SET updated_at=now() AT TIME ZONE 'UTC' WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    scoped_coverage(source, &analytics, &groups, "Береза", None)
        .await
        .unwrap();
    execute(source, "UPDATE attachment_chunk SET text='Вільха',summary=NULL WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    for search in ["Береза", "-Береза", "Вільха", "-Вільха"]
    {
        assert_requires_source(
            scoped_coverage(source, &analytics, &groups, search, None).await,
        );
        scoped_coverage(
            source,
            &analytics,
            &["unrelated-group".into()],
            search,
            None,
        )
        .await
        .unwrap();
        scoped_coverage(
            source,
            &analytics,
            &groups,
            search,
            Some(chrono::Utc::now().naive_utc() + chrono::Duration::days(1)),
        )
        .await
        .unwrap();
    }
    for search in ["Сосна", "-Сосна", "\"Сосна червона\""]
    {
        scoped_coverage(source, &analytics, &groups, search, None)
            .await
            .unwrap();
    }
    execute(
        source,
        "DELETE FROM attachment_search_message_change",
        vec![],
    )
    .await
    .unwrap();
    execute(
        source,
        "UPDATE signal_message_media SET file_name='renamed.txt' WHERE id=$1",
        vec![job.media_id.into()],
    )
    .await
    .unwrap();
    for search in ["-scoped", "renamed"] {
        assert_requires_source(
            scoped_coverage(source, &analytics, &groups, search, None).await,
        );
    }
    scoped_coverage(source, &analytics, &groups, "-Сосна", None)
        .await
        .unwrap();
    analytics.close().await.unwrap();
    source.execute_unprepared("DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search").await.unwrap();
}

async fn snapshot_membership(env: &Env) -> DatabaseConnection {
    env.dbx.execute_unprepared("DROP SCHEMA IF EXISTS attachment_search_replica_3780 CASCADE; CREATE SCHEMA attachment_search_replica_3780").await.unwrap();
    for table in [
        "signal_message",
        "sigint_inbox_item",
        "signal_message_group",
        "signal_message_media",
        "attachment_document",
        "attachment_chunk",
        "signal_message_audio_search",
    ] {
        execute(&env.dbx, &format!("CREATE TABLE attachment_search_replica_3780.{table} AS SELECT * FROM public.{table}"), vec![]).await.unwrap();
    }
    let mut options =
        sea_orm::ConnectOptions::new(crate::mk_conn_string(&env.config));
    options
        .max_connections(1)
        .map_sqlx_postgres_opts(|options| {
            options.options([(
                "search_path",
                "attachment_search_replica_3780,public",
            )])
        });
    sea_orm::Database::connect(options).await.unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_observes_commits_before_expiring_changes_3780() {
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let job = attachment(&env, message, "before-commit.txt").await;
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    let groups = [group];
    let transaction = source.begin().await.unwrap();
    transaction
        .execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "UPDATE signal_message_media SET file_name='after-commit.txt' WHERE id=$1",
            [job.media_id.into()],
        ))
        .await
        .unwrap();
    reconcile_search_changes(source).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    transaction.commit().await.unwrap();
    assert_requires_source(
        ensure_search_coverage_scoped(
            source,
            &analytics,
            &Some("-before".into()),
            None,
            1,
            SearchCoverageScope {
                since: None,
                till: None,
                till_inclusive: false,
                time_basis: SearchTimeBasis::Creation,
                groups: &groups,
                media_presence_filtered: false,
            },
        )
        .await,
    );
    reconcile_search_changes(source).await.unwrap();
    assert_eq!(
        query_ids(source, "SELECT count(*) FROM attachment_search_message_change WHERE changed_at IS NOT NULL").await,
        vec![1]
    );
    assert_requires_source(
        scoped_coverage(source, &analytics, &groups, "-before", None).await,
    );
    execute(source, "UPDATE attachment_search_message_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour'", vec![]).await.unwrap();
    scoped_coverage(source, &analytics, &groups, "-before", None)
        .await
        .unwrap();
    execute(source, "UPDATE signal_message_media SET file_name='edited-again.txt' WHERE id=$1", vec![job.media_id.into()]).await.unwrap();
    assert_requires_source(
        scoped_coverage(source, &analytics, &groups, "-before", None).await,
    );
    analytics.close().await.unwrap();
    source.execute_unprepared("DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search").await.unwrap();
}

async fn changed_time_membership(
) -> (Env, DatabaseConnection, String, [chrono::NaiveDateTime; 3]) {
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let interception = chrono::NaiveDate::from_ymd_opt(2026, 10, 10)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let timestamp = interception + chrono::Duration::days(1);
    let creation = interception + chrono::Duration::days(2);
    crate::functest::tests::mk_sigint_inbox_item(
        source,
        crate::entities::sigint_inbox_item::ActiveModel {
            id: Set(message),
            datetime: Set(Some(interception)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    execute(
        source,
        "UPDATE signal_message SET timestamp=$2,created_at=$3 WHERE id=$1",
        vec![message.into(), timestamp.into(), creation.into()],
    )
    .await
    .unwrap();
    let job = attachment(&env, message, "endpoints.txt").await;
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    execute(
        source,
        "UPDATE signal_message_media SET file_name='renamed.txt' WHERE id=$1",
        vec![job.media_id.into()],
    )
    .await
    .unwrap();
    execute(
        source,
        "UPDATE signal_message SET timestamp=$2,created_at=$2 WHERE id=$1",
        vec![
            message.into(),
            (creation + chrono::Duration::days(10)).into(),
        ],
    )
    .await
    .unwrap();
    execute(
        source,
        "UPDATE sigint_inbox_item SET datetime=$2 WHERE id=$1",
        vec![
            message.into(),
            (creation + chrono::Duration::days(10)).into(),
        ],
    )
    .await
    .unwrap();
    (env, analytics, group, [interception, timestamp, creation])
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_scopes_time_endpoints_and_literal_modes_3780() {
    use crate::rer_importer::types::AnalysisSearchMode;

    let (env, analytics, group, times) = changed_time_membership().await;
    let source = &env.dbx;
    let groups = [group];
    for search_mode in [
        AnalysisSearchMode::Fuzzy,
        AnalysisSearchMode::Exact,
        AnalysisSearchMode::Substring,
    ] {
        for (index, time) in times.into_iter().enumerate() {
            for (since, till, till_inclusive, expected) in [
                (time, time, true, true),
                (time, time, false, false),
                (
                    time + chrono::Duration::milliseconds(1),
                    time + chrono::Duration::days(1),
                    true,
                    false,
                ),
            ] {
                let result = ensure_search_coverage_scoped(
                    source,
                    &analytics,
                    &Some("-endpoints".into()),
                    Some(search_mode),
                    90_000,
                    SearchCoverageScope {
                        since: Some(since),
                        till: Some(till),
                        till_inclusive,
                        time_basis: match index {
                            0 => SearchTimeBasis::Interception,
                            1 => SearchTimeBasis::Timestamp,
                            _ => SearchTimeBasis::Creation,
                        },
                        groups: &groups,
                        media_presence_filtered: false,
                    },
                )
                .await;
                if expected {
                    assert_requires_source(result);
                } else {
                    result.unwrap();
                }
            }
        }
    }
    analytics.close().await.unwrap();
    source.execute_unprepared("DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search").await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_retains_former_owners_and_deleted_membership_3780() {
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let job = attachment(&env, message, "former-owner.txt").await;
    publish(&env, &job, package("Береза"), vec![1])
        .await
        .unwrap();
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    let next = mk_signal_message(source, Default::default()).await.unwrap();
    execute(
        source,
        "UPDATE signal_message_media SET signal_message_id=$2 WHERE id=$1",
        vec![job.media_id.into(), next.id.into()],
    )
    .await
    .unwrap();
    let changed = query_ids(source, "SELECT message_id FROM attachment_search_message_change ORDER BY message_id").await;
    assert_eq!(changed, vec![message, next.id]);
    execute(
        source,
        "DELETE FROM signal_message_group WHERE signal_message_id=$1",
        vec![message.into()],
    )
    .await
    .unwrap();
    let groups = [group];
    scoped_coverage(source, source, &groups, "-Береза", None)
        .await
        .unwrap();
    assert_requires_source(
        scoped_coverage(source, &analytics, &groups, "-Береза", None).await,
    );
    signal_message::Entity::delete_by_id(message)
        .exec(source)
        .await
        .unwrap();
    assert_requires_source(
        scoped_coverage(source, &analytics, &groups, "Береза", None).await,
    );
    execute(
        source,
        "DELETE FROM signal_message_media WHERE id=$1",
        vec![job.media_id.into()],
    )
    .await
    .unwrap();
    let changed = query_ids(source, "SELECT message_id FROM attachment_search_message_change ORDER BY message_id").await;
    assert_eq!(changed, vec![message, next.id]);
    analytics.close().await.unwrap();
    source.execute_unprepared("DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search").await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn latest_inbox_probe_retains_attachment_change_guards_3780() {
    use crate::functest::tests::find_test_login;
    use crate::rer_importer::inbox::query::load_analytics_inbox_candidates;
    use crate::rer_importer::types::{InboxMessagesReq, InboxMessagesSortBy};

    let (env, _, message) = fixture().await;
    let source = &env.dbx;
    let login = find_test_login(source).await.unwrap();
    let job = attachment(&env, message, "before-rename.txt").await;
    publish(&env, &job, package("Береза"), vec![1])
        .await
        .unwrap();
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    execute(
        source,
        r#"UPDATE signal_message_media SET file_name='after-rename.txt' WHERE id=$1"#,
        vec![job.media_id.into()],
    )
    .await
    .unwrap();
    for removed in [false, true] {
        if removed {
            execute(
                source,
                r#"DELETE FROM signal_message_group WHERE signal_message_id=$1"#,
                vec![message.into()],
            )
            .await
            .unwrap();
            reconcile_search_changes(source).await.unwrap();
        }
        for sort_by in [
            InboxMessagesSortBy::IMSDatetime,
            InboxMessagesSortBy::IMSTimestamp,
            InboxMessagesSortBy::IMSCreatedAt,
        ] {
            for search in ["Береза", "-Береза"] {
                let req = InboxMessagesReq {
                    load_latest: Some(true),
                    sort_by: Some(sort_by),
                    search: Some(search.into()),
                    ..Default::default()
                };
                let error = load_analytics_inbox_candidates(
                    &login.id, &env, &req, &analytics, 90_000,
                )
                .await
                .unwrap_err();
                let error = anyhow::Error::from(error);
                assert!(
                    error.chain().any(|error| error
                        .downcast_ref::<AttachmentSearchCoverageError>()
                        .is_some()),
                    "{error:#}"
                );
            }
        }
    }
    analytics.close().await.unwrap();
    source.execute_unprepared(r#"DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search"#).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_bootstrap_overflow_and_retention_stay_conservative_3780(
) {
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let job = attachment(&env, message, "bootstrap.txt").await;
    publish(&env, &job, package("Береза"), vec![1])
        .await
        .unwrap();
    ready_coverage(source).await;
    let groups = [group];
    execute(source, "UPDATE attachment_search_change SET tracked_from=now() AT TIME ZONE 'UTC' WHERE singleton", vec![]).await.unwrap();
    assert_requires_source(
        scoped_coverage(source, source, &groups, "-Береза", None).await,
    );
    ready_coverage(source).await;
    execute(source, "INSERT INTO attachment_search_message_change SELECT -n,now() AT TIME ZONE 'UTC' FROM generate_series(1,1001) n", vec![]).await.unwrap();
    assert_requires_source(
        scoped_coverage(source, source, &groups, "Береза", None).await,
    );
    execute(source, "UPDATE attachment_search_message_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '2 days'", vec![]).await.unwrap();
    reconcile_search_changes(source).await.unwrap();
    let remaining = query_ids(
        source,
        "SELECT count(*) FROM attachment_search_message_change",
    )
    .await;
    assert_eq!(remaining, vec![501]);
    execute(source, "INSERT INTO attachment_search_message_change VALUES (0,(now() AT TIME ZONE 'UTC')-interval '1 day 5 minutes')", vec![]).await.unwrap();
    reconcile_search_changes(source).await.unwrap();
    assert_eq!(
        query_ids(source, "SELECT count(*) FROM attachment_search_message_change WHERE message_id=0").await,
        vec![1]
    );
    scoped_coverage(source, source, &groups, "-Береза", None)
        .await
        .unwrap();
    source.execute_unprepared("DELETE FROM attachment_search_message_change; INSERT INTO attachment_search_message_change SELECT -n,NULL FROM generate_series(1,1001) n").await.unwrap();
    reconcile_search_changes(source).await.unwrap();
    assert_eq!(
        query_ids(source, "SELECT count(*) FROM attachment_search_message_change WHERE changed_at IS NULL").await,
        vec![501]
    );
    assert_eq!(
        query_ids(
            source,
            "SELECT count(*) FROM attachment_search_message_change"
        )
        .await,
        vec![1001]
    );
    assert_requires_source(
        scoped_coverage(source, source, &groups, "-Береза", None).await,
    );
    execute(
        source,
        "DELETE FROM attachment_search_message_change",
        vec![],
    )
    .await
    .unwrap();
    source.execute_unprepared("UPDATE public.echo_analytics_attachment_search SET history_complete=false; UPDATE attachment_document SET created_at=(now() AT TIME ZONE 'UTC')-interval '1 day'").await.unwrap();
    assert_requires_source(
        scoped_coverage(source, source, &groups, "-Береза", None).await,
    );
    execute(
        source,
        "DELETE FROM public.echo_analytics_attachment_search",
        vec![],
    )
    .await
    .unwrap();
}

async fn audio_search(source: &DatabaseConnection, message: i64, name: &str) {
    execute(
        source,
        r#"
        with source as (
            insert into transcription_source(id, source_key)
            values ($1, '3780-audio/' || $1::text) returning id
        ), audio as (
            insert into signal_message_audio_ref
                (id, signal_message_id, audio_id, transcription_source_id)
            select $1, $2, $1, id from source returning id
        )
        insert into signal_message_audio_search(id, signal_message_id, file_name)
        select id, $2, $3 from audio
        "#,
        vec![Uuid::new_v4().into(), message.into(), name.into()],
    )
    .await
    .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_change_terms_cover_audio_and_media_presence_3780() {
    let (env, group, message) = fixture().await;
    let source = &env.dbx;
    let job = attachment(&env, message, "unrelated.txt").await;
    publish(&env, &job, package("Береза"), vec![1])
        .await
        .unwrap();
    audio_search(source, message, "Вільха.wav").await;
    ready_coverage(source).await;
    let analytics = snapshot_membership(&env).await;
    let groups = [group];
    execute(
        source,
        "UPDATE signal_message_audio_search SET file_name='Сосна.wav' WHERE signal_message_id=$1",
        vec![message.into()],
    )
    .await
    .unwrap();
    for search in ["Сосна", "-Вільха"] {
        assert_requires_source(
            scoped_coverage(source, &analytics, &groups, search, None).await,
        );
    }
    scoped_coverage(source, &analytics, &groups, "Ясен", None)
        .await
        .unwrap();
    assert_requires_source(
        ensure_search_coverage_scoped(
            source,
            &analytics,
            &Some("Ясен".into()),
            None,
            90_000,
            SearchCoverageScope {
                since: None,
                till: None,
                till_inclusive: false,
                time_basis: SearchTimeBasis::Creation,
                groups: &groups,
                media_presence_filtered: true,
            },
        )
        .await,
    );
    analytics.close().await.unwrap();
    source.execute_unprepared("DROP SCHEMA attachment_search_replica_3780 CASCADE; DELETE FROM public.echo_analytics_attachment_search").await.unwrap();
}
