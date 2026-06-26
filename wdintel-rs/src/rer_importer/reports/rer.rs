use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::inbox::query::build_filtered_inbox_query;
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::types::{Env, ShortContext};
use chrono::NaiveDateTime;
use docx_rs::{AlignmentType, Docx, Paragraph, Run};
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

struct RerReportMessage {
    timestamp: NaiveDateTime,
    comment: String,
    body: String,
    points: Vec<String>,
}

#[derive(Default)]
struct RerReportSection {
    locations: BTreeSet<String>,
    callsigns: BTreeSet<String>,
    messages: Vec<RerReportMessage>,
}

pub async fn report_docx_kind_rer(
    user_login: &str,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let sections = load_sections(user_login, env, req).await.c(h!())?;
    let mut docx = Docx::new();
    for (unit_name, mut section) in sections {
        section.messages.sort_by_key(|message| message.timestamp);
        docx = docx
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().bold().add_text(unit_name))
                    .align(AlignmentType::Center),
            )
            .add_paragraph(Paragraph::new().add_run(
                Run::new().add_text(format!(
                    "Район: {}",
                    join_set(&section.locations)
                )),
            ))
            .add_paragraph(Paragraph::new().add_run(Run::new().add_text(
                format!("Позивні: {}", join_set(&section.callsigns)),
            )));
        let points = section
            .messages
            .iter()
            .flat_map(|message| message.points.clone())
            .collect::<BTreeSet<_>>();
        docx = docx.add_paragraph(Paragraph::new().add_run(
            Run::new().add_text(format!("Точки: {}", join_set(&points))),
        ));
        for message in section.messages {
            docx = docx.add_paragraph(Paragraph::new().add_run(
                Run::new().add_text(format!(
                    "{} {}\n{}",
                    message.timestamp.format("%H:%M"),
                    message.comment,
                    message.body
                )),
            ));
        }
        docx = docx.add_paragraph(Paragraph::new());
    }
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).c(h!())?;
    Ok(())
}

async fn load_sections(
    user_login: &str,
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<BTreeMap<String, RerReportSection>, AppError> {
    let dbx = &env.dbx;
    let item_ids = load_candidate_item_ids(dbx, user_login, env, req)
        .await
        .c(h!())?;
    let mut sections = BTreeMap::<String, RerReportSection>::new();
    for item_id in item_ids {
        if item_has_ai_other_tag(dbx, item_id).await.c(h!())? {
            continue;
        }
        let Some(item) = sigint_inbox_item::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(timestamp) = item.datetime else {
            continue;
        };
        let Some(message) = signal_message::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let comments = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(item_id))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|comment| comment.comment.trim().to_string())
            .filter(|comment| !comment.is_empty())
            .collect::<Vec<_>>();
        if comments.is_empty() {
            continue;
        }
        let networks = load_item_networks(dbx, item_id, req).await.c(h!())?;
        if networks.is_empty() {
            continue;
        }
        let callsigns = parse_callsigns(&item);
        let points = parse_points(&item);
        for sigint_network in networks {
            let unit_names = load_network_unit_names(dbx, sigint_network.id)
                .await
                .c(h!())?;
            for unit_name in unit_names {
                if unit_name.trim().is_empty() {
                    continue;
                }
                let section = sections.entry(unit_name).or_default();
                insert_non_empty(
                    &mut section.locations,
                    &sigint_network.location,
                );
                for callsign in &callsigns {
                    insert_non_empty(
                        &mut section.callsigns,
                        &callsign.to_uppercase(),
                    );
                }
                section.messages.push(RerReportMessage {
                    timestamp,
                    comment: comments.join("; "),
                    body: message_body_without_headers(&message).c(h!())?,
                    points: points.clone(),
                });
            }
        }
    }
    Ok(sections)
}

