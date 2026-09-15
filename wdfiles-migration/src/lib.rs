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
mod m20260808_113748_file_analysis_device_queue;
mod m20260808_134904_file_analysis_retry_limit;
mod m20260808_134905_analytics_tag_test_expectation;
mod m20260810_120000_seed_default_analytics_tags;
mod m20260813_120128_batched_file_metadata_sync;
mod m20260815_152642_rename_file_sync_primary_key_columns;
mod m20260818_094542_batched_file_analysis_runs;
mod m20260819_100659_rename_file_metadata_revision_to_file_revision;
mod m20260819_103638_optional_source_file_state_settled_by;
mod m20260819_103954_update_file_entry_analysis_guard;
mod m20260905_160446_device_file_content;
mod m20260915_212032_reuse_verified_file_content;

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
            Box::new(m20260808_113748_file_analysis_device_queue::Migration),
            Box::new(m20260808_134904_file_analysis_retry_limit::Migration),
            Box::new(
                m20260808_134905_analytics_tag_test_expectation::Migration,
            ),
            Box::new(m20260810_120000_seed_default_analytics_tags::Migration),
            Box::new(m20260813_120128_batched_file_metadata_sync::Migration),
            Box::new(
                m20260815_152642_rename_file_sync_primary_key_columns::Migration,
            ),
            Box::new(
                m20260818_094542_batched_file_analysis_runs::Migration,
            ),
            Box::new(
                m20260819_100659_rename_file_metadata_revision_to_file_revision::Migration,
            ),
            Box::new(
                m20260819_103638_optional_source_file_state_settled_by::Migration,
            ),
            Box::new(
                m20260819_103954_update_file_entry_analysis_guard::Migration,
            ),
            Box::new(m20260905_160446_device_file_content::Migration),
            Box::new(m20260915_212032_reuse_verified_file_content::Migration),
        ]
    }
}
