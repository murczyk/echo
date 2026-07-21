use crate::entities::{device, login};
use crate::functest::tests::{cleanup_locked, mk_login};
use crate::types::Uuid;
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, Statement,
    TransactionTrait,
};
use serde_json::{json, Value};
use std::error::Error as StdError;

#[tokio::test]
#[serial_test::serial]
async fn device_schema_enforces_target_fields() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    assert_exact_device_columns(&env.dbx).await;
    assert_device_aor_schema(&env.dbx).await;

    assert_legacy_device_file_table_is_absent(&env.dbx).await;
    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-schema-{}", Uuid::now_v7())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let custom_fields = json!({"inventory_id": "node-1", "transport": "ssh"});
    let saved = device_active_model(
        &login.login,
        "shared-source-label",
        Some("Analytical name"),
        custom_fields.clone(),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    let fetched = device::Entity::find_by_id(saved.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(fetched.name.as_deref(), Some("Analytical name"));
    assert_eq!(fetched.source_label, "shared-source-label");
    assert_eq!(fetched.custom_fields, custom_fields);

    let duplicate_source_label = device_active_model(
        &login.login,
        "shared-source-label",
        Some("Different name"),
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    assert_eq!(duplicate_source_label.source_label, "shared-source-label");

    let nullable_name = device_active_model(
        &login.login,
        "source-without-name",
        None,
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    assert_eq!(nullable_name.name, None);

    assert_device_check_fails(
        &env.dbx,
        &login.login,
        "   ",
        Some("Valid name"),
        json!({}),
        false,
        None,
    )
    .await;
    assert_device_check_fails(
        &env.dbx,
        &login.login,
        "valid-source-label",
        Some("   "),
        json!({}),
        false,
        None,
    )
    .await;
    assert_device_check_fails(
        &env.dbx,
        &login.login,
        "valid-source-label",
        Some("Valid name"),
        json!([]),
        false,
        None,
    )
    .await;
    assert_device_check_fails(
        &env.dbx,
        &login.login,
        "valid-source-label",
        Some("Valid name"),
        json!({}),
        false,
        Some(Utc::now().naive_utc()),
    )
    .await;
}

async fn assert_exact_device_columns(dbx: &DatabaseConnection) {
    let columns = dbx
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select column_name, is_nullable, column_default, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'device'
order by ordinal_position
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "column_name").unwrap(),
                row.try_get("", "is_nullable").unwrap(),
                row.try_get("", "column_default").unwrap(),
                row.try_get("", "data_type").unwrap(),
            )
        })
        .collect::<Vec<(String, String, Option<String>, String)>>();
    let expected_columns = [
        ("id", "NO", None, "uuid"),
        ("name", "YES", None, "text"),
        ("created_by", "NO", None, "text"),
        ("unit_id", "YES", None, "bigint"),
        ("tags", "NO", Some("'[]'::jsonb"), "jsonb"),
        ("external_url", "YES", None, "text"),
        ("archived", "NO", Some("false"), "boolean"),
        ("archived_at", "YES", None, "timestamp without time zone"),
        (
            "created_at",
            "NO",
            Some("(now() AT TIME ZONE 'utc'::text)"),
            "timestamp without time zone",
        ),
        (
            "updated_at",
            "NO",
            Some("(now() AT TIME ZONE 'utc'::text)"),
            "timestamp without time zone",
        ),
        ("source_label", "NO", None, "text"),
        ("custom_fields", "NO", None, "jsonb"),
    ]
    .into_iter()
    .map(|(name, nullable, default, data_type)| {
        (
            name.to_string(),
            nullable.to_string(),
            default.map(str::to_string),
            data_type.to_string(),
        )
    })
    .collect::<Vec<_>>();

    assert_eq!(columns, expected_columns);
}

async fn assert_legacy_device_file_table_is_absent(dbx: &DatabaseConnection) {
    let legacy_table: Option<String> = dbx
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "select to_regclass('public.device_file')::text as table_name"
                .to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "table_name")
        .unwrap();

    assert_eq!(legacy_table, None);
}

