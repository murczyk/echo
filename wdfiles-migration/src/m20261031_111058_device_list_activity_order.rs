use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let connection = manager.get_connection();
        for sql in [
            r#"
alter table public.device_content_stat add column last_audio_at timestamptz;

create function public.device_audio_update_activity()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $function$
begin
    insert into public.device_content_stat (device_id, last_audio_at, updated_at)
    values (new.device_id, new.created_at, now())
    on conflict (device_id) do update
        set last_audio_at = greatest(device_content_stat.last_audio_at, excluded.last_audio_at);
    return new;
end
$function$;
create trigger device_audio_activity_trg
    after insert on public.device_audio
    for each row execute function public.device_audio_update_activity();
"#,
            r#"
insert into public.device_content_stat (device_id, last_audio_at, updated_at)
select device_id, max(created_at), now() from public.device_audio group by device_id
on conflict (device_id) do update
    set last_audio_at = greatest(device_content_stat.last_audio_at, excluded.last_audio_at);
"#,
            r#"
create index concurrently device_content_stat_file_activity_idx
    on public.device_content_stat (last_content_at desc, device_id)
    where last_content_at is not null;
"#,
            r#"
create index concurrently device_content_stat_all_activity_idx
    on public.device_content_stat ((greatest(last_content_at, last_audio_at)) desc, device_id)
    where greatest(last_content_at, last_audio_at) is not null;
"#,
        ] {
            connection.execute_unprepared(sql).await.map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop index public.device_content_stat_all_activity_idx;
drop index public.device_content_stat_file_activity_idx;
drop trigger device_audio_activity_trg on public.device_audio;
drop function public.device_audio_update_activity();
alter table public.device_content_stat drop column last_audio_at;
"#,
            )
            .await
            .map_err(|error| {
                DbErr::Migration(format!("{}: {error}", file!()))
            })?;
        Ok(())
    }

    fn use_transaction(&self) -> Option<bool> {
        Some(false)
    }
}
