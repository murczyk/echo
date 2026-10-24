use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
create table public.device_audio_forwarding_outbox (
    audio_id uuid not null references device_audio(id) on delete restrict,
    group_master_key text not null,
    device_name text not null,
    unit_id bigint,
    actor_id uuid not null,
    created_at timestamptz not null default now(),
    next_attempt_at timestamptz not null default now(),
    attempts integer not null default 0,
    lease_token uuid,
    completed_at timestamptz,
    last_error text,
    primary key(audio_id, group_master_key)
);
create index device_audio_forwarding_outbox_pending_idx
    on public.device_audio_forwarding_outbox(next_attempt_at, audio_id, group_master_key)
    where completed_at is null;
"#).await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", file!())))?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration("Audio forwarding references and delivery history must be retained; disable forwarding and repair forward".into()))
    }
}
