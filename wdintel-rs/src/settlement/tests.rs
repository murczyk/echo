use super::*;
use crate::entities::{
    sea_orm_active_enums::SettlementKind, settlement, settlement_alias,
};
use crate::location::{types::SettlementDetails, SettlementsDataConfig};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseTransaction, EntityTrait,
    IntoActiveModel, TransactionTrait,
};
use serial_test::serial;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use uuid::Uuid;

async fn seed_settlement(
    dbx: &DatabaseTransaction,
    id: i32,
    name: &str,
    coords: Option<(f64, f64)>,
) {
    settlement::ActiveModel {
        id: Set(id),
        name: Set(name.to_string()),
        kind: Set(SettlementKind::Village),
        lat: Set(coords.map(|coords| coords.0)),
        lon: Set(coords.map(|coords| coords.1)),
        ..Default::default()
    }
    .insert(dbx)
    .await
    .unwrap();
}

async fn seed_alias(
    dbx: &DatabaseTransaction,
    settlement_id: i32,
    text: &str,
) -> Uuid {
    let alias = settlement_alias::ActiveModel {
        id: Set(Uuid::now_v7()),
        settlement_id: Set(settlement_id),
        text: Set(text.to_string()),
    }
    .insert(dbx)
    .await
    .unwrap();
    alias.id
}

#[tokio::test]
#[serial]
async fn searches_names_and_aliases_without_duplicate_settlements_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    seed_settlement(&txn, 2_000_338_311, "#3383 П’ятихатки", None).await;
    seed_settlement(&txn, 2_000_338_312, "#3383 Інше село", None).await;
    seed_settlement(&txn, 2_000_338_313, "#3383 Без синонімів", None).await;
    seed_alias(&txn, 2_000_338_311, "#3383 Пʼятихатки").await;
    seed_alias(&txn, 2_000_338_311, "#3383 Straße").await;
    seed_alias(&txn, 2_000_338_311, "#3383 Старе_100%\\село").await;
    seed_alias(&txn, 2_000_338_311, "#3383 Старе_100%\\село інша назва").await;
    let shared_alias =
        seed_alias(&txn, 2_000_338_312, "#3383 Старе_100%\\село").await;

    let found = search_by_name(&txn, "#3383 старе_100%\\село")
        .await
        .unwrap();
    assert_eq!(
        found
            .iter()
            .map(|settlement| settlement.id)
            .collect::<Vec<_>>(),
        vec![2_000_338_312, 2_000_338_311]
    );
    assert_eq!(
        search_by_name(&txn, "#3383 Straße").await.unwrap()[0].id,
        2_000_338_311
    );
    assert_eq!(
        search_by_name(&txn, "#3383 п`ятихатки")
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        search_by_name(&txn, "#3383 без синонімів").await.unwrap()[0].id,
        2_000_338_313
    );
    assert!(search_by_name(&txn, "#3383 СтареX100X\\село")
        .await
        .unwrap()
        .is_empty());
    assert!(search_by_name(&txn, "  ").await.unwrap().is_empty());

    let names = [
        "#3383 П'ятихатки",
        "#3383 старе_100%\\село",
        "#3383 відсутнє",
        " ",
        "#3383 Straße",
    ]
    .map(str::to_string);
    let found = find_by_names(&txn, &names).await.unwrap();
    assert_eq!(found[0].len(), 1);
    assert_eq!(found[0][0].id, 2_000_338_311);
    assert_eq!(found[1].len(), 2);
    assert!(found[2].is_empty());
    assert!(found[3].is_empty());
    assert_eq!(found[4][0].id, 2_000_338_311);

    settlement_alias::ActiveModel {
        id: Set(shared_alias),
        text: Set("#3383 Змінений синонім".to_string()),
        ..Default::default()
    }
    .update(&txn)
    .await
    .unwrap();
    assert_eq!(find_by_names(&txn, &names).await.unwrap()[1].len(), 1);
    assert_eq!(
        search_by_name(&txn, "#3383 Змінений синонім")
            .await
            .unwrap()[0]
            .id,
        2_000_338_312
    );
    settlement_alias::Entity::delete_by_id(shared_alias)
        .exec(&txn)
        .await
        .unwrap();
    assert!(search_by_name(&txn, "#3383 Змінений синонім")
        .await
        .unwrap()
        .is_empty());
    txn.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn preserves_input_groups_across_database_lookup_batches_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    seed_settlement(&txn, 2_000_338_314, "#3383 Канонічне", None).await;
    seed_alias(&txn, 2_000_338_314, "#3383 Синонім").await;
    let mut names = vec![
        "#3383 Не знайдено".to_string();
        SETTLEMENT_LOOKUP_BATCH_SIZE + 2
    ];
    names[0] = "#3383 Канонічне".to_string();
    names[SETTLEMENT_LOOKUP_BATCH_SIZE] = "#3383 Синонім".to_string();
    let found = find_by_names(&txn, &names).await.unwrap();
    assert_eq!(found.len(), names.len());
    for (index, settlements) in found.into_iter().enumerate() {
        if index == 0 || index == SETTLEMENT_LOOKUP_BATCH_SIZE {
            assert_eq!(settlements.len(), 1);
            assert_eq!(settlements[0].id, 2_000_338_314);
        } else {
            assert!(settlements.is_empty());
        }
    }
    txn.rollback().await.unwrap();
}

