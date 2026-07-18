use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table login add column id uuid not null default uuidv7();

create function pg_temp.login_id_from_name(login_name text)
returns uuid
language sql
stable
strict
as $$
    select id from login where login = login_name
$$;

do $$
declare
    ref record;
    missing_count bigint;
begin
    for ref in
        select * from (values
            ('api_integration', 'api_user'),
            ('area_of_responsibility', 'updated_by'),
            ('area_of_responsibility_report_order', 'updated_by'),
            ('datasource', 'api_login'),
            ('datasource', 'updated_by'),
            ('device_name', 'login'),
            ('enemy_units_geojson', 'created_by'),
            ('echo_missing_message', 'scheduled_by'),
            ('goi_integration', 'maintainer_login'),
            ('goi_integration_access_login', 'login'),
            ('log_users_report_generation', 'login'),
            ('organism_keyword_set', 'author_login'),
            ('palitra', 'author'),
            ('palitra_access_login', 'login'),
            ('report_history', 'requested_by'),
            ('restream', 'user_id'),
            ('restream_setup', 'user_id'),
            ('secret_group_user', 'login'),
            ('sigint_bookmark', 'user_id'),
            ('sigint_callsign_changelog', 'login'),
            ('sigint_comment', 'login'),
            ('sigint_important', 'user_id'),
            ('sigint_inbox_item_tag', 'login'),
            ('sigint_inbox_tag_model_error', 'model_login'),
            ('sigint_inbox_tag_model_error', 'removed_by_login'),
            ('sigint_key_share_policy', 'author'),
            ('sigint_network', 'updated_by'),
            ('sigint_network_callsign_changelog', 'login'),
            ('sigint_network_changelog', 'login'),
            ('sigint_network_description', 'login'),
            ('sigint_network_freq_changelog', 'login'),
            ('sigint_network_unit_changelog', 'login'),
            ('sigint_saved_filter', 'login'),
            ('sigint_settlement', 'updated_by'),
            ('sigint_signal_changelog', 'login'),
            ('sigint_unit', 'created_by'),
            ('sigint_unit_changelog', 'login'),
            ('signal_group_admin', 'login'),
            ('system_settings', 'updated_by'),
            ('tags_ordering', 'login'),
            ('url_visit_notification', 'user_id'),
            ('user_settings', 'login')
        ) as refs(table_name, column_name)
    loop
        execute format(
            'select count(*) from %I child left join login on login.login = child.%I where child.%I is not null and login.id is null',
            ref.table_name,
            ref.column_name,
            ref.column_name
        ) into missing_count;
        if missing_count > 0 then
            raise exception 'Cannot migrate %.%: % values do not reference login.login',
                ref.table_name, ref.column_name, missing_count;
        end if;
    end loop;
end
$$;

do $$
declare
    constraint_ref record;
begin
    for constraint_ref in
        select conrelid::regclass as table_name, conname
        from pg_constraint
        where contype = 'f'
          and confrelid = 'login'::regclass
          and confkey = array[
              (select attnum from pg_attribute
               where attrelid = 'login'::regclass and attname = 'login')
          ]::smallint[]
    loop
        execute format(
            'alter table %s drop constraint %I',
            constraint_ref.table_name,
            constraint_ref.conname
        );
    end loop;
end
$$;

do $$
declare
    ref record;
