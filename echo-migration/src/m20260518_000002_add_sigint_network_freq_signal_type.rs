use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_network_freq
                add column if not exists signal_type text not null default 'analog';

            update sigint_network_freq
            set signal_type = case
                when kind = 'VHF' then 'analog'
                when kind in ('DMR', 'DMRe') then 'digital'
                else signal_type
            end;

            alter table sigint_network_freq
                add constraint sigint_network_freq_signal_type_check
                check (signal_type in ('analog', 'digital'));
            "#,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"
            alter table sigint_network_freq
                drop constraint if exists sigint_network_freq_signal_type_check,
                drop column if exists signal_type;
            "#,
        )
        .await?;
        Ok(())
    }
}
