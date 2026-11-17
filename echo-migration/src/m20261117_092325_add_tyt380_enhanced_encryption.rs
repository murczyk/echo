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
-- New encryption type for networks (#4243). encryption.id has no sequence,
-- and sigint import already gives imported names MAX(id) + 1, so take the
-- next free id. A row imported from an upgraded peer is kept as is.
insert into encryption (id, name, enabled, created_at)
select (select coalesce(max(id), 0) + 1 from encryption),
       'TYT380Enhanced', true, now()
where not exists (
    select 1 from encryption where name = 'TYT380Enhanced'
);
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
-- Keeps the row while any frequency or key uses it, so rollback never
-- clears encryption assignments.
delete from encryption e
where e.name = 'TYT380Enhanced'
  and not exists (
      select 1 from sigint_network_freq f where f.encryption_id = e.id
  )
  and not exists (
      select 1 from sigint_network_encryption_key k
      where k.encryption_id = e.id
  );
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
