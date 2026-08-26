use super::*;
use crate::messenger::types::UnstageResult;
use crate::types::ShortContext;

/// Unsage logic
///
/// - when we create a message we set it deleted
/// - if we find that it's a duplicate - we link it to the original and delete the staged one
/// - if it's not a duplicate - we unmark it as deleted and create the link
pub async fn unstage_message(
    txn: &DatabaseTransaction,
    master_key: &str,
    message: signal_message::Model,
    m_duplicate_of: Option<(signal_message::Model, datasource_group::Model)>,
) -> anyhow::Result<UnstageResult> {
    if let Some((original, _group)) = m_duplicate_of {
        crate::battle_line::lock_updates_shared(txn).await.c(h!())?;
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(original.id),
            signal_message_uuid: Set(original.id_uuid),
            group_master_key: Set(Some(master_key.to_string())),
            sender: Set(message.sender.clone()),
            login_id: Set(message.login_id),
            message_uid: Set(original.message_uid.clone()),
            datasource_group_id: Set(message.datasource_group_id),
            created_at: Set(message.created_at),
        }
        .insert(txn)
        .await
        .c(h!())?;
        crate::battle_line::settlement_queue::requeue_item_settlements(
            txn,
            original.id,
        )
        .await
        .c(h!())?;
        if message.external_id.is_some()
            || message.echo_inbox_message_id.is_some()
        {
            let trace_message_uid = duplicate_trace_message_uid(message.id);
            let mut message = message.into_active_model();
            message.message_uid = Set(Some(trace_message_uid));
            message.update(txn).await.c(h!())?;
        } else {
            signal_message::Entity::delete_many()
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(txn)
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
    let message = model.update(txn).await.c(h!())?;
    signal_message_group::ActiveModel {
        id: NotSet,
        signal_message_id: Set(message.id),
        signal_message_uuid: Set(message.id_uuid),
        group_master_key: Set(Some(master_key.to_string())),
        sender: Set(message.sender.clone()),
        login_id: Set(message.login_id),
        message_uid: Set(message.message_uid.clone()),
        datasource_group_id: Set(message.datasource_group_id),
        created_at: Set(message.created_at),
    }
    .insert(txn)
    .await
    .c(h!())?;
    crate::battle_line::settlement_queue::requeue_item_settlements(
        txn, message.id,
    )
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
                where sii.id = $1
                on conflict (id) do update
                set search_tsv = excluded.search_tsv"#,
        [db_message_id.into()],
    );
    txn.execute_raw(statement).await.c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_signal_group, mk_signal_message,
    };
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
        let echo_inbox_message_id = 4242;
        let staged = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                deleted: Set(true),
                external_id: Set(None),
                echo_inbox_message_id: Set(Some(echo_inbox_message_id)),
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
        assert_eq!(trace.external_id, None);
        assert_eq!(trace.echo_inbox_message_id, Some(echo_inbox_message_id));
        assert_eq!(
            trace.message_uid.as_deref(),
            Some(duplicate_trace_message_uid(staged.id).as_str())
        );
        assert_ne!(trace.message_uid, original.message_uid);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn unstage_message_requeues_existing_settlement_links() {
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
        let message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                deleted: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message.id),
            settlement_text: Set("TEST".to_string()),
            settlement_id: Set(None),
            is_undefined: Set(Some(true)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();

        unstage_message(&txn, &signal_group.master_key, message.clone(), None)
            .await
            .unwrap();

        let settlement_link = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(message.id))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settlement_link.settlement_id, None);
        assert_eq!(settlement_link.is_undefined, None);
        txn.rollback().await.unwrap();
    }
}
