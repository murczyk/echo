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
alter table signal_group add column color_key text check (color_key is null or color_key in (
    'red', 'pink', 'purple', 'deep_purple',
    'indigo', 'blue', 'light_blue', 'cyan',
    'teal', 'green', 'light_green', 'lime',
    'amber', 'orange', 'deep_orange', 'blue_grey'
));

update signal_group
set color_key = (array[
    'red', 'pink', 'purple', 'deep_purple',
    'indigo', 'blue', 'light_blue', 'cyan',
    'teal', 'green', 'light_green', 'lime',
    'amber', 'orange', 'deep_orange', 'blue_grey'
])[1 + ((('x' || substr(md5(master_key), 1, 8))::bit(32)::bigint) % 16)]
where color_key is null;

create function signal_group_set_color_key() returns trigger as $$
begin
    if new.color_key is null then
        new.color_key := (array[
        'red', 'pink', 'purple', 'deep_purple',
        'indigo', 'blue', 'light_blue', 'cyan',
        'teal', 'green', 'light_green', 'lime',
        'amber', 'orange', 'deep_orange', 'blue_grey'
        ])[1 + floor(random() * 16)::integer];
    end if;
    return new;
end;
$$ language plpgsql;

create trigger signal_group_set_color_key
before insert or update of color_key on signal_group
for each row execute function signal_group_set_color_key();
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
drop trigger signal_group_set_color_key on signal_group;
drop function signal_group_set_color_key();
alter table signal_group drop column color_key;
                "#,
            )
            .await
            .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
        Ok(())
    }
}
