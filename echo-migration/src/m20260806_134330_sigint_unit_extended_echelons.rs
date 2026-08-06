use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table if exists sigint_unit
    add column if not exists army_region text,
    add column if not exists military_district text;

update sigint_unit
set army_region = coalesce(army_region, ''),
    military_district = coalesce(military_district, '')
where army_region is null
    or military_district is null;

alter table if exists sigint_unit
    alter column army_region set default '',
    alter column army_region set not null,
    alter column military_district set default '',
    alter column military_district set not null;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
alter table if exists sigint_unit
    drop column if exists army_region,
    drop column if exists military_district;
                "#,
            )
            .await?;
        Ok(())
    }
}
