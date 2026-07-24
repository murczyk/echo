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
                create table sigint_unit_attachment (
                    id bigserial primary key,
                    unit_id bigint not null references sigint_unit(id) on delete cascade,
                    file_name text not null,
                    content_type text not null,
                    size_bytes bigint not null check (size_bytes > 0),
                    storage_key text not null unique,
                    short_description text not null,
                    full_description text not null,
                    created_by_login_id uuid not null references login(id),
                    created_at timestamp without time zone default (now() at time zone 'utc') not null
                );

                create index idx_sigint_unit_attachment_unit_created
                    on sigint_unit_attachment(unit_id, created_at desc, id desc);

                create table sigint_unit_attachment_aor (
                    id bigserial primary key,
                    attachment_id bigint not null references sigint_unit_attachment(id) on delete cascade,
                    aor_id bigint not null references area_of_responsibility(id) on delete cascade,
                    created_at timestamp without time zone default (now() at time zone 'utc') not null,
                    unique (attachment_id, aor_id)
                );

                create index idx_sigint_unit_attachment_aor_aor_attachment
                    on sigint_unit_attachment_aor(aor_id, attachment_id);
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
                drop table sigint_unit_attachment_aor;
                drop table sigint_unit_attachment;
                "#,
            )
            .await?;
        Ok(())
    }
}
