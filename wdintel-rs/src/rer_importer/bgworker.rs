use crate::config::*;
use crate::types::*;
use sea_orm::*;

const CAPACITY: usize = 2000;

pub async fn process_message_to_inbox_nofail<'a, 'async_trait, C>(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &'a C,
    rq: &reqwest::Client,
    config: &Config,
    redis: &mut redis::aio::ConnectionManager,
    message_id: i64,
    m_created_at: Option<(String, String)>,
) where
    C: ConnectionTrait + 'async_trait,
{
    let mut cache = TopKCache::<String, String>::new(CAPACITY);
    let mut recs = vec![message_id];
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
            redis,
            m_created_at.clone(),
        )
        .await
        {
            Err(e) => {
                error!(
                    "> error while running inbox_item_oneoff_nofail: {e:#?}"
                );
            }
            Ok(new_recs) => {
                new_recs.iter().for_each(|rec| recs.push(*rec));
            }
        }
    }
}
