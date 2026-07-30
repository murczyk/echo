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
delete from orbit_unit_sigint_unit duplicate
using orbit_unit_sigint_unit retained
where duplicate.sigint_unit_id = retained.sigint_unit_id
    and duplicate.orbit_unit_id > retained.orbit_unit_id;

drop index orbit_unit_sigint_unit_sigint_unit_idx;

create unique index orbit_unit_sigint_unit_sigint_unit_uq
    on orbit_unit_sigint_unit (sigint_unit_id);
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
drop index orbit_unit_sigint_unit_sigint_unit_uq;

create index orbit_unit_sigint_unit_sigint_unit_idx
    on orbit_unit_sigint_unit (sigint_unit_id);
"#,
            )
            .await?;
        Ok(())
    }
}
