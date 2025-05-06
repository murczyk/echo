use crate::extension::postgres::Type;
use sea_orm::{EnumIter, Iterable};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_type(
                Type::create()
                    .as_enum(SigintSavedFilterTypeEnum)
                    .values(SigintSavedFilterType::iter())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(SigintSavedFilter::Table)
                    .add_column(
                        ColumnDef::new(SigintSavedFilter::Type).enumeration(
                            SigintSavedFilterTypeEnum,
                            SigintSavedFilterType::iter(),
                        ),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(SigintSavedFilter::Table)
                    .drop_column(SigintSavedFilter::Type)
                    .to_owned(),
            )
            .await?;

        manager
            .drop_type(Type::drop().name(SigintSavedFilterTypeEnum).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SigintSavedFilter {
    Table,
    Type,
}

#[derive(DeriveIden)]
struct SigintSavedFilterTypeEnum;

#[derive(DeriveIden, EnumIter)]
enum SigintSavedFilterType {
    Analysis,
    Duty,
}
