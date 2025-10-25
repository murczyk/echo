use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                create table palitra  (
                    id bigserial primary key,
                    name text not null,
                    hex text not null,
                    geometry jsonb,
                    area_of_responsibility_id int8 references area_of_responsibility(id) not null,
                    owner_organism_id int8 references organism(id) ON DELETE SET NULL,
                    owner_login text references login(login) ON DELETE SET NULL,
                    author text references login(login) ON DELETE SET NULL,
                    source_file_name text,
                    deleted bool not null default false,
                    deleted_at timestamp without time zone,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                create table palitra_point  (
                    id bigserial primary key,
                    palitra_id int8 not null references palitra(id) on delete cascade,
                    lat float8 not null,
                    lng float8 not null,
                    deleted bool not null default false,
                    deleted_at timestamp without time zone,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );
               "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "
                drop table palitra_point;
                drop table palitra;
                ",
            )
            .await;
        Ok(())
    }
}
