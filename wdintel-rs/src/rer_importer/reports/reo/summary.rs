use super::*;
use crate::rer_importer::report_chunking::exclude_inbox_report_linked_intel_products;
use sea_orm::sea_query::{Expr, SimpleExpr};

#[cfg(test)]
mod tests;

#[derive(Debug, FromQueryResult)]
struct ActivityRow {
    network_id: Option<i64>,
    freq: String,
    summary_group_master_key: Option<String>,
    since: Option<NaiveDateTime>,
    till: Option<NaiveDateTime>,
    seances_qty: i64,
}

pub(super) async fn load_summary_messages(
    db: &DatabaseConnection,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    chunks: &[ReportPeriodChunk],
    no_comments: bool,
    only_comments_from_current_organism: bool,
) -> anyhow::Result<Vec<(i64, ReoInboxMessage)>> {
    let groups = crate::messenger::group::get_identity_sigint_groups(db, login)
        .await
        .c(h!())?;
    let logins = if only_comments_from_current_organism && !no_comments {
        Some(
            crate::users::get_organism_login_ids_by_id(db, login)
                .await
                .c(h!())?,
        )
    } else {
        None
    };
    let eligible = activity_eligible(no_comments, logins.as_deref());
    let group = first_group(req, groups);
    let mut activities =
        HashMap::<NetworkSummaryKey, Option<NetworkActivity>>::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "REO summary chunk {}/{}: {}..{}",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms
        );
        let chunk_req = inbox_report_chunk_req(req, chunk);
        let query = build_filtered_inbox_report_chunk_query(
            db, login, env, &chunk_req, chunk.end,
        )
        .await
        .c(h!())?;
        let rows = activity_query(query, group.clone(), eligible.clone())
            .into_model::<ActivityRow>()
            .all(db)
            .await
            .c(h!())?;
        for row in rows {
            let activity = if row.seances_qty > 0 {
                Some(NetworkActivity {
                    since: row.since.c(h!())?,
                    till: row.till.c(h!())?,
                    seances_qty: row.seances_qty as u64,
                })
            } else {
                None
            };
            let key = NetworkSummaryKey {
                network_id: row.network_id,
                freq: row.freq,
                master_key: row.summary_group_master_key,
            };
            let total = activities.entry(key).or_default();
            if let Some(activity) = activity {
                match total {
                    Some(total) => total.merge(&activity),
                    None => *total = Some(activity),
                }
            }
        }
    }
    Ok(activities
        .into_iter()
        .enumerate()
        .map(|(id, (key, activity))| {
            (
                id as i64,
                ReoInboxMessage {
                    activity,
                    timestamp: None,
                    freq: Some(key.freq),
                    coords: None,
                    callsigns: Vec::new(),
                    callsigns_alg2: Vec::new(),
                    callsign_tokens: Vec::new(),
                    network_ids: key.network_id.map(|id| vec![id]),
                    group_master_key: key.master_key,
                },
            )
        })
        .collect())
}

fn activity_query(
    query: Select<signal_message::Entity>,
    group: SimpleExpr,
    eligible: SimpleExpr,
) -> Select<signal_message::Entity> {
    let timestamp = Expr::cust_with_values(
        "date_trunc('milliseconds', signal_message.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $1)",
        [crate::config::get_tz().name()],
    );
    exclude_inbox_report_linked_intel_products(query)
        .join(JoinType::LeftJoin, sigint_inbox_item::Relation::SigintInboxItemNetwork.def())
        .filter(sigint_inbox_item::Column::Freq.is_not_null())
        .select_only()
        .column_as(sigint_inbox_item_network::Column::SigintNetworkId, "network_id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(group, "summary_group_master_key")
        .column_as(Expr::cust_with_exprs("MIN($1) FILTER (WHERE $2)", [timestamp.clone(), eligible.clone()]), "since")
        .column_as(Expr::cust_with_exprs("MAX($1) FILTER (WHERE $2)", [timestamp, eligible.clone()]), "till")
        .column_as(Expr::cust_with_exprs("COUNT(DISTINCT $1) FILTER (WHERE $2 AND signal_message.timestamp IS NOT NULL)", [Expr::col((signal_message::Entity, signal_message::Column::Id)), eligible]), "seances_qty")
        .group_by(sigint_inbox_item_network::Column::SigintNetworkId)
        .group_by(sigint_inbox_item::Column::Freq)
        .group_by(Expr::col(Alias::new("summary_group_master_key")))
}

fn first_group(req: &InboxMessagesReq, groups: Vec<String>) -> SimpleExpr {
    let mut query = signal_message_group::Entity::find()
        .select_only()
        .column(signal_message_group::Column::GroupMasterKey)
        .filter(
            Expr::col((
                signal_message_group::Entity,
                signal_message_group::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(signal_message_group::Column::GroupMasterKey.is_in(groups));
    if let Some(groups) = req
        .selected_groups
        .as_ref()
        .filter(|groups| !groups.is_empty())
    {
        query = query.filter(
            signal_message_group::Column::GroupMasterKey.is_in(groups.clone()),
        );
    }
    if let Some(senders) = req
        .selected_senders
        .as_ref()
        .filter(|senders| !senders.is_empty())
    {
        query = query
            .filter(preferred_group_sender_expr(None).is_in(senders.clone()));
    }
    Expr::case(
        sigint_inbox_item_network::Column::SigintNetworkId.is_null(),
        Expr::from(
            query
                .order_by_asc(signal_message_group::Column::Id)
                .limit(1)
                .into_query(),
        ),
    )
    .finally(Expr::value(None::<String>))
    .into()
}

fn activity_eligible(
    no_comments: bool,
    logins: Option<&[uuid::Uuid]>,
) -> SimpleExpr {
    let has_callsigns = Expr::cust("coalesce(jsonb_array_length(sigint_inbox_item.callsign_tokens), 0) > 0");
    let eligible = sigint_inbox_item::Column::Coords
        .is_null()
        .or(has_callsigns);
    if no_comments {
        return eligible;
    }
    eligible.or(report_comment_exists(logins))
}

fn report_comment_exists(logins: Option<&[uuid::Uuid]>) -> SimpleExpr {
    let mut legacy = sigint_comment::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                sigint_comment::Entity,
                sigint_comment::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(sigint_comment::Column::MigratedSignalMessageId.is_null())
        .filter(Expr::cust("sigint_comment.comment ~ '[^[:space:]]'"));
    let author = Alias::new("reo_comment");
    let mut linked = intel_product::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .join_as(JoinType::InnerJoin, intel_product::Relation::SignalMessage2.def(), author.clone())
        .filter(Expr::col((intel_product::Entity, intel_product::Column::SourceMessageId))
            .equals((signal_message::Entity, signal_message::Column::Id)))
        .filter(crate::rer_importer::intel_product_filter::relation_kind_is_in([
            crate::rer_importer::intel_product_filter::RELATION_KIND_COMMENT,
            crate::rer_importer::intel_product_filter::RELATION_KIND_REPORT,
        ]))
        .filter(Expr::col((author.clone(), signal_message::Column::Deleted)).eq(false))
        .filter(Expr::cust("reo_comment.body ~ '[^[:space:]]'"));
    if let Some(logins) = logins {
        legacy = legacy
            .filter(sigint_comment::Column::LoginId.is_in(logins.to_vec()));
        linked = linked.filter(Expr::cust("coalesce(reo_comment.login_id::text, lower(reo_comment.sender))")
            .is_in(logins.iter().map(ToString::to_string).collect::<Vec<_>>()));
    }
    Expr::exists(legacy.into_query()).or(Expr::exists(linked.into_query()))
}
