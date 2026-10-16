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
alter table signal_group add column color_key text;

update signal_group
set color_key = (array[
    'red', 'pink', 'purple', 'deep_purple',
    'indigo', 'blue', 'light_blue', 'cyan',
    'teal', 'green', 'light_green', 'lime',
    'amber', 'orange', 'deep_orange', 'blue_grey'
])[1 + ((('x' || substr(md5(master_key), 1, 8))::bit(32)::bigint) % 16)];

alter table signal_group
    add constraint signal_group_color_key_check check (color_key in (
        'red', 'pink', 'purple', 'deep_purple',
        'indigo', 'blue', 'light_blue', 'cyan',
        'teal', 'green', 'light_green', 'lime',
        'amber', 'orange', 'deep_orange', 'blue_grey'
    )),
    alter column color_key set default (array[
        'red', 'pink', 'purple', 'deep_purple',
        'indigo', 'blue', 'light_blue', 'cyan',
        'teal', 'green', 'light_green', 'lime',
        'amber', 'orange', 'deep_orange', 'blue_grey'
    ])[1 + floor(random() * 16)::integer],
    alter column color_key set not null;
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
                "alter table signal_group drop column color_key;",
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
