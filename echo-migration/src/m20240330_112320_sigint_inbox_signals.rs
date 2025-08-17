use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SigintInboxItem::Table)
                    .add_column(
                        ColumnDef::new(SigintInboxItem::SignalTokens)
                            .json_binary(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SigintInboxItem::Table)
                    .drop_column(SigintInboxItem::SignalTokens)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SigintInboxItem {
    Table,
    SignalTokens,
}
