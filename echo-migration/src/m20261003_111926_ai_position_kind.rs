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
-- What a named location is: a position, a crew (розрахунок, екіпаж) or a
-- callsign tied to a place.
alter table ai_position_mention
    add column kind text not null default 'position'
        check (kind in ('position', 'crew', 'callsign'));

alter table ai_position_knowledge
    add column kind text not null default 'position'
        check (kind in ('position', 'crew', 'callsign'));

alter table ai_position_feedback
    add column kind text check (kind in ('position', 'crew', 'callsign'));

alter table ai_position_feedback drop constraint ai_position_feedback_verdict_check;
alter table ai_position_feedback add constraint ai_position_feedback_verdict_check
    check (verdict in (
        'correct', 'not_position', 'wrong_name', 'wrong_coordinates', 'missed',
        'wrong_kind', 'other'
    ));

-- Lookups by place: known locations and coordinate facts near a point.
create index ai_position_knowledge_location_idx
    on ai_position_knowledge (lat, lng);

create index ai_position_coordinate_location_idx
    on ai_position_coordinate (lat, lng);
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
drop index if exists ai_position_coordinate_location_idx;
drop index if exists ai_position_knowledge_location_idx;
delete from ai_position_feedback where verdict = 'wrong_kind';
alter table ai_position_feedback drop constraint ai_position_feedback_verdict_check;
alter table ai_position_feedback add constraint ai_position_feedback_verdict_check
    check (verdict in (
        'correct', 'not_position', 'wrong_name', 'wrong_coordinates', 'missed', 'other'
    ));
alter table ai_position_feedback drop column if exists kind;
alter table ai_position_knowledge drop column if exists kind;
alter table ai_position_mention drop column if exists kind;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
