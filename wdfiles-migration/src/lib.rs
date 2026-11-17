mod m20261023_071318_device_audio_forwarding;
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
mod m20260921_122222_device_sync_session_history;

mod m20261003_152726_create_device_audio;
mod m20261006_082251_device_documents;
mod m20261006_082252_file_history_search;
mod m20261007_162050_file_preview;
mod m20261008_124822_device_audio_preparation;
mod m20261008_183827_file_preview_archive_members;

mod m20261010_130006_device_audio_asr;
mod m20261012_094502_device_audio_asr_scan_indexes;

mod m20261016_165725_device_audio_transcription_pending;

mod m20261016_172538_retire_device_audio_asr_executor;

mod m20261014_182354_device_upload_finalization;
mod m20261017_101924_drop_device_audio_transcription_backfill;
mod m20261019_101619_file_archive_registry;
mod m20261024_090745_device_content_stats;
mod m20261024_090746_device_content_stats_pending_index;
mod m20261027_092423_failed_finalization_cleanup;
mod m20261027_093747_file_finalization_ownership;
mod m20261027_112601_synchronous_finalization_adoption;
mod m20261028_153759_finalization_terminal_metrics;
mod m20261030_143441_device_audio_activity_index;
mod m20261031_111058_device_list_activity_order;

mod m20261103_101213_file_markers;

mod m20261116_190308_device_document_claim_indexes;

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
            Box::new(m20260921_122222_device_sync_session_history::Migration),
            Box::new(m20261003_152726_create_device_audio::Migration),
            Box::new(m20261006_082251_device_documents::Migration),
            Box::new(m20261006_082252_file_history_search::Migration),
            Box::new(m20261007_162050_file_preview::Migration),
            Box::new(m20261008_124822_device_audio_preparation::Migration),
            Box::new(m20261008_183827_file_preview_archive_members::Migration),
            Box::new(m20261010_130006_device_audio_asr::Migration),
            Box::new(m20261012_094502_device_audio_asr_scan_indexes::Migration),
            Box::new(m20261016_165725_device_audio_transcription_pending::Migration),
            Box::new(m20261016_172538_retire_device_audio_asr_executor::Migration),
            Box::new(m20261017_101924_drop_device_audio_transcription_backfill::Migration),
            Box::new(m20261019_101619_file_archive_registry::Migration),
            Box::new(m20261023_071318_device_audio_forwarding::Migration),
            Box::new(m20261024_090745_device_content_stats::Migration),
            Box::new(m20261024_090746_device_content_stats_pending_index::Migration),
            Box::new(m20261014_182354_device_upload_finalization::Migration),
            Box::new(m20261027_092423_failed_finalization_cleanup::Migration),
            Box::new(m20261027_093747_file_finalization_ownership::Migration),
            Box::new(m20261027_112601_synchronous_finalization_adoption::Migration),
            Box::new(m20261028_153759_finalization_terminal_metrics::Migration),
            Box::new(m20261030_143441_device_audio_activity_index::Migration),
            Box::new(m20261031_111058_device_list_activity_order::Migration),
            Box::new(m20261103_101213_file_markers::Migration),
            Box::new(m20261116_190308_device_document_claim_indexes::Migration),
        ]
    }
}
