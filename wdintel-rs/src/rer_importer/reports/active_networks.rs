use crate::entities::{
    area_of_responsibility, sigint_comment, sigint_inbox_item, sigint_network,
    sigint_network_aor, sigint_network_freq, sigint_network_unit, sigint_unit,
    signal_message,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::{
    ActiveNetworksReportSettings, ReportPreviewReq, ReportType,
};
use crate::types::Env;
use crate::utils::dt_from_millis;
use anyhow::Context;
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
};
use log::info;
use sea_orm::{
    prelude::Expr, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait,
};
use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

pub async fn report_docx_kind_active_networks(
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_rer_report started");

    let read_db = env.dbx.clone();

    let aor_ids = match req.report_type.clone() {
        Some(ReportType::ActiveNetworks(ActiveNetworksReportSettings {
            aor_ids,
        })) => aor_ids,
        _ => vec![],
    };

    let aor_data = get_aor_network_comments(&read_db, aor_ids, req).await?;

    let mut docx = Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new()
                    .bold()
                    .add_text(format!("Підтверджено функціонування радіомереж за період з {:?} по {:?}",
                                      format_datetime_ms(req.req.since_date_inclusive_ms),
                                      format_datetime_ms(req.req.till_date_inclusive_ms)

                    ))).align(AlignmentType::Center)
        );

    for (aor, networks) in aor_data {
        docx = docx.add_paragraph(Paragraph::new().add_run(
            Run::new().bold().add_text(format!(
                "\tВ смузі оборони {}",
                aor.name.to_uppercase()
            )),
        ));

        if networks.is_empty() {
            docx = docx.add_paragraph(Paragraph::new().add_run(
                Run::new().add_text(
                    "\tАктивних радіомереж за обраний період не виявлено",
                ),
            ));
            continue;
        }

        let mut network_set = HashSet::new();
        for (network, units, comments) in networks {
            let unit_names: Vec<String> = units
                .iter()
                .filter(|u| !u.name.is_empty())
                .map(|u| u.name.clone())
                .collect();

            let network_line = if unit_names.is_empty() {
                format!("\tр/м {} невизначеного підрозділу", network.name)
            } else {
                format!("\tр/м {} {}", network.name, unit_names.join(", "))
            };

            if network_set.contains(&network_line) {
                continue;
            } else {
                network_set.insert(network_line.clone());
            }

            docx = docx.add_paragraph(
                Paragraph::new().add_run(Run::new().add_text(network_line)),
            );
            for comment in &comments {
                let comment_lines: Vec<&str> =
                    comment.comment.lines().collect();
                if comment_lines.len() <= 1 {
                    docx = docx.add_paragraph(Paragraph::new().add_run(
                        Run::new().add_text(format!(
                            "\t- {} - {}",
                            comment.created_at.format("%Y-%m-%d %H:%M"),
                            comment.comment
                        )),
                    ));
                } else {
                    docx = docx.add_paragraph(Paragraph::new().add_run(
                        Run::new().add_text(format!(
                            "\t- {} - {}",
                            comment.created_at.format("%Y-%m-%d %H:%M"),
                            comment_lines[0]
                        )),
                    ));
                    for line in &comment_lines[1..] {
                        docx = docx.add_paragraph(Paragraph::new().add_run(
                            Run::new().add_text(format!("\t\t{}", line)),
                        ));
                    }
                }
            }
        }
        docx = docx.add_paragraph(Paragraph::new());
    }

    info!("building docx took: {:?}", start_total.elapsed());

    let start = Instant::now();
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;
    info!("writing docx to file took: {:?}", start.elapsed());

    info!(
        "report_docx_kind_rer_report completed in total: {:?}",
        start_total.elapsed()
    );
    Ok(())
}

pub async fn get_aor_network_comments(
    db: &DatabaseConnection,
    aor_ids: Vec<i64>,
    req: &ReportPreviewReq,
) -> Result<
    Vec<(
        area_of_responsibility::Model,
        Vec<(
            sigint_network::Model,
            Vec<sigint_unit::Model>,
            Vec<sigint_comment::Model>,
        )>,
    )>,
    AppError,
> {
    let since_dt = req
        .req
        .since_date_inclusive_ms
        .map(dt_from_millis)
        .transpose()
        .context(h!())?
        .unwrap_or_default();
    let till_dt = req
        .req
        .till_date_inclusive_ms
        .map(dt_from_millis)
        .transpose()
        .context(h!())?
        .unwrap_or_default();

    let mut aors_select = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true));

    if !aor_ids.is_empty() {
        aors_select = aors_select
            .filter(area_of_responsibility::Column::Id.is_in(aor_ids));
    }

    let aors = aors_select.all(db).await.context(h!())?;

    let mut result = Vec::new();

    for aor in aors {
        let networks = sigint_network::Entity::find()
            .join(
                sea_orm::JoinType::InnerJoin,
                sigint_network_aor::Relation::SigintNetwork.def().rev(),
            )
            .filter(sigint_network_aor::Column::AorId.eq(aor.id))
            .filter(sigint_network::Column::Deleted.eq(false))
            .order_by_asc(sigint_network::Column::ActiveFrom)
            .distinct()
            .all(db)
            .await
            .context(h!())?;

        let mut network_with_comments = Vec::new();
        for network in networks {
            let units = sigint_unit::Entity::find()
                .join(
                    sea_orm::JoinType::InnerJoin,
                    sigint_network_unit::Relation::SigintUnit.def().rev(),
                )
                .filter(sigint_network_unit::Column::NetworkId.eq(network.id))
                .filter(sigint_unit::Column::Deleted.eq(false))
                .all(db)
                .await
                .context(h!())?;

            let comments = sigint_comment::Entity::find()
                .join(
                    sea_orm::JoinType::InnerJoin,
                    signal_message::Relation::SigintComment.def().rev(),
                )
                .join(
                    sea_orm::JoinType::InnerJoin,
                    sigint_inbox_item::Relation::SignalMessage.def().rev(),
                )
                .join(
                    sea_orm::JoinType::InnerJoin,
                    sigint_inbox_item::Relation::SigintNetworkFreq.def(),
                )
                .filter(
                    Expr::col((
                        sigint_network_freq::Entity,
                        sigint_network_freq::Column::NetworkId,
                    ))
                    .eq(network.id),
                )
                .filter(
                    Expr::col((
                        signal_message::Entity,
                        signal_message::Column::Deleted,
                    ))
                    .eq(false),
                )
                .filter(
                    Expr::col((
                        signal_message::Entity,
                        signal_message::Column::CreatedAt,
                    ))
                    .gte(since_dt),
                )
                .filter(
                    Expr::col((
                        signal_message::Entity,
                        signal_message::Column::CreatedAt,
                    ))
                    .lte(till_dt),
                )
                .order_by_asc(Expr::col((
                    sigint_comment::Entity,
                    sigint_comment::Column::CreatedAt,
                )))
                .all(db)
                .await
                .context(h!())?;

            network_with_comments.push((network, units, comments));
        }
        result.push((aor, network_with_comments));
    }

    Ok(result)
}

pub fn format_datetime_ms(dt_millis: Option<i64>) -> String {
    dt_millis
        .and_then(|millis| dt_from_millis(millis).ok())
        .map(|dt| dt.format("%Y.%m.%d %H:%M").to_string())
        .unwrap_or_default()
}
