use crate::config::get_tz;
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
use crate::utils::{dt_from_millis, dt_zoned_from_millis};
use anyhow::Context;
use chrono::NaiveDateTime;
use docx_rs::{
    AlignmentType, Docx, PageMargin, PageOrientationType, Paragraph, Run,
};
use echo_migration::{IntoCondition, JoinType};
use log::info;
use sea_orm::{
    prelude::Expr, ColumnTrait, DatabaseConnection, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
};
use std::path::Path;
use std::time::Instant;

pub async fn report_docx_kind_active_networks(
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_active_networks_report started");

    let read_db = env.dbx.clone();

    let aor_data: Vec<AreaOfResponsibilityNetworkComments> = get_aor_network_comments(&read_db, req).await?;

    let mut docx = get_docx_document(req);


    for aor_network_comments in aor_data {
        let aor: AreaOfResponsibility = aor_network_comments.area_of_responsibility;
        let networks: Vec<NetworkUnitComments> = aor_network_comments.network_unit_comments;

        docx = add_aor_paragraph(docx, aor);

        if networks.is_empty() {
            docx = handle_empty_network_for_docx(docx);
            continue;
        }

        for network_unit_comments in networks {
            docx = handle_comments_with_units_and_network(
                network_unit_comments, docx,
            );
        }
        docx = docx.add_paragraph(Paragraph::new());
    }

    info!("building docx took: {:?}", start_total.elapsed());

    let start = Instant::now();
    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;
    info!("writing docx to file took: {:?}", start.elapsed());

    info!(
        "report_docx_kind_active_networks_report completed in total: {:?}",
        start_total.elapsed()
    );
    Ok(())
}

pub async fn get_aor_network_comments(
    db: &DatabaseConnection,
    req: &ReportPreviewReq,
) -> Result<
    Vec<AreaOfResponsibilityNetworkComments>,
    AppError,
> {
    let aor_ids = get_request_aor_ids(req);

    let mut result: Vec<AreaOfResponsibilityNetworkComments> = Vec::new();

    let since_dt = format_to_native_date(req.req.since_date_inclusive_ms)?;
    let till_dt = format_to_native_date(req.req.till_date_inclusive_ms)?;

    let aors = get_areas_of_responsibility(db, aor_ids).await?;

    for area_of_responsibility in aors {
        let mut network_unit_comments: Vec<NetworkUnitComments> = Vec::new();

        let mut networks = get_aor_networks(db, area_of_responsibility.id).await?;
        networks.sort_by_key(|a| a.active_from);

        for network in networks {
            let units = get_network_units(db, network.id).await?;
            let comments =
                get_signal_message_comments(db, network.id, since_dt, till_dt)
                    .await?;

            network_unit_comments.push(NetworkUnitComments {network, units, comments});
        }
        result.push(AreaOfResponsibilityNetworkComments {
            area_of_responsibility,
            network_unit_comments
        });
    }

    Ok(result)
}

fn get_docx_document(req: &ReportPreviewReq) -> Docx {
    let tz = get_tz();
    let docx = Docx::new()
        .page_orient(PageOrientationType::Landscape)
        .page_size(11906 * 2, 16838)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(300).top(1200))
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new()
                    .bold()
                    .add_text(format!("Підтверджено функціонування радіомереж за період з {} по {}",
                                      format_datetime_ms(req.req.since_date_inclusive_ms, &tz),
                                      format_datetime_ms(req.req.till_date_inclusive_ms, &tz)

                    ))).align(AlignmentType::Center)
        );
    docx
}

fn add_aor_paragraph(mut docx: Docx, aor: AreaOfResponsibility) -> Docx {
    docx = docx.add_paragraph(
        Paragraph::new().add_run(Run::new().bold().add_text(format!(
            "\tВ смузі оборони {}",
            aor.name.to_uppercase()
        ))),
    );
    docx
}

fn handle_empty_network_for_docx(mut docx: Docx) -> Docx {
    docx =
        docx.add_paragraph(Paragraph::new().add_run(
            Run::new().add_text(
                "\tАктивних радіомереж за обраний період не виявлено",
            ),
        ));
    docx
}

fn handle_comments_with_units_and_network(
    network_unit_comments: NetworkUnitComments,
    mut docx: Docx,
) -> Docx {
    let unit_names: Vec<String> = network_unit_comments.units
        .iter()
        .filter(|u| !u.name.is_empty())
        .map(|u| u.name.clone())
        .collect();

    let network_line = if unit_names.is_empty() {
        format!("\tр/м {} невизначеного підрозділу", network_unit_comments.network.name)
    } else {
        format!("\tр/м {} {}", network_unit_comments.network.name, unit_names.join(", "))
    };

    docx = docx.add_paragraph(
        Paragraph::new().add_run(Run::new().add_text(network_line)),
    );
    for comment in &network_unit_comments.comments {
        docx = add_comment_to_docx(comment, docx);
    }
    docx
}

