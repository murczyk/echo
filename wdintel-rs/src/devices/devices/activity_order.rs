use crate::devices::config::DEVICE_LIST_MAX_LIMIT;
use crate::devices::files::stats;
use crate::entities::device;
use crate::h;
use anyhow::{Context, Result};
use sea_orm::{
    ColumnTrait, DatabaseConnection, QueryFilter, QueryOrder, QuerySelect,
    Select,
};
use std::collections::BTreeMap;

pub(super) async fn read(
    main_db: &DatabaseConnection,
    file_db: &DatabaseConnection,
    query: Select<device::Entity>,
    mut offset: u64,
    limit: u64,
    include_audio: bool,
) -> Result<Vec<device::Model>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut selected = Vec::new();
    let mut cursor = None;
    loop {
        let batch = stats::read_activity_page(
            file_db,
            cursor,
            DEVICE_LIST_MAX_LIMIT,
            include_audio,
        )
        .await
        .context(h!())?;
        let Some(last) = batch.last() else { break };
        cursor = Some(*last);
        let eligible = query
            .clone()
            .filter(device::Column::Id.is_in(batch.iter().map(|row| row.0)))
            .all(main_db)
            .await
            .context(h!())?;
        let mut eligible: BTreeMap<_, _> = eligible
            .into_iter()
            .map(|device| (device.id, device))
            .collect();
        for (id, _) in batch {
            if let Some(device) = eligible.remove(&id) {
                if offset > 0 {
                    offset -= 1;
                } else {
                    selected.push(device);
                    if selected.len() as u64 == limit {
                        return Ok(selected);
                    }
                }
            }
        }
    }
    append_without_activity(
        main_db,
        file_db,
        query,
        offset,
        limit,
        include_audio,
        selected,
    )
    .await
    .context(h!())
}

async fn append_without_activity(
    main_db: &DatabaseConnection,
    file_db: &DatabaseConnection,
    query: Select<device::Entity>,
    mut offset: u64,
    limit: u64,
    include_audio: bool,
    mut selected: Vec<device::Model>,
) -> Result<Vec<device::Model>> {
    let mut cursor = None;
    loop {
        let mut batch_query = query.clone();
        if let Some(cursor) = cursor {
            batch_query = batch_query.filter(device::Column::Id.gt(cursor));
        }
        let batch = batch_query
            .order_by_asc(device::Column::Id)
            .limit(DEVICE_LIST_MAX_LIMIT)
            .all(main_db)
            .await
            .context(h!())?;
        let Some(last) = batch.last() else { break };
        cursor = Some(last.id);
        let ids = batch.iter().map(|device| device.id).collect::<Vec<_>>();
        let (_, activity) =
            stats::read_sort_values(file_db, &ids, include_audio)
                .await
                .context(h!())?;
        for device in batch {
            if activity[device.id.to_string()].is_null() {
                if offset > 0 {
                    offset -= 1;
                } else {
                    selected.push(device);
                    if selected.len() as u64 == limit {
                        return Ok(selected);
                    }
                }
            }
        }
    }
    Ok(selected)
}