async fn assert_device_aor_schema(dbx: &DatabaseConnection) {
    let constraints = dbx
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select conname, contype::text, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.device_aor'::regclass
order by conname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "conname").unwrap(),
                row.try_get("", "contype").unwrap(),
                row.try_get("", "pg_get_constraintdef").unwrap(),
            )
        })
        .collect::<Vec<(String, String, String)>>();
    assert_eq!(
        constraints,
        [
            (
                "device_aor_aor_id_fkey",
                "f",
                "FOREIGN KEY (aor_id) REFERENCES area_of_responsibility(id) ON DELETE CASCADE",
            ),
            ("device_aor_aor_id_not_null", "n", "NOT NULL aor_id"),
            ("device_aor_created_at_not_null", "n", "NOT NULL created_at"),
            (
                "device_aor_device_aor_unique",
                "u",
                "UNIQUE (device_id, aor_id)",
            ),
            (
                "device_aor_device_id_fkey",
                "f",
                "FOREIGN KEY (device_id) REFERENCES device(id) ON DELETE CASCADE",
            ),
            ("device_aor_device_id_not_null", "n", "NOT NULL device_id"),
            ("device_aor_id_not_null", "n", "NOT NULL id"),
            ("device_aor_pkey", "p", "PRIMARY KEY (id)"),
        ]
        .into_iter()
        .map(|(name, kind, definition)| {
            (
                name.to_string(),
                kind.to_string(),
                definition.to_string(),
            )
        })
        .collect::<Vec<_>>(),
    );

    let indexes = dbx
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'device_aor'
order by indexname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "indexname").unwrap(),
                row.try_get("", "indexdef").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        indexes,
        [
            (
                "device_aor_aor_id_device_id_idx",
                "CREATE INDEX device_aor_aor_id_device_id_idx ON public.device_aor USING btree (aor_id, device_id)",
            ),
            (
                "device_aor_device_aor_unique",
                "CREATE UNIQUE INDEX device_aor_device_aor_unique ON public.device_aor USING btree (device_id, aor_id)",
            ),
            (
                "device_aor_device_id_idx",
                "CREATE INDEX device_aor_device_id_idx ON public.device_aor USING btree (device_id)",
            ),
            (
                "device_aor_pkey",
                "CREATE UNIQUE INDEX device_aor_pkey ON public.device_aor USING btree (id)",
            ),
        ]
        .into_iter()
        .map(|(name, definition)| (name.to_string(), definition.to_string()))
        .collect::<Vec<_>>(),
    );
}

async fn assert_device_check_fails(
    dbx: &DatabaseConnection,
    created_by: &str,
    source_label: &str,
    name: Option<&str>,
    custom_fields: Value,
    archived: bool,
    archived_at: Option<NaiveDateTime>,
) {
    let transaction = dbx.begin().await.unwrap();
    let error = device_active_model(
        created_by,
        source_label,
        name,
        custom_fields,
        archived,
        archived_at,
    )
    .insert(&transaction)
    .await
    .unwrap_err();
    assert!(
        has_postgres_error_code(&error, "23514"),
        "expected SQLSTATE 23514, got {error:?}"
    );
    transaction.rollback().await.unwrap();
}

fn device_active_model(
    created_by: &str,
    source_label: &str,
    name: Option<&str>,
    custom_fields: Value,
    archived: bool,
    archived_at: Option<NaiveDateTime>,
) -> device::ActiveModel {
    device::ActiveModel {
        id: Set(Uuid::now_v7()),
        name: Set(name.map(str::to_owned)),
        created_by: Set(created_by.to_string()),
        unit_id: Set(None),
        tags: Set(json!([])),
        external_url: Set(None),
        archived: Set(archived),
        archived_at: Set(archived_at),
        created_at: NotSet,
        updated_at: NotSet,
        source_label: Set(source_label.to_string()),
        custom_fields: Set(custom_fields),
    }
}

fn has_postgres_error_code(
    error: &(dyn StdError + 'static),
    code: &str,
) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(sqlx::Error::Database(database_error)) =
            error.downcast_ref::<sqlx::Error>()
        {
            if database_error.code().as_deref() == Some(code) {
                return true;
            }
        }
        source = error.source();
    }
    false
}
