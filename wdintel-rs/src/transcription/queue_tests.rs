use super::service;
use sea_orm::{ConnectionTrait, DbBackend, Statement};

#[tokio::test]
#[serial_test::serial]
async fn concurrent_key_replays_preserve_the_same_native_task() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let (first, second) = tokio::join!(
        service::enqueue(&env.dbx, "message-media/shared-source"),
        service::enqueue(&env.dbx, "message-media/shared-source"),
    );
    let (first, _) = first.unwrap();
    assert_eq!(first, second.unwrap().0);
    let task = echo_gpu_client::lookup(&env.dbx, first)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(task.0.id, first);
    let different = service::enqueue(&env.dbx, "device-audio/shared-source")
        .await
        .unwrap()
        .0;
    assert_ne!(first, different);
}

#[tokio::test]
#[serial_test::serial]
async fn enqueue_does_not_reset_terminal_history() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let (source, _) =
        service::enqueue(&env.dbx, "message-media/terminal-source")
            .await
            .unwrap();
    env.dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update echo_gpu_transcription_queue set state='terminal',attempt_count=7,last_error='preserve' where source_id=$1",
        [source.into()],
    )).await.unwrap();
    service::enqueue(&env.dbx, "message-media/terminal-source")
        .await
        .unwrap();
    let task = echo_gpu_client::lookup(&env.dbx, source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.0.state, "terminal");
    assert_eq!(task.0.attempt_count, 7);
    assert_eq!(task.0.last_error.as_deref(), Some("preserve"));
}
