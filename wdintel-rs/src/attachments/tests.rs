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
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use uuid::Uuid;

async fn fixture() -> (Env, String, i64) {
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

async fn attachment(env: &Env, message: i64, name: &str) -> Job {
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
