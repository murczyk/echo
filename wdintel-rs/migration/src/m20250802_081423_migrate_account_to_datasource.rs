use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table datasource add column description text;
            alter table datasource add column status account_status not null default 'ready';
            alter table datasource add column echo_client_lock_id bigint references echo_client_lock(id) ON DELETE SET NULL;
            alter table datasource add column created_at timestamp without time zone default (now() at time zone 'utc') not null;
            INSERT INTO datasource (status, echo_client_lock_id, created_at, display_name, description, kind)
                SELECT a.status, a.echo_client_lock_id, a.created_at, a.display_name, a.description, ea.source
                FROM messenger_account a inner join echo_client_lock l on a.echo_client_lock_id = l.id inner join echo_account ea on ea.id = l.account_id;
            ",
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
            alter table datasource drop column description;
            alter table datasource drop column created_at;
            alter table datasource drop column echo_client_lock_id;
            alter table datasource drop column status;
            delete from datasource where id > 3;
            ",
        )
        .await?;
        Ok(())
    }
}
