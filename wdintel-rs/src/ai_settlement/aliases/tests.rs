use super::*;
use crate::entities::sea_orm_active_enums::SettlementKind;
use sea_orm::{DatabaseTransaction, TransactionTrait};
use serial_test::serial;

async fn seed_settlement(dbx: &DatabaseTransaction, id: i32, region: &str) {
    settlement::ActiveModel {
        id: Set(id),
        name: Set("#3383 Село_синонім".to_string()),
        kind: Set(SettlementKind::Village),
        region: Set(Some(region.to_string())),
        ..Default::default()
    }
    .insert(dbx)
    .await
    .unwrap();
}

fn request(
    id: Option<String>,
    settlement_id: i32,
    text: &str,
) -> SaveSettlementAliasReq {
    SaveSettlementAliasReq {
        id,
        settlement_id,
        text: text.to_string(),
    }
}

#[tokio::test]
#[serial]
async fn manages_aliases_with_canonical_settlement_ids_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    seed_settlement(&txn, 2_000_338_301, "Перша область").await;
    seed_settlement(&txn, 2_000_338_302, "Друга область").await;

    let found = search_settlements(&txn, "СЕЛО_СИНОНІМ").await.unwrap();
    assert_eq!(found.len(), 2);
    assert_ne!(found[0].id, found[1].id);
    assert_ne!(found[0].region, found[1].region);
    assert!(search_settlements(&txn, "се").await.unwrap().is_empty());
    assert!(save_alias(&txn, request(None, 2_000_338_301, " \n "))
        .await
        .is_err());
    assert!(save_alias(&txn, request(None, -1, "Синонім"))
        .await
        .is_err());
    let missing_id = Uuid::now_v7().to_string();
    assert!(save_alias(
        &txn,
        request(Some(missing_id), 2_000_338_301, "Синонім")
    )
    .await
    .is_err());

    let alias =
        save_alias(&txn, request(None, 2_000_338_301, "  Старе   Село  "))
            .await
            .unwrap();
    assert_eq!(alias.text, "Старе Село");
    assert_eq!(alias.settlement.id, 2_000_338_301);
    let other = save_alias(&txn, request(None, 2_000_338_302, "Старе Село"))
        .await
        .unwrap();
    let found = search_settlements(&txn, "СТАРЕ СЕЛО").await.unwrap();
    for id in [2_000_338_301, 2_000_338_302] {
        assert!(found.iter().any(|settlement| settlement.id == id));
    }
    let additional =
        save_alias(&txn, request(None, 2_000_338_301, "Інша назва"))
            .await
            .unwrap();
    let saved = save_alias(
        &txn,
        request(Some(alias.id.clone()), 2_000_338_302, "Нове Село"),
    )
    .await
    .unwrap();
    assert_eq!(saved.id, alias.id);
    assert_eq!(saved.settlement.id, 2_000_338_302);
    assert_eq!(saved.text, "Нове Село");
    let page = load_aliases(&txn, Uuid::nil()).await.unwrap();
    assert!(page.items.contains(&saved));
    assert!(page.items.contains(&additional));
    delete_alias(&txn, Uuid::parse_str(&saved.id).unwrap())
        .await
        .unwrap();
    assert!(!load_aliases(&txn, Uuid::nil())
        .await
        .unwrap()
        .items
        .contains(&saved));
    settlement::Entity::delete_by_id(2_000_338_302)
        .exec(&txn)
        .await
        .unwrap();
    assert!(settlement_alias::Entity::find_by_id(
        Uuid::parse_str(&other.id).unwrap()
    )
    .one(&txn)
    .await
    .unwrap()
    .is_none());
    txn.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn rejects_case_insensitive_duplicates_per_settlement_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    seed_settlement(&txn, 2_000_338_301, "Перша область").await;
    save_alias(&txn, request(None, 2_000_338_301, "Старе Село"))
        .await
        .unwrap();
    let error = save_alias(&txn, request(None, 2_000_338_301, " старе село "))
        .await
        .unwrap_err();
    assert!(error.to_string().as_str().contains("уже додано"));
    txn.rollback().await.unwrap();
}

#[tokio::test]
#[serial]
async fn paginates_aliases_without_skipping_rows_3383() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    seed_settlement(&txn, 2_000_338_301, "Перша область").await;
    settlement_alias::Entity::insert_many(
        (0..=SETTLEMENT_ALIAS_PAGE_SIZE).map(|index| {
            settlement_alias::ActiveModel {
                id: Set(Uuid::now_v7()),
                settlement_id: Set(2_000_338_301),
                text: Set(format!("Синонім {index}")),
            }
        }),
    )
    .exec(&txn)
    .await
    .unwrap();
    let first = load_aliases(&txn, Uuid::nil()).await.unwrap();
    assert_eq!(first.items.len(), SETTLEMENT_ALIAS_PAGE_SIZE as usize);
    let cursor = Uuid::parse_str(first.next_id.as_deref().unwrap()).unwrap();
    let next = load_aliases(&txn, cursor).await.unwrap();
    assert_eq!(next.items.len(), 1);
    assert!(next.next_id.is_none());
    assert!(!first.items.iter().any(|alias| alias.id == next.items[0].id));
    txn.rollback().await.unwrap();
}

#[actix_web::test]
#[serial]
async fn dictionary_endpoints_require_admin_3383() {
    use crate::entities::login;
    use actix_identity::IdentityMiddleware;
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        cookie::Key, test, App, HttpMessage, HttpRequest, HttpResponse,
    };

    async fn sign_in(req: HttpRequest, id: web::Data<Uuid>) -> HttpResponse {
        Identity::login(&req.extensions(), id.to_string()).unwrap();
        HttpResponse::Ok().finish()
    }

    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let account = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap();
    let mut account = account.into_active_model();
    account.roles = Set(serde_json::json!(["Rer"]));
    let account = account.update(&env.dbx).await.unwrap();
    let session_store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session_store, Key::generate()))
            .app_data(web::Data::from(env.clone()))
            .app_data(web::Data::new(account.id))
            .route("/test/sign-in", web::post().to(sign_in))
            .service(list_settlement_aliases)
            .service(search_alias_settlements)
            .service(save_settlement_alias)
            .service(delete_settlement_alias),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post().uri("/test/sign-in").to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let cases = [
        ("list", serde_json::json!({"afterId": null})),
        ("settlements", serde_json::json!({"query": "Мирне"})),
        (
            "save",
            serde_json::json!({"id": null, "settlementId": 1, "text": "Назва"}),
        ),
        (
            "delete",
            serde_json::json!({"id": Uuid::now_v7().to_string()}),
        ),
    ];
    for (endpoint, payload) in cases {
        let path = format!("/api/admin/ai-settlements/aliases/{endpoint}");
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&path)
                .set_json(&payload)
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNAUTHORIZED
        );
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&path)
                .cookie(cookie.clone())
                .set_json(&payload)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::FORBIDDEN);
    }
    let mut account = login::Entity::find_by_id(account.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    account.roles = Set(serde_json::json!(["Admin"]));
    account.update(&env.dbx).await.unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/ai-settlements/aliases/list")
            .cookie(cookie)
            .set_json(serde_json::json!({"afterId": null}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), actix_web::http::StatusCode::OK);
}
