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
                create or replace function
                    public.file_entry_reject_invalid_current_analysis()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.current_analysis_run_id is null then
                        return new;
                    end if;
                    if not exists (
                        select 1
                        from file_analysis_run_item as item
                        join file_revision as target
                          on target.id = item.file_id
                         and target.revision = item.metadata_revision
                        where item.id = new.current_analysis_run_id
                          and item.file_id = new.id
                          and item.completed_at is not null
                          and target.analysis_input_revision =
                              new.analysis_input_revision
                    ) then
                        raise exception
                            'current file analysis must be complete and match the current evaluator input';
                    end if;
                    return new;
                end
                $function$;
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
                create or replace function
                    public.file_entry_reject_invalid_current_analysis()
                returns trigger
                language plpgsql
                security invoker
                set search_path = pg_catalog, public
                as $function$
                begin
                    if new.current_analysis_run_id is null then
                        return new;
                    end if;
                    if not exists (
                        select 1
                        from file_analysis_run_item as item
                        join file_metadata_revision as target
                          on target.id = item.file_id
                         and target.revision = item.metadata_revision
                        where item.id = new.current_analysis_run_id
                          and item.file_id = new.id
                          and item.completed_at is not null
                          and target.analysis_input_revision =
                              new.analysis_input_revision
                    ) then
                        raise exception
                            'current file analysis must be complete and match the current evaluator input';
                    end if;
                    return new;
                end
                $function$;
                "#,
            )
            .await?;
        Ok(())
    }
}
