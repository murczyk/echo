use crate::entities::{datasource, echo_attachment, echo_client_lock};
use crate::types::*;
use echo_im::types::MessageAttachmentF1;
use sea_orm::*;

pub async fn load_latest_echo_attachment_batch(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    echo_inbox_message_id: i32,
) -> anyhow::Result<Option<Vec<MessageAttachmentF1>>> {
    let Some(account_id) =
        datasource_echo_account_id(txn, datasource_id).await?
    else {
        return Ok(None);
    };
    let mut attachments = echo_attachment::Entity::find()
        .filter(echo_attachment::Column::MessageId.eq(echo_inbox_message_id))
        .filter(echo_attachment::Column::AccountId.eq(account_id))
        .order_by_desc(echo_attachment::Column::CreatedAt)
        .order_by_asc(echo_attachment::Column::Id)
        .all(txn)
        .await
        .c(h!())?;
    let Some(latest_created_at) =
        attachments.first().map(|attachment| attachment.created_at)
    else {
        return Ok(None);
    };
    attachments.retain(|attachment| attachment.created_at == latest_created_at);
    attachments.sort_by_key(|attachment| attachment.id);
    Ok(Some(
        attachments
            .into_iter()
            .map(|attachment| MessageAttachmentF1 {
                path: attachment.path,
                name: attachment.name,
            })
            .collect(),
    ))
}

pub fn latest_attachment_batch_by_expected_count(
    mut attachments: Vec<MessageAttachmentF1>,
    previous_attachment_count: usize,
) -> Vec<MessageAttachmentF1> {
    let Some(batch_size) =
        latest_attachment_batch_size(&attachments, previous_attachment_count)
    else {
        return attachments;
    };
    attachments.split_off(attachments.len() - batch_size)
}

async fn datasource_echo_account_id(
    txn: &DatabaseTransaction,
    datasource_id: i64,
) -> anyhow::Result<Option<i32>> {
    let Some(datasource) = datasource::Entity::find_by_id(datasource_id)
        .one(txn)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let Some(echo_client_lock_id) = datasource.echo_client_lock_id else {
        return Ok(None);
    };
    let Some(echo_client_lock) =
        echo_client_lock::Entity::find_by_id(echo_client_lock_id as i32)
            .one(txn)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    Ok(Some(echo_client_lock.account_id))
}

fn latest_attachment_batch_size(
    attachments: &[MessageAttachmentF1],
    previous_attachment_count: usize,
) -> Option<usize> {
    if previous_attachment_count == 0
        || attachments.len() <= previous_attachment_count
    {
        return None;
    }
    if attachments.len().is_multiple_of(previous_attachment_count) {
        return Some(previous_attachment_count);
    }
    (1..=previous_attachment_count.min(attachments.len() / 2))
        .filter(|batch_size| {
            previous_attachment_count.is_multiple_of(*batch_size)
                && attachments.len().is_multiple_of(*batch_size)
                && is_repeated_attachment_batch(attachments, *batch_size)
        })
        .max()
}

fn is_repeated_attachment_batch(
    attachments: &[MessageAttachmentF1],
    batch_size: usize,
) -> bool {
    attachments
        .chunks(batch_size)
        .all(|chunk| chunk == &attachments[..batch_size])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(path: &str) -> MessageAttachmentF1 {
        MessageAttachmentF1 {
            path: path.to_string(),
            name: Some(path.to_string()),
        }
    }

    #[test]
    fn keeps_intentional_duplicate_without_previous_count() {
        let attachments = latest_attachment_batch_by_expected_count(
            vec![attachment("x.gif"), attachment("x.gif")],
            0,
        );

        assert_eq!(attachments.len(), 2);
    }

    #[test]
    fn keeps_latest_batch_when_echo_repeats_previous_batch() {
        let attachments = latest_attachment_batch_by_expected_count(
            vec![
                attachment("x.gif"),
                attachment("y.gif"),
                attachment("x.gif"),
                attachment("y.gif"),
            ],
            2,
        );

        assert_eq!(attachments, vec![attachment("x.gif"), attachment("y.gif")]);
    }

    #[test]
    fn recovers_when_previous_count_already_contains_repeated_batches() {
        let attachments = latest_attachment_batch_by_expected_count(
            vec![
                attachment("x.gif"),
                attachment("y.gif"),
                attachment("x.gif"),
                attachment("y.gif"),
                attachment("x.gif"),
                attachment("y.gif"),
            ],
            4,
        );

        assert_eq!(attachments, vec![attachment("x.gif"), attachment("y.gif")]);
    }

    #[test]
    fn keeps_non_repeated_count_mismatch() {
        let attachments = latest_attachment_batch_by_expected_count(
            vec![
                attachment("a.gif"),
                attachment("b.gif"),
                attachment("c.gif"),
                attachment("d.gif"),
                attachment("e.gif"),
            ],
            4,
        );

        assert_eq!(attachments.len(), 5);
    }
}
