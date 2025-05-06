use crate::entities::sigint_inbox_item;
use crate::h;
use crate::types::*;
use anyhow::Context;
use futures_util::TryStreamExt;
use sea_orm::*;

const CAPACITY: usize = 2000;

pub async fn process_unit_v2_worker(dbx: &DatabaseConnection) {
    debug!("starting process_unit_v2_worker");
    loop {
        if let Err(e) = run_process_unit_v2_worker(&dbx).await {
            error!("process_unit_v2_worker error: {}", e);
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    }
}

pub async fn run_process_unit_v2_worker(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    loop {
        let mut q = sigint_inbox_item::Entity::find()
            .filter(sigint_inbox_item::Column::Unit.is_not_null())
            .filter(sigint_inbox_item::Column::ParsedUnitV2.eq(false));
        let two_hours_ago = chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::hours(2))
            .context(h!())?;
        q = q.filter(sigint_inbox_item::Column::Datetime.gte(two_hours_ago));
        let mut stream = q
            .order_by_desc(sigint_inbox_item::Column::Datetime)
            .stream(dbx)
            .await
            .context(h!())?;
        while let Some(entry) = stream.try_next().await.context(h!())? {
            let unit = entry.unit.clone().context(h!())?;
            let mut cached_m_unit = cache.get(&unit).cloned();
            if cached_m_unit.is_none() {
                let parsed_unit = crate::unit::parse_unit(&unit, dbx)
                    .await
                    .context(h!())?
                    .unwrap_or("".to_string());
                cache.put(unit.clone(), parsed_unit.clone());
                cached_m_unit = Some(parsed_unit);
            }
            let m_unit = cached_m_unit.filter(|u| !u.is_empty());

            let mut active_model = entry.into_active_model();
            active_model.unit_v2 = Set(m_unit);
            active_model.parsed_unit_v2 = Set(true);
            active_model.update(dbx).await.context(h!())?;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    }
}
