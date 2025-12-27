use crate::config::MAX_FIX_WHATSAPP_SENDERS_MESSAGE_DAYS;
use crate::entities::signal_message;
use crate::error::AppError;
use crate::h;
use crate::messenger::worker;
use crate::types::{Mode, ShortContext};
use chrono::Utc;
use sea_orm::*;

pub async fn oneoff_fix_whatsapp_senders(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let cutoff_ts = Utc::now().naive_utc()
        - chrono::Duration::days(MAX_FIX_WHATSAPP_SENDERS_MESSAGE_DAYS);
    let mut max_ts = Utc::now().naive_utc();
    let mut fuel = 1000;
    loop {
        fuel -= 1;
        if fuel < 0 {
            return Err(AppError::AnyhowError {
                source: anyhow::anyhow!("endless loop detected, halting..."),
            });
        }
        let messages = signal_message::Entity::find()
            .filter(signal_message::Column::Sender.is_not_null())
            .filter(signal_message::Column::Sender.like("%:%"))
            .filter(signal_message::Column::CreatedAt.gte(cutoff_ts))
            .filter(signal_message::Column::CreatedAt.lte(max_ts))
            .order_by_desc(signal_message::Column::CreatedAt)
            .limit(1000)
            .all(&dbx)
            .await
            .c(h!())?;
        if messages.is_empty() {
            break;
        }
        for m in messages {
            max_ts = m.created_at;
            let Some(sender) = m.sender.clone() else {
                continue;
            };
            let mut m_am = m.into_active_model();
            m_am.sender =
                Set(Some(worker::clear_messenger_login_string(&sender)));
            m_am.update(&dbx).await.c(h!())?;
        }
    }
    Ok(())
}
