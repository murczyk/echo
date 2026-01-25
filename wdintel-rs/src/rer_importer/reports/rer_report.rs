use crate::entities::{area_of_responsibility, sigint_comment, sigint_inbox_item, sigint_network, sigint_network_aor, sigint_network_freq, sigint_network_unit, sigint_unit, signal_message};
use crate::error::AppError;
use crate::h;
use crate::types::Env;
use anyhow::Context;
use docx_rs::{Docx, PageMargin, PageOrientationType, Paragraph, Run};
use log::info;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect, RelationTrait};
use std::path::Path;
use std::collections::HashSet;
use std::time::Instant;

pub async fn report_docx_kind_rer_report(
    env: &Env,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_rer_report started");

    let read_db = env.dbx.clone();

    let aor_data = get_aor_network_comments(&read_db).await?;

    let mut processed_networks = HashSet::new();
    let mut docx = Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(300).top(1200));

    for (aor, networks) in aor_data {
        if networks.is_empty() {
            continue
        }

        docx = docx.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().bold().add_text(format!("\tВ смузі оборони {}", aor.name.to_uppercase())))
        );

        let mut network_set = HashSet::new();
        for (network, units, comments) in networks {
            if processed_networks.contains(&network.id) {
                continue;
            }
            processed_networks.insert(network.id);
            if comments.is_empty() {
                continue;
            }

            for unit in units {

                let network_line = if unit.name.is_empty() {
                    format!("\tр/м {} невизначеного підрозділу ", network.name)
                } else {
                    format!("\tр/м {} {}", network.name, unit.name)
                };

                if network_set.contains(&network_line) {
                    continue
                } else {
                    network_set.insert(network_line.clone());
                }

                docx = docx.add_paragraph(Paragraph::new().add_run(Run::new().add_text(network_line)));
                for comment in comments.clone() {
                    docx = docx.add_paragraph(
                        Paragraph::new()
                            .add_run(Run::new().add_text(format!("\t- {} - {}", comment.created_at.format("%Y-%m-%d %H:%M"), comment.comment)))
                    );
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
    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .all(db)
        .await
        .context(h!())?;

    let mut result = Vec::new();

    for aor in aors {
        let networks = sigint_network::Entity::find()
            .join(
                sea_orm::JoinType::InnerJoin,
                sigint_network_aor::Relation::SigintNetwork.def().rev(),
            )
            .filter(sigint_network_aor::Column::AorId.eq(aor.id))
            .filter(sigint_network::Column::Deleted.eq(false))
            .order_by_asc(sigint_network::Column::CreatedAt)
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
                .filter(sigint_network_freq::Column::NetworkId.eq(network.id))
                .filter(signal_message::Column::Deleted.eq(false))
                .order_by_asc(sigint_comment::Column::CreatedAt)
                .all(db)
                .await
                .context(h!())?;

            if !comments.is_empty() {
                network_with_comments.push((network, units, comments));
            }
        }
        result.push((aor, network_with_comments));
    }

    Ok(result)
}

