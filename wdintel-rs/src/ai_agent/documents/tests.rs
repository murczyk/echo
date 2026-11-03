use super::revisions::{self, save_stored, StoredFile};
use super::types::*;
use super::validate;
use crate::entities::{
    ai_agent_conversation, ai_agent_document, ai_agent_request,
    ai_agent_upload, ai_engine, login,
};
use crate::error::AppError;
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    PaginatorTrait, QueryFilter, TransactionTrait,
};
use serde_json::json;
use serial_test::serial;
use std::io::{Cursor, Write};
use uuid::Uuid;

const MAIN_PART: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

fn package(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn content_types(main_type: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="{main_type}"/></Types>"#
    )
}

#[test]
fn issue_3985_only_plain_word_documents_are_stored() {
    let mut docx = Cursor::new(Vec::new());
    docx_rs::Docx::new()
        .add_paragraph(
            docx_rs::Paragraph::new()
                .add_run(docx_rs::Run::new().add_text("Звіт")),
        )
        .build()
        .pack(&mut docx)
        .unwrap();
    assert!(validate::validate_docx(docx.get_ref()).is_ok());

    let main = content_types(MAIN_PART);
    let body = ("word/document.xml", "<w:document/>");
    assert!(validate::validate_docx(b"not a zip").is_err());
    assert!(validate::validate_docx(&package(&[(
        "[Content_Types].xml",
        &main
    )]))
    .is_err());
    assert!(validate::validate_docx(&package(&[
        ("[Content_Types].xml", &main),
        body,
        ("word/vbaProject.bin", "macro"),
    ]))
    .is_err());
    let macros =
        content_types("application/vnd.ms-word.document.macroEnabled.main+xml");
    assert!(validate::validate_docx(&package(&[
        ("[Content_Types].xml", &macros),
        body,
    ]))
    .is_err());
}

#[test]
fn issue_3985_download_names_are_plain_docx_names() {
    assert_eq!(
        validate::file_name(Some("../../etc/passwd"), "Звіт"),
        "passwd.docx"
    );
    assert_eq!(
        validate::file_name(Some("Звіт: жовтень.doc"), "Звіт"),
        "Звіт жовтень.docx"
    );
    assert_eq!(
        validate::file_name(None, "Звіт за 01.11"),
        "Звіт за 01.11.docx"
    );
}

struct Fixture {
    human: login::Model,
    conversation: ai_agent_conversation::Model,
    ai_engine: ai_engine::Model,
}

