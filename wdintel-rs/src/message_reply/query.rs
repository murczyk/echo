use super::types::*;
use crate::config::{MESSAGE_REPLY_MAX_ANCHORS, MESSAGE_REPLY_PREVIEW_CHARS};
use crate::types::*;
use chrono::NaiveDateTime;
use sea_orm::{ConnectionTrait, DatabaseBackend, FromQueryResult, Statement};
use std::collections::BTreeSet;

#[derive(FromQueryResult)]
pub(super) struct IdRow {
    pub id: i64,
}

pub(super) struct AccessScope {
    groups: Vec<String>,
    senders: Vec<String>,
}

impl AccessScope {
    pub async fn load<C: ConnectionTrait>(
        db: &C,
        login: &Uuid,
    ) -> anyhow::Result<Self> {
        let groups =
            crate::messenger::group::get_identity_sigint_groups(db, login)
                .await
                .c(h!())?;
        let mut owners = crate::users::get_organism_login_ids_by_id(db, login)
            .await
            .c(h!())?;
        if !owners.contains(login) {
            owners.push(*login);
        }
        let senders = owners.iter().map(ToString::to_string).collect();
        Ok(Self { groups, senders })
    }

    pub async fn visible_ids<C: ConnectionTrait>(
        &self,
        db: &C,
        ids: &[i64],
    ) -> anyhow::Result<Vec<i64>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let rows = IdRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with access_messages (requested_id, id) as (
    select id, id from unnest($1::bigint[]) id
    union
    select p.intel_message_id, p.source_message_id from intel_product p
        where p.intel_message_id = any($1) and p.relation_kind in ('report', 'comment')
)
select distinct a.requested_id as id from access_messages a
join signal_message anchor on anchor.id = a.requested_id and not anchor.deleted
join signal_message sm on sm.id = a.id
where exists (select 1 from signal_message_group g where g.signal_message_id = sm.id and g.group_master_key = any($2))
or exists (select 1 from datasource_group dg where dg.id = sm.datasource_group_id and dg.group_master_key = any($2))
or (sm.datasource_group_id is null
    and not exists (select 1 from signal_message_group g where g.signal_message_id = sm.id)
    and coalesce(sm.sender, sm.login_id::text) = any($3))
            "#,
            vec![ids.to_vec().into(), self.groups.clone().into(), self.senders.clone().into()],
        )).all(db).await.c(h!())?;
        Ok(rows.into_iter().map(|row| row.id).collect())
    }
}

#[derive(FromQueryResult)]
struct ReplyRow {
    id: i64,
    original_signal_message_id: Option<i64>,
    reply_signal_message_id: Option<i64>,
    created_at: NaiveDateTime,
    deleted: bool,
}

#[derive(FromQueryResult)]
struct CitationRow {
    id: i64,
    timestamp: Option<NaiveDateTime>,
    created_at: NaiveDateTime,
    preview: String,
    id_uuid: Option<Uuid>,
    message_uid: Option<String>,
}

pub async fn load<C: ConnectionTrait>(
    db: &C,
    login: &Uuid,
    req: &MessageRepliesReq,
) -> anyhow::Result<MessageRepliesRsp> {
    anyhow::ensure!(
        req.signal_message_ids.len() <= MESSAGE_REPLY_MAX_ANCHORS,
        "Too many reply anchors"
    );
    let scope = AccessScope::load(db, login).await.c(h!())?;
    let anchors = scope
        .visible_ids(db, &req.signal_message_ids)
        .await
        .c(h!())?;
    if anchors.is_empty() {
        return Ok(MessageRepliesRsp {
            replies: vec![],
            reply_messages: vec![],
        });
    }
    let rows = ReplyRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"select * from (
            select id, original_signal_message_id, reply_signal_message_id, created_at, deleted
                from message_reply where original_signal_message_id = any($1)
            union
            select id, original_signal_message_id, reply_signal_message_id, created_at, deleted
                from message_reply where reply_signal_message_id = any($1)
        ) replies order by created_at, id"#,
        vec![anchors.clone().into()],
    )).all(db).await.c(h!())?;
    let mut ids: BTreeSet<i64> = rows
        .iter()
        .filter(|row| !row.deleted)
        .flat_map(|row| {
            [row.original_signal_message_id, row.reply_signal_message_id]
                .into_iter()
                .flatten()
        })
        .collect();
    ids.extend(anchors);
    let ids = scope
        .visible_ids(db, &ids.into_iter().collect::<Vec<_>>())
        .await
        .c(h!())?;
    let reply_messages = citations(db, &ids, req.screen).await.c(h!())?;
    let replies = rows
        .into_iter()
        .map(|row| MessageReply {
            id: row.id,
            original_signal_message_id: row.original_signal_message_id,
            reply_signal_message_id: row.reply_signal_message_id,
            created_at: row.created_at.and_utc().timestamp_millis(),
            deleted: row.deleted,
        })
        .collect();
    Ok(MessageRepliesRsp {
        replies,
        reply_messages,
    })
}

async fn citations<C: ConnectionTrait>(
    db: &C,
    ids: &[i64],
    screen: MessageReplyScreen,
) -> anyhow::Result<Vec<CitedMessage>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows = CitationRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"select id, timestamp, created_at, id_uuid, message_uid,
            array_to_string((string_to_array(left(replace(coalesce(body, ''), E'\r\n', E'\n'), $2), E'\n'))[1:2], E'\n') as preview
            from signal_message where id = any($1) and not deleted"#,
        vec![ids.to_vec().into(), (MESSAGE_REPLY_PREVIEW_CHARS as i32).into()],
    )).all(db).await.c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let identifier = row
                .id_uuid
                .map(|id| id.to_string())
                .unwrap_or_else(|| match screen {
                    MessageReplyScreen::Analysis => row
                        .message_uid
                        .filter(|uid| !uid.trim().is_empty())
                        .unwrap_or_else(|| row.id.to_string()),
                    MessageReplyScreen::Duty => row.id.to_string(),
                });
            let page = match screen {
                MessageReplyScreen::Duty => "rer-duty-neo",
                MessageReplyScreen::Analysis => "rer-analysis-neo",
            };
            let mut query =
                url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("m", &identifier);
            CitedMessage {
                id: row.id,
                timestamp: row
                    .timestamp
                    .map(|time| time.and_utc().timestamp_millis()),
                created_at: row.created_at.and_utc().timestamp_millis(),
                preview: row.preview,
                href: format!("/{page}?{}", query.finish()),
            }
        })
        .collect())
}
