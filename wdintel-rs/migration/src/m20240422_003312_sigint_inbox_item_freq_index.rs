use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .name("idx_sigint_inbox_item_freq")
                    .table(SigintInboxItem::Table)
                    .col(SigintInboxItem::Freq)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop().name("idx_sigint_inbox_item_freq").to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SigintInboxItem {
    Table,
    Freq,
}
