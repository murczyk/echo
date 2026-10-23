use super::{
    api::{read_document, search_documents},
    store::*,
    types::*,
    worker::{publish, Job, Package, Section},
};
use crate::{
    entities::{
        attachment_document, signal_group, signal_message, signal_message_media,
    },
    functest::tests::{cleanup, mk_signal_message},
    types::Env,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QuerySelect, Set,
};
use uuid::Uuid;

mod scoped;

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_correlated_terms_preserve_mixed_source_matches_3780()
{
    let (env, _, message) = fixture().await;
    crate::functest::tests::mk_sigint_inbox_item(
        &env.dbx,
        crate::entities::sigint_inbox_item::ActiveModel {
            id: Set(message),
            body_noheader: Set(Some(
                serde_json::json!({"body": "звичайне повідомлення"}),
            )),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    execute(&env.dbx, "INSERT INTO sigint_search(id,search_tsv) VALUES($1,to_tsvector('russian','звичайне повідомлення'))", vec![message.into()]).await.unwrap();
    let first = attachment(&env, message, "Бойовий звіт.txt").await;
    let second = attachment(&env, message, "Другий файл.txt").await;
    publish(&env, &first, package("Береза зміна позиції"), vec![1])
        .await
        .unwrap();
    publish(&env, &second, package("чергування Вільха"), vec![2])
        .await
        .unwrap();
    for query in [
        "Берез",
        "звичайне Береза",
        "Береза Вільха",
        "\"зміна позиції\"",
        "Бойовий",
        "Береза or Вільха",
        "звичайне -Береза",
        "звичайне -Невідомий",
        "-\"зміна позиції\"",
        "звичайне -\"немає тексту\"",
        "и",
        "9",
        "Береза or и",
        "Береза -и",
    ] {
        let expected = signal_message::Entity::find()
            .filter(super::search::message_filter(query, "all").unwrap())
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|message| message.id)
            .collect::<std::collections::BTreeSet<_>>();
        let actual = signal_message::Entity::find()
            .filter(super::search::correlated_message_filter(query).unwrap())
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|message| message.id)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(actual, expected, "{query}");
        for (correlated, inline_tsquery) in
            [(false, false), (true, false), (true, true)]
        {
            let actual = signal_message::Entity::find()
                .join(
                    sea_orm::JoinType::LeftJoin,
                    sea_orm::RelationTrait::def(
                        &signal_message::Relation::SigintInboxItem,
                    ),
                )
                .filter(
                    super::search::analysis_message_filter(
                        query,
                        None,
                        correlated,
                        inline_tsquery,
                    )
                    .unwrap(),
                )
                .all(&env.dbx)
                .await
                .unwrap()
                .into_iter()
                .map(|message| message.id)
                .collect::<std::collections::BTreeSet<_>>();
            assert_eq!(actual, expected, "{query}, correlated={correlated}, inline_tsquery={inline_tsquery}");
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_modes_respect_word_boundaries_and_case_3780() {
    use crate::entities::sigint_inbox_item;
    use crate::rer_importer::types::AnalysisSearchMode;
    use sea_orm::{JoinType, QuerySelect, RelationTrait};

    let (env, _, message) = fixture().await;
    crate::functest::tests::mk_sigint_inbox_item(
        &env.dbx,
        sigint_inbox_item::ActiveModel {
            id: Set(message),
            body_noheader: Set(Some(
                serde_json::json!({"body": "звичайне повідомлення"}),
            )),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let document = attachment(&env, message, "схема.txt").await;
    publish(&env, &document, package("норма ПАНОРАМА"), vec![1])
        .await
        .unwrap();
    for (mode, query, matches) in [
        (AnalysisSearchMode::Fuzzy, "НоРа", true),
        (AnalysisSearchMode::Exact, "НоРа", false),
        (AnalysisSearchMode::Substring, "НоРа", true),
        (AnalysisSearchMode::Exact, "-нора", true),
        (AnalysisSearchMode::Substring, "-нора", false),
    ] {
        let predicate = super::search::message_filter_with_mode(
            query,
            "all",
            Some(mode),
            false,
        )
        .unwrap();
        let actual = sigint_inbox_item::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .filter(sigint_inbox_item::Column::Id.eq(message))
            .filter(predicate)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some();
        assert_eq!(actual, matches, "{mode:?}: {query}");
    }
    execute(
        &env.dbx,
        "UPDATE signal_message_media SET file_name='НОРА.txt' WHERE id=$1",
        vec![document.media_id.into()],
    )
    .await
    .unwrap();
    let predicate = super::search::message_filter_with_mode(
        "нора",
        "all",
        Some(AnalysisSearchMode::Exact),
        false,
    )
    .unwrap();
    assert!(sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def()
        )
        .filter(sigint_inbox_item::Column::Id.eq(message))
        .filter(predicate)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
}

pub(super) async fn fixture() -> (Env, String, i64) {
    let env = cleanup().await.unwrap();
    let mut env = env.as_ref().clone();
    let config = crate::config::S3Config {
        s3_access_key_id: "test".into(),
        s3_secret_access_key: "test".into(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: "attachments-test".into(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    };
    env.s3_config = Some(crate::storage::S3Config::from(&config));
    env.config.s3_config = Some(config);
    env.s3 = Some(
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish(),
    );
    let group = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let message = mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            body: Set(Some("звичайне повідомлення".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    execute(&env.dbx,"insert into signal_message_group(signal_message_id,group_master_key,created_at) values($1,$2,now())",vec![message.id.into(),group.master_key.clone().into()]).await.unwrap();
    (env, group.master_key, message.id)
}

pub(super) async fn attachment(env: &Env, message: i64, name: &str) -> Job {
    let media = signal_message_media::ActiveModel {
        id: Set(Uuid::now_v7()),
        signal_message_id: Set(message),
        signal_message_uuid: Set(None),
        content_type: Set("text/plain".into()),
        file_ext: Set(Some("txt".into())),
        file_name: Set(Some(name.into())),
        size_bytes: Set(10),
        created_at: Set(chrono::Utc::now().naive_utc()),
        is_encrypted: Set(true),
        storage_key: Set(Some(name.into())),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    execute(&env.dbx,"update attachment_job set state='running',lease=gen_random_uuid(),lease_until=now()+interval '15 minutes' where media_id=$1",vec![media.id.into()]).await.unwrap();
    rows(
        &env.dbx,
        "select * from attachment_job where media_id=$1",
        vec![media.id.into()],
    )
    .await
    .unwrap()
    .pop()
    .unwrap()
}

fn package(text: &str) -> Package {
    Package {
        sections: vec![Section {
            member: "orders.zip!/positions.txt".into(),
            locator: "sheet Позиції; rows 1–20".into(),
            text: text.into(),
            markdown: text.into(),
            html: format!("<p>{text}</p><script>alert(1)</script>"),
        }],
        complete: true,
        ..Default::default()
    }
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_ocr_keeps_provider_profile_3662() {
    let (env, _, message) = fixture().await;
    let job = attachment(&env, message, "scan.pdf").await;
    let engine = Uuid::now_v7();
    execute(&env.dbx,"insert into ai_engine(id,name,url,model_name,enabled,ocr_enabled) values($1,$2,'http://localhost','ocr',true,true)",vec![engine.into(),format!("attachment-ocr-{engine}").into()]).await.unwrap();
    execute(&env.dbx,"insert into ocr_settings(id,worker_enabled,main_ai_engine_id) values(1,true,$1) on conflict(id) do update set main_ai_engine_id=excluded.main_ai_engine_id",vec![engine.into()]).await.unwrap();
    assert!(!super::worker::extract_ocr(&env, &job, "scan.pdf")
        .await
        .unwrap());
    let ocr = crate::entities::ocr_job::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ocr.ocr_request_profile.as_deref(), Some("openai_vision"));
    assert_eq!(ocr.ai_engine_id, Some(engine));
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_summary_projection_constraints_3662() {
    let (env, _, message) = fixture().await;
    let job = attachment(&env, message, "report.txt").await;
    let engine = Uuid::now_v7();
    execute(&env.dbx,"insert into ai_engine(id,name,url,model_name,enabled) values($1,$2,'http://localhost','text',true)",vec![engine.into(),format!("attachment-summary-{engine}").into()]).await.unwrap();
    publish(&env, &job, package("Батарей: 42"), vec![1])
        .await
        .unwrap();
    execute(&env.dbx,"update attachment_chunk set summary='Батарей: 42',coordinates=$2 where media_id=$1",vec![job.media_id.into(),serde_json::json!(vec![serde_json::json!({"value":"36UXV1234567890"}); 60]).into()]).await.unwrap();
    assert!(super::enrich::summarize(&env, &job, Some(engine))
        .await
        .unwrap());
    let summary =
        crate::entities::media_summary::Entity::find_by_id(job.media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(summary.state, "completed");
    assert_eq!(summary.source_digest.len(), 64);
    assert_eq!(summary.coordinates.as_array().unwrap().len(), 50);
    publish(&env, &job, Package::default(), vec![2])
        .await
        .unwrap();
    assert!(super::enrich::summarize(&env, &job, Some(engine))
        .await
        .unwrap());
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_visibility_and_revision_3064() {
    let (env, group, message) = fixture().await;
    let first = attachment(&env, message, "Бойовий звіт.txt").await;
    let second = attachment(&env, message, "Інший файл.txt").await;
    publish(
        &env,
        &first,
        package("Надійшла зміна позиції Береза 36UXV1234567890"),
        vec![1],
    )
    .await
    .unwrap();
    publish(&env, &second, package("Розклад чергувань"), vec![2])
        .await
        .unwrap();
    for query in [
        "Береза",
        "\"зміна позиції\"",
        "Бойовий",
        "Береза -чергувань",
    ] {
        let req = AttachmentSearchReq {
            query: Some(query.into()),
            ..Default::default()
        };
        let found = search_documents(&env, &req, vec![group.clone()])
            .await
            .unwrap();
        assert_eq!(found.documents.len(), 1, "{query}");
        assert_eq!(found.documents[0].media_id, first.media_id.to_string());
        assert!(search_documents(&env, &req, vec![])
            .await
            .unwrap()
            .documents
            .is_empty());
    }
    let messages = signal_message::Entity::find()
        .filter(super::search::message_filter("Береза", "all").unwrap())
        .all(&env.dbx)
        .await
        .unwrap();
    assert!(messages.iter().any(|item| item.id == message));
    let req = AttachmentReadReq {
        media_id: first.media_id.to_string(),
        ..Default::default()
    };
    let read = read_document(&env, &req).await.unwrap();
    assert!(!read.sections[0].html.contains("script"));
    assert!(!read.coordinates.is_empty());
    execute(
        &env.dbx,
        "update attachment_document set generation=gen_random_uuid() where media_id=$1",
        vec![first.media_id.into()],
    )
    .await
    .unwrap();
    publish(&env, &first, package("stale replacement"), vec![3])
        .await
        .unwrap();
    assert_eq!(
        read_document(&env, &req).await.unwrap().document.revision,
        read.document.revision
    );
    let pinned = AttachmentReadReq {
        revision: Some(Uuid::now_v7().to_string()),
        ..req
    };
    assert!(read_document(&env, &pinned).await.is_err());
    execute(
        &env.dbx,
        "delete from signal_message_group where signal_message_id=$1",
        vec![message.into()],
    )
    .await
    .unwrap();
    assert!(search_documents(
        &env,
        &AttachmentSearchReq::default(),
        vec![group]
    )
    .await
    .unwrap()
    .documents
    .is_empty());
    execute(
        &env.dbx,
        "delete from signal_message_media where id=$1",
        vec![first.media_id.into()],
    )
    .await
    .unwrap();
    assert!(attachment_document::Entity::find_by_id(first.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_search_preserves_cdc_only_history_and_recent_changes_3780()
{
    let (env, _, message) = fixture().await;
    let job = attachment(&env, message, "history.txt").await;
    publish(&env, &job, package("Береза зміна позиції"), vec![1])
        .await
        .unwrap();
    let source = &env.dbx;
    execute(source, "CREATE TABLE IF NOT EXISTS public.echo_analytics_attachment_search(singleton boolean PRIMARY KEY CHECK(singleton), started_at timestamp NOT NULL, history_complete boolean NOT NULL DEFAULT false)", vec![]).await.unwrap();
    execute(source, "INSERT INTO public.echo_analytics_attachment_search VALUES(true, now() AT TIME ZONE 'UTC', false) ON CONFLICT(singleton) DO UPDATE SET started_at=EXCLUDED.started_at,history_complete=false", vec![]).await.unwrap();
    execute(source, "UPDATE attachment_document SET created_at=(now() AT TIME ZONE 'UTC')-interval '1 day',updated_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    execute(source, "UPDATE attachment_search_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE singleton", vec![]).await.unwrap();
    for query in [
        "Береза",
        "-Береза",
        "\"зміна позиції\"",
        "-\"зміна позиції\"",
    ] {
        let error = super::analytics::ensure_search_coverage(
            source,
            source,
            &Some(query.into()),
            90_000,
        )
        .await
        .unwrap_err();
        assert!(error
            .chain()
            .any(|error| error
                .is::<super::analytics::AttachmentSearchCoverageError>()));
    }
    super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("НевідомийПозивний".into()),
        90_000,
    )
    .await
    .unwrap();
    execute(source, "UPDATE public.echo_analytics_attachment_search SET history_complete=true", vec![]).await.unwrap();
    super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("Береза".into()),
        90_000,
    )
    .await
    .unwrap();
    execute(source, "UPDATE attachment_document SET updated_at=now() AT TIME ZONE 'UTC' WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    assert!(super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("Береза".into()),
        90_000
    )
    .await
    .is_err());
    execute(source, "UPDATE attachment_chunk SET text='Вільха',summary=NULL WHERE media_id=$1", vec![job.media_id.into()]).await.unwrap();
    for query in ["Береза", "-Береза", "\"зміна позиції\""]
    {
        assert!(super::analytics::ensure_search_coverage(
            source,
            source,
            &Some(query.into()),
            90_000
        )
        .await
        .is_err());
    }
    assert!(super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("-Вільха".into()),
        90_000
    )
    .await
    .is_err());
    assert_media_mutations_require_source(source, job.media_id).await;
    assert_media_insert_requires_source(&env, message).await;
    execute(
        source,
        "DROP TABLE public.echo_analytics_attachment_search",
        vec![],
    )
    .await
    .unwrap();
    super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("155.275".into()),
        90_000,
    )
    .await
    .unwrap();
    assert!(super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("Береза".into()),
        90_000
    )
    .await
    .is_err());
}

async fn assert_media_mutations_require_source(
    source: &sea_orm::DatabaseConnection,
    media_id: Uuid,
) {
    execute(source, "UPDATE attachment_document SET updated_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE media_id=$1", vec![media_id.into()]).await.unwrap();
    let document = attachment_document::Entity::find_by_id(media_id)
        .one(source)
        .await
        .unwrap()
        .unwrap();
    signal_message_media::ActiveModel {
        id: Set(media_id),
        file_name: Set(Some("renamed.txt".into())),
        ..Default::default()
    }
    .update(source)
    .await
    .unwrap();
    assert_eq!(
        attachment_document::Entity::find_by_id(media_id)
            .one(source)
            .await
            .unwrap()
            .unwrap()
            .updated_at,
        document.updated_at
    );
    assert_mutation_search_falls_back(source).await;
    execute(source, "UPDATE attachment_search_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE singleton", vec![]).await.unwrap();
    super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("renamed".into()),
        90_000,
    )
    .await
    .unwrap();
    signal_message_media::Entity::delete_by_id(media_id)
        .exec(source)
        .await
        .unwrap();
    assert!(attachment_document::Entity::find_by_id(media_id)
        .one(source)
        .await
        .unwrap()
        .is_none());
    assert_mutation_search_falls_back(source).await;
}

async fn assert_mutation_search_falls_back(
    source: &sea_orm::DatabaseConnection,
) {
    for query in [
        "history",
        "inserted",
        "renamed",
        "-renamed",
        "Береза",
        "-Вільха",
        "\"зміна позиції\"",
    ] {
        let error = super::analytics::ensure_search_coverage(
            source,
            source,
            &Some(query.into()),
            90_000,
        )
        .await
        .unwrap_err();
        assert!(error
            .chain()
            .any(|error| error
                .is::<super::analytics::AttachmentSearchCoverageError>()));
    }
}

async fn assert_media_insert_requires_source(env: &Env, message: i64) {
    let source = &env.dbx;
    execute(source, "UPDATE signal_message SET created_at=(now() AT TIME ZONE 'UTC')-interval '1 day' WHERE id=$1", vec![message.into()]).await.unwrap();
    execute(source, "UPDATE attachment_search_change SET changed_at=(now() AT TIME ZONE 'UTC')-interval '1 hour' WHERE singleton", vec![]).await.unwrap();
    super::analytics::ensure_search_coverage(
        source,
        source,
        &Some("inserted".into()),
        90_000,
    )
    .await
    .unwrap();
    attachment(env, message, "inserted.txt").await;
    assert_mutation_search_falls_back(source).await;
}

#[tokio::test]
async fn ocr_coordinate_boundaries_and_precision_3714() {
    let package = super::worker::html_package("scan.pdf",
        "<section><p>X=5291456 Y=6662340<br>48.469429° <span>N</span> 37.315640° E</p><div>48.46942912345, <b>37.31564012345</b></div><table><tr><td>Grid</td><td>52-91456 66-62340<br>48.469429° N 37.315640° E</td></tr></table></section>").unwrap();
    let text = &package.sections[0].text;
    assert!(text.contains("6662340\n48.469429"), "{text}");
    assert!(text.contains("48.46942912345, 37.31564012345"), "{text}");
    assert!(text.contains("| Grid |"), "{text}");
    let fragments = crate::media_summary::plain_text_from_sanitized_html(
        "<span>48.</span><b>469429° N</b> <span>37.315640° E</span><div>52-91456 66-62340</div><div>48.469429° N 37.315640° E</div>").unwrap();
    assert!(
        fragments.contains("48.469429° N 37.315640° E"),
        "{fragments}"
    );
    assert!(fragments.contains("66-62340\n48.469429"), "{fragments}");

    let coordinates = super::enrich::coordinates(text, "page 1").await.unwrap();
    assert!(
        coordinates
            .as_array()
            .unwrap()
            .iter()
            .any(|coordinate| coordinate["coordinateSystem"] == "wgs84"
                && coordinate["value"] == "48.469429, 37.315640"),
        "{coordinates}"
    );
    let coordinates =
        super::enrich::coordinates("48.46942912345, 37.31564012345", "page 1")
            .await
            .unwrap();
    assert_eq!(coordinates[0]["value"], "48.46942912345, 37.31564012345");
}

#[tokio::test]
#[serial_test::serial]
async fn attachment_coordinates_without_summary_and_revisions_3714() {
    let (env, _, message) = fixture().await;
    let job = attachment(&env, message, "coordinates.txt").await;
    publish(&env, &job, package("48.469429° N 37.315640° E"), vec![1])
        .await
        .unwrap();
    let media = signal_message_media::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let login = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap();
    crate::messenger::media::ensure_media_access(&env.dbx, &login.id, message)
        .await
        .unwrap();
    let initial = super::coordinates::load_statuses(
        &env.dbx,
        std::slice::from_ref(&media),
    )
    .await
    .unwrap();
    assert!(initial[&job.media_id].has_coordinates);
    for (state, enabled) in
        [("queued", true), ("queued", false), ("failed", true)]
    {
        execute(
            &env.dbx,
            "update attachment_settings set summaries_enabled=$1 where id=1",
            vec![enabled.into()],
        )
        .await
        .unwrap();
        execute(
            &env.dbx,
            "update attachment_document set summary_state=$2 where media_id=$1",
            vec![job.media_id.into(), state.into()],
        )
        .await
        .unwrap();
        let coordinates =
            crate::media_summary::coordinates_for_media(&env.dbx, job.media_id)
                .await
                .unwrap();
        assert_eq!(coordinates[0].coordinate_system, "wgs84");
        assert_eq!(coordinates[0].value, "48.469429, 37.315640");
    }
    publish(&env, &job, package("48.479429, 37.325640"), vec![2])
        .await
        .unwrap();
    let updated = super::coordinates::load_statuses(
        &env.dbx,
        std::slice::from_ref(&media),
    )
    .await
    .unwrap();
    assert_ne!(
        initial[&job.media_id].revision,
        updated[&job.media_id].revision
    );
    assert_eq!(
        crate::media_summary::coordinates_for_media(&env.dbx, job.media_id)
            .await
            .unwrap()[0]
            .value,
        "48.479429, 37.325640"
    );
    publish(&env, &job, Package::default(), vec![3])
        .await
        .unwrap();
    execute(&env.dbx,"insert into media_summary(media_id,source_kind,source_digest,source_char_count,state,coordinates,ai_engine_name,model_name,summary) values($1,'ocr_text',$2,10,'completed',$3,'legacy','legacy','legacy summary')",vec![job.media_id.into(),"a".repeat(64).into(),serde_json::json!([{"title":"legacy","coordinateSystem":"wgs84","value":"48.469429, 37.315640"}]).into()]).await.unwrap();
    assert!(crate::media_summary::coordinates_for_media(
        &env.dbx,
        job.media_id
    )
    .await
    .unwrap()
    .is_empty());
    let empty = super::coordinates::load_statuses(
        &env.dbx,
        std::slice::from_ref(&media),
    )
    .await
    .unwrap();
    assert!(!empty[&job.media_id].has_coordinates);
    execute(
        &env.dbx,
        "update attachment_document set revision=null where media_id=$1",
        vec![job.media_id.into()],
    )
    .await
    .unwrap();
    assert_eq!(
        crate::media_summary::coordinates_for_media(&env.dbx, job.media_id)
            .await
            .unwrap()[0]
            .title,
        "legacy"
    );
    execute(
        &env.dbx,
        "delete from signal_message_group where signal_message_id=$1",
        vec![message.into()],
    )
    .await
    .unwrap();
    assert!(matches!(
        crate::messenger::media::ensure_media_access(
            &env.dbx, &login.id, message
        )
        .await,
        Err(crate::error::AppError::Forbidden(_))
    ));
}

#[tokio::test]
#[serial_test::serial]
async fn stored_ocr_recovery_is_scoped_and_dry_by_default_3714() {
    let (env, _, message) = fixture().await;
    let job = attachment(&env, message, "scan.pdf").await;
    let other = attachment(&env, message, "untouched.txt").await;
    execute(&env.dbx, "update signal_message_media set content_type='application/pdf',file_ext='pdf' where id=$1", vec![job.media_id.into()]).await.unwrap();
    let html = "<p>X=5291456 Y=6662340<br>48.469429° N 37.315640° E</p>";
    crate::storage::upload_encrypted_to_s3_with_operator(
        &env.s3,
        env.s3_config.as_ref().unwrap(),
        &env.config.s3_config.as_ref().unwrap().strongbox_key,
        "stored-ocr",
        html.as_bytes().to_vec().into(),
    )
    .await
    .unwrap();
    execute(&env.dbx,"insert into ocr_job(media_id,state,quality_status,html_s3_key) values($1,'completed','accepted','stored-ocr')",vec![job.media_id.into()]).await.unwrap();
    let original_generation =
        attachment_document::Entity::find_by_id(job.media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .generation;
    let mut params = crate::OneoffReindexStoredOcrPs {
        media_id: job.media_id,
        dry_run: false,
        yes: false,
    };
    super::recovery::reindex(&env, &params).await.unwrap();
    let document = attachment_document::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(document.generation, original_generation);
    params.yes = true;
    params.dry_run = true;
    super::recovery::reindex(&env, &params).await.unwrap();
    assert_eq!(
        attachment_document::Entity::find_by_id(job.media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .generation,
        original_generation
    );
    params.dry_run = false;
    super::recovery::reindex(&env, &params).await.unwrap();
    let document = attachment_document::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(document.generation, original_generation);
    execute(&env.dbx,"update attachment_job set state='running',lease=gen_random_uuid(),lease_until=now()+interval '15 minutes' where media_id=$1 and generation=$2",vec![job.media_id.into(),document.generation.into()]).await.unwrap();
    let replacement: Job = rows(&env.dbx,"select * from attachment_job where media_id=$1 and generation=$2 and kind='extract'",vec![job.media_id.into(),document.generation.into()]).await.unwrap().pop().unwrap();
    assert!(super::worker::extract_ocr(&env, &replacement, "scan.pdf")
        .await
        .unwrap());
    assert!(crate::media_summary::coordinates_for_media(
        &env.dbx,
        job.media_id
    )
    .await
    .unwrap()
    .iter()
    .any(|coordinate| coordinate.value == "48.469429, 37.315640"));
    let ocr = crate::entities::ocr_job::Entity::find_by_id(job.media_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ocr.state, "completed");
    assert_eq!(ocr.html_s3_key.as_deref(), Some("stored-ocr"));
    assert_eq!(
        attachment_document::Entity::find_by_id(other.media_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .generation,
        other.generation
    );
    params.media_id = other.media_id;
    assert!(super::recovery::reindex(&env, &params).await.is_err());
}
