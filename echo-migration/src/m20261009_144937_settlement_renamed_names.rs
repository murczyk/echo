use sea_orm_migration::prelude::*;

macro_rules! h {
    () => {
        concat!("at ", file!(), " line ", line!(), " column ", column!())
    };
}

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
insert into settlement
    (id, kind, name, territorial_community, district, region, lon, lat, tag)
select renamed.new_id, legacy.kind, renamed.new_name,
       legacy.territorial_community, legacy.district, legacy.region,
       legacy.lon, legacy.lat, legacy.tag
from (values
    (79948, 2000000001, 'Анищине'),
    (98911, 2000000002, 'Іващине'),
    (65447, 2000000003, 'Рибалчине')
) as renamed(legacy_id, new_id, new_name)
join settlement legacy on legacy.id = renamed.legacy_id
where not exists (
    select 1 from settlement existing
    where existing.name = renamed.new_name
      and existing.territorial_community is not distinct from legacy.territorial_community
      and existing.district is not distinct from legacy.district
      and existing.region is not distinct from legacy.region
);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Names may predate this migration or have acquired message references.
        Ok(())
    }
}
