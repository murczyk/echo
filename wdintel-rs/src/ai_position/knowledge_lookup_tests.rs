use super::{knowledge, load_knowledge_for};
use crate::entities::{ai_position_knowledge, ai_position_mention};
use crate::types::Mode;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseTransaction, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

// Regression: https://github.com/echoua/echo/issues/3757
#[actix_web::test]
async fn large_knowledge_lookup_survives_in_subprocess() {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "ai_position::list::knowledge_lookup_tests::large_knowledge_lookup_child",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("WDINTEL_SKIP_TEST_DB_INIT", "1")
            .env("RUST_MIN_STACK", "2097152")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("knowledge lookup subprocess timed out")
    .unwrap();
    assert!(
        output.status.success(),
        "knowledge lookup subprocess failed: {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[actix_web::test]
#[ignore = "executed by the subprocess regression"]
async fn large_knowledge_lookup_child() {
    let dbx = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
    let txn = dbx.begin().await.unwrap();
    let group = Uuid::now_v7().to_string();
    let aor = Uuid::now_v7().to_string();
    let allowed = HashSet::from([group.clone()]);
    let scopes = HashMap::from([(
        group.clone(),
        vec![
            knowledge::Scope {
                kind: "group",
                key: group.clone(),
            },
            knowledge::Scope {
                kind: "aor",
                key: aor.clone(),
            },
        ],
    )]);
    let first =
        seed_knowledge(&txn, "group", &group, 0, vec![group.clone()]).await;
    let last_repeated =
        seed_knowledge(&txn, "aor", &aor, 300, vec![group.clone()]).await;
    let last_unique =
        seed_knowledge(&txn, "group", &group, 19999, vec![group.clone()]).await;
    seed_knowledge(
        &txn,
        "group",
        &group,
        1,
        vec![group.clone(), "secret".into()],
    )
    .await;
    seed_knowledge(&txn, "group", &aor, 0, vec![group.clone()]).await;
    for unique_names in [301, 20000] {
        let mentions = (0..20000)
            .map(|index| mention(&group, index % unique_names))
            .collect::<Vec<_>>();
        let rows = load_knowledge_for(
            &txn,
            &mentions,
            &HashMap::new(),
            &scopes,
            &allowed,
        )
        .await
        .unwrap();
        let mut expected = HashSet::from([first, last_repeated]);
        if unique_names == 20000 {
            expected.insert(last_unique);
        }
        assert_eq!(rows.len(), expected.len());
        assert_eq!(
            rows.into_iter().map(|row| row.id).collect::<HashSet<_>>(),
            expected
        );
    }
    txn.rollback().await.unwrap();
}

fn mention(group: &str, index: usize) -> ai_position_mention::Model {
    let now = chrono::Utc::now().naive_utc();
    ai_position_mention::Model {
        id: Uuid::now_v7(),
        sigint_inbox_item_id: None,
        media_id: None,
        name: format!("position-{index:05}"),
        name_key: format!("position-{index:05}"),
        begin_char: 0,
        end_char: 14,
        message_at: now,
        group_master_key: Some(group.to_string()),
        group_is_secret: false,
        aor_ids: vec![],
        ai_engine_id: None,
        model_name: "test".to_string(),
        created_at: now,
        kind: "position".to_string(),
        attachment_chunk_id: None,
    }
}

async fn seed_knowledge(
    txn: &DatabaseTransaction,
    scope_kind: &str,
    scope_key: &str,
    index: usize,
    source_group_keys: Vec<String>,
) -> Uuid {
    let now = chrono::Utc::now().naive_utc();
    ai_position_knowledge::ActiveModel {
        scope_kind: Set(scope_kind.to_string()),
        scope_key: Set(scope_key.to_string()),
        name_key: Set(format!("position-{index:05}")),
        name: Set(format!("position-{index:05}")),
        kind: Set("position".to_string()),
        mgrs: Set("36TXT7573468963".to_string()),
        lat: Set(47.55029916845189),
        lng: Set(35.335663776872615),
        certainty: Set("high".to_string()),
        fact_count: Set(1),
        conflicting: Set(false),
        first_fact_at: Set(now),
        last_fact_at: Set(now),
        source_group_keys: Set(source_group_keys),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(txn)
    .await
    .unwrap()
    .id
}
