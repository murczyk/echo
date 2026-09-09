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
        replace_foreign_key_delete_actions(
            manager,
            r#"
                ('sigint_callsign', 'unit_id', 'sigint_unit', 'id', 'cascade'),
                ('sigint_callsign_changelog', 'sigint_callsign_id', 'sigint_callsign', 'id', 'cascade'),
                ('sigint_network_callsign', 'unit_id', 'sigint_unit', 'id', 'set null'),
                ('sigint_network_unit', 'unit_id', 'sigint_unit', 'id', 'cascade'),
                ('sigint_network_unit_changelog', 'sigint_network_unit_id', 'sigint_network_unit', 'id', 'cascade'),
                ('sigint_signal', 'unit', 'sigint_unit', 'id', 'set null'),
                ('sigint_unit_changelog', 'sigint_unit_id', 'sigint_unit', 'id', 'cascade')
            "#,
        )
        .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        replace_foreign_key_delete_actions(
            manager,
            r#"
                ('sigint_callsign', 'unit_id', 'sigint_unit', 'id', 'no action'),
                ('sigint_callsign_changelog', 'sigint_callsign_id', 'sigint_callsign', 'id', 'no action'),
                ('sigint_network_callsign', 'unit_id', 'sigint_unit', 'id', 'no action'),
                ('sigint_network_unit', 'unit_id', 'sigint_unit', 'id', 'no action'),
                ('sigint_network_unit_changelog', 'sigint_network_unit_id', 'sigint_network_unit', 'id', 'no action'),
                ('sigint_signal', 'unit', 'sigint_unit', 'id', 'no action'),
                ('sigint_unit_changelog', 'sigint_unit_id', 'sigint_unit', 'id', 'no action')
            "#,
        )
        .await
    }
}

async fn replace_foreign_key_delete_actions(
    manager: &SchemaManager<'_>,
    relationships: &str,
) -> Result<(), DbErr> {
    manager
        .get_connection()
        .execute_unprepared(&format!(
            r#"
do $$
declare
    relationship record;
    constraint_name text;
begin
    for relationship in
        select *
        from (values {relationships}) as relationships(
            relation_name,
            column_name,
            referenced_relation_name,
            referenced_column_name,
            delete_action
        )
    loop
        select pg_constraint.conname
        into constraint_name
        from pg_constraint
        where pg_constraint.conrelid = relationship.relation_name::regclass
          and pg_constraint.confrelid = relationship.referenced_relation_name::regclass
          and pg_constraint.contype = 'f'
          and pg_constraint.conkey = array[
              (
                  select pg_attribute.attnum
                  from pg_attribute
                  where pg_attribute.attrelid = relationship.relation_name::regclass
                    and pg_attribute.attname = relationship.column_name
              )
          ]::smallint[]
          and pg_constraint.confkey = array[
              (
                  select pg_attribute.attnum
                  from pg_attribute
                  where pg_attribute.attrelid = relationship.referenced_relation_name::regclass
                    and pg_attribute.attname = relationship.referenced_column_name
              )
          ]::smallint[];

        if constraint_name is null then
            raise exception 'foreign key from % to % does not exist',
                relationship.relation_name,
                relationship.referenced_relation_name;
        end if;

        execute format(
            'alter %s %I drop constraint %I',
            'table',
            relationship.relation_name,
            constraint_name
        );
        execute format(
            'alter %s %I add constraint %I foreign key (%I) references %I (%I) on delete %s',
            'table',
            relationship.relation_name,
            constraint_name,
            relationship.column_name,
            relationship.referenced_relation_name,
            relationship.referenced_column_name,
            relationship.delete_action
        );
    end loop;
end
$$;
            "#,
        ))
        .await
        .map_err(|error| DbErr::Migration(format!("{}: {error}", h!())))?;
    Ok(())
}
