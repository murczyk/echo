use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                r#"
                delete from palitra;
                alter table palitra drop column geometry;
                alter table palitra drop column area_of_responsibility_id;
                alter table palitra drop column owner_organism_id;
                alter table palitra drop column owner_login;

                create table palitra_access_aor  (
                    id bigserial primary key,
                    palitra_id int8 not null references palitra(id) on delete cascade,
                    aor_id int8 not null references area_of_responsibility(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                create table palitra_access_organism  (
                    id bigserial primary key,
                    palitra_id int8 not null references palitra(id) on delete cascade,
                    organism_id int8 not null references organism(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                create table palitra_access_login  (
                    id bigserial primary key,
                    palitra_id int8 not null references palitra(id) on delete cascade,
                    login text not null references login(login) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                SELECT AddGeometryColumn('palitra', 'convex_hull', 4326, 'LINESTRING', 2);
                SELECT AddGeometryColumn('palitra', 'center', 4326, 'POINT', 2);
               "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let _ = db
            .execute_unprepared(
                "
                drop table palitra_access_aor;
                drop table palitra_access_organism;
                drop table palitra_access_login;
                delete from palitra;
                alter table palitra drop column convex_hull;
                alter table palitra drop column center;
                alter table palitra add column area_of_responsibility_id int8 references area_of_responsibility(id) not null;
                alter table palitra add column geometry jsonb;
                alter table palitra add column owner_organism_id int8 references organism(id) ON DELETE SET NULL;
                alter table palitra add column owner_login text references login(login) ON DELETE SET NULL;
                ",
            )
            .await;
        Ok(())
    }
}
