use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table organism_message_stats_exclusion (
    login_id uuid primary key references login(id) on delete cascade,
    organism_id bigint not null references organism(id) on delete cascade
);
create index organism_message_stats_exclusion_organism_idx on organism_message_stats_exclusion(organism_id);
create trigger organism_message_stats_exclusion_revision after insert or update or delete on organism_message_stats_exclusion
    for each statement execute function bump_organism_user_label_revision();
create function check_organism_message_stats_exclusion_owner() returns trigger language plpgsql as $$
begin
    perform 1 from login where id = new.login_id and organism_id = new.organism_id and not deleted_permanently for update;
    if not found then
        raise exception 'User and statistics setting must belong to the same organism';
    end if;
    return new;
end $$;
create trigger organism_message_stats_exclusion_owner before insert or update on organism_message_stats_exclusion
    for each row execute function check_organism_message_stats_exclusion_owner();
create function clear_moved_organism_message_stats_exclusion() returns trigger language plpgsql as $$
begin
    if old.organism_id is distinct from new.organism_id or new.deleted_permanently then
        delete from organism_message_stats_exclusion where login_id = new.id;
    end if;
    return new;
end $$;
create trigger organism_message_stats_exclusion_moved after update of organism_id, deleted_permanently on login
    for each row execute function clear_moved_organism_message_stats_exclusion();
        "#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop trigger organism_message_stats_exclusion_moved on login;
drop function clear_moved_organism_message_stats_exclusion();
drop table organism_message_stats_exclusion;
drop function check_organism_message_stats_exclusion_owner();
        "#,
            )
            .await?;
        Ok(())
    }
}