begin
    for ref in
        select * from (values
            ('api_integration', 'api_user', 'api_user_login_id'),
            ('area_of_responsibility', 'updated_by', 'updated_by_login_id'),
            ('area_of_responsibility_report_order', 'updated_by', 'updated_by_login_id'),
            ('datasource', 'api_login', 'api_login_id'),
            ('datasource', 'updated_by', 'updated_by_login_id'),
            ('device_name', 'login', 'login_id'),
            ('enemy_units_geojson', 'created_by', 'created_by_login_id'),
            ('echo_missing_message', 'scheduled_by', 'scheduled_by_login_id'),
            ('goi_integration', 'maintainer_login', 'maintainer_login_id'),
            ('goi_integration_access_login', 'login', 'login_id'),
            ('log_users_report_generation', 'login', 'login_id'),
            ('organism_keyword_set', 'author_login', 'author_login_id'),
            ('palitra', 'author', 'author_login_id'),
            ('palitra_access_login', 'login', 'login_id'),
            ('report_history', 'requested_by', 'requested_by_login_id'),
            ('restream', 'user_id', 'login_id'),
            ('restream_setup', 'user_id', 'login_id'),
            ('secret_group_user', 'login', 'login_id'),
            ('sigint_bookmark', 'user_id', 'login_id'),
            ('sigint_callsign_changelog', 'login', 'login_id'),
            ('sigint_comment', 'login', 'login_id'),
            ('sigint_important', 'user_id', 'login_id'),
            ('sigint_inbox_item_tag', 'login', 'login_id'),
            ('sigint_inbox_tag_model_error', 'model_login', 'model_login_id'),
            ('sigint_inbox_tag_model_error', 'removed_by_login', 'removed_by_login_id'),
            ('sigint_key_share_policy', 'author', 'author_login_id'),
            ('sigint_network', 'updated_by', 'updated_by_login_id'),
            ('sigint_network_callsign_changelog', 'login', 'login_id'),
            ('sigint_network_changelog', 'login', 'login_id'),
            ('sigint_network_description', 'login', 'login_id'),
            ('sigint_network_freq_changelog', 'login', 'login_id'),
            ('sigint_network_unit_changelog', 'login', 'login_id'),
            ('sigint_saved_filter', 'login', 'login_id'),
            ('sigint_settlement', 'updated_by', 'updated_by_login_id'),
            ('sigint_signal_changelog', 'login', 'login_id'),
            ('sigint_unit', 'created_by', 'created_by_login_id'),
            ('sigint_unit_changelog', 'login', 'login_id'),
            ('signal_group_admin', 'login', 'login_id'),
            ('system_settings', 'updated_by', 'updated_by_login_id'),
            ('tags_ordering', 'login', 'login_id'),
            ('url_visit_notification', 'user_id', 'login_id'),
            ('user_settings', 'login', 'login_id')
        ) as refs(table_name, old_column_name, new_column_name)
    loop
        execute format(
            'alter table %I alter column %I type uuid using pg_temp.login_id_from_name(%I)',
            ref.table_name,
            ref.old_column_name,
            ref.old_column_name
        );
        execute format(
            'alter table %I rename column %I to %I',
            ref.table_name,
            ref.old_column_name,
            ref.new_column_name
        );
    end loop;
end
$$;

alter table login drop constraint login_pkey;
alter table login add constraint login_pkey primary key (id);
alter table login add constraint login_login_key unique (login);

alter table api_integration add constraint fk_api_integration_api_user_login_id foreign key (api_user_login_id) references login(id);
alter table area_of_responsibility add constraint fk_aor_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table area_of_responsibility_report_order add constraint fk_aor_report_order_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table datasource add constraint fk_datasource_api_login_id foreign key (api_login_id) references login(id);
alter table datasource add constraint fk_datasource_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table device_name add constraint fk_device_name_login_id foreign key (login_id) references login(id);
alter table enemy_units_geojson add constraint fk_enemy_units_geojson_created_by_login_id foreign key (created_by_login_id) references login(id);
alter table echo_missing_message add constraint fk_echo_missing_message_scheduled_by_login_id foreign key (scheduled_by_login_id) references login(id);
alter table goi_integration add constraint fk_goi_integration_maintainer_login_id foreign key (maintainer_login_id) references login(id) on delete set null;
alter table goi_integration_access_login add constraint fk_goi_integration_access_login_login_id foreign key (login_id) references login(id) on delete cascade;
alter table log_users_report_generation add constraint fk_log_users_report_generation_login_id foreign key (login_id) references login(id);
alter table organism_keyword_set add constraint fk_organism_keyword_set_author_login_id foreign key (author_login_id) references login(id) on delete set null;
alter table palitra add constraint fk_palitra_author_login_id foreign key (author_login_id) references login(id) on delete set null;
alter table palitra_access_login add constraint fk_palitra_access_login_login_id foreign key (login_id) references login(id) on delete cascade;
alter table report_history add constraint fk_report_history_requested_by_login_id foreign key (requested_by_login_id) references login(id);
alter table restream add constraint fk_restream_login_id foreign key (login_id) references login(id);
alter table restream_setup add constraint fk_restream_setup_login_id foreign key (login_id) references login(id);
alter table secret_group_user add constraint fk_secret_group_user_login_id foreign key (login_id) references login(id);
alter table sigint_bookmark add constraint fk_sigint_bookmark_login_id foreign key (login_id) references login(id);
alter table sigint_callsign_changelog add constraint fk_sigint_callsign_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_comment add constraint fk_sigint_comment_login_id foreign key (login_id) references login(id);
alter table sigint_important add constraint fk_sigint_important_login_id foreign key (login_id) references login(id);
alter table sigint_inbox_item_tag add constraint fk_sigint_inbox_item_tag_login_id foreign key (login_id) references login(id);
alter table sigint_inbox_tag_model_error add constraint fk_sigint_inbox_tag_model_error_model_login_id foreign key (model_login_id) references login(id);
alter table sigint_inbox_tag_model_error add constraint fk_sigint_inbox_tag_model_error_removed_by_login_id foreign key (removed_by_login_id) references login(id);
alter table sigint_key_share_policy add constraint fk_sigint_key_share_policy_author_login_id foreign key (author_login_id) references login(id);
alter table sigint_network add constraint fk_sigint_network_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table sigint_network_callsign_changelog add constraint fk_sigint_network_callsign_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_network_changelog add constraint fk_sigint_network_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_network_description add constraint fk_sigint_network_description_login_id foreign key (login_id) references login(id);
alter table sigint_network_freq_changelog add constraint fk_sigint_network_freq_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_network_unit_changelog add constraint fk_sigint_network_unit_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_saved_filter add constraint fk_sigint_saved_filter_login_id foreign key (login_id) references login(id);
alter table sigint_settlement add constraint fk_sigint_settlement_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table sigint_signal_changelog add constraint fk_sigint_signal_changelog_login_id foreign key (login_id) references login(id);
alter table sigint_unit add constraint fk_sigint_unit_created_by_login_id foreign key (created_by_login_id) references login(id);
alter table sigint_unit_changelog add constraint fk_sigint_unit_changelog_login_id foreign key (login_id) references login(id);
alter table signal_group_admin add constraint fk_signal_group_admin_login_id foreign key (login_id) references login(id) on delete cascade;
alter table system_settings add constraint fk_system_settings_updated_by_login_id foreign key (updated_by_login_id) references login(id);
alter table tags_ordering add constraint fk_tags_ordering_login_id foreign key (login_id) references login(id);
alter table url_visit_notification add constraint fk_url_visit_notification_login_id foreign key (login_id) references login(id);
alter table user_settings add constraint fk_user_settings_login_id foreign key (login_id) references login(id) on delete cascade;
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create function pg_temp.login_name_from_id(login_id uuid)
returns text
language sql
stable
strict
as $$
    select login from login where id = login_id
