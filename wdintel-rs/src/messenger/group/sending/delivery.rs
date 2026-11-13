use crate::config::{
    MESSENGER_GROUP_SEND_ATTACHMENTS_TOTAL_MAX_BYTES,
    MESSENGER_GROUP_SEND_ATTACHMENT_MAX_BYTES,
};
use crate::entities::{signal_message, signal_message_media};
use crate::types::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use echo_im::types::{MessageSource, OutboxAttachmentInput, SendMessageReq};
use futures_util::TryStreamExt;
use sea_orm::*;

#[derive(FromQueryResult)]
struct Destination {
    master_key: String,
    client_name: String,
    source: String,
}

pub(crate) async fn enqueue(
    env: &Env,
    txn: &DatabaseTransaction,
    login_id: &uuid::Uuid,
    signal_message_id: i64,
) -> anyhow::Result<()> {
    let destinations =
        Destination::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select g.master_key, ec.name as client_name, ec.source::text as source
from signal_message sm
join lateral (
    select dg.group_master_key from datasource_group dg
    where dg.id = sm.datasource_group_id and not dg.deleted
    union
    select smg.group_master_key from signal_message_group smg
    join datasource_group dg on dg.id = smg.datasource_group_id and not dg.deleted
    where smg.signal_message_id = sm.id
) destination on true
join signal_group g on g.master_key = destination.group_master_key
join lateral (
    select ec.name, ea.source
    from datasource_group dg
    join datasource d on d.id = dg.datasource_id
    join echo_client_lock ecl on ecl.id = d.echo_client_lock_id
    join echo_client ec on ec.id = ecl.client_id
    join echo_account ea on ea.id = ecl.account_id
    where dg.group_master_key = g.master_key and not dg.deleted
        and not d.deleted and d.can_send_messages is true
        and d.kind in ('signal', 'whatsapp')
        and not ec.deleted and not ecl.remove_requested
        and ea.source::text in ('signal', 'whatsapp')
    order by (d.status = 'active') desc, d.display_name, d.id
    limit 1
) ec on true
join login l on l.id = $2
join sigint_group_sender_organism sender
    on sender.master_key = g.master_key and sender.organism_id = l.organism_id
where sm.id = $1 and not sm.deleted
    and not g.deleted and not g.is_archived and g.send_messages is true
"#,
            vec![signal_message_id.into(), (*login_id).into()],
        ))
        .all(txn)
        .await
        .c(h!())?;
    if destinations.is_empty() {
        return Ok(());
    }
    let message = signal_message::Entity::find_by_id(signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    let attachments = attachments(env, txn, signal_message_id).await.c(h!())?;
    for destination in destinations {
        echo_im::send_message(
            SendMessageReq {
                text: message.body.clone().unwrap_or_default(),
                source: if destination.source == "signal" {
                    MessageSource::Signal
                } else {
                    MessageSource::Whatsapp
                },
                group_ids: vec![destination.master_key],
                recipient_phone_numbers: vec![],
                attachments: attachments.clone(),
            },
            &destination.client_name,
            txn,
            None,
        )
        .await
        .c(h!())?
        .c(h!())?;
    }
    Ok(())
}

async fn attachments(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
) -> anyhow::Result<Vec<OutboxAttachmentInput>> {
    let media = crate::messenger::audio_ref::for_messages(
        env,
        txn,
        &[signal_message_id],
    )
    .await
    .c(h!())?;
    validate_attachment_sizes(&media).c(h!())?;
    let mut attachments = Vec::with_capacity(media.len());
    for media in media {
        let bytes = attachment_bytes(env, txn, &media).await.c(h!())?;
        anyhow::ensure!(
            i64::try_from(bytes.len()).c(h!())? == media.size_bytes,
            "Incomplete attachment {}",
            media.id
        );
        attachments.push(OutboxAttachmentInput {
            content_base64: STANDARD.encode(bytes),
            extension: media.file_ext,
        });
    }
    Ok(attachments)
}

fn validate_attachment_sizes(
    media: &[signal_message_media::Model],
) -> anyhow::Result<()> {
    let mut total_bytes = 0;
    for media in media {
        let size = u64::try_from(media.size_bytes).c(h!())?;
        anyhow::ensure!(
            size <= MESSENGER_GROUP_SEND_ATTACHMENT_MAX_BYTES,
            "Вкладення перевищує 25 МіБ для надсилання в месенджер."
        );
        total_bytes += size;
        anyhow::ensure!(
            total_bytes <= MESSENGER_GROUP_SEND_ATTACHMENTS_TOTAL_MAX_BYTES,
            "Загальний розмір вкладень перевищує 100 МіБ для надсилання в месенджер."
        );
    }
    Ok(())
}

async fn attachment_bytes(
    env: &Env,
    txn: &DatabaseTransaction,
    media: &signal_message_media::Model,
) -> anyhow::Result<Vec<u8>> {
    if crate::messenger::audio_ref::is_reference(media) {
        let reference = crate::messenger::audio_ref::reference(txn, media.id)
            .await
            .c(h!())?
            .c(h!())?;
        let audio = crate::messenger::audio_ref::audio(env, &reference)
            .await
            .c(h!())?;
        return crate::devices::audio::shared_bytes(&env.device_audio, &audio)
            .await
            .c(h!());
    }
    if media.is_encrypted {
        return crate::messenger::media::fetch_media_bytes(env, media)
            .await
            .c(h!());
    }
    let size = u64::try_from(media.size_bytes).c(h!())?;
    let mut stream = crate::messenger::media::stream_plaintext_media_range(
        env,
        media,
        0..size,
    )
    .await
    .c(h!())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.try_next().await.c(h!())? {
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) as u64 <= size,
            "Attachment {} exceeded its size",
            media.id
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
