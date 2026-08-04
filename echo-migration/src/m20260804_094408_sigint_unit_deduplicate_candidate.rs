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
    add column if not exists is_deduplicate_candidate boolean;

update sigint_unit
set is_deduplicate_candidate = exists (
    select 1
    from orbit_unit_sigint_unit candidate_link
    join orbit_unit candidate_orbit_unit
        on candidate_orbit_unit.unit_id = candidate_link.orbit_unit_id
    join sigint_unit candidate_sigint_unit
        on candidate_sigint_unit.id = candidate_link.sigint_unit_id
    where candidate_link.is_suppressed = false
        and candidate_orbit_unit.deleted = false
        and candidate_sigint_unit.deleted = false
        and candidate_link.orbit_unit_id in (
            select duplicate_link.orbit_unit_id
            from orbit_unit_sigint_unit duplicate_link
            join orbit_unit duplicate_orbit_unit
                on duplicate_orbit_unit.unit_id = duplicate_link.orbit_unit_id
            join sigint_unit duplicate_sigint_unit
                on duplicate_sigint_unit.id = duplicate_link.sigint_unit_id
            where duplicate_link.is_suppressed = false
                and duplicate_orbit_unit.deleted = false
                and duplicate_sigint_unit.deleted = false
            group by duplicate_link.orbit_unit_id
            having count(distinct duplicate_link.sigint_unit_id) > 1
        )
        and candidate_link.sigint_unit_id = sigint_unit.id
)
where is_deduplicate_candidate is null;
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
    drop column if exists is_deduplicate_candidate;
                "#,
            )
            .await?;
        Ok(())
    }
}
