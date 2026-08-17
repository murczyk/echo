pub use sea_orm_migration::prelude::*;

mod m20220101_000001_create_table;
mod m20231226_134526_index_sigint_comment_signal_message_id;
mod m20231227_163602_sigint_unit;
mod m20240205_115451_etalonka;
mod m20240207_101323_etalonka_template_rm;
mod m20240228_110149_orgnism_roles_login_roles;
mod m20240228_111528_remove_login_roles;
mod m20240228_111624_organism_roles;
mod m20240228_130245_unit_add_comment;
mod m20240228_164429_battalion_rename;
mod m20240228_170631_unit_id_bigserial;
mod m20240229_130457_sigint_unit_changelog;
mod m20240229_135325_login_deleted;
mod m20240301_111707_sigint_callsign;
mod m20240301_122514_sigint_callsign_changelog;
mod m20240302_163722_sigint_source;
mod m20240304_152047_whatsapp_queue;
mod m20240306_170503_whatsapp_queue_attachment;
mod m20240311_112632_callsign_developing;
mod m20240312_221856_delta_kmz_to_geojson;
mod m20240313_144541_whatsapp_group_owner_jid_nullable;
mod m20240317_155625_enemy_units_geojson;
mod m20240319_063103_freqs;
mod m20240322_160658_sigint_network;
mod m20240322_173423_sigint_network_many_units;
mod m20240323_121129_signals_for_units;
mod m20240323_183428_sigint_network_comment;
mod m20240330_112320_sigint_inbox_signals;
mod m20240401_100321_callsign_radio_freq;
mod m20240415_190303_sigint_saved_filter_type;
mod m20240422_003312_sigint_inbox_item_freq_index;
mod m20240430_210133_sigint_bookmark_delete_column;
mod m20240430_222646_sigint_important_delete_column;
mod m20240430_234500_sigint_important_alter_user_id_column_default_value;
mod m20240501_124433_milgeo_settlement;
mod m20240501_134257_remove_freeair_tables;
mod m20240613_214633_sigint_inbox_item_text;
mod m20240628_070147_sigint_inbox_item_position;
mod m20240708_162645_sigint_inbox_item_no_header_to_jsonb;
mod m20240729_204813_organism_group_relation;
mod m20240803_083018_fix_increment_for_organism;
mod m20240805_134949_index_signal_group_to_datasource;
mod m20240806_111922_sigint_zone_deleted;
mod m20240814_113113_signal_attachment_signal_message_id_index;
mod m20240903_063201_alter_sigint_network_add_updated_by;
mod m20240903_151806_add_signal_message_deleted;
mod m20240925_170431_alter_signal_group_add_ignore_operativny;
mod m20241015_155823_add_sigint_inbox_locationv2;
mod m20241016_122639_add_sigint_coords_locv2;
mod m20241016_144306_setup_milgeo;
mod m20241021_074637_add_sigint_inbox_unitv2;
mod m20241022_155931_add_unitv2_marker;
mod m20241023_002404_reset_unitv2;
mod m20241025_140248_add_disable_organism;
mod m20241029_213653_reset_empty_locationv2;
mod m20241105_223723_add_inbox_coords_location;
mod m20241105_225447_add_sigint_network_location;
mod m20241108_222959_add_sigint_inbox_item_other_coords;
mod m20241110_180636_create_sigint_peleng;
mod m20241111_115744_add_delta_login;
mod m20241115_122835_parsed_unit_v2_notnull;
mod m20241127_125659_add_sigint_network_unit_changelog;
mod m20241129_075403_add_rb_settelments_milgeo;
mod m20241204_104300_add_rb_settelments_milgeo;
mod m20241227_080017_sigint_network_add_fields;
mod m20250101_003216_fix_start_of_year_data;
mod m20250115_170706_remove_obsolete_elalonka_tables;
mod m20250210_185135_change_search_index;
mod m20250214_120000_echo_inbox_message_seen_index;
mod m20250214_130500_signal_queue_indexes;
mod m20250214_131000_echo_inbox_message_internal_id_index;
mod m20250214_132500_echo_inbox_message_created_at_index;
mod m20250305_132553_new_networks_structure;
mod m20250318_225255_drop_inbox_item_freq;
mod m20250328_120859_assign_tags_ordering;
mod m20250408_073547_add_log_users_report_generation_table;
mod m20250410_065608_add_palitra_tag;
mod m20250410_094149_add_callsign_bind_table;
mod m20250412_180735_add_sigint_network_freq_changelog;
mod m20250416_171837_network_kind_uhf_rename;
mod m20250416_183523_network_kind_uhf_rename_part2;
mod m20250417_060930_add_merge_api_login;
mod m20250417_082042_network_kind_uhf_rename_part3;
mod m20250417_150320_fix_merge_login_migration;
mod m20250418_095050_add_active_from_to_for_network;
mod m20250418_103016_add_logging_for_networks;
mod m20250421_130108_add_secret_chats;
mod m20250424_191053_add_modulation_to_network;
mod m20250430_090456_add_sigint_post;
mod m20250502_124932_network_description;
mod m20250525_151839_add_kind_and_modulation_to_network_freqs;
mod m20250525_195819_add_sigint_network_description_freq;
mod m20250526_141346_add_sigint_network_callsign;
mod m20250528_151120_add_sigint_settlement;
mod m20250530_143601_drop_sigint_settlements;
mod m20250530_211149_add_sigint_settlement;
mod m20250602_112459_add_freq_activity_history;
mod m20250604_053059_add_sigint_network_activity_history;
mod m20250611_044845_idx_sigint_network_callsign_callsign_id;
mod m20250611_045218_idx_sigint_callsign_callsign_deleted;
mod m20250612_065458_sigint_network_callsign_id_to_text;
mod m20250617_111140_update_login_table;
mod m20250628_175425_add_organism_hierarchy;
mod m20250702_115302_add_noautologout_role;
mod m20250710_094800_remove_comment_from_network;
mod m20250713_091110_add_tsvector_to_units;
mod m20250714_150613_add_sigint_origin;
mod m20250715_124452_add_system_login;
mod m20250716_150622_add_mothership_post;
mod m20250722_144413_add_messenger_account;
mod m20250730_084125_add_area_of_responsibility;
mod m20250730_090455_add_messenger_account_description;
mod m20250730_181007_add_group_admin_data;
mod m20250731_115541_expand_aor_table;
mod m20250801_080750_add_cascade_fk;
mod m20250802_081423_migrate_account_to_datasource;
mod m20250802_141246_add_message_external_id;
mod m20250803_080948_add_datasource_aor;
mod m20250803_175404_fix_datasource_id_seq;
mod m20250804_100857_remove_messenger_account;
mod m20250808_153740_add_deleted_permanently;
mod m20250809_064407_drop_callsing_bind_table;
mod m20250809_072634_alter_network_callsign_table;
mod m20250811_140034_add_default_organism;
mod m20250816_160937_default_big_aor;
mod m20250817_172424_add_modulation;
mod m20250818_080807_add_radio_freq_to_network_callsign;
mod m20250818_124718_sigint_network_freq_deleted;
mod m20250821_173159_add_developing_field_to_network_callsign;
mod m20250822_190939_add_message_id;
mod m20250823_115254_trim_callsigns;
mod m20250823_182737_fix_network_freqs_format;
mod m20250824_080657_add_datasource_api_login;
mod m20250825_105052_add_unit_developing;
mod m20250825_182526_rename_sources;
mod m20250825_192410_make_callsign_sources_optional;
mod m20250826_094122_add_datasource_group;
mod m20250826_190501_add_deleted_to_groups;
mod m20250827_115758_add_main_station_to_network_callsign;
mod m20250828_164520_drop_mothership_id;
mod m20250828_185442_add_aor_sigint_origin_id;
mod m20250829_104933_set_network_active_from_nullable;
mod m20250829_133754_add_original_id;
mod m20250829_170110_add_new_sigint_origins;
mod m20250830_065224_add_datasource_mainenatce_attributes;
mod m20250830_145026_fix_merge_networks_login;
mod m20250831_075948_add_sigint_network_callsign_changelog;
mod m20250902_132740_add_datasource_group_id_to_message;
mod m20250903_075616_remove_legacy_message_columns;
mod m20250903_091910_rename_datasource_group_id;
mod m20250905_212243_add_organism_aor;
mod m20250911_194424_deleted_datasource_group;
mod m20250912_073903_drop_group_auto_link;
mod m20251011_090052_add_settlement_tag;
mod m20251016_085427_add_datasource_last_sync_at_ts;
mod m20251020_120000_signal_message_group;
mod m20251023_130959_create_palitra_tables;
mod m20251024_092630_add_palitra_point_label;
mod m20251030_093422_add_geometry_columns;
mod m20251106_125324_drop_datasource_legacy_columns;
mod m20251107_102225_datasource_default_status;
mod m20251111_145848_add_signal_queue;
mod m20251112_000000_signal_queue_indexes;
mod m20251113_093602_add_group_stats_tables;
mod m20251115_105217_add_echo_indexes;
mod m20251117_100845_update_stats;
mod m20251117_104540_add_freq_group_stats;
mod m20251117_141654_rename_stats;
mod m20251118_114747_add_more_stats;
mod m20251118_183849_add_signal_message_group_fk;
mod m20251119_121701_fix_tag_stats;
mod m20251124_084954_signal_message_media;
mod m20251124_145441_add_group_batch;
mod m20251127_112149_delete_signal_attachments;
mod m20251129_112846_sigint_inbox_item_tags_many_to_many;
mod m20251129_124751_sigint_inbox_item_tags_unique;
mod m20251204_070600_tags_keywords;
mod m20251205_121716_tag_suggestion_worker_queue;
mod m20251206_234500_add_signal_message_indexes;
mod m20251215_110739_tag_keywords_seed_data;
mod m20251215_130030_sigint_inbox_tag_multilabel;
mod m20251215_143321_drop_signal_group_notes;
mod m20251223_131547_tag_keywords_negative_forms;
mod m20251223_144906_seed_negative_keyword_forms;
mod m20251227_093913_add_bgtask_res_url;
mod m20251229_181328_enemy_units_geojson_s3_keys;
mod m20260106_080738_add_freq_key;
mod m20260108_005722_add_sigint_network_encryption_key_fields;
mod m20260108_153000_add_key_modulation_and_freqs;
mod m20260110_123009_drop_tyt_veda;
mod m20260115_135733_add_enc_key_hash;
mod m20260119_134955_drop_signal_message_duplicate_of;
mod m20260121_090000_add_sigint_inbox_item_network;
mod m20260121_150103_add_network_invalidation_task_col;
mod m20260122_133442_add_sigint_key_share_policy;
mod m20260123_082757_add_stale_task;
mod m20260124_161520_add_sigint_inbox_item_network_indexes;
mod m20260126_083712_add_network_invalidation_task_aor;
mod m20260206_175400_palitra_point_search_indexes;
mod m20260211_161110_add_network_invalidation_task_tag;
mod m20260212_150900_palitra_point_label_lower_pat_idx;
mod m20260212_164832_add_worker_status;
mod m20260216_120000_add_network_group_stats;
mod m20260218_120000_add_aor_location_config;
mod m20260219_090000_add_aor_location_configs_json;
mod m20260225_090001_add_table_sigint_inbox_item_point_tokens;
mod m20260225_174500_add_palitra_point_lexeme;
mod m20260301_123031_inbox_item_points_per_palitra;
mod m20260303_171130_add_palitra_polygon;
mod m20260303_200001_add_organism_goi_connection_fields;
mod m20260304_124501_palitra_highlight_worker_job;
mod m20260305_100926_palitra_tag_flag;
mod m20260305_115200_add_callsign_additional_source;
mod m20260306_101500_palitra_v2_indexes;
mod m20260310_091035_add_sigint_inbox_item_metadata;
mod m20260311_120331_add_sigint_inbox_item_metadata_indices;
mod m20260313_120000_add_sigint_inbox_item_metadata_spans;
mod m20260315_190000_add_goi_api_and_association;
mod m20260317_120000_sigint_network_list_perf_indexes;
mod m20260317_214944_add_goi_knowledge;
mod m20260317_234004_add_goi_knowledge_deleted_at;
mod m20260318_110000_add_sigint_network_freq_last_seen_dt;
mod m20260318_131247_add_organism_goi_integration_type;
mod m20260319_011722_add_system_settings;
mod m20260325_120000_add_user_settings;
mod m20260325_123200_add_rer_duty_test_settings;
mod m20260326_120000_add_full_name_to_sigint_callsign;
mod m20260329_184900_add_palitra_line_strings;
mod m20260331_230927_add_palitra_s3_id;
mod m20260406_194408_palitra_archive_and_folder;
mod m20260406_210334_add_goi_integrations;
mod m20260420_114249_add_aor_order_for_report;
mod m20260420_193430_add_rer_duty_historical_replay;
mod m20260426_191910_add_slowlog_perf_indexes;
mod m20260429_175416_add_signal_message_group_lookup_indexes;
mod m20260429_181706_add_datasource_group_lookup_index;
mod m20260429_212239_tune_datasource_autovacuum;
mod m20260430_120000_add_analysis_map_in_sidebar;
mod m20260507_151045_add_palitra_goi_sync_job;
mod m20260510_101006_operator_dmr_metadata;
mod m20260511_145205_delta_login_lower_unique;
mod m20260513_102326_add_sigint_network_description_topic;
mod m20260515_120000_add_sigint_post_id_to_sigint_comment;
mod m20260519_091147_add_command_control_to_sigint_network_callsign;
mod m20260520_120000_create_organism_keyword_set;
mod m20260529_110000_add_short_url_to_admin_config;
mod m20260601_000000_add_release_news_viewed;
mod m20260602_153344_add_signal_group_admin;
mod m20260605_162305_echo_swapp_sync_state;
mod m20260609_115925_add_api_integration;
mod m20260610_123823_add_api_integration_sync;
mod m20260616_153800_create_report_history;
mod m20260618_120000_rename_modulation_to_encryption_ddl;
mod m20260619_101731_report_history_created_at_idx;
mod m20260622_090245_aor_report_order_scope;
mod m20260622_101608_add_signal_group_archive;
mod m20260626_101738_non_rer_interceptions;
mod m20260626_220129_signal_group_fills_etalonka;
mod m20260627_101500_add_sigint_network_do_not_archive;
mod m20260627_180543_signal_group_disable_network_assignment;
mod m20260628_114539_add_peleng_bounds_to_system_settings;
mod m20260629_072958_add_signal_message_operator_tags;
mod m20260629_080533_unit_tags_on_sigint_network;
mod m20260629_085034_signal_message_operator_tags;
mod m20260630_094347_interseption_kind_and_unit_mask;
mod m20260630_130141_signal_group_merge_network_assignment_flags;
mod m20260630_210912_goi_palitra_sync_upgrade;
mod m20260701_073733_default_neo_analysis;
mod m20260701_100000_backfill_deleted_freq_active_to;
mod m20260701_120000_goi_palitra_sync_multi_palitra;
mod m20260701_152707_goi_palitra_sync_side_checksums;
mod m20260701_160523_palitra_conversion_job_goi_upload_flag;
mod m20260702_145245_create_sigint_comment;
mod m20260702_155737_echo_im_sync_since;
mod m20260702_173206_echo_missing_messages;
mod m20260702_192716_signal_message_echo_inbox_message_id;
mod m20260703_095738_add_organism_to_tags;
mod m20260705_230242_operator_datasource_group_perf;
mod m20260706_142937_add_goi_integration_pause_worker;
mod m20260706_153312_tag_unique_enabled_organism_label;
mod m20260707_081900_create_devices;
mod m20260707_095504_echo_missing_message_deleted_status;
mod m20260707_132105_create_device_aor;
mod m20260707_135501_drop_device_aor_id;
mod m20260707_164344_echo_missing_message_duplicate_status;
mod m20260707_170000_signal_message_attachments_hash;
mod m20260707_180541_rename_device_tags_archive;
mod m20260707_212500_echo_missing_message_duplicate_backfill;
mod m20260708_083252_add_cyber_echo_enabled_to_settings;
mod m20260708_130958_add_computer_name;
mod m20260708_143111_add_computer_name_search_indexes;
mod m20260709_092435_add_system_settings_notifications;
mod m20260709_124309_signal_message_queue_latest_state;
mod m20260709_140720_rename_computer_name_to_device_name;
mod m20260710_091610_organism_secret_group_invites;
mod m20260710_095803_echo_missing_message_created_at_idx;
mod m20260710_102248_add_login_description;
mod m20260711_120000_add_sigint_comment_parsing_to_system_settings;
mod m20260712_204007_add_do_not_store_duplicate_echoim_failures;
mod m20260713_152932_rename_cyber_echo_enabled_to_devices_section_enabled;
mod m20260715_092901_add_sigint_inbox_item_network;
mod m20260716_101007_device_hostname_ssh_port_and_drop_name_uniqueness;
mod m20260716_134601_device_aor_id_uuid;
mod m20260716_161040_login_uuid_v7;
mod m20260717_111121_goi_palitra_sync_changelog_source;
mod m20260720_100029_analysis_stats_query_indexes;
mod m20260720_124323_add_signal_message_media_is_encrypted;
mod m20260721_120720_device_source_label_custom_fields;
mod m20260721_124518_drop_legacy_device_file;
mod m20260721_141920_echo_analytics_heartbeat;
mod m20260721_191340_goi_association_message_uid;
mod m20260721_200001_goi_message_uid_worker_setting;
mod m20260721_200002_goi_message_uid_lookup_indexes;
mod m20260721_203106_add_audio_transcription_setting;
mod m20260723_125003_palitra_highlight_blacklist;
mod m20260723_134939_goi_knowledge_prune_index;
mod m20260723_151016_add_full_name_to_sigint_network_callsign;
mod m20260723_185734_sigint_unit_attachments;
mod m20260724_080724_add_login_password_auth_enabled;
mod m20260724_095619_add_report_generation_settings;
mod m20260725_082926_index_network_callsign_lower;
mod m20260725_110839_add_audio_transcription_collapse_preferences;
mod m20260725_120000_group_stats_recalculation_task;
mod m20260727_065339_fix_direct_submit_profile_names;
mod m20260727_075435_add_ai_engines;
mod m20260727_080639_group_stats_recalculation_task_pending_unique;
mod m20260727_094537_add_ai_callsign_parsing;
mod m20260727_101425_propagate_network_callsign_full_name;
mod m20260727_102348_add_ai_callsign_worker;
mod m20260727_162911_add_analysis_callsign_form_setting;
mod m20260728_084158_index_inbox_item_unit_datetime;
mod m20260728_163700_add_echo_client_display_name;
mod m20260728_203332_propagate_echo_client_display_name;
mod m20260729_062653_add_classic_menu_visibility_settings;
mod m20260729_121823_drop_postgres_group_stats;
mod m20260729_143549_add_device_organism;
mod m20260729_155811_add_sigint_inbox_item_callsign;
mod m20260729_170544_orbit_units;
mod m20260730_125429_orbit_unit_grouping_many_to_many;
mod m20260730_134741_orbit_unit_sigint_unit;
mod m20260730_151706_unique_orbit_link_per_sigint_unit;
mod m20260731_080107_allow_multiple_orbit_links_per_sigint_unit;
mod m20260731_121431_add_pelengation_object;
mod m20260731_145031_orbit_sync;
mod m20260731_220945_persist_manual_orbit_links;
mod m20260731_234500_orbit_unit_search_indexes;
mod m20260801_085538_suppress_deleted_orbit_links;
mod m20260802_174927_rer_duty_test_replay;
mod m20260803_093803_echo_automation_send_log;
mod m20260803_130117_device_source_role_and_name;
mod m20260803_212227_ai_agent_harness;
mod m20260804_091538_sigint_comment_blacklist;
mod m20260804_093435_hide_orbit_data;
mod m20260804_094408_sigint_unit_deduplicate_candidate;
mod m20260804_095344_ai_agent_dispatcher;
mod m20260805_064150_ai_agent_mattermost_chat;
mod m20260805_135334_sigint_unit_orbit_note;
mod m20260806_091349_add_sigint_inbox_item_datetime_neo;
mod m20260806_120000_drop_legacy_inbox_callsigns;
mod m20260806_134330_sigint_unit_extended_echelons;
mod m20260806_141904_report_history_duplicate_lookup;
mod m20260810_062938_echo_automation_coordinates_screenshot;
mod m20260810_140653_inbox_unit_resolution;
mod m20260811_064758_sigint_inbox_item_units;
mod m20260811_073954_failed_inbox_unit_bad_text_index;
mod m20260811_142447_failed_inbox_unit_note;
mod m20260811_161634_failed_inbox_unit_multi_text;
mod m20260812_113859_signal_message_copy;
mod m20260812_115511_sigint_inbox_item_datetime_neo_indexes;
mod m20260813_183642_sigint_unit_orbit_echelons;
mod m20260815_125337_add_sigint_comment_migration_marker;
mod m20260816_102640_ocr;
mod m20260816_173322_media_summary;
mod m20260817_125243_add_intel_prod_relation_kind;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20220101_000001_create_table::Migration),
            Box::new(m20231226_134526_index_sigint_comment_signal_message_id::Migration),
            Box::new(m20231227_163602_sigint_unit::Migration),
            Box::new(m20240205_115451_etalonka::Migration),
            Box::new(m20240207_101323_etalonka_template_rm::Migration),
            Box::new(m20240228_110149_orgnism_roles_login_roles::Migration),
            Box::new(m20240228_111528_remove_login_roles::Migration),
            Box::new(m20240228_111624_organism_roles::Migration),
            Box::new(m20240228_130245_unit_add_comment::Migration),
            Box::new(m20240228_164429_battalion_rename::Migration),
            Box::new(m20240228_170631_unit_id_bigserial::Migration),
            Box::new(m20240229_130457_sigint_unit_changelog::Migration),
            Box::new(m20240229_135325_login_deleted::Migration),
            Box::new(m20240301_111707_sigint_callsign::Migration),
            Box::new(m20240301_122514_sigint_callsign_changelog::Migration),
            Box::new(m20240302_163722_sigint_source::Migration),
            Box::new(m20240304_152047_whatsapp_queue::Migration),
            Box::new(m20240306_170503_whatsapp_queue_attachment::Migration),
            Box::new(m20240311_112632_callsign_developing::Migration),
            Box::new(m20240312_221856_delta_kmz_to_geojson::Migration),
            Box::new(m20240313_144541_whatsapp_group_owner_jid_nullable::Migration),
            Box::new(m20240317_155625_enemy_units_geojson::Migration),
            Box::new(m20240319_063103_freqs::Migration),
            Box::new(m20240322_160658_sigint_network::Migration),
            Box::new(m20240322_173423_sigint_network_many_units::Migration),
            Box::new(m20240323_121129_signals_for_units::Migration),
            Box::new(m20240323_183428_sigint_network_comment::Migration),
            Box::new(m20240330_112320_sigint_inbox_signals::Migration),
            Box::new(m20240401_100321_callsign_radio_freq::Migration),
            Box::new(m20240415_190303_sigint_saved_filter_type::Migration),
            Box::new(m20240422_003312_sigint_inbox_item_freq_index::Migration),
            Box::new(m20240430_210133_sigint_bookmark_delete_column::Migration),
            Box::new(m20240430_222646_sigint_important_delete_column::Migration),
            Box::new(m20240430_234500_sigint_important_alter_user_id_column_default_value::Migration),
            Box::new(m20240501_124433_milgeo_settlement::Migration),
            Box::new(m20240501_134257_remove_freeair_tables::Migration),
            Box::new(m20240613_214633_sigint_inbox_item_text::Migration),
            Box::new(m20240628_070147_sigint_inbox_item_position::Migration),
            Box::new(m20240708_162645_sigint_inbox_item_no_header_to_jsonb::Migration),
            Box::new(m20240729_204813_organism_group_relation::Migration),
            Box::new(m20240803_083018_fix_increment_for_organism::Migration),
            Box::new(m20240805_134949_index_signal_group_to_datasource::Migration),
            Box::new(m20240806_111922_sigint_zone_deleted::Migration),
            Box::new(m20240814_113113_signal_attachment_signal_message_id_index::Migration),
            Box::new(m20240903_063201_alter_sigint_network_add_updated_by::Migration),
            Box::new(m20240903_151806_add_signal_message_deleted::Migration),
            Box::new(m20240925_170431_alter_signal_group_add_ignore_operativny::Migration),
            Box::new(m20241015_155823_add_sigint_inbox_locationv2::Migration),
            Box::new(m20241016_122639_add_sigint_coords_locv2::Migration),
            Box::new(m20241016_144306_setup_milgeo::Migration),
            Box::new(m20241021_074637_add_sigint_inbox_unitv2::Migration),
            Box::new(m20241022_155931_add_unitv2_marker::Migration),
            Box::new(m20241023_002404_reset_unitv2::Migration),
            Box::new(m20241025_140248_add_disable_organism::Migration),
            Box::new(m20241029_213653_reset_empty_locationv2::Migration),
            Box::new(m20241105_223723_add_inbox_coords_location::Migration),
            Box::new(m20241105_225447_add_sigint_network_location::Migration),
            Box::new(m20241108_222959_add_sigint_inbox_item_other_coords::Migration),
            Box::new(m20241110_180636_create_sigint_peleng::Migration),
            Box::new(m20241111_115744_add_delta_login::Migration),
            Box::new(m20241115_122835_parsed_unit_v2_notnull::Migration),
            Box::new(m20241127_125659_add_sigint_network_unit_changelog::Migration),
            Box::new(m20241129_075403_add_rb_settelments_milgeo::Migration),
            Box::new(m20241204_104300_add_rb_settelments_milgeo::Migration),
            Box::new(m20241227_080017_sigint_network_add_fields::Migration),
            Box::new(m20250101_003216_fix_start_of_year_data::Migration),
            Box::new(m20250115_170706_remove_obsolete_elalonka_tables::Migration),
            Box::new(m20250210_185135_change_search_index::Migration),
            Box::new(m20250214_120000_echo_inbox_message_seen_index::Migration),
            Box::new(m20250214_130500_signal_queue_indexes::Migration),
            Box::new(m20250214_131000_echo_inbox_message_internal_id_index::Migration),
            Box::new(m20250214_132500_echo_inbox_message_created_at_index::Migration),
            Box::new(m20250305_132553_new_networks_structure::Migration),
            Box::new(m20250318_225255_drop_inbox_item_freq::Migration),
            Box::new(m20250328_120859_assign_tags_ordering::Migration),
            Box::new(m20250408_073547_add_log_users_report_generation_table::Migration),
            Box::new(m20250410_065608_add_palitra_tag::Migration),
            Box::new(m20250410_094149_add_callsign_bind_table::Migration),
            Box::new(m20250412_180735_add_sigint_network_freq_changelog::Migration),
            Box::new(m20250416_171837_network_kind_uhf_rename::Migration),
            Box::new(m20250416_183523_network_kind_uhf_rename_part2::Migration),
            Box::new(m20250417_060930_add_merge_api_login::Migration),
            Box::new(m20250417_082042_network_kind_uhf_rename_part3::Migration),
            Box::new(m20250417_150320_fix_merge_login_migration::Migration),
            Box::new(m20250418_095050_add_active_from_to_for_network::Migration),
            Box::new(m20250418_103016_add_logging_for_networks::Migration),
            Box::new(m20250421_130108_add_secret_chats::Migration),
            Box::new(m20250424_191053_add_modulation_to_network::Migration),
            Box::new(m20250430_090456_add_sigint_post::Migration),
            Box::new(m20250502_124932_network_description::Migration),
            Box::new(m20250525_151839_add_kind_and_modulation_to_network_freqs::Migration),
            Box::new(m20250525_195819_add_sigint_network_description_freq::Migration),
            Box::new(m20250526_141346_add_sigint_network_callsign::Migration),
            Box::new(m20250528_151120_add_sigint_settlement::Migration),
            Box::new(m20250530_143601_drop_sigint_settlements::Migration),
            Box::new(m20250530_211149_add_sigint_settlement::Migration),
            Box::new(m20250602_112459_add_freq_activity_history::Migration),
            Box::new(m20250604_053059_add_sigint_network_activity_history::Migration),
            Box::new(m20250611_044845_idx_sigint_network_callsign_callsign_id::Migration),
            Box::new(m20250611_045218_idx_sigint_callsign_callsign_deleted::Migration),
            Box::new(m20250612_065458_sigint_network_callsign_id_to_text::Migration),
            Box::new(m20250617_111140_update_login_table::Migration),
            Box::new(m20250628_175425_add_organism_hierarchy::Migration),
            Box::new(m20250702_115302_add_noautologout_role::Migration),
            Box::new(m20250710_094800_remove_comment_from_network::Migration),
            Box::new(m20250713_091110_add_tsvector_to_units::Migration),
            Box::new(m20250714_150613_add_sigint_origin::Migration),
            Box::new(m20250715_124452_add_system_login::Migration),
            Box::new(m20250716_150622_add_mothership_post::Migration),
            Box::new(m20250722_144413_add_messenger_account::Migration),
            Box::new(m20250730_084125_add_area_of_responsibility::Migration),
            Box::new(m20250730_090455_add_messenger_account_description::Migration),
            Box::new(m20250730_181007_add_group_admin_data::Migration),
            Box::new(m20250731_115541_expand_aor_table::Migration),
            Box::new(m20250801_080750_add_cascade_fk::Migration),
            Box::new(m20250802_081423_migrate_account_to_datasource::Migration),
            Box::new(m20250802_141246_add_message_external_id::Migration),
            Box::new(m20250803_080948_add_datasource_aor::Migration),
            Box::new(m20250803_175404_fix_datasource_id_seq::Migration),
            Box::new(m20250804_100857_remove_messenger_account::Migration),
            Box::new(m20250808_153740_add_deleted_permanently::Migration),
            Box::new(m20250809_064407_drop_callsing_bind_table::Migration),
            Box::new(m20250809_072634_alter_network_callsign_table::Migration),
            Box::new(m20250811_140034_add_default_organism::Migration),
            Box::new(m20250816_160937_default_big_aor::Migration),
            Box::new(m20250817_172424_add_modulation::Migration),
            Box::new(m20250818_080807_add_radio_freq_to_network_callsign::Migration),
            Box::new(m20250818_124718_sigint_network_freq_deleted::Migration),
            Box::new(m20250821_173159_add_developing_field_to_network_callsign::Migration),
            Box::new(m20250822_190939_add_message_id::Migration),
            Box::new(m20250823_115254_trim_callsigns::Migration),
            Box::new(m20250823_182737_fix_network_freqs_format::Migration),
            Box::new(m20250824_080657_add_datasource_api_login::Migration),
            Box::new(m20250825_105052_add_unit_developing::Migration),
            Box::new(m20250825_182526_rename_sources::Migration),
            Box::new(m20250825_192410_make_callsign_sources_optional::Migration),
            Box::new(m20250826_094122_add_datasource_group::Migration),
            Box::new(m20250826_190501_add_deleted_to_groups::Migration),
            Box::new(m20250827_115758_add_main_station_to_network_callsign::Migration),
            Box::new(m20250828_164520_drop_mothership_id::Migration),
            Box::new(m20250828_185442_add_aor_sigint_origin_id::Migration),
            Box::new(m20250829_104933_set_network_active_from_nullable::Migration),
            Box::new(m20250829_133754_add_original_id::Migration),
            Box::new(m20250829_170110_add_new_sigint_origins::Migration),
            Box::new(m20250830_065224_add_datasource_mainenatce_attributes::Migration),
            Box::new(m20250830_145026_fix_merge_networks_login::Migration),
            Box::new(m20250831_075948_add_sigint_network_callsign_changelog::Migration),
            Box::new(m20250902_132740_add_datasource_group_id_to_message::Migration),
            Box::new(m20250903_075616_remove_legacy_message_columns::Migration),
            Box::new(m20250903_091910_rename_datasource_group_id::Migration),
            Box::new(m20250905_212243_add_organism_aor::Migration),
            Box::new(m20250911_194424_deleted_datasource_group::Migration),
            Box::new(m20250912_073903_drop_group_auto_link::Migration),
            Box::new(m20251011_090052_add_settlement_tag::Migration),
            Box::new(m20251016_085427_add_datasource_last_sync_at_ts::Migration),
            Box::new(m20251020_120000_signal_message_group::Migration),
            Box::new(m20251023_130959_create_palitra_tables::Migration),
            Box::new(m20251024_092630_add_palitra_point_label::Migration),
            Box::new(m20251030_093422_add_geometry_columns::Migration),
            Box::new(m20251106_125324_drop_datasource_legacy_columns::Migration),
            Box::new(m20251107_102225_datasource_default_status::Migration),
            Box::new(m20251111_145848_add_signal_queue::Migration),
            Box::new(m20251112_000000_signal_queue_indexes::Migration),
            Box::new(m20251113_093602_add_group_stats_tables::Migration),
            Box::new(m20251115_105217_add_echo_indexes::Migration),
            Box::new(m20251117_100845_update_stats::Migration),
            Box::new(m20251117_104540_add_freq_group_stats::Migration),
            Box::new(m20251117_141654_rename_stats::Migration),
            Box::new(m20251118_114747_add_more_stats::Migration),
            Box::new(m20251118_183849_add_signal_message_group_fk::Migration),
            Box::new(m20251119_121701_fix_tag_stats::Migration),
            Box::new(m20251124_084954_signal_message_media::Migration),
            Box::new(m20251124_145441_add_group_batch::Migration),
            Box::new(m20251127_112149_delete_signal_attachments::Migration),
            Box::new(m20251129_112846_sigint_inbox_item_tags_many_to_many::Migration),
            Box::new(m20251129_124751_sigint_inbox_item_tags_unique::Migration),
            Box::new(m20251204_070600_tags_keywords::Migration),
            Box::new(m20251205_121716_tag_suggestion_worker_queue::Migration),
            Box::new(m20251206_234500_add_signal_message_indexes::Migration),
            Box::new(m20251215_110739_tag_keywords_seed_data::Migration),
            Box::new(m20251215_130030_sigint_inbox_tag_multilabel::Migration),
            Box::new(m20251215_143321_drop_signal_group_notes::Migration),
            Box::new(m20251223_131547_tag_keywords_negative_forms::Migration),
            Box::new(m20251223_144906_seed_negative_keyword_forms::Migration),
            Box::new(m20251227_093913_add_bgtask_res_url::Migration),
            Box::new(m20251229_181328_enemy_units_geojson_s3_keys::Migration),
            Box::new(m20260106_080738_add_freq_key::Migration),
            Box::new(m20260108_005722_add_sigint_network_encryption_key_fields::Migration),
            Box::new(m20260108_153000_add_key_modulation_and_freqs::Migration),
            Box::new(m20260110_123009_drop_tyt_veda::Migration),
            Box::new(m20260115_135733_add_enc_key_hash::Migration),
            Box::new(m20260119_134955_drop_signal_message_duplicate_of::Migration),
            Box::new(m20260121_090000_add_sigint_inbox_item_network::Migration),
            Box::new(m20260121_150103_add_network_invalidation_task_col::Migration),
            Box::new(m20260122_133442_add_sigint_key_share_policy::Migration),
            Box::new(m20260123_082757_add_stale_task::Migration),
            Box::new(m20260124_161520_add_sigint_inbox_item_network_indexes::Migration),
            Box::new(m20260126_083712_add_network_invalidation_task_aor::Migration),
            Box::new(m20260206_175400_palitra_point_search_indexes::Migration),
            Box::new(m20260211_161110_add_network_invalidation_task_tag::Migration),
            Box::new(m20260212_150900_palitra_point_label_lower_pat_idx::Migration),
            Box::new(m20260212_164832_add_worker_status::Migration),
            Box::new(m20260216_120000_add_network_group_stats::Migration),
            Box::new(m20260218_120000_add_aor_location_config::Migration),
            Box::new(m20260219_090000_add_aor_location_configs_json::Migration),
            Box::new(m20260225_090001_add_table_sigint_inbox_item_point_tokens::Migration),
            Box::new(m20260225_174500_add_palitra_point_lexeme::Migration),
            Box::new(m20260301_123031_inbox_item_points_per_palitra::Migration),
            Box::new(m20260303_171130_add_palitra_polygon::Migration),
            Box::new(m20260303_200001_add_organism_goi_connection_fields::Migration),
            Box::new(m20260304_124501_palitra_highlight_worker_job::Migration),
            Box::new(m20260305_100926_palitra_tag_flag::Migration),
            Box::new(m20260305_115200_add_callsign_additional_source::Migration),
            Box::new(m20260306_101500_palitra_v2_indexes::Migration),
            Box::new(m20260310_091035_add_sigint_inbox_item_metadata::Migration),
            Box::new(m20260311_120331_add_sigint_inbox_item_metadata_indices::Migration),
            Box::new(m20260313_120000_add_sigint_inbox_item_metadata_spans::Migration),
            Box::new(m20260315_190000_add_goi_api_and_association::Migration),
            Box::new(m20260317_120000_sigint_network_list_perf_indexes::Migration),
            Box::new(m20260317_214944_add_goi_knowledge::Migration),
            Box::new(m20260317_234004_add_goi_knowledge_deleted_at::Migration),
            Box::new(m20260318_110000_add_sigint_network_freq_last_seen_dt::Migration),
            Box::new(m20260318_131247_add_organism_goi_integration_type::Migration),
            Box::new(m20260319_011722_add_system_settings::Migration),
            Box::new(m20260325_120000_add_user_settings::Migration),
            Box::new(m20260325_123200_add_rer_duty_test_settings::Migration),
            Box::new(m20260326_120000_add_full_name_to_sigint_callsign::Migration),
            Box::new(m20260329_184900_add_palitra_line_strings::Migration),
            Box::new(m20260331_230927_add_palitra_s3_id::Migration),
            Box::new(m20260406_194408_palitra_archive_and_folder::Migration),
            Box::new(m20260406_210334_add_goi_integrations::Migration),
            Box::new(m20260420_114249_add_aor_order_for_report::Migration),
            Box::new(m20260420_193430_add_rer_duty_historical_replay::Migration),
            Box::new(m20260426_191910_add_slowlog_perf_indexes::Migration),
            Box::new(m20260429_175416_add_signal_message_group_lookup_indexes::Migration),
            Box::new(m20260429_181706_add_datasource_group_lookup_index::Migration),
            Box::new(m20260429_212239_tune_datasource_autovacuum::Migration),
            Box::new(m20260430_120000_add_analysis_map_in_sidebar::Migration),
            Box::new(m20260507_151045_add_palitra_goi_sync_job::Migration),
            Box::new(m20260510_101006_operator_dmr_metadata::Migration),
            Box::new(m20260511_145205_delta_login_lower_unique::Migration),
            Box::new(m20260513_102326_add_sigint_network_description_topic::Migration),
            Box::new(m20260515_120000_add_sigint_post_id_to_sigint_comment::Migration),
            Box::new(m20260519_091147_add_command_control_to_sigint_network_callsign::Migration),
            Box::new(m20260520_120000_create_organism_keyword_set::Migration),
            Box::new(m20260529_110000_add_short_url_to_admin_config::Migration),
            Box::new(m20260601_000000_add_release_news_viewed::Migration),
            Box::new(m20260602_153344_add_signal_group_admin::Migration),
            Box::new(m20260605_162305_echo_swapp_sync_state::Migration),
            Box::new(m20260609_115925_add_api_integration::Migration),
            Box::new(m20260610_123823_add_api_integration_sync::Migration),
            Box::new(m20260616_153800_create_report_history::Migration),
            Box::new(m20260618_120000_rename_modulation_to_encryption_ddl::Migration),
            Box::new(m20260619_101731_report_history_created_at_idx::Migration),
            Box::new(m20260622_090245_aor_report_order_scope::Migration),
            Box::new(m20260622_101608_add_signal_group_archive::Migration),
            Box::new(m20260626_101738_non_rer_interceptions::Migration),
            Box::new(m20260626_220129_signal_group_fills_etalonka::Migration),
            Box::new(m20260627_101500_add_sigint_network_do_not_archive::Migration),
            Box::new(m20260627_180543_signal_group_disable_network_assignment::Migration),
            Box::new(m20260628_114539_add_peleng_bounds_to_system_settings::Migration),
            Box::new(m20260629_072958_add_signal_message_operator_tags::Migration),
            Box::new(m20260629_080533_unit_tags_on_sigint_network::Migration),
            Box::new(m20260629_085034_signal_message_operator_tags::Migration),
            Box::new(m20260630_094347_interseption_kind_and_unit_mask::Migration),
            Box::new(m20260630_130141_signal_group_merge_network_assignment_flags::Migration),
            Box::new(m20260630_210912_goi_palitra_sync_upgrade::Migration),
            Box::new(m20260701_073733_default_neo_analysis::Migration),
            Box::new(m20260701_100000_backfill_deleted_freq_active_to::Migration),
            Box::new(m20260701_120000_goi_palitra_sync_multi_palitra::Migration),
            Box::new(m20260701_152707_goi_palitra_sync_side_checksums::Migration),
            Box::new(m20260701_160523_palitra_conversion_job_goi_upload_flag::Migration),
            Box::new(m20260702_145245_create_sigint_comment::Migration),
            Box::new(m20260702_155737_echo_im_sync_since::Migration),
            Box::new(m20260702_173206_echo_missing_messages::Migration),
            Box::new(m20260702_192716_signal_message_echo_inbox_message_id::Migration),
            Box::new(m20260703_095738_add_organism_to_tags::Migration),
            Box::new(
                m20260705_230242_operator_datasource_group_perf::Migration,
            ),
            Box::new(
                m20260706_142937_add_goi_integration_pause_worker::Migration,
            ),
            Box::new(
                m20260706_153312_tag_unique_enabled_organism_label::Migration,
            ),
            Box::new(
                m20260707_095504_echo_missing_message_deleted_status::Migration,
            ),
            Box::new(
                m20260707_164344_echo_missing_message_duplicate_status::Migration,
            ),
            Box::new(
                m20260707_212500_echo_missing_message_duplicate_backfill::Migration,
            ),
            Box::new(
                m20260707_170000_signal_message_attachments_hash::Migration,
            ),
            Box::new(m20260708_083252_add_cyber_echo_enabled_to_settings::Migration),
            Box::new(m20260708_130958_add_computer_name::Migration),
            Box::new(m20260708_143111_add_computer_name_search_indexes::Migration),
            Box::new(
                m20260709_092435_add_system_settings_notifications::Migration,
            ),
            Box::new(
                m20260709_124309_signal_message_queue_latest_state::Migration,
            ),
            Box::new(m20260709_140720_rename_computer_name_to_device_name::Migration),
            Box::new(
                m20260710_091610_organism_secret_group_invites::Migration,
            ),
            Box::new(
                m20260710_095803_echo_missing_message_created_at_idx::Migration,
            ),
            Box::new(m20260710_102248_add_login_description::Migration),
            Box::new(
                m20260711_120000_add_sigint_comment_parsing_to_system_settings::Migration,
            ),
            Box::new(
                m20260712_204007_add_do_not_store_duplicate_echoim_failures::Migration,
            ),
            Box::new(
                m20260713_152932_rename_cyber_echo_enabled_to_devices_section_enabled::Migration,
            ),
            Box::new(m20260715_092901_add_sigint_inbox_item_network::Migration),
            Box::new(m20260716_161040_login_uuid_v7::Migration),
            Box::new(
                m20260717_111121_goi_palitra_sync_changelog_source::Migration,
            ),
            Box::new(m20260720_100029_analysis_stats_query_indexes::Migration),
            Box::new(
                m20260720_124323_add_signal_message_media_is_encrypted::Migration,
            ),
            Box::new(m20260721_141920_echo_analytics_heartbeat::Migration),
            Box::new(
                m20260721_191340_goi_association_message_uid::Migration,
            ),
            Box::new(
                m20260721_200001_goi_message_uid_worker_setting::Migration,
            ),
            Box::new(
                m20260721_200002_goi_message_uid_lookup_indexes::Migration,
            ),
            Box::new(
                m20260721_203106_add_audio_transcription_setting::Migration,
            ),
            Box::new(m20260723_125003_palitra_highlight_blacklist::Migration),
            Box::new(
                m20260723_134939_goi_knowledge_prune_index::Migration,
            ),
            Box::new(
                m20260723_151016_add_full_name_to_sigint_network_callsign::Migration,
            ),
            Box::new(
                m20260723_185734_sigint_unit_attachments::Migration,
            ),
            Box::new(
                m20260724_080724_add_login_password_auth_enabled::Migration,
            ),
            Box::new(
                m20260724_095619_add_report_generation_settings::Migration,
            ),
            Box::new(
                m20260725_082926_index_network_callsign_lower::Migration,
            ),
            Box::new(
                m20260725_110839_add_audio_transcription_collapse_preferences::Migration,
            ),
            Box::new(
                m20260725_120000_group_stats_recalculation_task::Migration,
            ),
            Box::new(m20260727_065339_fix_direct_submit_profile_names::Migration),
            Box::new(m20260727_075435_add_ai_engines::Migration),
            Box::new(
                m20260727_080639_group_stats_recalculation_task_pending_unique::Migration,
            ),
            Box::new(m20260727_094537_add_ai_callsign_parsing::Migration),
            Box::new(
                m20260727_101425_propagate_network_callsign_full_name::Migration,
            ),
            Box::new(m20260727_102348_add_ai_callsign_worker::Migration),
            Box::new(
                m20260727_162911_add_analysis_callsign_form_setting::Migration,
            ),
            Box::new(
                m20260728_084158_index_inbox_item_unit_datetime::Migration,
            ),
            Box::new(m20260728_163700_add_echo_client_display_name::Migration),
            Box::new(
                m20260728_203332_propagate_echo_client_display_name::Migration,
            ),
            Box::new(
                m20260729_062653_add_classic_menu_visibility_settings::Migration,
            ),
            Box::new(m20260729_121823_drop_postgres_group_stats::Migration),
            Box::new(
                m20260729_155811_add_sigint_inbox_item_callsign::Migration,
            ),
            Box::new(
                m20260806_120000_drop_legacy_inbox_callsigns::Migration,
            ),
            Box::new(m20260729_170544_orbit_units::Migration),
            Box::new(
                m20260730_125429_orbit_unit_grouping_many_to_many::Migration,
            ),
            Box::new(m20260730_134741_orbit_unit_sigint_unit::Migration),
            Box::new(
                m20260730_151706_unique_orbit_link_per_sigint_unit::Migration,
            ),
            Box::new(
                m20260731_080107_allow_multiple_orbit_links_per_sigint_unit::Migration,
            ),
            Box::new(m20260731_121431_add_pelengation_object::Migration),
            Box::new(m20260731_145031_orbit_sync::Migration),
            Box::new(
                m20260731_220945_persist_manual_orbit_links::Migration,
            ),
            Box::new(m20260731_234500_orbit_unit_search_indexes::Migration),
            Box::new(
                m20260801_085538_suppress_deleted_orbit_links::Migration,
            ),
            Box::new(m20260802_174927_rer_duty_test_replay::Migration),
            Box::new(m20260803_093803_echo_automation_send_log::Migration),
            Box::new(m20260707_081900_create_devices::Migration),
            Box::new(m20260707_132105_create_device_aor::Migration),
            Box::new(m20260707_135501_drop_device_aor_id::Migration),
            Box::new(m20260707_180541_rename_device_tags_archive::Migration),
            Box::new(
                m20260716_101007_device_hostname_ssh_port_and_drop_name_uniqueness::Migration,
            ),
            Box::new(m20260716_134601_device_aor_id_uuid::Migration),
            Box::new(m20260721_120720_device_source_label_custom_fields::Migration),
            Box::new(m20260721_124518_drop_legacy_device_file::Migration),
            Box::new(m20260729_143549_add_device_organism::Migration),
            Box::new(m20260803_130117_device_source_role_and_name::Migration),
            Box::new(m20260803_212227_ai_agent_harness::Migration),
            Box::new(
                m20260804_091538_sigint_comment_blacklist::Migration,
            ),
            Box::new(m20260804_093435_hide_orbit_data::Migration),
            Box::new(
                m20260804_094408_sigint_unit_deduplicate_candidate::Migration,
            ),
            Box::new(m20260804_095344_ai_agent_dispatcher::Migration),
            Box::new(m20260805_064150_ai_agent_mattermost_chat::Migration),
            Box::new(m20260805_135334_sigint_unit_orbit_note::Migration),
            Box::new(
                m20260806_091349_add_sigint_inbox_item_datetime_neo::Migration,
            ),
            Box::new(
                m20260806_134330_sigint_unit_extended_echelons::Migration,
            ),
            Box::new(
                m20260806_141904_report_history_duplicate_lookup::Migration,
            ),
            Box::new(
                m20260810_062938_echo_automation_coordinates_screenshot::Migration,
            ),
            Box::new(m20260810_140653_inbox_unit_resolution::Migration),
            Box::new(m20260811_064758_sigint_inbox_item_units::Migration),
            Box::new(
                m20260811_073954_failed_inbox_unit_bad_text_index::Migration,
            ),
            Box::new(m20260811_142447_failed_inbox_unit_note::Migration),
            Box::new(m20260811_161634_failed_inbox_unit_multi_text::Migration),
            Box::new(m20260812_113859_signal_message_copy::Migration),
            Box::new(
                m20260812_115511_sigint_inbox_item_datetime_neo_indexes::Migration,
            ),
            Box::new(
                m20260813_183642_sigint_unit_orbit_echelons::Migration,
            ),
            Box::new(
                m20260815_125337_add_sigint_comment_migration_marker::Migration,
            ),
            Box::new(m20260816_102640_ocr::Migration),
            Box::new(m20260816_173322_media_summary::Migration),
            Box::new(m20260817_125243_add_intel_prod_relation_kind::Migration),
        ]
    }
}
