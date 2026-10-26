use crate::h;
use crate::types::{AppError, Mode, ShortContext};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement, TransactionTrait};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct SettlementAdditions {
    pub(super) settlements: u64,
    pub(super) synonyms: u64,
}

pub(crate) async fn oneoff_add_missing_settlements(
    mode: Mode,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    let added = add_missing_settlements(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    println!(
        "Added settlement definitions: settlements={}, synonyms={}",
        added.settlements, added.synonyms
    );
    Ok(())
}

pub(super) async fn add_missing_settlements(
    dbx: &impl ConnectionTrait,
) -> anyhow::Result<SettlementAdditions> {
    let settlements = add_settlement_definitions(dbx).await.c(h!())?;
    let synonyms = add_settlement_synonyms(dbx).await.c(h!())?;
    Ok(SettlementAdditions {
        settlements,
        synonyms,
    })
}

async fn add_settlement_definitions(
    dbx: &impl ConnectionTrait,
) -> anyhow::Result<u64> {
    let result = dbx
        .execute_unprepared(
            r#"
INSERT INTO public.settlement (
    id, kind, name, territorial_community, district, region, lon, lat
)
VALUES
    (94886, 'Village', 'Кам’янка', 'Дворічанська', 'Куп’янський', 'Харківська',
     37.832401, 49.977469),
    (65447, 'Village', 'Рибалкине', 'Вовчанська', 'Чугуївський', 'Харківська',
     37.234633, 50.378159)
ON CONFLICT (id) DO NOTHING;
"#,
        )
        .await
        .c(h!())?;
    Ok(result.rows_affected())
}

async fn add_settlement_synonyms(
    dbx: &impl ConnectionTrait,
) -> anyhow::Result<u64> {
    let result = dbx
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
INSERT INTO public.settlement_alias (id, settlement_id, text)
VALUES ($1, 65447, 'Рибалкіне')
ON CONFLICT DO NOTHING;
"#,
            [Uuid::now_v7().into()],
        ))
        .await
        .c(h!())?;
    Ok(result.rows_affected())
}
