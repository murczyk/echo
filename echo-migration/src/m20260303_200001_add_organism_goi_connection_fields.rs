use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table organism
                    add column goi_ssh_host text,
                    add column goi_ssh_user text,
                    add column goi_ssh_password text,
                    add column goi_ssh_port int4 not null default 22,
                    add column goi_path text not null default '/etc/goi/data/palettes';
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
                alter table organism
                    drop column goi_path,
                    drop column goi_ssh_port,
                    drop column goi_ssh_password,
                    drop column goi_ssh_user,
                    drop column goi_ssh_host;
            "#,
        )
        .await?;
        Ok(())
    }
}
