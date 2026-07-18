use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_palitra_sync
                add column if not exists changelog jsonb not null default '[]'::jsonb,
                add column if not exists goi_source_file_name text,
                add column if not exists goi_source_format text,
                add column if not exists goi_source_content_type text,
                add column if not exists goi_source_file_data bytea,
                add column if not exists goi_source_file_size bigint,
                add column if not exists goi_source_file_sha256 text,
                add column if not exists goi_source_failed_file_sha256 text,
                add column if not exists goi_source_last_retry_at timestamptz;

            do $$
            begin
                if exists (
                    select 1
                    from information_schema.columns
                    where table_name = 'goi_palitra_sync'
                      and column_name = 'last_error'
                ) then
                    update goi_palitra_sync
                    set changelog = changelog || jsonb_build_array(
                        jsonb_build_object(
                            'is_ok', false,
                            'timestamp', coalesce(updated_at, now())::text,
                            'text', last_error,
                            'description', 'Помилка синхронізації з ГОІ. Перевірте технічні деталі.'
                        )
                    )
                    where last_error is not null
                      and btrim(last_error) <> '';

                    alter table goi_palitra_sync
                        drop column last_error;
                end if;
            end $$;
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table goi_palitra_sync
                add column if not exists last_error text;

            update goi_palitra_sync
            set last_error = latest_warning.text
            from lateral (
                select entry.value ->> 'text' as text
                from jsonb_array_elements(changelog) with ordinality as entry(value, ord)
                where coalesce((entry.value ->> 'is_ok')::boolean, false) = false
                order by entry.ord desc
                limit 1
            ) latest_warning
            where latest_warning.text is not null
              and btrim(latest_warning.text) <> '';

            alter table goi_palitra_sync
                drop column if exists goi_source_last_retry_at,
                drop column if exists goi_source_failed_file_sha256,
                drop column if exists goi_source_file_sha256,
                drop column if exists goi_source_file_size,
                drop column if exists goi_source_file_data,
                drop column if exists goi_source_content_type,
                drop column if exists goi_source_format,
                drop column if exists goi_source_file_name,
                drop column if exists changelog;
            "#,
        )
        .await?;
        Ok(())
    }
}