impl Fixture {
    async fn new(env: &Env) -> Self {
        let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
        let human = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ai_engine = ai_engine::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(format!("document-test-{}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:8000/v1".to_string()),
            model_name: Set("test".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let conversation = ai_agent_conversation::ActiveModel {
            id: Set(Uuid::now_v7()),
            human_login_id: Set(human.id),
            ai_engine_id: Set(ai_engine.id),
            title: Set("Documents".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        Self {
            human,
            conversation,
            ai_engine,
        }
    }

    async fn request(&self, env: &Env) -> ai_agent_request::Model {
        let now = Utc::now().naive_utc();
        ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            conversation_id: Set(self.conversation.id),
            human_login_id: Set(self.human.id),
            ai_engine_id: Set(self.ai_engine.id),
            prompt: Set("Заповни звіт".to_string()),
            state: Set("running".to_string()),
            queued_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }
}

fn stored() -> StoredFile {
    StoredFile {
        storage_key: format!("test/{}", Uuid::now_v7()),
        sha256: "0".repeat(64),
        size_bytes: 10,
    }
}

fn new_document(key: Uuid) -> AgentDocumentSaveQuery {
    AgentDocumentSaveQuery {
        idempotency_key: key.to_string(),
        title: Some("Звіт".to_string()),
        ..Default::default()
    }
}

fn new_version(document_id: &str, expected: i32) -> AgentDocumentSaveQuery {
    AgentDocumentSaveQuery {
        idempotency_key: Uuid::now_v7().to_string(),
        document_id: Some(document_id.to_string()),
        expected_revision: Some(expected),
        summary: Some("Оновив таблицю".to_string()),
        ..Default::default()
    }
}

fn current_revision(error: &AppError) -> Option<i64> {
    match error {
        AppError::ConflictJson { body } => body["currentRevision"].as_i64(),
        _ => None,
    }
}

#[actix_web::test]
#[serial]
async fn issue_3985_agent_saves_versions_inside_its_conversation() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let request = fixture.request(&env).await;
    let key = Uuid::now_v7();
    let created = save_stored(&env, &request, &new_document(key), stored())
        .await
        .unwrap();
    assert_eq!(
        (
            created.revision,
            created.created,
            created.file_name.as_str()
        ),
        (1, true, "Звіт.docx")
    );
    let replayed = save_stored(&env, &request, &new_document(key), stored())
        .await
        .unwrap();
    assert_eq!(replayed, created);

    let renamed = AgentDocumentSaveQuery {
        title: Some("Звіт за жовтень".to_string()),
        ..new_version(&created.document_id, 1)
    };
    let second = save_stored(&env, &request, &renamed, stored())
        .await
        .unwrap();
    assert_eq!(
        (second.revision, second.created, second.file_name.as_str()),
        (2, false, "Звіт за жовтень.docx")
    );
    let stale = save_stored(
        &env,
        &request,
        &new_version(&created.document_id, 1),
        stored(),
    )
    .await
    .unwrap_err();
    assert_eq!(current_revision(&stale), Some(2));

    let stranger = Fixture::new(&env).await;
    let foreign = stranger.request(&env).await;
    let denied = save_stored(
        &env,
        &foreign,
        &new_version(&created.document_id, 2),
        stored(),
    )
    .await;
    assert!(matches!(denied, Err(AppError::NotFound)));

    let announced = json!({"documentId": created.document_id, "revision": 2});
    assert!(
        super::artifact_event_payload(&env.dbx, foreign.id, &announced)
            .await
            .is_err()
    );
    let payload =
        super::artifact_event_payload(&env.dbx, request.id, &announced)
            .await
            .unwrap();
    assert_eq!(payload["document"]["revision"], 2);
    assert_eq!(payload["document"]["title"], "Звіт за жовтень");

    let target = AiAgentDocumentTarget {
        document_id: created.document_id.clone(),
        revision: 2,
    };
    let txn = env.dbx.begin().await.unwrap();
    let elsewhere = super::store_request_target(
        &txn,
        stranger.human.id,
        stranger.conversation.id,
        foreign.id,
        &target,
    )
    .await;
    assert!(elsewhere.is_err());
    drop(txn);
}

#[actix_web::test]
#[serial]
async fn issue_3985_a_retry_racing_its_first_save_stores_one_version() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let request = fixture.request(&env).await;
    let create = new_document(Uuid::now_v7());
    let (first, retry) = tokio::join!(
        save_stored(&env, &request, &create, stored()),
        save_stored(&env, &request, &create, stored()),
    );
    let created = first.unwrap();
    assert_eq!(retry.unwrap(), created);
    let update = new_version(&created.document_id, 1);
    let (first, retry) = tokio::join!(
        save_stored(&env, &request, &update, stored()),
        save_stored(&env, &request, &update, stored()),
    );
    let updated = first.unwrap();
    assert_eq!((retry.unwrap(), updated.revision), (updated.clone(), 2));
    let documents = ai_agent_document::Entity::find()
        .filter(
            ai_agent_document::Column::ConversationId
                .eq(fixture.conversation.id),
        )
        .count(&env.dbx)
        .await
        .unwrap();
    assert_eq!(documents, 1);
}

#[actix_web::test]
#[serial]
async fn issue_3985_restoring_a_version_branches_like_undo() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let request = fixture.request(&env).await;
    let created =
        save_stored(&env, &request, &new_document(Uuid::now_v7()), stored())
            .await
            .unwrap();
    save_stored(
        &env,
        &request,
        &new_version(&created.document_id, 1),
        stored(),
    )
    .await
    .unwrap();
    let document_id = Uuid::parse_str(&created.document_id).unwrap();
    let head = |expected_revision, revision| AiAgentDocumentHeadReq {
        document_id: created.document_id.clone(),
        expected_revision,
        revision,
    };

    let restored = revisions::set_head(&env, document_id, &head(2, 1))
        .await
        .unwrap();
    assert_eq!(
        (
            restored.document.head_revision,
            restored.undo_revision,
            restored.redo_revision
        ),
        (1, None, Some(2))
    );
    let stale = revisions::set_head(&env, document_id, &head(2, 2))
        .await
        .unwrap_err();
    assert_eq!(current_revision(&stale), Some(1));

    let branched = save_stored(
        &env,
        &request,
        &new_version(&created.document_id, 1),
        stored(),
    )
    .await
    .unwrap();
    assert_eq!(branched.revision, 3);
    let document = ai_agent_document::Entity::find_by_id(document_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let workspace = revisions::workspace(&env.dbx, &document).await.unwrap();
    assert_eq!(workspace.revisions[0].revision, 3);
    assert_eq!(workspace.revisions[0].parent_revision, Some(1));
    assert_eq!(workspace.undo_revision, Some(1));

    let undone = revisions::set_head(&env, document_id, &head(3, 1))
        .await
        .unwrap();
    assert_eq!(undone.redo_revision, Some(3));
}

async fn upload(
    env: &Env,
    human_login_id: Uuid,
    conversation_id: Option<Uuid>,
    file_name: &str,
) -> String {
    let now = Utc::now().naive_utc();
    ai_agent_upload::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human_login_id),
        conversation_id: Set(conversation_id),
        request_id: Set(None),
        file_name: Set(file_name.to_string()),
        extension: Set(file_name.rsplit('.').next().unwrap().to_string()),
        content_type: Set("application/octet-stream".to_string()),
        size_bytes: Set(10),
        sha256: Set("0".repeat(64)),
        storage_key: Set(format!("test/{}", Uuid::now_v7())),
        preview_key: Set(None),
        state: Set("ready".to_string()),
        extractor_job_id: Set(None),
        chunk_count: Set(1),
        text_chars: Set(10),
        warnings: Set(json!([])),
        last_error: Set(None),
        attempts: Set(0),
        lease: Set(None),
        lease_until: Set(None),
        next_attempt_at: Set(now),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&env.dbx)
    .await
    .unwrap()
    .id
    .to_string()
}

