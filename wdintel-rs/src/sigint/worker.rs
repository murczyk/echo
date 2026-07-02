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
        if message.external_id.is_some() {
            let trace_message_uid = duplicate_trace_message_uid(message.id);
            let mut message = message.into_active_model();
            message.message_uid = Set(Some(trace_message_uid));
            message.update(dbx).await.c(h!())?;
        } else {
            signal_message::Entity::delete_many()
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(dbx)
                .await
                .c(h!())?;
        }
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

fn duplicate_trace_message_uid(message_id: i64) -> String {
    format!("duplicate-trace-{message_id}")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup, mk_signal_group, mk_signal_message};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn unstage_duplicate_keeps_echo_external_id_trace() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let signal_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                message_uid: Set(Some("uid-original".to_string())),
                deleted: Set(false),
                external_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let staged = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                deleted: Set(true),
                external_id: Set(Some(4242)),
                message_uid: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let now = Utc::now().naive_utc();
        let datasource_group = datasource_group::Model {
            id: 1,
            group_master_key: signal_group.master_key.clone(),
            datasource_id: 1,
            last_sync_at: now,
            created_at: now,
            name: "group".to_string(),
            deleted: false,
        };

        let result = unstage_message(
            &txn,
            &signal_group.master_key,
            staged.clone(),
            Some((original.clone(), datasource_group)),
        )
        .await
        .unwrap();

        assert!(result.is_duplicate);
        let trace = signal_message::Entity::find_by_id(staged.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(trace.deleted);
        assert_eq!(trace.external_id, staged.external_id);
        assert_eq!(
            trace.message_uid.as_deref(),
            Some(duplicate_trace_message_uid(staged.id).as_str())
        );
        assert_ne!(trace.message_uid, original.message_uid);
        txn.rollback().await.unwrap();
    }
}
