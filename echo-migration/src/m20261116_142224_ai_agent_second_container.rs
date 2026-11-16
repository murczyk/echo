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
-- A user's conversations on another model backend run in a second agent
-- container with its own agent login (#4232); slot 0 is the main one.
alter table ai_agent_user_link
    add column if not exists slot smallint default 0 not null
        check (slot >= 0);

alter table ai_agent_user_link
    drop constraint if exists ai_agent_user_link_human_login_id_key;

alter table ai_agent_user_link
    add constraint ai_agent_user_link_human_login_id_slot_key
        unique (human_login_id, slot);
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
-- Fails while second-slot links exist; destroy those containers and delete
-- their links first.
alter table ai_agent_user_link
    drop constraint if exists ai_agent_user_link_human_login_id_slot_key;

alter table ai_agent_user_link
    add constraint ai_agent_user_link_human_login_id_key
        unique (human_login_id);

alter table ai_agent_user_link
    drop column if exists slot;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