#[actix_web::test]
#[serial]
async fn issue_3985_report_requests_in_short_modes_get_time_to_build_the_document(
) {
    use crate::ai_agent::reasoning;
    use crate::ai_agent::types::AiAgentReasoningPreset as Preset;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let human = fixture.human.id;
    let conversation = Some(fixture.conversation.id);
    let detect =
        |conversation, prompt: &'static str, uploads: Vec<String>, open| {
            let env = env.clone();
            async move {
                super::is_document_request(
                    &env.dbx,
                    human,
                    conversation,
                    prompt,
                    &uploads,
                    open,
                )
                .await
                .unwrap()
            }
        };
    let template = upload(&env, human, None, "Звіт за вересень.docx").await;
    let order = upload(&env, human, None, "наказ.pdf").await;
    assert!(
        detect(None, "Зроби такий самий за жовтень", vec![template], false)
            .await
    );
    assert!(!detect(None, "Що в наказі?", vec![order], false).await);
    let stranger = Fixture::new(&env).await;
    let foreign = upload(&env, stranger.human.id, None, "чужий.docx").await;
    assert!(!detect(None, "Що тут?", vec![foreign], false).await);
    assert!(detect(conversation, "Додай колонку", vec![], true).await);

    // The template was attached in an earlier message of the conversation.
    assert!(
        !detect(conversation, "Використай документ як шаблон", vec![], false)
            .await
    );
    upload(&env, human, conversation, "Звіт про перехоплення.docx").await;
    assert!(
        detect(conversation, "Використай документ як шаблон", vec![], false)
            .await
    );
    assert!(!detect(conversation, "Хто такий САТУРН?", vec![], false).await);

    let engine = &fixture.ai_engine;
    let balanced =
        reasoning::resolve(&env.config, engine, Preset::Balanced, false);
    let document =
        reasoning::resolve(&env.config, engine, Preset::Balanced, true);
    // The test engine runs bounded research, which doubles the summary reserve.
    assert_eq!(
        (
            document.max_runtime_seconds,
            document.finalization_seconds,
            document.document_task
        ),
        (1800, 240, true)
    );
    assert_eq!(document.reasoning_effort, balanced.reasoning_effort);
    assert!(serde_json::to_value(&balanced)
        .unwrap()
        .get("documentTask")
        .is_none());
    let deep = reasoning::resolve(&env.config, engine, Preset::Deep, true);
    assert_eq!(
        (
            deep.max_runtime_seconds,
            deep.finalization_seconds,
            deep.document_task
        ),
        (14_400, 600, false)
    );
    let long = reasoning::limits(Some(&deep));
    let short = reasoning::limits(Some(&document));
    assert_eq!(
        (
            long.api_calls,
            long.provider_calls,
            long.runner_events,
            long.provider_turn_timeout_sec
        ),
        (1024, 2048, 50_000, Some(1800))
    );
    assert_eq!(
        (
            short.api_calls,
            short.provider_calls,
            short.provider_turn_timeout_sec
        ),
        (128, 256, None)
    );
}
