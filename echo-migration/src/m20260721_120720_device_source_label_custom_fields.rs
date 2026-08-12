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
                alter table device
                    add column source_label text,
                    add column custom_fields jsonb;

                update device
                set source_label = name,
                    custom_fields = jsonb_strip_nulls(
                        jsonb_build_object(
                            'hostname', hostname,
                            'ssh_port', ssh_port::text
                        )
                    );

                alter table device
                    alter column source_label set not null,
                    alter column custom_fields set not null,
                    alter column name drop not null,
                    add constraint device_source_label_not_empty_check
                        check (btrim(source_label) <> ''),
                    add constraint device_custom_fields_object_check
                        check (jsonb_typeof(custom_fields) = 'object'),
                    drop constraint device_hostname_not_empty_check,
                    drop constraint device_ssh_port_range_check,
                    drop column hostname,
                    drop column ssh_port;
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
                do $$
                begin
                    if exists (
                        select 1
                        from device
                        where name is null
                           or source_label is distinct from name
                    ) then
                        raise exception
                            'cannot restore device legacy fields: name must equal source_label';
                    end if;

                    if exists (
                        select 1
                        from device
                        where jsonb_typeof(custom_fields) <> 'object'
                    ) then
                        raise exception
                            'cannot restore device legacy fields: custom_fields must be an object';
                    end if;

                    if exists (
                        select 1
                        from device
                        cross join lateral jsonb_object_keys(custom_fields)
                            as custom_field(key)
                        where custom_field.key not in ('hostname', 'ssh_port')
                    ) then
                        raise exception
                            'cannot restore device legacy fields: unexpected custom_fields key';
                    end if;

                    if exists (
                        select 1
                        from device
                        cross join lateral jsonb_each(custom_fields)
                            as custom_field(key, value)
                        where jsonb_typeof(custom_field.value) <> 'string'
                    ) then
                        raise exception
                            'cannot restore device legacy fields: custom_fields values must be strings';
                    end if;

                    if exists (
                        select 1
                        from device
                        where custom_fields ? 'hostname'
                          and btrim(custom_fields ->> 'hostname') = ''
                    ) then
                        raise exception
                            'cannot restore device legacy fields: hostname must not be blank';
                    end if;

                    if exists (
                        select 1
                        from device
                        where custom_fields ? 'ssh_port'
                          and not case
                              when custom_fields ->> 'ssh_port' ~ '^[1-9][0-9]{0,4}$'
                                  then (custom_fields ->> 'ssh_port')::integer between 1 and 65535
                                   and custom_fields ->> 'ssh_port'
                                       = ((custom_fields ->> 'ssh_port')::integer)::text
                              else false
                          end
                    ) then
                        raise exception
                            'cannot restore device legacy fields: ssh_port must be canonical decimal in range';
                    end if;
                end
                $$;

                alter table device
                    add column hostname text,
                    add column ssh_port integer;

                update device
                set hostname = custom_fields ->> 'hostname',
                    ssh_port = case
                        when custom_fields ? 'ssh_port'
                            then (custom_fields ->> 'ssh_port')::integer
                        else null
                    end;

                alter table device
                    add constraint device_hostname_not_empty_check
                        check (hostname is null or btrim(hostname) <> ''),
                    add constraint device_ssh_port_range_check
                        check (ssh_port is null or ssh_port between 1 and 65535),
                    drop constraint device_custom_fields_object_check,
                    drop constraint device_source_label_not_empty_check,
                    drop column custom_fields,
                    drop column source_label,
                    alter column name set not null;
                "#,
            )
            .await?;
        Ok(())
    }
}
