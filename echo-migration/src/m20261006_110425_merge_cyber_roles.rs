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
update login
set roles = (roles - 'DeviceSource' - 'CyberViewer' - 'Cyber') || '["Cyber"]'::jsonb
where roles ?| array['DeviceSource', 'CyberViewer'];

update organism
set roles = (roles - 'DeviceSource' - 'CyberViewer' - 'Cyber') || '["Cyber"]'::jsonb
where roles ?| array['DeviceSource', 'CyberViewer'];
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Original role assignments cannot be reconstructed after merging.
        Ok(())
    }
}