async fn load_candidate_item_ids(
    dbx: &DatabaseConnection,
    user_login: &str,
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<Vec<i64>, AppError> {
    Ok(build_filtered_inbox_query(dbx, user_login, env, &req.req)
        .await
        .c(h!())?
        .filter(unit_machine_link_exists())
        .filter(item_network_link_exists())
        .filter(non_empty_comment_exists())
        .select_only()
        .distinct()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

fn unit_machine_link_exists() -> SimpleExpr {
    let subquery = sigint_inbox_item_unit_machine::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                sigint_inbox_item_unit_machine::Entity,
                sigint_inbox_item_unit_machine::Column::SigintInboxItemId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .into_query();

    Expr::exists(subquery)
}

fn item_network_link_exists() -> SimpleExpr {
    let subquery = sigint_inbox_item_network::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                sigint_inbox_item_network::Entity,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .into_query();

    Expr::exists(subquery)
}

fn non_empty_comment_exists() -> SimpleExpr {
    let subquery = sigint_comment::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            Expr::col((
                sigint_comment::Entity,
                sigint_comment::Column::SignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(sigint_comment::Column::Comment.ne(""))
        .into_query();

    Expr::exists(subquery)
}

fn message_body_without_headers(
    message: &signal_message::Model,
) -> Result<String, AppError> {
    let body = message.body.clone().unwrap_or_default();
    Ok(crate::rer_importer::body_noheader::extract_text(&body)
        .c(h!())?
        .body)
}

async fn load_item_networks(
    dbx: &DatabaseConnection,
    item_id: i64,
    req: &ReportPreviewReq,
) -> Result<Vec<sigint_network::Model>, AppError> {
    let mut query = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintInboxItemNetwork.def(),
        )
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId.eq(item_id),
        )
        .filter(sigint_network::Column::Deleted.eq(false));
    if let Some(network_ids) = req
        .req
        .selected_networks
        .as_ref()
        .filter(|network_ids| !network_ids.is_empty())
    {
        query =
            query.filter(sigint_network::Column::Id.is_in(network_ids.clone()));
    }
    let mut networks = query.all(dbx).await.c(h!())?;
    if let Some(aor_ids) = req
        .req
        .selected_aors
        .as_ref()
        .filter(|aor_ids| !aor_ids.is_empty())
    {
        let network_ids = networks
            .iter()
            .map(|network| network.id)
            .collect::<Vec<_>>();
        let allowed = sigint_network_aor::Entity::find()
            .filter(sigint_network_aor::Column::NetworkId.is_in(network_ids))
            .filter(sigint_network_aor::Column::AorId.is_in(aor_ids.clone()))
            .select_only()
            .column(sigint_network_aor::Column::NetworkId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .collect::<HashSet<_>>();
        networks.retain(|network| allowed.contains(&network.id));
    }
    Ok(networks)
}

async fn load_network_unit_names(
    dbx: &DatabaseConnection,
    network_id: i64,
) -> Result<Vec<String>, AppError> {
    Ok(sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit::Column::Name)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?)
}

async fn item_has_ai_other_tag(
    dbx: &DatabaseConnection,
    item_id: i64,
) -> Result<bool, AppError> {
    let count = sigint_inbox_item_tag::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::Tag.def(),
        )
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(item_id))
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .filter(tag::Column::Label.eq("Інше"))
        .count(dbx)
        .await
        .c(h!())?;
    Ok(count > 0)
}

fn parse_callsigns(item: &sigint_inbox_item::Model) -> Vec<String> {
    item.callsigns
        .clone()
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|callsign| callsign.trim().to_string())
        .filter(|callsign| !callsign.is_empty())
        .collect()
}

fn parse_points(item: &sigint_inbox_item::Model) -> Vec<String> {
    let mut points = BTreeSet::new();
    if let Some(coords) = &item.coords {
        insert_non_empty(&mut points, coords);
    }
    if let Some(location_v2) = &item.location_v2 {
        insert_non_empty(&mut points, location_v2);
    }
    points.into_iter().collect()
}

fn insert_non_empty(values: &mut BTreeSet<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        values.insert(value.to_string());
    }
}

fn join_set(values: &BTreeSet<String>) -> String {
    values.iter().cloned().collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_body_without_headers_strips_non_rer_header() {
        let message = signal_message::Model {
            id: 1,
            body: Some(
                "50 обрБпС [33hhfg50d] | 2026-06-26_08-13-12\nПерехоплення"
                    .to_string(),
            ),
            created_at: chrono::Utc::now().naive_utc(),
            timestamp: None,
            sender: None,
            format: None,
            deleted: false,
            external_id: None,
            message_uid: None,
            datasource_group_id: None,
        };

        assert_eq!(
            message_body_without_headers(&message).unwrap(),
            "Перехоплення"
        );
    }
}
