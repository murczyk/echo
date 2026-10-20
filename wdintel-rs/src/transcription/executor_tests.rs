use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::time::Duration;
use uuid::Uuid;

#[actix_web::test]
#[serial_test::serial]
async fn heartbeat_progresses_while_native_work_holds_a_sql_connection() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    active_instance(&env.dbx).await;
    let client = super::executor::client(&env.config).await.unwrap();
    let (source, _) = super::service::enqueue(&env.dbx, "heartbeat/sql")
        .await
        .unwrap();
    let claim = echo_gpu_client::claim_one(client.database(), Uuid::now_v7())
        .await
        .unwrap()
        .unwrap();
    let work = client.database().query_one_raw(Statement::from_string(
        DbBackend::Postgres,
        "select pg_sleep(0.8)",
    ));
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => panic!("SQL completed before heartbeat: {result:?}"),
        _ = tokio::time::sleep(Duration::from_millis(100)) => (),
    }
    let heartbeat = tokio::time::timeout(
        Duration::from_millis(500),
        echo_gpu_client::heartbeat(client.database(), claim.fence()),
    )
    .await;
    assert!(heartbeat.is_ok(), "heartbeat waited for suspended work SQL");
    heartbeat.unwrap().unwrap();
    work.await.unwrap();
    assert_eq!(
        echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0
            .attempt_count,
        1
    );
    client
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
}

#[actix_web::test]
#[serial_test::serial]
async fn a_reconnected_session_recovers_before_exposing_a_second_claim() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    active_instance(&env.dbx).await;
    let first = super::executor::client(&env.config).await.unwrap();
    let (source, _) = super::service::enqueue(&env.dbx, "guarded/source")
        .await
        .unwrap();
    let claim = echo_gpu_client::claim_one(first.database(), Uuid::now_v7())
        .await
        .unwrap()
        .unwrap();
    let pid = leader_pid(&env.dbx).await;
    let held = first
        .database()
        .get_postgres_connection_pool()
        .acquire()
        .await
        .unwrap();
    let config = env.config.clone();
    let mut second =
        tokio::spawn(async move { super::executor::client(&config).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err()
    );
    env.dbx
        .execute_unprepared(&format!("select pg_terminate_backend({pid},5000)"))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .is_err()
    );
    env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set heartbeat_at=(now() at time zone 'utc')-interval '1 hour' where source_id='{source}'")).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(1200), &mut second)
            .await
            .is_err(),
        "successor bypassed an old work session"
    );
    drop(held);
    let second = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let current = echo_gpu_client::lookup(second.database(), source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.0.state, "retrying");
    assert!(echo_gpu_client::heartbeat(second.database(), claim.fence())
        .await
        .is_err());
    assert!(first
        .database()
        .query_one_raw(Statement::from_string(DbBackend::Postgres, "select 1"))
        .await
        .is_err());
    second
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
}

#[actix_web::test]
#[serial_test::serial]
async fn reconnect_between_prepare_and_claim_fences_old_processing_before_new_claim(
) {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    active_instance(&env.dbx).await;
    let client = super::executor::client(&env.config).await.unwrap();
    let (source, _) = super::service::enqueue(&env.dbx, "reconnect/first")
        .await
        .unwrap();
    let claim = echo_gpu_client::claim_one(client.database(), Uuid::now_v7())
        .await
        .unwrap()
        .unwrap();
    let (next, _) = super::service::enqueue(&env.dbx, "reconnect/second")
        .await
        .unwrap();
    let pid: i32 = client
        .database()
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select pg_backend_pid() as pid",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "pid")
        .unwrap();
    env.dbx.execute_unprepared(&format!("select pg_terminate_backend({pid},5000); update echo_gpu_transcription_queue set heartbeat_at=(now() at time zone 'utc')-interval '1 hour' where source_id='{source}'")).await.unwrap();
    assert!(
        echo_gpu_client::claim_one(client.database(), Uuid::now_v7())
            .await
            .is_err()
    );
    let replacement = super::executor::client(&env.config).await.unwrap();
    let next_claim =
        echo_gpu_client::claim_one(replacement.database(), Uuid::now_v7())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(next_claim.item.source_id, next);
    assert_eq!(
        echo_gpu_client::queue_status(&env.dbx)
            .await
            .unwrap()
            .processing,
        1
    );
    assert!(echo_gpu_client::heartbeat(client.database(), claim.fence())
        .await
        .is_err());
    replacement
        .database()
        .get_postgres_connection_pool()
        .close()
        .await;
}

async fn active_instance(db: &sea_orm::DatabaseConnection) {
    echo_gpu_client::create_instance(
        db,
        echo_gpu_client::CreateInstance {
            name: "fencing fixture".into(),
            host: "fencing.invalid".into(),
            rs_port: 1,
            py_port: 2,
            train: false,
            ordering: Some(1),
        },
    )
    .await
    .unwrap();
}

async fn leader_pid(db: &sea_orm::DatabaseConnection) -> i32 {
    db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select pid from pg_locks where locktype='advisory' and classid=0 and objid::bigint=$1 and objsubid=1 and mode='ExclusiveLock' and granted",
        [super::executor::ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_LOCK.into()])).await.unwrap().unwrap().try_get("","pid").unwrap()
}
