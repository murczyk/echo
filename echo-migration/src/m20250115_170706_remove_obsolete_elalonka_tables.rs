use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
drop table etalonka_attachment;
drop table etalonka_correspondent;
drop table etalonka_frequency;
drop table etalonka_group_network;
drop table etalonka_group;
drop table etalonka_network;
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
create table etalonka_network (
  id serial primary key,
  name varchar(255) ,
  description text,
  sort_id int,
  created_at timestamp default now(),
  created_by varchar(255),
  updated_at timestamp default now(),
  updated_by varchar(255),
  credibility int
);

create table etalonka_group (
  id serial primary key,
  mark varchar(255),
  sort_id int
);

create table etalonka_group_network (
  groups_id int references etalonka_group(id),
  networks_id int references etalonka_network(id),
  primary key (groups_id, networks_id)
);

create table etalonka_frequency (
  id serial primary key,
  value float,
  network_id int references etalonka_network(id)
);

create table etalonka_correspondent (
  id serial primary key,
  call_sign varchar(255),
  affiliation varchar(255),
  detection_date timestamp,
  confirmation_date timestamp,
  description text,
  network_id int references etalonka_network(id),
  color_code varchar(255),
  credibility int
);

create table etalonka_attachment (
  id serial primary key,
  file_name varchar(255),
  network_id int references etalonka_network(id),
  content bytea
);
",
        )
        .await?;
        Ok(())
    }
}
