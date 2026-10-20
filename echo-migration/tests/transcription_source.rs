use sea_orm::{
    ConnectionTrait, Database, DbBackend, Statement, TransactionTrait,
};

#[tokio::test]
async fn source_identity_is_unique_by_exact_key() {
    let name = std::env::var("TEST_DB_NAME").expect("isolated TEST_DB_NAME");
    assert!(name.starts_with("wd_test_"));
    let user = std::env::var("PGUSER")
        .or_else(|_| std::env::var("PG_USER"))
        .or_else(|_| std::env::var("USER"))
        .unwrap();
    let db = Database::connect(format!("postgresql://{user}@localhost/{name}"))
        .await
        .unwrap();
    let txn = db.begin().await.unwrap();
    let insert = |id: &str, key: &str| {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            "insert into transcription_source(id,source_key) values ($1::text::uuid,$2) on conflict(source_key) do update set source_key=excluded.source_key returning id::text",
            [id.to_owned().into(), key.to_owned().into()],
        )
    };
    let first = txn
        .query_one_raw(insert(
            "0199a111-0000-7000-8000-000000000001",
            "media/shared-audio",
        ))
        .await
        .unwrap()
        .unwrap();
    let replay = txn
        .query_one_raw(insert(
            "0199a111-0000-7000-8000-000000000002",
            "media/shared-audio",
        ))
        .await
        .unwrap()
        .unwrap();
    let other = txn
        .query_one_raw(insert(
            "0199a111-0000-7000-8000-000000000003",
            "device-audio/shared-audio",
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        first.try_get_by_index::<String>(0).unwrap(),
        replay.try_get_by_index::<String>(0).unwrap()
    );
    assert_ne!(
        first.try_get_by_index::<String>(0).unwrap(),
        other.try_get_by_index::<String>(0).unwrap()
    );
    txn.rollback().await.unwrap();
}
