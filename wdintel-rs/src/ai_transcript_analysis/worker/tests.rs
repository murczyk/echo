use super::*;
use crate::entities::{ai_engine, sigint_important, signal_message_media};
use crate::functest::tests::{
    cleanup_locked, find_test_login, find_test_signal_group,
    mk_sigint_inbox_item,
};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
use serial_test::serial;

fn file_database(env: &Env) -> &DatabaseConnection {
    env.file_registry_db().unwrap().connection()
}

async fn message(env: &Env) -> i64 {
    let group = find_test_signal_group(&env.dbx).await.unwrap();
    settings::set_group(&env.dbx, &group.master_key, Some(true))
        .await
        .unwrap();
    let message = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .unwrap();
    execute(&env.dbx, "insert into signal_message_group(signal_message_id,group_master_key) values($1,$2)",vec![message.id.into(),group.master_key.into()]).await.unwrap();
    message.id
}

async fn engine(env: &Env) -> ai_engine::Model {
    let now = chrono::Utc::now().naive_utc();
    let engine = ai_engine::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(Uuid::now_v7().to_string()),
        url: Set("http://localhost".into()),
        model_name: Set("fixture".into()),
        enabled: Set(true),
        callsign_enabled: Set(false),
        ocr_enabled: Set(false),
        ocr_request_profile: Set("openai_vision".into()),
        token: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    execute(&env.dbx, "update ai_transcript_analysis_settings set worker_enabled=true,worker_ai_engine_id=$1,revision=gen_random_uuid()",vec![engine.id.into()]).await.unwrap();
    engine
}