$$;

do $$
declare
    constraint_ref record;
begin
    for constraint_ref in
        select conrelid::regclass as table_name, conname
        from pg_constraint
        where contype = 'f'
          and confrelid = 'login'::regclass
          and confkey = array[
              (select attnum from pg_attribute
               where attrelid = 'login'::regclass and attname = 'id')
          ]::smallint[]
    loop
        execute format(
            'alter table %s drop constraint %I',
            constraint_ref.table_name,
            constraint_ref.conname
        );
    end loop;
end
$$;

do $$
declare
    ref record;
begin
    for ref in
        select * from (values
            ('api_integration', 'api_user_login_id', 'api_user'),
            ('area_of_responsibility', 'updated_by_login_id', 'updated_by'),
            ('area_of_responsibility_report_order', 'updated_by_login_id', 'updated_by'),
            ('datasource', 'api_login_id', 'api_login'),
            ('datasource', 'updated_by_login_id', 'updated_by'),
            ('device_name', 'login_id', 'login'),
            ('enemy_units_geojson', 'created_by_login_id', 'created_by'),
            ('echo_missing_message', 'scheduled_by_login_id', 'scheduled_by'),
            ('goi_integration', 'maintainer_login_id', 'maintainer_login'),
            ('goi_integration_access_login', 'login_id', 'login'),
            ('log_users_report_generation', 'login_id', 'login'),
            ('organism_keyword_set', 'author_login_id', 'author_login'),
            ('palitra', 'author_login_id', 'author'),
            ('palitra_access_login', 'login_id', 'login'),
            ('report_history', 'requested_by_login_id', 'requested_by'),
            ('restream', 'login_id', 'user_id'),
            ('restream_setup', 'login_id', 'user_id'),
            ('secret_group_user', 'login_id', 'login'),
            ('sigint_bookmark', 'login_id', 'user_id'),
            ('sigint_callsign_changelog', 'login_id', 'login'),
            ('sigint_comment', 'login_id', 'login'),
            ('sigint_important', 'login_id', 'user_id'),
            ('sigint_inbox_item_tag', 'login_id', 'login'),
            ('sigint_inbox_tag_model_error', 'model_login_id', 'model_login'),
            ('sigint_inbox_tag_model_error', 'removed_by_login_id', 'removed_by_login'),
            ('sigint_key_share_policy', 'author_login_id', 'author'),
            ('sigint_network', 'updated_by_login_id', 'updated_by'),
            ('sigint_network_callsign_changelog', 'login_id', 'login'),
            ('sigint_network_changelog', 'login_id', 'login'),
            ('sigint_network_description', 'login_id', 'login'),
            ('sigint_network_freq_changelog', 'login_id', 'login'),
            ('sigint_network_unit_changelog', 'login_id', 'login'),
            ('sigint_saved_filter', 'login_id', 'login'),
            ('sigint_settlement', 'updated_by_login_id', 'updated_by'),
            ('sigint_signal_changelog', 'login_id', 'login'),
            ('sigint_unit', 'created_by_login_id', 'created_by'),
            ('sigint_unit_changelog', 'login_id', 'login'),
            ('signal_group_admin', 'login_id', 'login'),
            ('system_settings', 'updated_by_login_id', 'updated_by'),
            ('tags_ordering', 'login_id', 'login'),
            ('url_visit_notification', 'login_id', 'user_id'),
            ('user_settings', 'login_id', 'login')
        ) as refs(table_name, old_column_name, new_column_name)
    loop
        execute format(
            'alter table %I alter column %I type text using pg_temp.login_name_from_id(%I)',
            ref.table_name,
            ref.old_column_name,
            ref.old_column_name
        );
        execute format(
            'alter table %I rename column %I to %I',
            ref.table_name,
            ref.old_column_name,
            ref.new_column_name
        );
    end loop;