fn catalog(coords: &[(f64, f64)]) -> Arc<crate::location::SettlementsData> {
    let settlements = coords
        .iter()
        .enumerate()
        .map(|(index, &coords)| SettlementDetails {
            id: Some(index as i32),
            name: format!("#3383 DICTIONARY {index}"),
            coords: Some(coords),
            ..Default::default()
        })
        .collect::<Vec<_>>();
    Arc::new((
        vec![],
        vec![],
        crate::location::trie::Trie::new(),
        settlements
            .iter()
            .map(|settlement| (settlement.id.unwrap(), settlement.clone()))
            .collect(),
        settlements
            .into_iter()
            .map(|settlement| (settlement.name.clone(), vec![settlement]))
            .collect::<BTreeMap<_, _>>(),
    ))
}

#[tokio::test]
#[serial]
async fn settlement_oneoff_preserves_existing_definitions_and_synonyms_2133() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let original = settlement::Entity::find_by_id(94886)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    let mut settlement = original.clone().into_active_model();
    settlement.tag = Set(Some("#2133 preserved".to_string()));
    let settlement = settlement.update(&txn).await.unwrap();
    assert_eq!(
        oneoff::add_missing_settlements(&txn).await.unwrap(),
        oneoff::SettlementAdditions {
            settlements: 0,
            synonyms: 1,
        }
    );
    let alias = settlement_alias::Entity::find()
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(alias.settlement_id, 65447);
    let mut alias = alias.into_active_model();
    alias.text = Set("  рибалкіне  ".to_string());
    let alias = alias.update(&txn).await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            oneoff::add_missing_settlements(&txn).await.unwrap(),
            oneoff::SettlementAdditions {
                settlements: 0,
                synonyms: 0,
            }
        );
    }
    assert_eq!(
        settlement::Entity::find_by_id(94886)
            .one(&txn)
            .await
            .unwrap(),
        Some(settlement)
    );
    assert_eq!(
        settlement_alias::Entity::find_by_id(alias.id)
            .one(&txn)
            .await
            .unwrap(),
        Some(alias)
    );
    txn.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn settlement_oneoff_restores_missing_definitions_and_synonyms_2133() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let original = settlement::Entity::find_by_id(94886)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    let ribalkyne = settlement::Entity::find_by_id(65447)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    settlement::Entity::delete_by_id(65447)
        .exec(&txn)
        .await
        .unwrap();
    settlement::Entity::delete_by_id(94886)
        .exec(&txn)
        .await
        .unwrap();
    for (settlements, synonyms) in [(2, 1), (0, 0)] {
        assert_eq!(
            oneoff::add_missing_settlements(&txn).await.unwrap(),
            oneoff::SettlementAdditions {
                settlements,
                synonyms,
            }
        );
    }
    assert_eq!(
        settlement::Entity::find_by_id(94886)
            .one(&txn)
            .await
            .unwrap(),
        Some(original)
    );
    assert_eq!(
        settlement::Entity::find_by_id(65447)
            .one(&txn)
            .await
            .unwrap(),
        Some(ribalkyne)
    );
    let matches = find_by_names(&txn, &[" РИБАЛКІНЕ ".to_string()])
        .await
        .unwrap();
    assert_eq!(matches[0].len(), 1);
    assert_eq!(matches[0][0].id, 65447);
    txn.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn resolves_database_aliases_within_the_selected_catalog_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let alias = "#3383 П’ятихатки синонім";
    seed_settlement(&txn, 2_000_338_315, "#3383 Перше", Some((10.0, 10.0)))
        .await;
    seed_settlement(&txn, 2_000_338_316, "#3383 Друге", Some((20.0, 20.0)))
        .await;
    seed_settlement(&txn, 2_000_338_317, "#3383 Без координат", None).await;
    for id in [2_000_338_315, 2_000_338_316, 2_000_338_317] {
        seed_alias(&txn, id, alias).await;
    }
    let mut config = SettlementsDataConfig {
        default_settlements_data: catalog(&[(10.005, 10.005)]),
        ..Default::default()
    };
    config
        .aor_id_to_settlements_data
        .insert(3383, catalog(&[(20.005, 20.005)]));
    let config = Arc::new(RwLock::new(config));
    let names = vec![
        " #3383 п'ятихатки синонім ".to_string(),
        "#3383 DICTIONARY 0".to_string(),
    ];
    for (aor_ids, expected_id) in [
        (None, 2_000_338_315),
        (Some(vec![3383]), 2_000_338_316),
        (Some(vec![3384]), 2_000_338_315),
    ] {
        let found = resolve_candidates(
            &txn,
            config.clone(),
            &names,
            aor_ids.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(found[0].len(), 1);
        assert_eq!(found[0][0].id, expected_id);
        assert_eq!(found[1].len(), 1);
        assert_eq!(found[1][0].id, expected_id);
    }
    let found = resolve_candidates(&txn, config, &names, Some(&[3383, 3384]))
        .await
        .unwrap();
    assert_eq!(found[0].len(), 2);
    txn.rollback().await.unwrap();
}