async fn media(
    env: &Env,
    message: i64,
    text: Option<&str>,
) -> signal_message_media::Model {
    let media = signal_message_media::ActiveModel {
        id: Set(Uuid::now_v7()),
        signal_message_id: Set(message),
        content_type: Set("audio/ogg".into()),
        size_bytes: Set(100),
        is_encrypted: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let source = crate::transcription::service::register(
        &env.dbx,
        &crate::transcriber::media_queue::source_key(&media),
    )
    .await
    .unwrap();
    echo_gpu_client::enqueue(&env.dbx, source).await.unwrap();
    if let Some(text) = text {
        execute(&env.dbx, "update echo_gpu_transcription_queue set state='completed',transcribed_value=$2,finished_at=now() at time zone 'utc' where source_id=$1",vec![source.into(),text.into()]).await.unwrap();
    }
    media
}

async fn oversized_media(
    env: &Env,
    message: i64,
) -> signal_message_media::Model {
    signal_message_media::ActiveModel {
        id: Set(Uuid::now_v7()),
        signal_message_id: Set(message),
        content_type: Set("audio/ogg".into()),
        size_bytes: Set(ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES + 1),
        is_encrypted: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap()
}

// https://github.com/echoua/echo/issues/3646
#[tokio::test]
#[serial]
async fn admission_skips_history_and_claims_once_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let group = find_test_signal_group(&env.dbx).await.unwrap();
    settings::set_group(&env.dbx, &group.master_key, Some(true))
        .await
        .unwrap();
    assert!(eligible(&env.dbx, message).await.unwrap());
    enqueue(&env.dbx, message).await.unwrap();
    assert!(claim(&env.dbx).await.unwrap().is_some());
    assert!(claim(&env.dbx).await.unwrap().is_none());
    execute(&env.dbx,"update signal_message set created_at=created_at-interval '1 day' where id=$1",vec![message.into()]).await.unwrap();
    assert!(!eligible(&env.dbx, message).await.unwrap());
}

#[tokio::test]
#[serial]
async fn queue_pages_preserve_job_details_without_duplicates_3646() {
    use crate::ai_transcript_analysis::{queue, types::AiTranscriptQueueReq};

    let (env, _guard) = cleanup_locked().await.unwrap();
    let group = find_test_signal_group(&env.dbx).await.unwrap();
    let mut ids = Vec::new();
    for _ in 0..=AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE {
        let message = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        execute(
            &env.dbx,
            r#"insert into ai_transcript_analysis_job(message_id) values($1)"#,
            vec![message.id.into()],
        )
        .await
        .unwrap();
        ids.push(message.id);
    }
    let latest = *ids.last().unwrap();
    execute(&env.dbx, r#"insert into signal_message_group(signal_message_id,group_master_key) values($1,$2)"#, vec![latest.into(),group.master_key.clone().into()]).await.unwrap();
    execute(
        &env.dbx,
        r#"update signal_group set name=null where master_key=$1"#,
        vec![group.master_key.clone().into()],
    )
    .await
    .unwrap();
    execute(&env.dbx, r#"update ai_transcript_analysis_job set state='retry',attempts=3,last_error='Помилка моделі' where message_id=$1"#, vec![latest.into()]).await.unwrap();
    execute(&env.dbx, r#"update ai_transcript_analysis_job set state='completed',important=false,manual_suppressed=true,completed_at=now() at time zone 'utc' where message_id=$1"#, vec![ids[0].into()]).await.unwrap();

    let page = queue::list(
        &env.dbx,
        AiTranscriptQueueReq {
            before_message_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE);
    let item = &page.items[0];
    assert_eq!(item.message_id, latest);
    assert_eq!(item.groups, vec![group.master_key]);
    assert_eq!(item.state, "retry");
    assert_eq!(item.attempts, 3);
    assert_eq!(item.last_error.as_deref(), Some("Помилка моделі"));
    assert!(item.created_at > 0 && item.next_attempt_at > 0);
    let incoming = mk_sigint_inbox_item(&env.dbx, Default::default())
        .await
        .unwrap();
    execute(
        &env.dbx,
        r#"insert into ai_transcript_analysis_job(message_id) values($1)"#,
        vec![incoming.id.into()],
    )
    .await
    .unwrap();
    let next = queue::list(
        &env.dbx,
        AiTranscriptQueueReq {
            before_message_id: page.next_before_message_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(next.items.len(), 1);
    assert!(next.next_before_message_id.is_none());
    let item = &next.items[0];
    assert_eq!(item.message_id, ids[0]);
    assert!(item.groups.is_empty());
    assert_eq!(item.important, Some(false));
    assert!(item.manual_suppressed && item.completed_at.is_some());
    assert!(!page
        .items
        .iter()
        .any(|previous| previous.message_id == item.message_id));
}

#[tokio::test]
#[serial]
async fn waits_for_all_automatic_transcripts_and_deduplicates_sources_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    crate::entities::system_settings::ActiveModel {
        enable_audio_transcription: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let message = message(&env).await;
    media(&env, message, Some("Перша транскрипція")).await;
    let pending = media(&env, message, None).await;
    signal_message_media::ActiveModel {
        id: Set(pending.id),
        size_bytes: Set(ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    oversized_media(&env, message).await;
    let reconciled = crate::transcriber::media_queue::reconcile_message(
        &env.dbx,
        message,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(reconciled.skipped_oversized, 1);
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    assert!(!snapshot.ready);
    assert_eq!(snapshot.transcript, "Перша транскрипція");
    let source = crate::transcription::service::source_id(
        &env.dbx,
        &crate::transcriber::media_queue::source_key(&pending),
    )
    .await
    .unwrap()
    .unwrap();
    execute(&env.dbx,"update echo_gpu_transcription_queue set state='completed',transcribed_value='Друга транскрипція' where source_id=$1",vec![source.into()]).await.unwrap();
    execute(&env.dbx,"insert into signal_message_audio_ref(id,signal_message_id,audio_id,transcription_source_id) values($1,$2,$3,$4)",vec![Uuid::now_v7().into(),message.into(),Uuid::now_v7().into(),source.into()]).await.unwrap();
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    assert!(snapshot.ready);
    assert_eq!(
        snapshot.transcript,
        "Перша транскрипція\n\nДруга транскрипція"
    );
}

#[tokio::test]
#[serial]
async fn oversized_only_audio_is_skipped_without_spending_attempts_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    crate::entities::system_settings::ActiveModel {
        enable_audio_transcription: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let message = message(&env).await;
    engine(&env).await;
    let oversized = oversized_media(&env, message).await;
    let reconciled = crate::transcriber::media_queue::reconcile_message(
        &env.dbx,
        message,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(reconciled.skipped_oversized, 1);
    assert!(crate::transcription::service::source_id(
        &env.dbx,
        &crate::transcriber::media_queue::source_key(&oversized),
    )
    .await
    .unwrap()
    .is_none());
    assert!(step(&env).await.unwrap());
    assert!(!step(&env).await.unwrap());
    #[derive(FromQueryResult)]
    struct SkippedJob {
        state: String,
        attempts: i32,
    }
    let job = rows::<SkippedJob, _>(&env.dbx, "select state,attempts from ai_transcript_analysis_job where message_id=$1", vec![message.into()]).await.unwrap().pop().unwrap();
    assert_eq!(job.state, "skipped");
    assert_eq!(job.attempts, 0);
}

#[tokio::test]
#[serial]
async fn oversized_device_references_do_not_block_ready_transcripts_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message_id = message(&env).await;
    media(&env, message_id, Some("Готова транскрипція вкладення")).await;
    let files = file_database(&env).begin().await.unwrap();
    files
        .execute_unprepared(
            r#"
        create temp table device_audio (
            id uuid primary key,
            source_size_bytes bigint not null
        ) on commit drop;
        set local search_path=pg_temp,public;
    "#,
        )
        .await
        .unwrap();
    let mut reference_ids = Vec::new();
    let mut sources = Vec::new();
    for size in [
        ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES + 1,
        ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES,
    ] {
        let audio = Uuid::now_v7();
        let reference = Uuid::now_v7();
        let source = crate::transcription::service::register(
            &env.dbx,
            &format!("device-audio/{audio}"),
        )
        .await
        .unwrap();
        execute(
            &files,
            "insert into device_audio(id,source_size_bytes) values($1,$2)",
            vec![audio.into(), size.into()],
        )
        .await
        .unwrap();
        execute(&env.dbx, "insert into signal_message_audio_ref(id,signal_message_id,audio_id,transcription_source_id) values($1,$2,$3,$4)", vec![reference.into(),message_id.into(),audio.into(),source.into()]).await.unwrap();
        reference_ids.push(reference);
        sources.push(source);
    }
    let snapshot = input(&env.dbx, Some(&files), message_id, false)
        .await
        .unwrap();
    assert!(!snapshot.ready);
    echo_gpu_client::enqueue(&env.dbx, sources[1])
        .await
        .unwrap();
    execute(&env.dbx, "update echo_gpu_transcription_queue set state='completed',transcribed_value='Готова транскрипція пристрою' where source_id=$1", vec![sources[1].into()]).await.unwrap();
    let snapshot = input(&env.dbx, Some(&files), message_id, false)
        .await
        .unwrap();
    assert!(snapshot.ready);
    assert_eq!(
        snapshot.transcript,
        "Готова транскрипція вкладення\n\nГотова транскрипція пристрою"
    );
    let transaction = env.dbx.begin().await.unwrap();
    let locked = input(&transaction, Some(&files), message_id, true)
        .await
        .unwrap();
    assert_eq!(locked, snapshot);
    transaction.rollback().await.unwrap();
    let oversized_only = message(&env).await;
    execute(
        &env.dbx,
        "update signal_message_audio_ref set signal_message_id=$2 where id=$1",
        vec![reference_ids[0].into(), oversized_only.into()],
    )
    .await
    .unwrap();
    let snapshot = input(&env.dbx, Some(&files), oversized_only, false)
        .await
        .unwrap();
    assert!(snapshot.ready);
    assert!(snapshot.transcript.is_empty());
    files.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn completion_is_once_and_manual_removal_preserves_other_marks_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let engine = engine(&env).await;
    let settings = settings::load(&env.dbx).await.unwrap();
    media(&env, message, Some("Автоматичний текст")).await;
    enqueue(&env.dbx, message).await.unwrap();
    let job = claim(&env.dbx).await.unwrap().unwrap();
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let human = sigint_important::ActiveModel {
        login_id: Set(Some(login.id)),
        signal_message_id: Set(message),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    assert!(complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok(answer(true))
    )
    .await
    .unwrap());
    assert!(!complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok(answer(true))
    )
    .await
    .unwrap());
    suppress(&env.dbx, message).await.unwrap();
    enqueue(&env.dbx, message).await.unwrap();
    assert!(claim(&env.dbx).await.unwrap().is_none());
    assert!(
        !sigint_important::Entity::find_by_id(human.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .deleted
    );
}

#[tokio::test]
#[serial]
async fn stale_settings_and_suppression_fence_inflight_results_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let engine = engine(&env).await;
    let settings = settings::load(&env.dbx).await.unwrap();
    media(&env, message, Some("Текст")).await;
    enqueue(&env.dbx, message).await.unwrap();
    let job = claim(&env.dbx).await.unwrap().unwrap();
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    settings::save_prompt(&env.dbx, "Інший промпт")
        .await
        .unwrap();
    assert!(!complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok(answer(true))
    )
    .await
    .unwrap());
    execute(&env.dbx,"update ai_transcript_analysis_job set next_attempt_at=now() at time zone 'utc' where message_id=$1",vec![message.into()]).await.unwrap();
    let job = claim(&env.dbx).await.unwrap().unwrap();
    suppress(&env.dbx, message).await.unwrap();
    assert!(!complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok(answer(true))
    )
    .await
    .unwrap());
}

#[tokio::test]
#[serial]
async fn lease_recovery_fences_old_owner_and_failures_are_bounded_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    enqueue(&env.dbx, message).await.unwrap();
    let first = claim(&env.dbx).await.unwrap().unwrap();
    execute(&env.dbx,"update ai_transcript_analysis_job set lease_until=now() at time zone 'utc'-interval '1 second' where message_id=$1",vec![message.into()]).await.unwrap();
    let replacement = claim(&env.dbx).await.unwrap().unwrap();
    assert_ne!(first.lease, replacement.lease);
    release(&env.dbx, &first, "completed", 0).await.unwrap();
    fail(
        &env.dbx,
        &Job {
            attempts: AI_TRANSCRIPT_ANALYSIS_MAX_ATTEMPTS,
            ..replacement
        },
        "provider failure",
    )
    .await
    .unwrap();
    assert!(claim(&env.dbx).await.unwrap().is_none());
}

fn answer(important: bool) -> (inference::Decision, String) {
    let text = serde_json::json!({
        "important": important,
        "description": "Тестовий опис",
        "quotes": []
    })
    .to_string();
    (inference::parse_response(&text).unwrap(), text)
}

#[test]
fn structured_model_response_requires_typed_fields_and_verbatim_quotes_3646() {
    let response = r#"{"important":true,"description":"Короткий опис","quotes":["Точний уривок"]}"#;
    let parsed = inference::parse_response(response).unwrap();
    assert!(parsed.important);
    assert_eq!(parsed.description, "Короткий опис");
    assert!(
        inference::validate_quotes(&parsed, "Точний уривок транскрипції")
            .is_ok()
    );
    assert!(inference::validate_quotes(&parsed, "Інший текст").is_err());
    assert!(
        !inference::parse_response(
            r#"{"important":false,"description":"","quotes":[]}"#
        )
        .unwrap()
        .important
    );
    for response in [
        "{}",
        r#"{"important":true}"#,
        r#"{"important":null,"description":"","quotes":[]}"#,
        r#"{"important":"true","description":"","quotes":[]}"#,
        r#"{"important":true,"description":null,"quotes":[]}"#,
        r#"{"important":true,"description":"","quotes":"text"}"#,
        r#"{"important":true,"description":"","quotes":[1]}"#,
        r#"{"important":true,"description":"","quotes":[""]}"#,
        r#"{"important":true,"description":"","quotes":[],"reason":"x"}"#,
        "```json\n{\"important\":true,\"description\":\"\",\"quotes\":[]}\n```",
    ] {
        assert!(inference::parse_response(response).is_err(), "{response}");
    }
}

#[tokio::test]
#[serial]
async fn worker_uses_structured_automatic_text_and_does_not_run_twice_3646() {
    use actix_web::{web, App, HttpResponse, HttpServer};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let engine = engine(&env).await;
    let first_quote = "Оператор: Файл сохранён?\nТехник: Да, файл сохранён.";
    let second_quote =
        "Оператор: А резервная копия?\nТехник: Резервная копия готова.";
    let transcript = "Оператор: Файл сохранён?\nТехник: Да, файл сохранён.\nОператор: А резервная копия?\nТехник: Резервная копия готова.";
    let description = "Файл збережено, резервна копія готова.";
    media(&env, message, Some(transcript)).await;
    execute(&env.dbx, r#"update signal_message set body='Початковий текст оператора' where id=$1"#, vec![message.into()]).await.unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let received = requests.clone();
    let server = HttpServer::new(move || {
        let received = received.clone();
        App::new().default_service(web::post().to(move |body: web::Json<serde_json::Value>| {
            let received = received.clone();
            async move {
                received.fetch_add(1, Ordering::SeqCst);
                assert_eq!(body["response_format"]["type"], "json_schema");
                assert_eq!(body["response_format"]["json_schema"]["strict"], true);
                assert_eq!(body["response_format"]["json_schema"]["schema"]["required"], serde_json::json!(["important", "description", "quotes"]));
                assert_eq!(body["messages"][1]["content"], transcript);
                HttpResponse::Ok().json(serde_json::json!({"choices":[{"message":{"content":serde_json::json!({"important":true,"description":description,"quotes":[first_quote,second_quote]}).to_string()},"finish_reason":"stop"}]}))
            }
        }))
    }).bind(("127.0.0.1", 0)).unwrap();
    let address = server.addrs()[0];
    let server = server.run();
    let handle = server.handle();
    tokio::spawn(server);
    execute(
        &env.dbx,
        "update ai_engine set url=$2 where id=$1",
        vec![engine.id.into(), format!("http://{address}/v1").into()],
    )
    .await
    .unwrap();
    enqueue(&env.dbx, message).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(10), step(&env))
        .await
        .unwrap()
        .unwrap());
    assert!(!step(&env).await.unwrap());
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    #[derive(FromQueryResult)]
    struct ResultRow {
        important: bool,
        transcript: String,
    }
    let result = rows::<ResultRow,_>(&env.dbx, "select important,transcript from ai_transcript_analysis_job where message_id=$1 and state='completed'", vec![message.into()]).await.unwrap().pop().unwrap();
    assert!(result.important);
    assert_eq!(result.transcript, transcript);
    #[derive(FromQueryResult)]
    struct MessageText {
        body: String,
        no_headers_body: String,
        searchable: bool,
    }
    let text = rows::<MessageText,_>(&env.dbx, r#"select message.body,item.body_noheader->>'body' as no_headers_body,search.search_tsv @@ plainto_tsquery('russian','резервна') as searchable from signal_message message join sigint_inbox_item item on item.id=message.id join sigint_search search on search.id=message.id where message.id=$1"#, vec![message.into()]).await.unwrap().pop().unwrap();
    assert_eq!(text.body, format!("Початковий текст оператора\n\n{description}\n\n{first_quote}\n\n{second_quote}"));
    assert!(text.no_headers_body.contains(description));
    assert!(text.searchable);
    handle.stop(false).await;
}

#[tokio::test]
#[serial]
async fn negative_decision_preserves_message_and_completes_once_3646() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let engine = engine(&env).await;
    let settings = settings::load(&env.dbx).await.unwrap();
    media(&env, message, Some("Тестовий уривок")).await;
    enqueue(&env.dbx, message).await.unwrap();
    let job = claim(&env.dbx).await.unwrap().unwrap();
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    execute(&env.dbx, r#"update signal_message set body='Виправлений оператором текст' where id=$1"#, vec![message.into()]).await.unwrap();
    #[derive(Debug, PartialEq, FromQueryResult)]
    struct MessageText {
        body: String,
        no_headers_body: Option<serde_json::Value>,
        search_tsv: Option<String>,
    }
    let query = r#"select message.body,item.body_noheader,search.search_tsv::text from signal_message message join sigint_inbox_item item on item.id=message.id left join sigint_search search on search.id=message.id where message.id=$1"#;
    let before = rows::<MessageText, _>(&env.dbx, query, vec![message.into()])
        .await
        .unwrap();
    let response = serde_json::json!({
        "important": false,
        "description": "Тестовий опис",
        "quotes": ["Тестовий уривок"]
    })
    .to_string();
    assert!(!complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok((
            inference::parse_response(&response).unwrap(),
            response.clone()
        ))
    )
    .await
    .unwrap());
    assert!(!complete(
        &env.dbx,
        Some(file_database(&env)),
        &job,
        &settings,
        &engine,
        &snapshot,
        Ok((
            inference::parse_response(&response).unwrap(),
            response.clone()
        ))
    )
    .await
    .unwrap());
    let after = rows::<MessageText, _>(&env.dbx, query, vec![message.into()])
        .await
        .unwrap();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].body, "Виправлений оператором текст");
    assert_eq!(after, before);
    #[derive(FromQueryResult)]
    struct CompletedDecision {
        important: bool,
        response_text: String,
    }
    let completed = rows::<CompletedDecision, _>(&env.dbx, "select important,response_text from ai_transcript_analysis_job where message_id=$1 and state='completed'", vec![message.into()]).await.unwrap().pop().unwrap();
    assert!(!completed.important);
    assert_eq!(completed.response_text, response);
    assert_eq!(
        sigint_important::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
#[serial]
async fn engine_deletion_does_not_deadlock_or_apply_an_inflight_decision_3646()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let message = message(&env).await;
    let engine = engine(&env).await;
    let engine_id = engine.id;
    let settings = settings::load(&env.dbx).await.unwrap();
    media(&env, message, Some("Текст")).await;
    enqueue(&env.dbx, message).await.unwrap();
    let job = claim(&env.dbx).await.unwrap().unwrap();
    let snapshot = input(&env.dbx, Some(file_database(&env)), message, false)
        .await
        .unwrap();
    let transaction = env.dbx.begin().await.unwrap();
    transaction
        .query_all_raw(sql(
            "select id from ai_engine where id=$1 for update",
            vec![engine_id.into()],
        ))
        .await
        .unwrap();
    #[derive(FromQueryResult)]
    struct Backend {
        pid: i32,
    }
    let backend = rows::<Backend, _>(
        &transaction,
        "select pg_backend_pid() as pid",
        vec![],
    )
    .await
    .unwrap()
    .pop()
    .unwrap()
    .pid;
    let db = env.dbx.clone();
    let files = file_database(&env).clone();
    let completion = tokio::spawn(async move {
        complete(
            &db,
            Some(&files),
            &job,
            &settings,
            &engine,
            &snapshot,
            Ok(answer(true)),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked = rows::<Allowed,_>(&env.dbx,"select exists(select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))) as allowed",vec![backend.into()]).await.unwrap().pop().unwrap().allowed;
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let deletion = tokio::time::timeout(
        Duration::from_millis(500),
        execute(
            &transaction,
            "delete from ai_engine where id=$1",
            vec![engine_id.into()],
        ),
    )
    .await;
    let deleted = matches!(deletion, Ok(Ok(1)));
    if deleted {
        transaction.commit().await.unwrap();
    } else {
        transaction.rollback().await.unwrap();
    }
    let applied = tokio::time::timeout(Duration::from_secs(5), completion)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        deleted,
        "Engine deletion waited for an inverted settings lock"
    );
    assert!(!applied);
}
