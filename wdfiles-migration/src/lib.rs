pub use sea_orm_migration::prelude::*;

mod m20260719_174625_create_file_registry_device_file;
mod m20260721_124238_create_file_entry;
mod m20260721_124518_drop_legacy_device_file;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(
                m20260719_174625_create_file_registry_device_file::Migration,
            ),
            Box::new(m20260721_124238_create_file_entry::Migration),
            Box::new(m20260721_124518_drop_legacy_device_file::Migration),
        ]
    }
}
