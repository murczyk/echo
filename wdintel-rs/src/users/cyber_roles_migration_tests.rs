use crate::entities::{login, organism};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use echo_migration::{MigratorTrait, SchemaManager};
use sea_orm::{ActiveValue::Set, EntityTrait};
use serde_json::json;

#[tokio::test]
#[serial_test::serial]
async fn migration_merges_cyber_roles_for_users_and_organisms() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let cases = [
        (json!(["DeviceSource"]), json!(["Cyber"])),
        (json!(["CyberViewer"]), json!(["Cyber"])),
        (json!(["DeviceSource", "CyberViewer"]), json!(["Cyber"])),
        (
            json!([
                "Cyber",
                "Rer",
                "CyberViewer",
                "No2FA",
                "DeviceSource",
                "Cyber"
            ]),
            json!(["Rer", "No2FA", "Cyber"]),
        ),
        (json!(["Cyber", "Rer"]), json!(["Cyber", "Rer"])),
        (json!(["Admin", "Full"]), json!(["Admin", "Full"])),
        (json!([]), json!([])),
    ];
    let mut expected = Vec::new();
    for (roles, migrated_roles) in cases {
        for disabled in [false, true] {
            let mut organism = mk_organism(
                &env.dbx,
                organism::ActiveModel {
                    roles: Set(roles.clone()),
                    enabled: Set(!disabled),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let mut login = mk_login(
                &env.dbx,
                login::ActiveModel {
                    roles: Set(roles.clone()),
                    organism_id: Set(Some(organism.id)),
                    deleted: Set(disabled),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            organism.roles = migrated_roles.clone();
            login.roles = migrated_roles.clone();
            expected.push((organism, login));
        }
    }
    let migration = echo_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| migration.name().ends_with("_merge_cyber_roles"))
        .expect("Cyber role migration must be registered");
    let manager = SchemaManager::new(&env.dbx);
    for _ in 0..2 {
        migration.up(&manager).await.unwrap();
        for (organism, login) in &expected {
            assert_eq!(
                organism::Entity::find_by_id(organism.id)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .as_ref(),
                Some(organism),
            );
            assert_eq!(
                login::Entity::find_by_id(login.id)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .as_ref(),
                Some(login),
            );
        }
    }
}
