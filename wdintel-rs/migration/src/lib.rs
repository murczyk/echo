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
            Box::new(m20250424_191053_add_modulation_to_network::Migration),
            Box::new(m20250430_090456_add_sigint_post::Migration),
            Box::new(m20250502_124932_network_description::Migration),
            Box::new(m20250525_151839_add_kind_and_modulation_to_network_freqs::Migration),
            Box::new(m20250525_195819_add_sigint_network_description_freq::Migration),
            Box::new(m20250526_141346_add_sigint_network_callsign::Migration),
            Box::new(m20250528_151120_add_sigint_settlement::Migration),
            Box::new(m20250530_143601_drop_sigint_settlements::Migration),
            Box::new(m20250530_211149_add_sigint_settlement::Migration),
            Box::new(m20250604_053059_add_sigint_network_activity_history::Migration),
            Box::new(m20250602_112459_add_freq_activity_history::Migration),
        ]
    }
}
