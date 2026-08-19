use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{
    h, new_pg_maintenance_connection_from_mode, new_pg_pool_from_mode,
    OneoffBackfillInboxNetworksPs, OneoffPrepareInboxNetworkUniquenessPs,
};
use chrono::NaiveDateTime;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use std::time::Instant;

const PREPARE_INBOX_NETWORK_UNIQUENESS_SQL: &str = r#"
delete from sigint_inbox_item_network duplicate
using sigint_inbox_item_network retained
where duplicate.sigint_network_id = retained.sigint_network_id
  and duplicate.sigint_inbox_item_id = retained.sigint_inbox_item_id
  and duplicate.id > retained.id;
"#;
const SIGINT_INBOX_NETWORK_UNIQUE_INDEX: &str =
    "sigint_inbox_item_network_network_inbox_uq";

pub async fn oneoff_backfill_inbox_networks(
    mode: Mode,
    ps: OneoffBackfillInboxNetworksPs,
) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let since_ts = parse_m_ts(ps.start).ok();
    let till_ts = parse_m_ts(ps.end).ok();
    backfill_inbox_networks(&db, since_ts, till_ts)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn backfill_inbox_networks(
    db: &DatabaseConnection,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> anyhow::Result<()> {
    super::enqueue_network_invalidation_task(
        db,
        since_ts,
        till_ts,
        super::NetworkInvalidationScope::default(),
        "oneoff inbox network backfill".to_string(),
    )
    .await
    .c(h!())
}

pub async fn oneoff_prepare_inbox_network_uniqueness(
    mode: Mode,
    ps: &OneoffPrepareInboxNetworkUniquenessPs,
) -> Result<(), AppError> {
    if !ps.yes {
        return Err(AppError::BL {
            msg: "pass --yes to delete duplicate inbox-network links and create the unique index"
                .to_string(),
        });
    }
    let db = new_pg_maintenance_connection_from_mode(mode)
        .await
        .c(h!())?;
    prepare_inbox_network_uniqueness(&db).await.c(h!())?;
    Ok(())
}

async fn prepare_inbox_network_uniqueness(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    db.execute_unprepared("set statement_timeout = 0; set lock_timeout = 0;")
        .await
        .c(h!())?;
    if inbox_network_unique_index_is_valid(db).await.c(h!())? {
        println!("inbox-network unique index is already valid");
        return Ok(());
    }

    drop_invalid_inbox_network_unique_index(db).await.c(h!())?;
    let started_at = Instant::now();
    let deleted = db
        .execute_unprepared(PREPARE_INBOX_NETWORK_UNIQUENESS_SQL)
        .await
        .c(h!())?
        .rows_affected();
    println!(
        "deleted {deleted} duplicate inbox-network links in {:.2?}",
        started_at.elapsed()
    );

    let index_started_at = Instant::now();
    db.execute_unprepared(&format!(
        "create unique index concurrently {} on sigint_inbox_item_network \
         (sigint_network_id, sigint_inbox_item_id);",
        SIGINT_INBOX_NETWORK_UNIQUE_INDEX,
    ))
    .await
    .c(h!())?;
    if !inbox_network_unique_index_is_valid(db).await.c(h!())? {
        anyhow::bail!(
            "inbox-network unique index was created but is not valid"
        );
    }
    println!(
        "created the inbox-network unique index in {:.2?}; total {:.2?}",
        index_started_at.elapsed(),
        started_at.elapsed()
    );
    Ok(())
}

async fn drop_invalid_inbox_network_unique_index(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let index_exists = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "select 1 \
                 from pg_class index_class \
                 join pg_namespace index_namespace \
                   on index_namespace.oid = index_class.relnamespace \
                 where index_class.relkind = 'i' \
                   and index_namespace.nspname = 'public' \
                   and index_class.relname = '{}'",
                SIGINT_INBOX_NETWORK_UNIQUE_INDEX,
            ),
        ))
        .await
        .c(h!())?
        .is_some();
    if index_exists {
        println!("dropping the existing invalid inbox-network unique index");
        db.execute_unprepared(&format!(
            "drop index concurrently public.{};",
            SIGINT_INBOX_NETWORK_UNIQUE_INDEX,
        ))
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn inbox_network_unique_index_is_valid(
    db: &DatabaseConnection,
) -> anyhow::Result<bool> {
    Ok(db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                r#"
select 1
from pg_index index_state
join pg_class index_class on index_class.oid = index_state.indexrelid
join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
where index_namespace.nspname = 'public'
  and index_class.relname = '{}'
  and index_state.indrelid = 'public.sigint_inbox_item_network'::regclass
  and index_state.indisunique
  and index_state.indisvalid
  and index_state.indisready
  and index_state.indpred is null
  and index_state.indexprs is null
  and index_state.indnkeyatts = 2
  and (
      select array_agg(attribute.attname order by index_column.ordinality)
      from unnest(index_state.indkey) with ordinality
          as index_column(attribute_number, ordinality)
      join pg_attribute attribute
        on attribute.attrelid = index_state.indrelid
       and attribute.attnum = index_column.attribute_number
  ) = array['sigint_network_id', 'sigint_inbox_item_id']::name[];
                "#,
                SIGINT_INBOX_NETWORK_UNIQUE_INDEX,
            ),
        ))
        .await
        .c(h!())?
        .is_some())
}

fn parse_m_ts(m_ts_txt: Option<String>) -> anyhow::Result<NaiveDateTime> {
    let ts_txt = m_ts_txt.c(h!())?;
    NaiveDateTime::parse_from_str(&ts_txt, "%Y-%m-%dT%H:%M:%S").c(h!())
}
