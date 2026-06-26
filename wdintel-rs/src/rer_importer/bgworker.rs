use crate::config::*;
use crate::types::*;
use sea_orm::*;

const CAPACITY: usize = 2000;

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
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    let mut recs = vec![message_id];
    let mut changed_inbox_item_ids = vec![];
    while !recs.is_empty() {
        let Some(message_id) = recs.pop() else {
            break;
        };
        match crate::inbox::construct_inbox_item(
            settlements.clone(),
            txn,
            rq,
            config,
            message_id,
            &mut cache,
            m_created_at.clone(),
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
