pub use sea_orm_migration::prelude::*;

mod m20260719_174625_create_file_registry_device_file;
mod m20260721_124238_create_file_entry;
mod m20260721_124518_drop_legacy_device_file;
mod m20260728_111013_add_file_entry_journal_index;
mod m20260728_182132_add_file_entry_content_path;
mod m20260803_164204_file_entry_kind_and_windows_paths;
mod m20260806_160450_device_analytics_tags;
mod m20260807_125456_analytics_tag_rule_revision;
mod m20260807_162040_file_analysis_state;

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
            Box::new(m20260728_111013_add_file_entry_journal_index::Migration),
            Box::new(m20260728_182132_add_file_entry_content_path::Migration),
            Box::new(
                m20260803_164204_file_entry_kind_and_windows_paths::Migration,
            ),
            Box::new(m20260806_160450_device_analytics_tags::Migration),
            Box::new(m20260807_125456_analytics_tag_rule_revision::Migration),
            Box::new(m20260807_162040_file_analysis_state::Migration),
        ]
    }
}
