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
                alter table file_entry
                    drop constraint file_entry_sync_projection_check,
                    add constraint file_entry_sync_projection_check
                        check (
                            (
                                kind = 'file'
                                and revision is not null
                                and sync_id is not null
                                and analysis_input_revision is not null
                                and (
                                    (
                                        source_file_state is null
                                        and source_file_state_settled_at is null
                                        and source_file_state_settled_by is null
                                    )
                                    or (
                                        source_file_state is not null
                                        and source_file_state_settled_at is not null
                                        and (
                                            source_file_state_settled_by is null
                                            or pg_catalog.btrim(
                                                source_file_state_settled_by
                                            ) <> ''
                                        )
                                    )
                                )
                            )
                            or (
                                kind = 'directory'
                                and revision is null
                                and sync_id is null
                                and analysis_input_revision is null
                                and current_analysis_run_id is null
                                and source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                        );

                alter table file_revision
                    drop constraint file_metadata_revision_source_state_check,
                    add constraint file_metadata_revision_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and (
                                    source_file_state_settled_by is null
                                    or pg_catalog.btrim(
                                        source_file_state_settled_by
                                    ) <> ''
                                )
                            )
                        );

                alter table file_sync_item
                    drop constraint file_sync_item_source_state_check,
                    add constraint file_sync_item_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and (
                                    source_file_state_settled_by is null
                                    or pg_catalog.btrim(
                                        source_file_state_settled_by
                                    ) <> ''
                                )
                            )
                        );
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
                alter table file_entry
                    drop constraint file_entry_sync_projection_check,
                    add constraint file_entry_sync_projection_check
                        check (
                            (
                                kind = 'file'
                                and revision is not null
                                and sync_id is not null
                                and analysis_input_revision is not null
                                and (
                                    (
                                        source_file_state is null
                                        and source_file_state_settled_at is null
                                        and source_file_state_settled_by is null
                                    )
                                    or (
                                        source_file_state is not null
                                        and source_file_state_settled_at is not null
                                        and source_file_state_settled_by is not null
                                        and pg_catalog.btrim(
                                            source_file_state_settled_by
                                        ) <> ''
                                    )
                                )
                            )
                            or (
                                kind = 'directory'
                                and revision is null
                                and sync_id is null
                                and analysis_input_revision is null
                                and current_analysis_run_id is null
                                and source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                        );

                alter table file_revision
                    drop constraint file_metadata_revision_source_state_check,
                    add constraint file_metadata_revision_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and source_file_state_settled_by is not null
                                and pg_catalog.btrim(
                                    source_file_state_settled_by
                                ) <> ''
                            )
                        );

                alter table file_sync_item
                    drop constraint file_sync_item_source_state_check,
                    add constraint file_sync_item_source_state_check
                        check (
                            (
                                source_file_state is null
                                and source_file_state_settled_at is null
                                and source_file_state_settled_by is null
                            )
                            or (
                                source_file_state is not null
                                and source_file_state_settled_at is not null
                                and source_file_state_settled_by is not null
                                and pg_catalog.btrim(
                                    source_file_state_settled_by
                                ) <> ''
                            )
                        );
                "#,
            )
            .await?;
        Ok(())
    }
}
