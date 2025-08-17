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
                    .as_enum(SigintSignalChangelogActionEnum)
                    .values(SigintSignalChangelogAction::iter())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(SigintSignal::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SigintSignal::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SigintSignal::Text).string().not_null())
                    .col(ColumnDef::new(SigintSignal::Meaning).string())
                    .col(ColumnDef::new(SigintSignal::Unit).big_integer())
                    .col(ColumnDef::new(SigintSignal::Coordinates).string())
                    .col(
                        ColumnDef::new(SigintSignal::Deleted)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(SigintSignal::CreatedAt)
                            .timestamp()
                            .default(SimpleExpr::Keyword(
                                Keyword::CurrentTimestamp,
                            ))
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("signal_unit_idx")
                            .from(SigintSignal::Table, SigintSignal::Unit)
                            .to(SigintUnit::Table, SigintUnit::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(SigintSignalChangelog::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SigintSignalChangelog::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::SigintSignalId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::Login)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::Action)
                            .enumeration(
                                SigintSignalChangelogActionEnum,
                                SigintSignalChangelogAction::iter(),
                            )
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::CreatedAt)
                            .timestamp()
                            .default(SimpleExpr::Keyword(
                                Keyword::CurrentTimestamp,
                            ))
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::NewValue)
                            .json_binary(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::OldValue)
                            .json_binary(),
                    )
                    .col(
                        ColumnDef::new(SigintSignalChangelog::Req)
                            .json_binary(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("signal_changelog_signal_idx")
                            .from(
                                SigintSignalChangelog::Table,
                                SigintSignalChangelog::SigintSignalId,
                            )
                            .to(SigintSignal::Table, SigintSignal::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("signal_changelog_login_idx")
                            .from(
                                SigintSignalChangelog::Table,
                                SigintSignalChangelog::Login,
                            )
                            .to(Login::Table, Login::Login),
                    )
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop().table(SigintSignalChangelog::Table).to_owned(),
            )
            .await?;

        manager
            .drop_table(Table::drop().table(SigintSignal::Table).to_owned())
            .await?;

        manager
            .drop_type(
                Type::drop()
                    .name(SigintSignalChangelogActionEnum)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }
}

#[derive(DeriveIden)]
enum SigintSignal {
    Table,
    Id,
    Text,
    Meaning,
    Unit,
    Coordinates,
    Deleted,
    CreatedAt,
}

#[derive(DeriveIden)]
enum SigintSignalChangelog {
    Table,
    Id,
    SigintSignalId,
    Login,
    Action,
    CreatedAt,
    NewValue,
    OldValue,
    Req,
}

#[derive(DeriveIden)]
enum Login {
    Table,
    Login,
}

#[derive(DeriveIden)]
enum SigintUnit {
    Table,
    Id,
}

#[derive(DeriveIden)]
struct SigintSignalChangelogActionEnum;

#[derive(DeriveIden, EnumIter)]
enum SigintSignalChangelogAction {
    Create,
    Update,
    Delete,
}