fn get_request_aor_ids(req: &ReportPreviewReq) -> Vec<i64> {
    match req.report_type.clone() {
        Some(ReportType::ActiveNetworks(ActiveNetworksReportSettings {
            aor_ids,
        })) => aor_ids,
        _ => vec![],
    }
}

fn add_comment_to_docx(comment: &SigintComment, mut docx: Docx) -> Docx {
    let comment_lines: Vec<&str> = comment.comment.lines().collect();
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
            docx = docx.add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text(format!("\t\t{}", line))),
            );
        }
    }
    docx
}

async fn get_areas_of_responsibility(
    db: &DatabaseConnection,
    aor_ids: Vec<i64>,
) -> Result<Vec<AreaOfResponsibility>, AppError> {
    let mut aors_select = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true));

    if !aor_ids.is_empty() {
        aors_select = aors_select
            .filter(area_of_responsibility::Column::Id.is_in(aor_ids));
    }

    let aors = aors_select
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .column(area_of_responsibility::Column::Name)
        .into_model::<AreaOfResponsibility>()
        .all(db)
        .await
        .context(h!())?;

    Ok(aors)
}

async fn get_aor_networks(
    db: &DatabaseConnection,
    aor_id: i64,
) -> Result<Vec<SigintNetwork>, AppError> {
    let networks = sigint_network::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network_aor::Relation::SigintNetwork.def().rev(),
        )
        .filter(sigint_network_aor::Column::AorId.eq(aor_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .distinct()
        .select_only()
        .column(sigint_network::Column::Id)
        .column(sigint_network::Column::Name)
        .column(sigint_network::Column::ActiveFrom)
        .into_model::<SigintNetwork>()
        .all(db)
        .await
        .context(h!())?;

    Ok(networks)
}

async fn get_network_units(
    db: &DatabaseConnection,
    network_id: i64,
) -> Result<Vec<NetworkUnit>, AppError> {
    let units = sigint_unit::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def().rev(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit::Column::Name)
        .into_model::<NetworkUnit>()
        .all(db)
        .await
        .context(h!())?;

    Ok(units)
}

async fn get_signal_message_comments(
    db: &DatabaseConnection,
    network_id: i64,
    since_dt: NaiveDateTime,
    till_dt: NaiveDateTime,
) -> Result<Vec<SigintComment>, AppError> {
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
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq
                .def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network_freq::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .filter(
            Expr::col((
                sigint_network_freq::Entity,
                sigint_network_freq::Column::NetworkId,
            ))
            .eq(network_id),
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
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ))
            .gte(since_dt),
        )
        .filter(
            Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ))
            .lte(till_dt),
        )
        .order_by_asc(Expr::col((
            sigint_comment::Entity,
            sigint_comment::Column::CreatedAt,
        )))
        .select_only()
        .column(sigint_comment::Column::Comment)
        .column(sigint_comment::Column::CreatedAt)
        .into_model::<SigintComment>()
        .all(db)
        .await
        .context(h!())?;

    Ok(comments)
}

pub fn format_datetime_ms(
    dt_millis: Option<i64>,
    tz: &chrono_tz::Tz,
) -> String {
    dt_millis
        .and_then(|millis| dt_zoned_from_millis(millis).ok())
        .map(|dt| dt.with_timezone(tz).format("%Y.%m.%d %H:%M").to_string())
        .unwrap_or_default()
}

pub fn format_to_native_date(
    dt: Option<i64>,
) -> Result<NaiveDateTime, AppError> {
    Ok(dt
        .map(dt_from_millis)
        .transpose()
        .context(h!())?
        .unwrap_or_default())
}


pub struct AreaOfResponsibilityNetworkComments {
    pub area_of_responsibility: AreaOfResponsibility,
    pub network_unit_comments: Vec<NetworkUnitComments>,
}

pub struct NetworkUnitComments{
    pub network: SigintNetwork,
    pub units: Vec<NetworkUnit>,
    pub comments: Vec<SigintComment>
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct AreaOfResponsibility {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, FromQueryResult)]
pub struct SigintNetwork {
    pub id: i64,
    pub name: String,
    pub active_from: NaiveDateTime,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct NetworkUnit {
    pub name: String,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct SigintComment {
    pub comment: String,
    pub created_at: NaiveDateTime,
}
