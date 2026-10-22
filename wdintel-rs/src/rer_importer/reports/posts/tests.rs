use super::*;
use crate::entities::sea_orm_active_enums::IntelProductRelationKind;
use crate::functest::tests::*;
use crate::rer_importer::types::InboxMessagesReq;
use serial_test::serial;

#[tokio::test]
#[serial]
async fn issue_3864_posts_report_excludes_products_and_keeps_sources(
) -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let login = find_test_login(&env.dbx).await.c(h!())?;
    let group = find_test_datasource_group(&env.dbx).await.c(h!())?;
    let timestamp = chrono::Utc::now().naive_utc();
    let mut message_ids = Vec::new();
    for _ in 0..4 {
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                timestamp: Set(Some(timestamp)),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.group_master_key.clone())),
                datasource_group_id: Set(Some(group.id)),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(timestamp)),
                freq: Set(Some("138.500".to_string())),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        message_ids.push(message.id);
    }
    for (intel_message_id, relation_kind) in [
        (message_ids[2], IntelProductRelationKind::Comment),
        (message_ids[3], IntelProductRelationKind::Report),
    ] {
        for source_message_id in &message_ids[..2] {
            intel_product::ActiveModel {
                intel_message_id: Set(intel_message_id),
                source_message_id: Set(*source_message_id),
                relation_kind: Set(relation_kind.clone()),
                created_at: Set(timestamp),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .c(h!())?;
        }
    }

    let messages = load_post_report_messages(
        &env.dbx,
        &login.id,
        &env,
        &InboxMessagesReq {
            since_date_inclusive_ms: Some(
                timestamp.and_utc().timestamp_millis() - 1,
            ),
            till_date_inclusive_ms: Some(
                timestamp.and_utc().timestamp_millis() + 1,
            ),
            selected_groups: Some(vec![group.group_master_key]),
            return_duplicates: Some(false),
            ..Default::default()
        },
        ReportPeriodEnd::Inclusive,
    )
    .await
    .c(h!())?;
    let mut actual_ids = messages.iter().map(|(id, _)| *id).collect_vec();
    actual_ids.sort_unstable();
    assert_eq!(actual_ids, message_ids[..2]);
    assert!(messages
        .iter()
        .all(|(_, message)| message.freq.as_deref() == Some("138.500")));
    Ok(())
}
