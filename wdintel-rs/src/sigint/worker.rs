use super::*;
use crate::messenger::types::UnstageResult;
use crate::types::ShortContext;

/// Unsage logic
/// 
/// - when we create a message we set it deleted
/// - if we find that it's a duplicate - we link it to the original and delete the staged one
/// - if it's not a duplicate - we unmark it as deleted and create the link
pub async fn unstage_message<'a, 'async_trait, C>(
    dbx: &'a C,
    master_key: &str,
    message: signal_message::Model,
    m_duplicate_of: Option<(signal_message::Model, datasource_group::Model)>,
) -> anyhow::Result<UnstageResult>
where
    C: ConnectionTrait + 'async_trait,
{
    if let Some((original, _group)) = m_duplicate_of {
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(original.id),
            group_master_key: Set(Some(master_key.to_string())),
            sender: Set(message.sender.clone()),
            message_uid: Set(original.message_uid.clone()),
            datasource_group_id: Set(message.datasource_group_id),
            created_at: Set(message.created_at),
        }
        .insert(dbx)
        .await
        .c(h!())?;
        signal_message::Entity::delete_many()
            .filter(signal_message::Column::Id.eq(message.id))
            .exec(dbx)
            .await
            .c(h!())?;
        return Ok(UnstageResult {
            message: original,
            is_duplicate: true,
        });
    }

    let mut model = message.into_active_model();
    model.deleted = Set(false);
    let message = model.update(dbx).await.c(h!())?;
    signal_message_group::ActiveModel {
        id: NotSet,
        signal_message_id: Set(message.id),
        group_master_key: Set(Some(master_key.to_string())),
        sender: Set(message.sender.clone()),
        message_uid: Set(message.message_uid.clone()),
        datasource_group_id: Set(message.datasource_group_id),
        created_at: Set(message.created_at),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    Ok(UnstageResult {
        message,
        is_duplicate: false,
    })
}

/// Shared logic between signal and buran api integration
pub async fn incoming_message_after_insert<'a, 'async_trait, C>(
    txn: &'a C,
    db_message_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"insert into sigint_search (id, search_tsv)
                select sii.id, to_tsvector('russian', sii.body_noheader->>'body')
                from sigint_inbox_item sii
                where sii.id = $1"#,
        [db_message_id.into()],
    );
    txn.execute(statement).await.c(h!())?;
    Ok(())
}
