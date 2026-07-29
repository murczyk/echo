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
                lock table device in share row exclusive mode;
                lock table login in share mode;

                alter table device
                    add column organism_id bigint;

                update device
                set organism_id = login.organism_id
                from login
                where login.login = device.created_by;

                do $$
                begin
                    if exists (
                        select 1
                        from device
                        where organism_id is null
                    ) then
                        raise exception
                            'cannot assign device organism: creator has no organism';
                    end if;
                end
                $$;

                alter table device
                    alter column organism_id set not null,
                    add constraint device_organism_id_fkey
                        foreign key (organism_id) references organism(id);

                create index device_organism_id_archived_updated_at_id_idx
                    on device(organism_id, archived, updated_at desc, id);
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
                drop index device_organism_id_archived_updated_at_id_idx;

                alter table device
                    drop constraint device_organism_id_fkey,
                    drop column organism_id;
                "#,
            )
            .await?;
        Ok(())
    }
}
