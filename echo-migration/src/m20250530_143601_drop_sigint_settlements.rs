use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop table sigint_settlement_at_post;")
            .await?;
        db.execute_unprepared("drop table sigint_settlement_token;")
            .await?;
        db.execute_unprepared("drop table sigint_settlement;")
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            create table sigint_settlement (
                id bigserial primary key,
                name text not null,
                lat float8 not null,
                lon float8 not null,
                alt_names jsonb not null,
                deleted bool not null default false,
                updated_by text references login(login),
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create table sigint_settlement_at_post (
                id bigserial primary key,
                settlement_id bigint REFERENCES sigint_settlement(id) ON DELETE CASCADE,
                post_id bigint REFERENCES sigint_post(id) ON DELETE SET NULL,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            create table sigint_settlement_token (
                id bigserial primary key,
                settlement_id bigint REFERENCES sigint_settlement(id) ON DELETE SET NULL,
                post_id bigint REFERENCES sigint_post(id) ON DELETE SET NULL,
                content text not null,
                parsed_name text,
                lat float8,
                lon float8,
                updated_by text references login(login),
                updated_at timestamp without time zone default (now() at time zone 'utc') not null,
                created_at timestamp without time zone default (now() at time zone 'utc') not null
            );",
        )
            .await?;
        Ok(())
    }
}
