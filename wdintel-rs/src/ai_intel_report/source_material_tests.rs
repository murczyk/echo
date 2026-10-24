use super::load_source_materials;
use crate::entities::{signal_message, signal_message_media, system_settings};
use crate::functest::tests::{cleanup_locked, mk_signal_message};
use chrono::{Duration, Utc};
use sea_orm::*;
use uuid::Uuid;

async fn transcription(
    db: &DatabaseConnection,
    key: &str,
    state: &str,
    text: &str,
) -> Uuid {
    let (source, _) = crate::transcription::service::enqueue(db, key)
        .await
        .unwrap();
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update echo_gpu_transcription_queue set state=$2, transcribed_value=$3 where source_id=$1",
        [source.into(), state.into(), text.into()],
    ))
    .await
    .unwrap();
    source
}

// #3646: reference-backed audio supplies report text without device storage access.
#[tokio::test]
#[serial_test::serial]
async fn source_materials_include_only_completed_transcriptions_of_this_message(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::DevicesSectionEnabled,
            sea_query::Expr::value(false),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    let source = mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            body: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let unrelated = mk_signal_message(&env.dbx, Default::default())
        .await
        .unwrap();
    for (message, state, text) in [
        (source.id, "completed", "Виявлено рух техніки"),
        (source.id, "queued", "Неготовий результат"),
        (unrelated.id, "completed", "Текст іншого повідомлення"),
    ] {
        let audio_id = Uuid::new_v4();
        let transcription_source = transcription(
            &env.dbx,
            &format!("device-audio/{audio_id}"),
            state,
            text,
        )
        .await;
        crate::entities::signal_message_audio_ref::ActiveModel {
            id: Set(Uuid::new_v4()),
            signal_message_id: Set(message),
            audio_id: Set(audio_id),
            transcription_source_id: Set(transcription_source),
            created_at: Set(Utc::now().naive_utc()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
    }
    assert_eq!(
        load_source_materials(&env.dbx, &source).await.unwrap(),
        ["Розшифровка аудіо:\nВиявлено рух техніки"]
    );

    let media_id = Uuid::new_v4();
    let storage_key = format!("report-audio/{media_id}");
    signal_message_media::ActiveModel {
        id: Set(media_id),
        signal_message_id: Set(source.id),
        content_type: Set("audio/wav".into()),
        size_bytes: Set(100),
        created_at: Set(Utc::now().naive_utc() - Duration::days(1)),
        is_encrypted: Set(true),
        storage_key: Set(Some(storage_key.clone())),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    transcription(
        &env.dbx,
        &format!("message-media/{storage_key}"),
        "completed",
        "Звичайне аудіовкладення",
    )
    .await;
    let mut source = source.into_active_model();
    source.body = Set(Some("Текст повідомлення".into()));
    let source = source.update(&env.dbx).await.unwrap();
    assert_eq!(
        load_source_materials(&env.dbx, &source).await.unwrap(),
        [
            "Текст повідомлення:\nТекст повідомлення",
            "Розшифровка аудіо:\nЗвичайне аудіовкладення",
            "Розшифровка аудіо:\nВиявлено рух техніки",
        ]
    );
}
