use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table ai_agent_work_record (
    request_id uuid not null references ai_agent_request(id) on delete cascade,
    sequence bigint not null check(sequence > 0),
    kind text not null check(kind in ('tool','checkpoint')),
    payload jsonb not null,
    payload_bytes integer not null check(payload_bytes > 0),
    access_scope text not null,
    created_at timestamp without time zone not null default (now() at time zone 'utc'),
    primary key(request_id, sequence)
);
"#).await.map_err(|error| DbErr::Migration(format!("at {}:{}: {error}", file!(), line!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("drop table ai_agent_work_record;")
            .await
            .map_err(|error| {
                DbErr::Migration(format!("at {}:{}: {error}", file!(), line!()))
            })?;
        Ok(())
    }
}
