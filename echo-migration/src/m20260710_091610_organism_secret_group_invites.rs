use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                create table if not exists secret_group_organism (
                    id bigserial primary key not null,
                    master_key text not null references signal_group(master_key) on update cascade on delete cascade,
                    organism_id bigint not null references organism(id) on delete cascade,
                    created_at timestamp without time zone not null default (now() at time zone 'utc')
                );

                alter table secret_group_user
                    add column if not exists secret_group_organism_id bigint
                        references secret_group_organism(id) on delete cascade;

                delete from secret_group_user kept
                using secret_group_user removed
                where kept.id > removed.id
                    and kept.master_key = removed.master_key
                    and kept.login = removed.login
                    and kept.secret_group_organism_id is null
                    and removed.secret_group_organism_id is null;

                create unique index if not exists secret_group_organism_master_organism_uidx
                    on secret_group_organism(master_key, organism_id);

                create unique index if not exists secret_group_user_direct_master_login_uidx
                    on secret_group_user(master_key, login)
                    where secret_group_organism_id is null;

                create unique index if not exists secret_group_user_organism_master_login_uidx
                    on secret_group_user(master_key, login, secret_group_organism_id)
                    where secret_group_organism_id is not null;

                create index if not exists secret_group_organism_organism_idx
                    on secret_group_organism(organism_id);

                create index if not exists secret_group_user_secret_group_organism_idx
                    on secret_group_user(secret_group_organism_id)
                    where secret_group_organism_id is not null;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                drop index if exists secret_group_user_secret_group_organism_idx;
                drop index if exists secret_group_user_organism_master_login_uidx;
                drop index if exists secret_group_user_direct_master_login_uidx;
                drop index if exists secret_group_organism_organism_idx;
                drop index if exists secret_group_organism_master_organism_uidx;

                alter table secret_group_user
                    drop column if exists secret_group_organism_id;

                drop table if exists secret_group_organism;
            "#,
        )
        .await?;
        Ok(())
    }
}