end
$$;

alter table login drop constraint login_pkey;
alter table login drop constraint login_login_key;
alter table login add constraint login_pkey primary key (login);
alter table login drop column id;

alter table api_integration add constraint fk_api_integration_login foreign key (api_user) references login(login);
alter table area_of_responsibility add constraint fk_area_of_responsibility_login foreign key (updated_by) references login(login);
alter table area_of_responsibility_report_order add constraint fk_area_of_responsibility_report_order_login foreign key (updated_by) references login(login);
alter table datasource add constraint fk_datasource_api_login foreign key (api_login) references login(login);
alter table datasource add constraint fk_datasource_updated_by foreign key (updated_by) references login(login);
alter table device_name add constraint fk_device_name_login foreign key (login) references login(login);
alter table goi_integration add constraint fk_goi_integration_login foreign key (maintainer_login) references login(login) on delete set null;
alter table goi_integration_access_login add constraint fk_goi_integration_access_login foreign key (login) references login(login) on delete cascade;
alter table log_users_report_generation add constraint fk_log_users_report_generation_login foreign key (login) references login(login);
alter table organism_keyword_set add constraint fk_organism_keyword_set_login foreign key (author_login) references login(login) on delete set null;
alter table palitra add constraint fk_palitra_login foreign key (author) references login(login) on delete set null;
alter table palitra_access_login add constraint fk_palitra_access_login foreign key (login) references login(login) on delete cascade;
alter table report_history add constraint fk_report_history_login foreign key (requested_by) references login(login);
alter table secret_group_user add constraint fk_secret_group_user_login foreign key (login) references login(login);
alter table sigint_callsign_changelog add constraint fk_sigint_callsign_changelog_login foreign key (login) references login(login);
alter table sigint_comment add constraint fk_sigint_comment_login foreign key (login) references login(login);
alter table sigint_inbox_item_tag add constraint fk_sigint_inbox_item_tag_login foreign key (login) references login(login);
alter table sigint_inbox_tag_model_error add constraint fk_sigint_inbox_tag_model_error_model_login foreign key (model_login) references login(login);
alter table sigint_inbox_tag_model_error add constraint fk_sigint_inbox_tag_model_error_removed_by_login foreign key (removed_by_login) references login(login);
alter table sigint_key_share_policy add constraint fk_sigint_key_share_policy_login foreign key (author) references login(login);
alter table sigint_network add constraint fk_sigint_network_login foreign key (updated_by) references login(login);
alter table sigint_network_description add constraint fk_sigint_network_description_login foreign key (login) references login(login);
alter table sigint_settlement add constraint fk_sigint_settlement_login foreign key (updated_by) references login(login);
alter table sigint_signal_changelog add constraint fk_sigint_signal_changelog_login foreign key (login) references login(login);
alter table sigint_unit_changelog add constraint fk_sigint_unit_changelog_login foreign key (login) references login(login);
alter table signal_group_admin add constraint fk_signal_group_admin_login foreign key (login) references login(login) on update cascade on delete cascade;
alter table system_settings add constraint fk_system_settings_login foreign key (updated_by) references login(login);
alter table tags_ordering add constraint fk_tags_ordering_login foreign key (login) references login(login);
alter table user_settings add constraint fk_user_settings_login foreign key (login) references login(login) on update cascade on delete cascade;
"#,
            )
            .await?;
        Ok(())
    }
}
