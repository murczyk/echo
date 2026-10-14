use crate::config::*;
use crate::rer_importer::import_csv::reconcile_rer_csv_message_target_group_in_transaction;
use crate::types::*;
use sea_orm::*;

const CAPACITY: usize = 2000;

pub async fn process_message_to_inbox<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    m_created_at: Option<(String, String)>,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let datetime_override = m_created_at.map(|(date, time)| {
        crate::inbox::InboxDatetimeOverride::Fields { date, time }
    });
    Ok(process_message_to_inbox_with_override(
        settlements,
        txn,
        rq,
        config,
        message_id,
        datetime_override,
        None,
    )
    .await
    .c(h!())?)
}

pub(crate) async fn process_message_to_inbox_with_override<
    C: ConnectionTrait,
>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    datetime_override: Option<crate::inbox::InboxDatetimeOverride>,
    target_group: Option<(&str, i64)>,
) -> anyhow::Result<Vec<i64>> {
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    let mut recs = vec![message_id];
    let mut changed_inbox_item_ids = vec![];
    while !recs.is_empty() {
        let Some(message_id) = recs.pop() else {
            break;
        };
        if let Some((group_id, datasource_group_id)) = target_group {
            reconcile_rer_csv_message_target_group_in_transaction(
                group_id,
                datasource_group_id,
                message_id,
                txn,
            )
            .await
            .context(h!())?;
        }
        let result = process_message_to_inbox_one(
            settlements.clone(),
            txn,
            rq,
            config,
            message_id,
            &mut cache,
            datetime_override.clone(),
        )
        .await
        .c(h!())?;

        result
            .spawned_message_ids
            .iter()
            .for_each(|rec| recs.push(*rec));
        if let Some(changed_inbox_item_id) = result.changed_inbox_item_id {
            changed_inbox_item_ids.push(changed_inbox_item_id);
        }
    }
    Ok(changed_inbox_item_ids)
}

pub async fn process_message_to_inbox_nofail<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    m_created_at: Option<(String, String)>,
) -> Vec<i64>
where
    C: ConnectionTrait + 'async_trait,
{
    let datetime_override = m_created_at.map(|(date, time)| {
        crate::inbox::InboxDatetimeOverride::Fields { date, time }
    });
    process_message_to_inbox_nofail_with_override(
        settlements,
        txn,
        rq,
        config,
        message_id,
        datetime_override,
    )
    .await
}

pub(crate) async fn process_historical_message_to_inbox_nofail<
    'a,
    'async_trait,
    C,
>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    datetime: chrono::NaiveDateTime,
    reference_time: chrono::DateTime<chrono_tz::Tz>,
) -> Vec<i64>
where
    C: ConnectionTrait + 'async_trait,
{
    process_message_to_inbox_nofail_with_override(
        settlements,
        txn,
        rq,
        config,
        message_id,
        Some(crate::inbox::InboxDatetimeOverride::Historical {
            datetime,
            reference_time,
        }),
    )
    .await
}

async fn process_message_to_inbox_nofail_with_override<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    datetime_override: Option<crate::inbox::InboxDatetimeOverride>,
) -> Vec<i64>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    let mut recs = vec![message_id];
    let mut changed_inbox_item_ids = vec![];
    while !recs.is_empty() {
        let Some(message_id) = recs.pop() else {
            break;
        };
        match process_message_to_inbox_one(
            settlements.clone(),
            txn,
            rq,
            config,
            message_id,
            &mut cache,
            datetime_override.clone(),
        )
        .await
        {
            Err(e) => {
                error!(
                    "> error while running inbox_item_oneoff_nofail: {:#?}",
                    e
                );
            }
            Ok(result) => {
                result
                    .spawned_message_ids
                    .iter()
                    .for_each(|rec| recs.push(*rec));
                if let Some(changed_inbox_item_id) =
                    result.changed_inbox_item_id
                {
                    changed_inbox_item_ids.push(changed_inbox_item_id);
                }
            }
        }
    }
    changed_inbox_item_ids
}

async fn process_message_to_inbox_one<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    message_id: i64,
    cache: &mut TopKCache<String, String>,
    datetime_override: Option<crate::inbox::InboxDatetimeOverride>,
) -> Result<crate::inbox::ConstructInboxItemResult, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(crate::inbox::construct_inbox_item_with_datetime(
        settlements,
        txn,
        rq,
        config,
        message_id,
        cache,
        datetime_override,
    )
    .await
    .c(h!())?)
}
