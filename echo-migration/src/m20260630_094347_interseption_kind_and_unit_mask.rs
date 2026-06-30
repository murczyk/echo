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
                do $$
                begin
                    if not exists (
                        select 1
                        from pg_type
                        where typname = 'interseption_kind'
                    ) then
                        create type interseption_kind as enum ('rer', 'other');
                    end if;
                end
                $$;

                alter table signal_group
                    add column if not exists interseption_kind interseption_kind not null default 'rer';

                update signal_group
                    set interseption_kind = case
                        when is_rer then 'rer'::interseption_kind
                        else 'other'::interseption_kind
                    end
                    where exists (
                        select 1
                        from information_schema.columns
                        where table_name = 'signal_group'
                            and column_name = 'is_rer'
                    );

                alter table signal_group
                    drop column if exists is_rer;

                alter index if exists sigint_network_unit_tags_gin_idx
                    rename to sigint_network_unit_mask_gin_idx;

                alter table sigint_network
                    rename constraint sigint_network_unit_tags_array_check
                    to sigint_network_unit_mask_array_check;

                alter table sigint_network
                    rename column unit_tags to unit_mask;
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
                alter table sigint_network
                    rename column unit_mask to unit_tags;

                alter table sigint_network
                    rename constraint sigint_network_unit_mask_array_check
                    to sigint_network_unit_tags_array_check;

                alter index if exists sigint_network_unit_mask_gin_idx
                    rename to sigint_network_unit_tags_gin_idx;

                alter table signal_group
                    add column if not exists is_rer boolean not null default true;

                update signal_group
                    set is_rer = interseption_kind = 'rer'::interseption_kind
                    where exists (
                        select 1
                        from information_schema.columns
                        where table_name = 'signal_group'
                            and column_name = 'interseption_kind'
                    );

                alter table signal_group
                    drop column if exists interseption_kind;

                drop type if exists interseption_kind;
                "#,
            )
            .await?;
        Ok(())
    }
}
