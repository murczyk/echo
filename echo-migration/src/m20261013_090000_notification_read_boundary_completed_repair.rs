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
create table if not exists notification_read_boundary_completed (
    boundary_id uuid primary key,
    recipient_login_id uuid not null references login(id) on delete cascade,
    unread_count bigint not null,
    receipt_ids uuid[] not null,
    created_at timestamp not null default now()
);
create index if not exists notification_read_boundary_completed_created_at_idx
    on notification_read_boundary_completed (created_at);
"#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
