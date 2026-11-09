use super::*;
use crate::entities::{
    ai_agent_conversation, ai_agent_request, ai_agent_upload_chunk, ai_engine,
    login,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, IntoActiveModel, TransactionTrait,
};
use serial_test::serial;

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
            name: Set(format!("upload-test-{}", Uuid::now_v7())),
            url: Set("http://127.0.0.1:8000/v1".to_string()),
            model_name: Set("test".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let conversation = conversation(env, human.id, ai_engine.id).await;
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
            prompt: Set("Що в документі?".to_string()),
            state: Set("queued".to_string()),
            queued_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap()
    }
}

async fn conversation(
    env: &Env,
    human_login_id: Uuid,
    ai_engine_id: Uuid,
) -> ai_agent_conversation::Model {
    ai_agent_conversation::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human_login_id),
        ai_engine_id: Set(ai_engine_id),
        title: Set("Uploads".to_string()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap()
}

async fn draft(
    env: &Env,
    human_login_id: Uuid,
    conversation_id: Option<Uuid>,
    file_name: &str,
) -> ai_agent_upload::Model {
    let now = Utc::now().naive_utc();
    ai_agent_upload::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human_login_id),
        conversation_id: Set(conversation_id),
        request_id: Set(None),
        file_name: Set(file_name.to_string()),
        extension: Set(formats::extension(file_name)),
        content_type: Set("text/plain".to_string()),
        size_bytes: Set(10),
        sha256: Set("0".repeat(64)),
        storage_key: Set(format!("test/{}", Uuid::now_v7())),
        preview_key: Set(None),
        state: Set("uploaded".to_string()),
        extractor_job_id: Set(None),
        chunk_count: Set(0),
        text_chars: Set(0),
        warnings: Set(serde_json::json!([])),
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
}

async fn bind(
    env: &Env,
    fixture: &Fixture,
    request_id: Uuid,
    uploads: &[&ai_agent_upload::Model],
) -> Result<(), AppError> {
    let txn = env.dbx.begin().await.unwrap();
    let ids = uploads
        .iter()
        .map(|upload| upload.id.to_string())
        .collect::<Vec<_>>();
    let result = bind_to_request(
        &txn,
        fixture.human.id,
        fixture.conversation.id,
        request_id,
        &ids,
    )
    .await;
    if result.is_ok() {
        txn.commit().await.unwrap();
    }
    result
}

async fn mark_ready(env: &Env, upload: &ai_agent_upload::Model, text: &str) {
    ai_agent_upload_chunk::ActiveModel {
        id: Set(Uuid::now_v7()),
        upload_id: Set(upload.id),
        ordinal: Set(0),
        member: Set(upload.file_name.clone()),
        locator: Set("рядки 1–1".to_string()),
        text: Set(text.to_string()),
        markdown: Set(text.to_string()),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let mut upload = ai_agent_upload::Entity::find_by_id(upload.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    upload.state = Set("ready".to_string());
    upload.chunk_count = Set(1);
    upload.text_chars = Set(text.chars().count() as i64);
    upload.update(&env.dbx).await.unwrap();
}

#[actix_web::test]
#[serial]
async fn issue_3962_binding_accepts_only_own_unsent_drafts() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let first = fixture.request(&env).await;
    let own = draft(&env, fixture.human.id, None, "notes.txt").await;
    let stale_snapshot = own.clone();
    bind(&env, &fixture, first.id, &[&own]).await.unwrap();
    assert!(!store::delete_draft(&env, &stale_snapshot).await.unwrap());
    let own = ai_agent_upload::Entity::find_by_id(own.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(own.request_id, Some(first.id));
    assert_eq!(own.conversation_id, Some(fixture.conversation.id));

    let second = fixture.request(&env).await;
    assert!(bind(&env, &fixture, second.id, &[&own]).await.is_err());

    let stranger = Fixture::new(&env).await;
    let foreign = draft(&env, stranger.human.id, None, "foreign.txt").await;
    assert!(bind(&env, &fixture, second.id, &[&foreign]).await.is_err());

    let elsewhere = draft(
        &env,
        fixture.human.id,
        Some(
            conversation(&env, fixture.human.id, fixture.ai_engine.id)
                .await
                .id,
        ),
        "elsewhere.txt",
    )
    .await;
    assert!(bind(&env, &fixture, second.id, &[&elsewhere])
        .await
        .is_err());
}

#[actix_web::test]
#[serial]
async fn issue_3962_runner_context_inlines_visible_documents_only() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let earlier = fixture.request(&env).await;
    let report = draft(&env, fixture.human.id, None, "report.md").await;
    bind(&env, &fixture, earlier.id, &[&report]).await.unwrap();
    mark_ready(&env, &report, "Колона техніки біля мосту").await;

    let current = fixture.request(&env).await;
    let pending = draft(&env, fixture.human.id, None, "scan.pdf").await;
    bind(&env, &fixture, current.id, &[&pending]).await.unwrap();
    assert_eq!(context::pending_count(&env, current.id).await.unwrap(), 1);

    let later = fixture.request(&env).await;
    let future = draft(&env, fixture.human.id, None, "later.txt").await;
    bind(&env, &fixture, later.id, &[&future]).await.unwrap();

    let runner = context::runner_uploads(&env, &current, false)
        .await
        .unwrap();
    let names = runner
        .uploads
        .iter()
        .map(|upload| upload["fileName"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["report.md", "scan.pdf"]);
    assert!(runner.uploads[0]["inlineText"]
        .as_str()
        .unwrap()
        .contains("[report.md — рядки 1–1]\nКолона техніки"));
    assert_eq!(runner.uploads[0]["currentMessage"], false);
    assert!(runner.uploads[1].get("inlineText").is_none());
    assert_eq!(runner.uploads[1]["currentMessage"], true);
    assert!(runner.turn_images.is_empty());

    let grouped = context::by_request(&env.dbx, &[earlier.id]).await.unwrap();
    let prefix = context::history_prefix(&grouped[&earlier.id]);
    assert!(prefix.contains("report.md"));
    assert!(prefix.contains(&report.id.to_string()));
}

#[actix_web::test]
#[serial]
async fn issue_3962_cleanup_removed_stale_drafts_and_deleted_conversations() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let request = fixture.request(&env).await;
    let sent = draft(&env, fixture.human.id, None, "sent.txt").await;
    bind(&env, &fixture, request.id, &[&sent]).await.unwrap();
    let fresh = draft(&env, fixture.human.id, None, "fresh.txt").await;
    let stale = draft(&env, fixture.human.id, None, "stale.txt").await;
    let mut stale_act = stale.clone().into_active_model();
    stale_act.created_at = Set(Utc::now().naive_utc()
        - chrono::Duration::hours(
            crate::config::AI_AGENT_UPLOAD_DRAFT_TTL_HOURS as i64 + 1,
        ));
    stale_act.update(&env.dbx).await.unwrap();

    worker::cleanup(&env).await.unwrap();
    let exists = |id: Uuid| {
        let env = env.clone();
        async move {
            ai_agent_upload::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .is_some()
        }
    };
    assert!(exists(sent.id).await);
    assert!(exists(fresh.id).await);
    assert!(!exists(stale.id).await);

    let mut conversation = fixture.conversation.clone().into_active_model();
    conversation.deleted_at = Set(Some(Utc::now().naive_utc()));
    conversation.update(&env.dbx).await.unwrap();
    worker::cleanup(&env).await.unwrap();
    assert!(!exists(sent.id).await);
    assert!(exists(fresh.id).await);
}
