use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table if not exists signal_group_admin (
                signal_group_id text not null references signal_group(master_key) on update cascade on delete cascade,
                login text not null references login(login) on update cascade on delete cascade,
                deleted boolean not null default false,
                created_at timestamp without time zone not null default (now() at time zone 'utc'),
                primary key (signal_group_id, login)
            );

            create index if not exists signal_group_admin_login_idx
                on signal_group_admin(login)
                where deleted = false;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table if exists signal_group_admin;
            "#,
        )
        .await?;
        Ok(())
    }
}
