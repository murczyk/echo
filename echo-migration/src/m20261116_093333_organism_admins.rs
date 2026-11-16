use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            create table organism_admin (
                organism_id bigint not null references organism(id) on update cascade on delete cascade,
                login_id uuid not null references login(id) on update cascade on delete cascade,
                deleted boolean not null default false,
                created_at timestamp without time zone not null default (now() at time zone 'utc'),
                primary key (organism_id, login_id)
            );
            create index organism_admin_login_idx on organism_admin(login_id) where deleted = false;

            insert into organism_admin (organism_id, login_id)
            select organism_id, id from login
            where organism_id is not null and roles ? 'OrganismAdmin';

            update login set roles = roles - 'OrganismAdmin' where roles ? 'OrganismAdmin';
            update organism set roles = roles - 'OrganismAdmin' where roles ? 'OrganismAdmin';
            "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            update login set roles = roles || '["OrganismAdmin"]'::jsonb
            where not (roles ? 'OrganismAdmin') and exists (
                select 1 from organism_admin
                where organism_admin.login_id = login.id
                  and organism_admin.organism_id = login.organism_id
                  and not organism_admin.deleted
            );
            drop table organism_admin;
            "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
