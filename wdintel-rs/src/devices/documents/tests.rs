use super::{access, extraction, queue, read, search, types::*};
use crate::{
    attachments::{
        store::{execute, rows},
        worker::{Package, Section},
    },
    entities::{ai_agent_user_link, device, login, system_settings},
    file_registry::{
        entities::{
            file_entry, file_revision, sea_orm_active_enums::FileEntryKind,
        },
        test_support,
    },
    functest::tests::{cleanup_locked, mk_login, mk_organism},
    types::Env,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, EntityTrait, FromQueryResult,
    IntoActiveModel,
};
use serde_json::json;
use uuid::Uuid;

async fn reader(env: &Env) -> login::Model {
    let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
    mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Cyber"])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn device(env: &Env, login: &login::Model) -> device::Model {
    crate::devices::tests::schema::device_active_model(
        &login.login,
        login.organism_id.unwrap(),
        Some("Evidence device"),
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap()
}

async fn file(
    env: &Env,
    device: Uuid,
    name: &str,
    content: bool,
    login: Uuid,
) -> file_entry::Model {
    let db = env.file_registry_db().unwrap().connection();
    let root = Uuid::now_v7();
    let id = Uuid::now_v7();
    let now = chrono::Utc::now().naive_utc();
    file_entry::ActiveModel {
        id: Set(root),
        device_id: Set(device),
        kind: Set(FileEntryKind::Directory),
        name: Set(root.to_string()),
        parent_id: Set(None),
        hierarchy_path: Set(format!("n{}", root.simple())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let file = test_support::insert_entry(
        db,
        file_entry::ActiveModel {
            id: Set(id),
            device_id: Set(device),
            parent_id: Set(Some(root)),
            kind: Set(FileEntryKind::File),
            name: Set(name.into()),
            extension: Set(Some("txt".into())),
            absolute_path: Set(Some(format!("C:\\{name}"))),
            hierarchy_path: Set(format!("n{}.n{}", root.simple(), id.simple())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        },
    )
    .await;
    if content {
        test_support::publish_content(db, &file, login).await;
    }
    file
}

fn package(text: &str) -> Package {
    Package {
        complete: true,
        sections: vec![Section {
            member: "report.txt".into(),
            locator: "page 1".into(),
            text: text.into(),
            markdown: text.into(),
            html: format!("<p>{text}</p>"),
        }],
        ..Default::default()
    }
}

fn request(file: &file_entry::Model) -> DeviceDocumentReadReq {
    DeviceDocumentReadReq {
        device_id: file.device_id.to_string(),
        file_id: file.id.to_string(),
        revision: file.revision.unwrap(),
        ..Default::default()
    }
}

mod authorization;
mod lifecycle;
mod maps;
mod positions;
