use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table sigint_freq_unit (
    id bigserial primary key,
    freq text not null,
    unit_id int8 references sigint_unit(id),
    deleted boolean not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null
);
",
        )
        .await?;
        db.execute_unprepared(
            "create index sigint_freq_unit_freq_idx on sigint_freq_unit(freq);",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("drop index sigint_freq_unit_freq_idx")
            .await?;
        db.execute_unprepared("drop table sigint_freq_unit").await?;
        Ok(())
    }
}
