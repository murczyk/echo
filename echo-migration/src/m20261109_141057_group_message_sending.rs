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
alter table signal_group add column send_messages boolean;

-- Publish the nullable column through CDC without firing visibility triggers.
update signal_group set send_messages = send_messages
where master_key = (select master_key from signal_group order by master_key limit 1);

create table sigint_group_sender_organism (
    master_key text not null references signal_group(master_key) on update cascade on delete cascade,
    organism_id bigint not null references organism(id) on delete cascade,
    primary key (master_key, organism_id)
);
create index sigint_group_sender_organism_organism_idx
    on sigint_group_sender_organism (organism_id);
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
drop table sigint_group_sender_organism;
alter table signal_group drop column send_messages;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
