use super::*;
use crate::attachments::analytics::{
    ensure_search_coverage_scoped, prune_search_changes, SearchCoverageScope,
    SearchTimeBasis,
};
use sea_orm::{ConnectionTrait, DatabaseConnection};

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
    let groups = [group];
    execute(source, "UPDATE attachment_document SET updated_at=now() AT TIME ZONE 'UTC' WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    scoped_coverage(source, source, &groups, "Береза", None)
        .await
        .unwrap();
    execute(source, "UPDATE attachment_chunk SET text='Вільха',summary=NULL WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    for search in ["Береза", "-Береза", "Вільха", "-Вільха"]
    {
        assert!(scoped_coverage(source, source, &groups, search, None)
            .await
            .is_err());
        scoped_coverage(
            source,
            source,
            &["unrelated-group".into()],
            search,
            None,
        )
        .await
        .unwrap();
        scoped_coverage(
            source,
            source,
            &groups,
            search,
            Some(chrono::Utc::now().naive_utc() + chrono::Duration::days(1)),
        )
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
    assert!(scoped_coverage(source, source, &groups, "-scoped", None)
        .await
        .is_err());
    execute(
        source,
        "DELETE FROM public.echo_analytics_attachment_search",
        vec![],
    )
    .await
    .unwrap();
}

async fn snapshot_membership(env: &Env) -> DatabaseConnection {
    env.dbx.execute_unprepared("DROP SCHEMA IF EXISTS attachment_search_replica_3780 CASCADE; CREATE SCHEMA attachment_search_replica_3780").await.unwrap();
    for table in [
        "signal_message",
        "sigint_inbox_item",
        "signal_message_group",
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
    assert!(
        scoped_coverage(source, &analytics, &groups, "-Береза", None)
            .await
            .is_err()
    );
    signal_message::Entity::delete_by_id(message)
        .exec(source)
        .await
        .unwrap();
    assert!(scoped_coverage(source, &analytics, &groups, "Береза", None)
        .await
        .is_err());
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
    execute(source, "UPDATE attachment_search_change SET tracked_from=now() AT TIME ZONE 'UTC',changed_at=now() AT TIME ZONE 'UTC' WHERE singleton", vec![]).await.unwrap();
    assert!(scoped_coverage(source, source, &groups, "-Береза", None)
        .await
        .is_err());
    ready_coverage(source).await;
    execute(source, "INSERT INTO attachment_search_message_change SELECT -n,now() AT TIME ZONE 'UTC' FROM generate_series(1,1001) n", vec![]).await.unwrap();
    assert!(scoped_coverage(source, source, &groups, "Береза", None)
        .await
        .is_err());
    execute(source, "UPDATE attachment_search_message_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '2 days'", vec![]).await.unwrap();
    prune_search_changes(source).await.unwrap();
    let remaining = query_ids(
        source,
        "SELECT count(*) FROM attachment_search_message_change",
    )
    .await;
    assert_eq!(remaining, vec![501]);
    scoped_coverage(source, source, &groups, "-Береза", None)
        .await
        .unwrap();
    source.execute_unprepared("UPDATE public.echo_analytics_attachment_search SET history_complete=false; UPDATE attachment_document SET created_at=(now() AT TIME ZONE 'UTC')-interval '1 day'").await.unwrap();
    assert!(scoped_coverage(source, source, &groups, "-Береза", None)
        .await
        .is_err());
    execute(
        source,
        "DELETE FROM public.echo_analytics_attachment_search",
        vec![],
    )
    .await
    .unwrap();
}
