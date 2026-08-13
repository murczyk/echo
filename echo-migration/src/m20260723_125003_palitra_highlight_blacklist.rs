use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table palitra_highlight_blacklist (
                id bigserial primary key,
                palitra_id int8 not null references palitra(id) on delete cascade,
                label text not null,
                normalized_label text not null,
                created_by_login_id uuid not null,
                constraint palitra_highlight_blacklist_palitra_label_uq
                    unique (palitra_id, normalized_label),
                constraint fk_palitra_highlight_blacklist_created_by_login_id
                    foreign key (created_by_login_id) references login(id)
            );
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            drop table palitra_highlight_blacklist;
            "#,
        )
        .await?;
        Ok(())
    }
}
