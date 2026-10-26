use super::{store::rows, types::*};
use crate::{
    config::AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE, h, types::ShortContext,
};
use sea_orm::{ConnectionTrait, FromQueryResult};
use std::collections::HashMap;

#[derive(FromQueryResult)]
struct QueueItem {
    message_id: i64,
    message_uuid: Option<String>,
    message_uid: Option<String>,
    created_at: i64,
    state: String,
    attempts: i32,
    next_attempt_at: i64,
    completed_at: Option<i64>,
    important: Option<bool>,
    manual_suppressed: bool,
    last_error: Option<String>,
}

#[derive(FromQueryResult)]
struct Group {
    message_id: i64,
    name: String,
}

pub(crate) async fn list<C: ConnectionTrait>(
    db: &C,
    req: AiTranscriptQueueReq,
) -> anyhow::Result<AiTranscriptQueueRsp> {
    let mut items = rows::<QueueItem, _>(
        db,
        r#"
with page as materialized (
    select message_id, state, attempts, next_attempt_at, completed_at,
           important, manual_suppressed, last_error
    from ai_transcript_analysis_job
    where message_id < $1
    order by message_id desc
    limit $2
)
select page.message_id, message.id_uuid::text as message_uuid, message.message_uid,
       (extract(epoch from message.created_at) * 1000)::bigint as created_at,
       page.state, page.attempts,
       (extract(epoch from page.next_attempt_at) * 1000)::bigint as next_attempt_at,
       (extract(epoch from page.completed_at) * 1000)::bigint as completed_at,
       page.important, page.manual_suppressed, page.last_error
from page join signal_message message on message.id = page.message_id
order by page.message_id desc
"#,
        vec![
            req.before_message_id.unwrap_or(i64::MAX).into(),
            ((AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE + 1) as i64).into(),
        ],
    )
    .await
    .c(h!())?;
    let has_more = items.len() > AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE;
    items.truncate(AI_TRANSCRIPT_ANALYSIS_QUEUE_PAGE_SIZE);
    let next_before_message_id = has_more
        .then(|| items.last().map(|item| item.message_id))
        .flatten();
    let mut groups: HashMap<i64, Vec<String>> = HashMap::new();
    if !items.is_empty() {
        for group in rows::<Group, _>(
            db,
            r#"
select membership.signal_message_id as message_id, coalesce(g.name, g.master_key) as name
from signal_message_group membership
join signal_group g on g.master_key = membership.group_master_key
where membership.signal_message_id = any($1)
order by membership.signal_message_id, g.name, g.master_key
"#,
            vec![items.iter().map(|item| item.message_id).collect::<Vec<_>>().into()],
        )
        .await
        .c(h!())?
        {
            groups.entry(group.message_id).or_default().push(group.name);
        }
    }
    Ok(AiTranscriptQueueRsp {
        next_before_message_id,
        items: items
            .into_iter()
            .map(|item| AiTranscriptQueueItem {
                message_id: item.message_id,
                message_uuid: item.message_uuid,
                message_uid: item.message_uid,
                groups: groups.remove(&item.message_id).unwrap_or_default(),
                created_at: item.created_at,
                state: item.state,
                attempts: item.attempts,
                next_attempt_at: item.next_attempt_at,
                completed_at: item.completed_at,
                important: item.important,
                manual_suppressed: item.manual_suppressed,
                last_error: item.last_error,
            })
            .collect(),
    })
}
