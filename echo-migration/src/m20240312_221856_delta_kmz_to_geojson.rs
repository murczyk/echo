use sea_orm::{EnumIter, Iterable};
use sea_orm_migration::prelude::*;
use sea_query::extension::postgres::Type;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_type(
                Type::create()
                    .as_enum(StatusEnum)
                    .values(StatusVariant::iter())
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(DeltaKmzToGeojson::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DeltaKmzToGeojson::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(DeltaKmzToGeojson::CreatedBy)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeltaKmzToGeojson::Status)
                            .enumeration(StatusEnum, StatusVariant::iter()),
                    )
                    .col(
                        ColumnDef::new(DeltaKmzToGeojson::CreatedAt)
                            .timestamp()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop().table(DeltaKmzToGeojson::Table).to_owned(),
            )
            .await?;
        manager
            .drop_type(Type::drop().name(StatusEnum).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum DeltaKmzToGeojson {
    Table,
    Id,
    CreatedBy,
    Status,
    CreatedAt,
}

#[derive(DeriveIden)]
struct StatusEnum;

#[derive(DeriveIden, EnumIter)]
enum StatusVariant {
    Pending,
    Success,
    Failed,
}
