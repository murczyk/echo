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
                alter table area_of_responsibility
                    rename column order_for_report to order_for_report_legacy;

                create table area_of_responsibility_report_order (
                    id bigserial primary key,
                    area_of_responsibility_id bigint not null references area_of_responsibility(id) on delete cascade,
                    organism_id bigint references organism(id) on delete cascade,
                    order_for_report float8 not null,
                    updated_by text references login(login),
                    updated_at timestamp not null default now(),
                    created_at timestamp not null default now()
                );

                create unique index area_of_responsibility_report_order_scope_uidx
                    on area_of_responsibility_report_order(
                        area_of_responsibility_id,
                        coalesce(organism_id, 0)
                    );

                create index area_of_responsibility_report_order_organism_idx
                    on area_of_responsibility_report_order(organism_id);

                create index area_of_responsibility_report_order_aor_idx
                    on area_of_responsibility_report_order(area_of_responsibility_id);

                insert into area_of_responsibility_report_order (
                    area_of_responsibility_id,
                    organism_id,
                    order_for_report
                )
                select id, null, order_for_report_legacy
                from area_of_responsibility
                where deleted = false
                on conflict do nothing;
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
                drop table if exists area_of_responsibility_report_order;

                alter table area_of_responsibility
                    rename column order_for_report_legacy to order_for_report;
                "#,
            )
            .await?;
        Ok(())
    }
}
