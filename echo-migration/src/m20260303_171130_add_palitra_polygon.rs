use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            create table palitra_geometry (
                id bigserial primary key,
                palitra_id bigint not null references palitra(id) on delete cascade,
                hex text not null,
                source_file_name text,
                deleted bool not null default false,
                created_at timestamp without time zone default (now() at time zone 'utc') not null,
                last_uploaded_at timestamp without time zone default (now() at time zone 'utc'),
                updated_at timestamp without time zone default (now() at time zone 'utc') not null
            );

            alter table palitra rename column source_file_name to source_file_name_legacy;
            ALTER TABLE palitra ALTER COLUMN hex DROP NOT NULL;
            alter table palitra rename column hex to hex_legacy;
            alter table palitra rename column last_uploaded_at to last_uploaded_at_legacy;

            SELECT AddGeometryColumn('palitra_geometry', 'convex_hull', 4326, 'LINESTRING', 2);
            SELECT AddGeometryColumn('palitra_geometry', 'center', 4326, 'POINT', 2);

            alter table palitra_point add column palitra_geometry_id BIGINT references palitra_geometry(id) on delete cascade;

            INSERT INTO palitra_geometry (palitra_id, hex, source_file_name, created_at, last_uploaded_at, convex_hull, center)
                SELECT id, hex_legacy, source_file_name_legacy, created_at, last_uploaded_at_legacy, convex_hull, center  FROM palitra;

            UPDATE palitra_point
                SET palitra_geometry_id = palitra_geometry.id
                FROM palitra_geometry
                WHERE palitra_point.palitra_id = palitra_geometry.palitra_id;

            ALTER TABLE palitra_point ALTER COLUMN palitra_geometry_id SET NOT NULL;
            ALTER TABLE palitra_point ALTER COLUMN palitra_id DROP NOT NULL;
            alter table palitra_point rename column palitra_id to palitra_id_legacy;
            "#,
        )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table palitra_point rename column palitra_id_legacy to palitra_id;
            UPDATE palitra_point
                SET palitra_id = palitra.id FROM palitra, palitra_geometry
                WHERE palitra_point.palitra_geometry_id = palitra_geometry.id;

            ALTER TABLE palitra_point DROP COLUMN palitra_geometry_id;
            ALTER TABLE palitra_point ALTER COLUMN palitra_id SET NOT NULL;

            UPDATE palitra
                SET hex_legacy = palitra_geometry.hex FROM palitra_geometry
                WHERE palitra_geometry.palitra_id = palitra.id;

            alter table palitra rename column source_file_name_legacy to source_file_name;
            alter table palitra rename column hex_legacy to hex;
            ALTER TABLE palitra ALTER COLUMN hex SET NOT NULL;
            alter table palitra rename column last_uploaded_at_legacy to last_uploaded_at;

            drop table palitra_geometry;
            "#,
        )
            .await?;
        Ok(())
    }
}
