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
alter table signal_message_media add column order_f64 double precision;
alter table signal_message_audio_ref add column order_f64 double precision;

-- Publish the nullable columns through CDC. Updating only order_f64 avoids
-- column-specific extraction triggers; the media Iggy trigger is bounded to one row.
update signal_message_media set order_f64 = order_f64
where id = (select id from signal_message_media order by id limit 1);
update signal_message_audio_ref set order_f64 = order_f64
where id = (select id from signal_message_audio_ref order by id limit 1);
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
alter table signal_message_audio_ref drop column order_f64;
alter table signal_message_media drop column order_f64;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
