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
create table orbit_unit_sigint_unit (
    orbit_unit_id uuid not null references orbit_unit(unit_id) on delete cascade,
    sigint_unit_id bigint not null references sigint_unit(id) on delete cascade,
    primary key (orbit_unit_id, sigint_unit_id)
);

create index orbit_unit_sigint_unit_sigint_unit_idx
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
drop table if exists orbit_unit_sigint_unit;
"#,
            )
            .await?;
        Ok(())
    }
}
