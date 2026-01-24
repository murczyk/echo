use crate::entities::prelude::{SigintNetwork, SigintNetworkFreq};
use crate::entities::sigint_unit::{Entity, Model as SigintUnit, Model};
use crate::entities::{
    area_of_responsibility, datasource, datasource_group, login,
    sigint_comment, sigint_network, sigint_network_freq, sigint_network_unit,
    sigint_unit, signal_message,
};
use crate::error::AppError;
use crate::h;
use crate::rer_importer::reports::types::{ReoReportSettings, ReportType};
use crate::rer_importer::reports::util;
use crate::rer_importer::reports::util::{
    mk_header_cell, mk_merged_text_cell, DocxConfig,
};
use crate::rer_importer::types::InboxMessage;
use crate::sigint::network::types::Network;
use crate::types::{Env, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use actix_identity::Identity;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use clap::builder::Str;
use docx_rs::{
    AlignmentType, BorderType, Docx, PageMargin, PageOrientationType,
    Paragraph, Run, Table, TableBorder, TableBorderPosition, TableRow,
    WidthType,
};
use echo_migration::JoinType;
use log::info;
use sea_orm::JoinType::InnerJoin;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait,
};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::time::Instant;

pub async fn report_docx_kind_rer_report(
    user: Identity,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let start_total = Instant::now();
    info!("report_docx_kind_rer_report started");

    let read_db = env.dbx.clone();

    let mut current_req = req.req.clone();
    current_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    println!("--------------------------");
    println!("starting querying");
    let sigint_data = get_sigint_units_with_networks_and_comments(&read_db)
        .await
        .context(h!())?;
    println!("finish querying");

    let mut docx = Docx::new()
        .page_orient(PageOrientationType::Portrait)
        .default_size(28)
        .page_margin(PageMargin::new().left(600).right(600).top(1000));

    for (aof, messages) in sigint_data {
        if messages.is_empty() {
            continue;
        };
        docx = docx.add_paragraph(Paragraph::new().add_run(
            Run::new().bold().add_tab().add_text(format!(
                "В смузі оборони {}, є такі р/м",
                aof.name
            )),
        ));

        let mut network_comments: HashMap<
            String,
            Vec<(String, Option<chrono::NaiveDateTime>)>,
        > = HashMap::new();
        let mut networks: Vec<String> = Vec::new();
        for message in messages {
            let split = message.body.split("\n").find(|s| {
                s.starts_with("УКХ")
                    || s.contains("р/м")
                    || s.contains("радіомережа")
            });
            if let Some(network) = split {
                if let Some(comments) = network_comments.get_mut(network) {
                    comments.push((message.comment, message.created_at));
                } else {
                    network_comments.insert(network.to_string(), vec![]);
                    networks.push(network.to_owned());
                }
            }
        }

        for network_key in networks {
            let comments = network_comments.get(&network_key);
            if let Some(comments) = comments {
                docx = docx.add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .bold()
                            .add_tab()
                            .add_text(format!("Мережа - {}:", network_key)),
                    ),
                );

                for (comment, created_at) in comments {
                    docx = docx.add_paragraph(Paragraph::new().add_run(
                        Run::new().add_text(format!(
                            "\t- {}, {}",
                            created_at.map_or("".to_string(), |d| {
                                d.format("%Y-%m-%d %H:%M").to_string()
                            }),
                            comment
                        )),
                    ));
                }
            }
        }

        docx = docx.add_paragraph(Paragraph::new())
    }

    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).context(h!())?;

    info!(
        "report_docx_kind_rer_report completed in {:?}",
        start_total.elapsed()
    );

    Ok(())
}

pub struct SigintUnitWithNetworks {
    pub unit: SigintUnit,
    pub networks: Vec<Network>,
}

pub fn generate_sigint_unit_network_report(
    sigint_units: Vec<SigintUnitWithNetworks>,
) -> Result<Vec<u8>, anyhow::Error> {
    let mut docx = Docx::new();

    for unit_with_networks in sigint_units {
        let unit_paragraph =
            Paragraph::new().add_run(Run::new().bold().add_text(format!(
                "Sigint Unit: {}",
                unit_with_networks.unit.name
            )));
        docx = docx.add_paragraph(unit_paragraph);

        for network in unit_with_networks.networks {
            let network_paragraph = Paragraph::new()
                .add_run(Run::new().add_text(format!("- {}", network.name)));
            docx = docx.add_paragraph(network_paragraph);
        }

        docx = docx.add_paragraph(Paragraph::new()); // Add a blank line for spacing
    }

    let mut buf = Cursor::new(Vec::new());
    docx.build().pack(&mut buf)?;
    Ok(buf.into_inner())
}

#[derive(FromQueryResult)]
struct AreaResponsibilityMessage {
    body: String,
    created_at: Option<chrono::NaiveDateTime>,
    comment: String,
}

pub async fn get_sigint_units_with_networks_and_comments(
    read_db: &DatabaseConnection,
) -> Result<
    Vec<(
        area_of_responsibility::Model,
        Vec<AreaResponsibilityMessage>,
    )>,
    AppError,
> {
    let area_of_responsibility = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .all(read_db)
        .await
        .context(h!())?;

    let mut result = Vec::new();
    for x in area_of_responsibility.clone() {
        println!("{}", x.name.clone())
    }
    println!("{}", area_of_responsibility.len());

    for aof in area_of_responsibility {
        dbg!(aof.name.clone());
        println!("---------------------------------------");
        let aof_messages = datasource::Entity::find()
            .join(
                InnerJoin,
                datasource_group::Relation::Datasource.def().rev(),
            )
            .join(
                InnerJoin,
                signal_message::Relation::DatasourceGroup.def().rev(),
            )
            .join(
                InnerJoin,
                sigint_comment::Relation::SignalMessage.def().rev(),
            )
            .filter(datasource::Column::DefaultAorId.eq(aof.id))
            .filter(datasource::Column::Deleted.eq(false))
            .filter(datasource_group::Column::Deleted.eq(false))
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(sigint_comment::Column::Comment.is_not_null())
            .order_by_asc(sigint_comment::Column::CreatedAt)
            .select_only()
            .column(signal_message::Column::Body)
            .column(signal_message::Column::CreatedAt)
            .column(sigint_comment::Column::Comment)
            .into_model::<AreaResponsibilityMessage>()
            .all(read_db)
            .await
            .context(h!())?;

        result.push((aof, aof_messages))
    }

    Ok(result)
}
