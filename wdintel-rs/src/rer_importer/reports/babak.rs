use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::types::{
    AnalysisStatsReq, InboxMessagesReq, NewCallsignsRes,
};
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use chrono::prelude::*;
use docx_rs::*;
use echo_migration::IntoCondition;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::{Alias, CommonTableExpression, Expr, Func, Query, SimpleExpr};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fmt::Debug;
use std::path::Path;

pub struct BabakReportData {
    pub units: Vec<StatsPerUnitReport>,
    pub new_callsigns: NewCallsignsRes,
    pub date_from: NaiveDateTime,
    pub date_to: NaiveDateTime,
}

pub async fn bl_babak_report(
    user_login: &str,
    env: &Env,
    req: &super::types::ReportPreviewReq,
) -> Result<BabakReportData, AppError> {
    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt = dt_from_millis(since_date_inclusive_ms)?;
    let date_to_dt = dt_from_millis(till_date_inclusive_ms)?;
    let without_comments = req.without_comments.unwrap_or(false);

    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = if without_comments {
        Some(false)
    } else {
        req.report_tags_only_this_unit
    };

    let units = get_inbox_messages_report_unit(user_login, env, &inbox_req)
        .await
        .c(h!())?;

    let new_callsing_req = AnalysisStatsReq {
        since_date_inclusive_ms: inbox_req.since_date_inclusive_ms.unwrap_or(0),
        till_date_noninclusive_ms: inbox_req
            .till_date_inclusive_ms
            .unwrap_or(0),
        selected_groups: inbox_req.selected_groups,
        selected_senders: inbox_req.selected_senders,
        selected_freqs: inbox_req.selected_freqs,
        selected_posts: inbox_req.selected_posts,
        selected_callsigns: inbox_req.selected_callsigns,
        selected_units: inbox_req.selected_units,
        selected_locations: inbox_req.selected_locations,
        or_with_extended_form: inbox_req.or_with_extended_form,
        or_bookmarked: inbox_req.or_bookmarked,
        or_important: inbox_req.or_important,
        or_with_coords: inbox_req.or_with_coords,
        or_without_coords: inbox_req.or_without_coords,
        search: inbox_req.search,
        selected_tags: inbox_req.selected_tags,
        selected_networks: inbox_req.selected_networks,
        without_network: inbox_req.without_network,
        metadata_cc: inbox_req.metadata_cc,
        metadata_sender: inbox_req.metadata_sender,
        metadata_receiver: inbox_req.metadata_receiver,
        metadata_hash: inbox_req.metadata_hash,
        only_with_metadata: inbox_req.only_with_metadata,
        without_metadata: inbox_req.without_metadata,
        include_peleng_locations: inbox_req.include_peleng_locations,
        units_exact_match_only: inbox_req.units_exact_match_only,
        filter_tags_option: inbox_req.filter_tags_option,
        selected_aors: inbox_req.selected_aors,
        without_model_tags: inbox_req.without_model_tags,
        report_tags_only_this_unit: inbox_req.report_tags_only_this_unit,
    };
    let new_callsigns_res =
        bi_new_callsigns(user_login, env, &new_callsing_req)
            .await
            .context(h!())?;

    Ok(BabakReportData {
        units,
        new_callsigns: new_callsigns_res,
        date_from: date_from_dt,
        date_to: date_to_dt,
    })
}

pub async fn report_docx_kind_babak(
    user_login: &str,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &Path,
) -> Result<(), AppError> {
    let BabakReportData {
        units,
        new_callsigns: new_callsigns_res,
        date_from,
        date_to,
    } = bl_babak_report(user_login, env, req).await?;
    let tz = crate::config::get_tz();
    let without_comments = req.without_comments.unwrap_or(false);
    let date_from_dt_tz = Utc.from_utc_datetime(&date_from).with_timezone(&tz);
    let date_to_dt_tz = Utc.from_utc_datetime(&date_to).with_timezone(&tz);

    let file = std::fs::File::create(outpath)?;

    let units_list = units
        .iter()
        .filter_map(|unit| unit.unit.clone())
        .filter(|r| r != "НВ")
        .collect::<Vec<String>>()
        .join(", ");

    let style_invisible = Style::new("Invisible", StyleType::Paragraph)
        .name("Invisible")
        .align(AlignmentType::Center)
        .size(0);

    let bullet_numbering = Numbering::new(0, 1);

    let abs_numbering =
        AbstractNumbering::new(1).add_level(docx_rs::Level::new(
            0,
            Start::new(1),
            NumberFormat::new("bullet"),
            LevelText::new("-"),
            LevelJc::new("left"),
        ));

    let mut trs = vec![TableRow::new(vec![
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("Полк/бригада")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("к-сть перехоплень")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("відмічено БПЛА")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("відмічено РЕБ")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("відмічено артилерія")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new()
                    .add_run(Run::new().add_text("відмічено забезпечення")),
            )
            .set_borders(TableCellBorders::new()),
        TableCell::new()
            .add_paragraph(
                Paragraph::new().add_run(Run::new().add_text("втрати")),
            )
            .set_borders(TableCellBorders::new()),
    ])];
    for stat in units.iter() {
        // dbg!(stat.clone());

        trs.push(TableRow::new(vec![
            TableCell::new()
                .add_paragraph(Paragraph::new().add_run(
                    Run::new().add_text(
                        stat.unit.clone().unwrap_or("НВ".to_string()),
                    ),
                ))
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.count)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.bpla))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.reb))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(format!("{}", stat.arta))),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.software)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
            TableCell::new()
                .add_paragraph(
                    Paragraph::new().add_run(
                        Run::new().add_text(format!("{}", stat.losses)),
                    ),
                )
                .set_borders(TableCellBorders::new()),
        ]));
    }
    let stats_table = Table::new(trs);

    let head = "Heading";
    let style_heading = Style::new(head, StyleType::Paragraph)
        .name("Heading 1")
        .align(AlignmentType::Left)
        .size(28)
        .bold();
    let mut doc = docx_rs::Docx::new()
        .default_size(24)
        .add_style(style_invisible)
        .add_style(style_heading)
        .add_numbering(bullet_numbering)
        .add_abstract_numbering(abs_numbering)
        .add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .size(42)
                        .add_text(format!(
                            "Розвідувальне донесення з РЕР за {}-{} {} - {}",
                            date_from_dt_tz.format("%d.%m"),
                            date_to_dt_tz.format("%d.%m.%Y"),
                            date_from_dt_tz.format("%H:%M"),
                            date_to_dt_tz.format("%H:%M")
                        ))
                        .bold(),
                )
                .align(docx_rs::alignment_type::AlignmentType::Center),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Мапа ймовірних смуг відповідальності підрозділів:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Підрозділи що відмічені в р/о за звітний період:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(units_list))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text("Статистика за звітний період"))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_table(stats_table)
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(format!(
                    "Кількість нових частот виявлених в смузі: {}",
                    0
                )))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(
                    Run::new()
                        .add_text("Позивні, присутні в обраний період, але яких не було 7 днів до цього:"),
                )
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(
                    new_callsigns_res.not_seen_7days.join(", ")
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    if !without_comments {
        doc = doc
            .add_paragraph(
                Paragraph::new()
                    .style(head)
                    .add_run(
                        Run::new().add_text(
                            "Характер дій противника за звітний період",
                        ),
                    )
                    .align(docx_rs::alignment_type::AlignmentType::Left),
            )
            .add_paragraph(Paragraph::new());

        for unit in &units {
            let comments: Vec<BabakComment> = serde_json::from_value(
                unit.comments.clone().unwrap_or(Vec::<Value>::new().into()),
            )
            .unwrap_or(vec![]);
            let comments = uniq_via_btreeset(&comments);

            if comments
                .clone()
                .into_iter()
                .filter(|comment| {
                    babak_non_empty_text(comment.comment.as_deref()).is_some()
                        && comment.datetime.is_some()
                })
                .collect::<Vec<_>>()
                .is_empty()
            {
                continue;
            }

            doc = doc
                .add_paragraph(babak_unit_heading_paragraph(
                    &unit.unit.clone().unwrap_or("НВ".to_string()),
                ))
                .add_paragraph(Paragraph::new());

            for comment in comments.clone() {
                let comment_text =
                    babak_non_empty_text(comment.comment.as_deref());

                if let (Some(comment_text), Some(d)) =
                    (comment_text, comment.datetime)
                {
                    let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                    doc = doc
                        .add_paragraph(
                            add_multiline_text(
                                Paragraph::new(),
                                &format!(
                                    "{} {}",
                                    d_tz.format("%d/%m %H:%M"),
                                    comment_text
                                ),
                                false,
                            )
                            .numbering(
                                NumberingId::new(1),
                                IndentLevel::new(0),
                            ),
                        )
                        .add_paragraph(Paragraph::new());
                }
            }
        }
    }

    doc = doc
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text("Втрати противника:"))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    for unit in &units {
        let losses_comments: Vec<BabakComment> = serde_json::from_value(
            unit.losses_comments
                .clone()
                .unwrap_or(Vec::<Value>::new().into()),
        )
        .unwrap_or(vec![]);
        let losses_comments = uniq_via_btreeset(&losses_comments);

        if losses_comments
            .clone()
            .into_iter()
            .filter(|comment| {
                let has_comment = !without_comments
                    && babak_non_empty_text(comment.comment.as_deref())
                        .is_some();
                let has_text =
                    babak_non_empty_text(comment.text.as_deref()).is_some();

                comment.datetime.is_some() && (has_comment || has_text)
            })
            .collect::<Vec<_>>()
            .is_empty()
        {
            continue;
        }

        doc = doc
            .add_paragraph(babak_unit_heading_paragraph(
                &unit.unit.clone().unwrap_or("НВ".to_string()),
            ))
            .add_paragraph(Paragraph::new());

        for comment in losses_comments.clone() {
            let comment_text = if without_comments {
                None
            } else {
                babak_non_empty_text(comment.comment.as_deref())
            };
            let body_text = babak_non_empty_text(comment.text.as_deref());

            if let Some(d) = comment.datetime {
                if comment_text.is_none() && body_text.is_none() {
                    continue;
                }

                let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                let mut paragraph = Paragraph::new().add_run(
                    Run::new().add_text(d_tz.format("%d/%m %H:%M").to_string()),
                );
                if let Some(comment_text) = comment_text {
                    paragraph = add_multiline_text(
                        paragraph,
                        &format!(" {comment_text}"),
                        false,
                    );
                }
                if let Some(text) = body_text {
                    paragraph = paragraph
                        .add_run(Run::new().add_break(BreakType::TextWrapping));
                    paragraph = add_multiline_text(paragraph, text, false);
                }
                doc = doc
                    .add_paragraph(
                        paragraph.numbering(
                            NumberingId::new(1),
                            IndentLevel::new(0),
                        ),
                    )
                    .add_paragraph(Paragraph::new());
            }
        }
    }

    doc = doc
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(
                    Run::new().add_text("Імовірний характер дій противника:"),
                )
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(Run::new().add_text(
                    "Радіоперехоплення, що становлять розвідувальну цінність:",
                ))
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    for unit in &units {
        let others_comments: Vec<BabakComment> = serde_json::from_value(
            unit.others_comments
                .clone()
                .unwrap_or(Vec::<Value>::new().into()),
        )
        .unwrap_or(vec![]);
        let others_comments = uniq_via_btreeset(&others_comments);

        if others_comments
            .clone()
            .into_iter()
            .filter(|comment| {
                let has_comment = !without_comments
                    && babak_non_empty_text(comment.comment.as_deref())
                        .is_some();
                let has_text =
                    babak_non_empty_text(comment.text.as_deref()).is_some();

                comment.datetime.is_some() && (has_comment || has_text)
            })
            .collect::<Vec<_>>()
            .is_empty()
        {
            continue;
        }

        doc = doc
            .add_paragraph(babak_unit_heading_paragraph(
                &unit.unit.clone().unwrap_or("НВ".to_string()),
            ))
            .add_paragraph(Paragraph::new());

        for comment in others_comments.clone() {
            let comment_text = if without_comments {
                None
            } else {
                babak_non_empty_text(comment.comment.as_deref())
            };
            let body_text = babak_non_empty_text(comment.text.as_deref());

            if let Some(d) = comment.datetime {
                if comment_text.is_none() && body_text.is_none() {
                    continue;
                }

                let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                let mut paragraph = Paragraph::new().add_run(
                    Run::new().add_text(d_tz.format("%d/%m %H:%M").to_string()),
                );
                if let Some(comment_text) = comment_text {
                    paragraph = add_multiline_text(
                        paragraph,
                        &format!(" {comment_text}"),
                        true,
                    );
                }

                doc = doc.add_paragraph(
                    paragraph
                        .numbering(NumberingId::new(1), IndentLevel::new(0)),
                );

                if let Some(text) = body_text {
                    doc = doc.add_paragraph(add_multiline_text(
                        Paragraph::new().indent(Some(720), None, None, None),
                        text,
                        false,
                    ));
                }

                doc = doc.add_paragraph(Paragraph::new());
            }
        }
    }

    doc.build().pack(file).context(h!())?;

    Ok(())
}

#[derive(FromQueryResult, Deserialize, Debug, Clone)]
pub struct StatsPerUnitReport {
    pub unit: Option<String>,
    pub count: i64,
    pub bpla: i64,
    pub reb: i64,
    pub arta: i64,
    pub software: i64,
    pub losses: i64,
    pub comments: Option<Value>,
    pub others_comments: Option<Value>,
    pub losses_comments: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
struct BabakComment {
    datetime: Option<chrono::NaiveDateTime>,
    comment: Option<String>,
    text: Option<String>,
}

fn add_multiline_text(
    paragraph: Paragraph,
    text: &str,
    is_bold: bool,
) -> Paragraph {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized.split('\n').peekable();
    let mut paragraph = paragraph;

    while let Some(line) = lines.next() {
        let mut run = Run::new().add_text(line.to_string());
        if is_bold {
            run = run.bold();
        }
        paragraph = paragraph.add_run(run);

        if lines.peek().is_some() {
            paragraph = paragraph
                .add_run(Run::new().add_break(BreakType::TextWrapping));
        }
    }

    paragraph
}

fn babak_non_empty_text(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

fn babak_unit_heading_paragraph(unit: &str) -> Paragraph {
    Paragraph::new().add_run(
        Run::new()
            .add_text(format!(" {unit} "))
            .bold()
            .shading(Shading::new().fill("d9d9d9")),
    )
}

fn dedup_babak_comments_across_units(units: &mut [StatsPerUnitReport]) {
    let mut seen_comments = BTreeSet::new();
    let mut seen_losses = BTreeSet::new();
    let mut seen_others = BTreeSet::new();

    for unit in units.iter_mut() {
        unit.comments = dedup_babak_comment_values(
            unit.comments.take(),
            &mut seen_comments,
        );
        unit.losses_comments = dedup_babak_comment_values(
            unit.losses_comments.take(),
            &mut seen_losses,
        );
        unit.others_comments = dedup_babak_comment_values(
            unit.others_comments.take(),
            &mut seen_others,
        );
    }
}

fn dedup_babak_comment_values(
    value: Option<Value>,
    seen: &mut BTreeSet<BabakComment>,
) -> Option<Value> {
    let value = value?;
    let original = value.clone();
    let comments: Vec<BabakComment> = match serde_json::from_value(value) {
        Ok(items) => items,
        Err(_) => return Some(original),
    };
    let mut deduped = Vec::with_capacity(comments.len());
    for comment in comments {
        if seen.insert(comment.clone()) {
            deduped.push(comment);
        }
    }

    serde_json::to_value(deduped).ok().or(Some(original))
}

pub async fn get_inbox_messages_report_unit(
    login: &str,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<StatsPerUnitReport>, AppError> {
    let read_db = env.replica();
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let logins = crate::users::get_organism_logins_by_login(&read_db, login)
        .await
        .context(h!())?;
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&read_db, login)
            .await
            .c(h!())?;
    let mut q = signal_message::Entity::find()
        .select_only()
        // creare a unique id for each message, using either duplicate_of or sigint_inbox_item.id to filter out duplicates
        .expr_as(
            Expr::cust(
                r#"signal_message.id"#,
            ),
            "id",
        ).clone()
        .columns(vec![
            // sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::Lat,
            sigint_inbox_item::Column::Lng,
        ])
        .expr_as(
            Expr::cust_with_expr(
                "array_agg($1) filter (where $1 is not null)",
                Expr::col(sigint_inbox_item_tag::Column::TagId),
            ),
            "tags",
        )
        .column(signal_message::Column::Body)
        // For the messages without a network assigned (or no frequency), we use the unit_v2 field
        .expr_as(
            Expr::cust(
                r#"coalesce(nullif("sigint_unit"."regiment", ''),
                            nullif("sigint_unit"."battalion",''),
                            nullif("sigint_unit"."division",''),
                            nullif("sigint_unit"."army",''),
                            nullif("sigint_unit"."name",''),
                            sigint_inbox_item.unit_v2
                        )"#,
            ),
            "unit",
        ).clone()
        .column(sigint_inbox_item::Column::Datetime)
        .column(sigint_comment::Column::Comment)
        .expr_as(
            Expr::cust_with_expr(
                r#"ST_ClusterDBSCAN(
                    ST_SetSRID(ST_MakePoint(sigint_inbox_item.lng, sigint_inbox_item.lat), 4326),
                    eps := $1::numeric,
                    minPoints := 2
                ) OVER ()"#,
                env.config.cluster_radius.unwrap_or(2.0) / 100.0, // 2km is a default radius
            ),
            "cluster_id",
        ).clone()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network_freq::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::SigintNetwork.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_network::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_unit::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_post::Column::Deleted))
                        .eq(false)
                        .into_condition()
                }),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item_tag::Relation::SigintInboxItem
                .def()
                .rev()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_inbox_item_tag::Column::Confidence))
                        .gte(TAG_MINIMUM_CONFIDENCE)
                        .into_condition()
                }),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        );
    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    q = q.join(
        JoinType::LeftJoin,
        signal_message::Relation::SigintComment.def(),
    );

    if req.report_tags_only_this_unit == Some(true) {
        q = q.filter(sigint_comment::Column::Login.eq_any(logins.clone()));
        q = q.filter(
            sigint_inbox_item_tag::Column::Login.eq_any(logins.clone()),
        );
    }
    if req.without_model_tags == Some(true) {
        q = q.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }

    // let q = q.filter(signal_message::Column::DuplicateOf.is_null());
    let q = filter_selected_groups_and_senders_with_access(
        q,
        &req.selected_groups,
        &req.selected_senders,
        &sigint_groups,
    )?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let q = filter_selected_metadata_for_inbox_messages(q, req)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let mut q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    if let Some(since_date_inclusive_ms) = req.since_date_inclusive_ms {
        q = q.filter(
            sigint_inbox_item::Column::Datetime
                .gte(dt_from_millis(since_date_inclusive_ms)?),
        );
    }
    if let Some(till_date_inclusive_ms) = req.till_date_inclusive_ms {
        q = q.filter(
            sigint_inbox_item::Column::Datetime
                .lte(dt_from_millis(till_date_inclusive_ms)?),
        );
    }
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    // group by to get rid of duplicates
    let q = q.group_by(Expr::cust("1,2,3,5,6,7,8"));
    let q = q.order_by_asc(Expr::col(Alias::new("unit")));

    let clustered_points = CommonTableExpression::new()
        .query(q.into_query().to_owned())
        .table_name(Alias::new("clustered_points"))
        .to_owned();

    let bpla_tag = "бпла";
    let rer_tag = "рер";
    let arta_tag = "арта";
    let software_tag = "забезп";
    let losses_tag = "втрати";

    // Define cluster_centroids CTE
    let cluster_centroids = CommonTableExpression::new()
        .query(
            Query::select()
                .expr_as(Expr::if_null(Expr::col(Alias::new("unit")), Expr::cust("cluster_id::varchar(255)")), Alias::new("unit"))
                .expr_as(
                    Expr::cust(
                        "ST_Centroid(ST_Collect(ST_SetSRID(ST_MakePoint(lng, lat), 4326)))",
                    ),
                    Alias::new("centroid"),
                )
                .expr_as(
                    Expr::cust("COUNT(*)"),
                    Alias::new("count"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(bpla_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("bpla"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(rer_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("reb"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(arta_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("arta"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(software_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("software"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("losses"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "json_agg(jsonb_build_object('datetime', datetime, 'comment', comment, 'text', body) ORDER BY \"datetime\") FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("losses_comments"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "json_agg(jsonb_build_object('datetime', datetime, 'comment', comment, 'text', body) ORDER BY \"datetime\") FILTER (WHERE NOT(tags @> $1))",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("array_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("others_comments"),
                )
                .expr_as(
                    Expr::cust("json_agg(jsonb_build_object('datetime', datetime, 'comment', comment, 'text', body) ORDER BY \"datetime\")"),
                    Alias::new("comments"),
                )
                .from(Alias::new("clustered_points"))
                .add_group_by(vec![Expr::if_null(Expr::col(Alias::new("unit")), Expr::cust("cluster_id::varchar(255)"))])
                .to_owned(),
        )
        .table_name(Alias::new("cluster_centroids")).to_owned();

    let degree_expr = |val| {
        Expr::cust_with_values(
            "degrees(ST_Azimuth(centroid::geography, s.geom::geography)) < $1",
            [val],
        )
    };

    // Define the main query
    let main_query = Query::select()
        .exprs(vec![
            Expr::col(Alias::new("count")),
            Expr::col(Alias::new("bpla")),
            Expr::col(Alias::new("reb")),
            Expr::col(Alias::new("arta")),
            Expr::col(Alias::new("software")),
            Expr::col(Alias::new("losses")),
            Expr::col(Alias::new("comments")),
            Expr::col(Alias::new("others_comments")),
            Expr::col(Alias::new("losses_comments")),
        ])
        .expr_as(
            Expr::case(
                Expr::cust("unit ~ '^\\d+$'"),
                Func::cust(Alias::new("FORMAT"))
                    .arg(Expr::val("%s км %s %s"))
                    .arg(Func::round_with_precision(
                        Expr::cust("ST_Distance(centroid::geography,s.geom::geography)").cast_as(Alias::new("numeric")).div(Expr::val(1000.0)),
                        Expr::val(1),
                    ))
                    .arg(
                        Expr::case(
                            degree_expr(22.5),
                            Expr::val("Пн"),
                        ).case(
                            degree_expr(67.5),
                            Expr::val("Пн-Сх"),
                        ).case(
                            degree_expr(112.5),
                            Expr::val("Сх"),
                        ).case(
                            degree_expr(157.5),
                            Expr::val("Пд-Сх"),
                        ).case(
                            degree_expr(202.5),
                            Expr::val("Пд"),
                        ).case(
                            degree_expr(247.5),
                            Expr::val("Пд-Зх"),
                        ).case(
                            degree_expr(292.5),
                            Expr::val("Зх"),
                        ).case(
                            degree_expr(337.5),
                            Expr::val("Пн-Зх"),
                        ).finally("Пн")
                    )
                    .arg(Expr::cust("s.name")),
            )
                .case(
                    Expr::cust("unit IS NOT NULL AND unit <> ''"),
                    Expr::cust("unit"),
                )
                .finally("НВ"),
            Alias::new("unit"),
        )
        .from(Alias::new("cluster_centroids"))
        // @TODO: postgresql doesn't support CROSS JOIN LATERAL with ON
        .join_lateral(
            JoinType::CrossJoin,
            Query::select()
                .column(settlement::Column::Name)
                .expr_as(Expr::cust("ST_SetSRID(ST_MakePoint(lon, lat), 4326)"), Alias::new("geom"))
                .from(settlement::Entity)
                .order_by_expr(Expr::cust("cluster_centroids.centroid <-> ST_SetSRID(ST_MakePoint(lon, lat), 4326)"), Order::Asc)
                .limit(1)
                .to_owned(),
            Alias::new("s"),
            Expr::cust(""),
        )
        .to_owned();

    // Combine CTEs with the main query
    let combined_query = Query::with()
        .cte(clustered_points)
        .cte(cluster_centroids)
        .clone()
        .query(main_query);

    let query = &combined_query.to_string(PostgresQueryBuilder);
    let raw_query = query.strip_suffix("ON ").unwrap();

    print!("{raw_query}");

    let mut units = read_db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            raw_query.to_string(),
        ))
        .await
        .c(h!())?
        .iter()
        .map(|row| StatsPerUnitReport::from_query_result(row, "").unwrap())
        .collect::<Vec<StatsPerUnitReport>>();

    if req.report_tags_only_this_unit == Some(true) {
        dedup_babak_comments_across_units(&mut units);
    }

    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use crate::rer_importer::reports::types::ReportPreviewReq;
    use crate::rer_importer::types::InboxMessagesReq;
    use chrono::Utc;
    use sea_orm::ActiveValue::Set;
    use serde_json::json;
    use serial_test::serial;

    #[serial]
    #[tokio::test]
    async fn test_bl_babak_report_returns_unit_stats() {
        let env = cleanup().await.unwrap();
        let now = Utc::now().naive_utc();

        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let bpla_tag = find_test_bpla_tag(&env.dbx).await.unwrap();

        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("test message".to_string())),
                created_at: Set(now),
                timestamp: Set(Some(now)),
                sender: Set(Some("sender".to_string())),
                message_uid: Set(Some("uid-1".to_string())),
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let inbox_item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some("123.45".to_string())),
                callsigns: Set(Some(json!(["Alpha"]))),
                lat: Set(Some(50.0)),
                lng: Set(Some(30.0)),
                tags: Set(Some(json!([bpla_tag.id]))),
                date: Set(Some(now.date().to_string())),
                time: Set(Some(now.time().format("%H:%M:%S").to_string())),
                unit_v2: Set(Some("TestUnit".to_string())),
                checked: Set(Some(true)),
                reviewed: Set(Some(true)),
                parsed_unit_v2: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let datetime = inbox_item
            .datetime
            .expect("expected auto-set datetime on sigint_inbox_item");
        let ts = datetime.and_utc().timestamp_millis();

        let req = ReportPreviewReq {
            kind: "babak".to_string(),
            req: InboxMessagesReq {
                since_date_inclusive_ms: Some(ts - 1_000),
                till_date_inclusive_ms: Some(ts + 1_000),
                nolimit: Some(true),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: Some(false),
            report_1213_linked_networks_only: None,
            without_comments: Some(false),
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
        };

        let res = bl_babak_report(&login.login, &env, &req).await.unwrap();

        assert_eq!(res.units.len(), 1);
        let unit = &res.units[0];
        assert_eq!(unit.unit.as_deref(), Some("TestUnit"));
        assert_eq!(unit.count, 1);
        assert!(
            res.new_callsigns
                .not_seen_7days
                .contains(&"Alpha".to_string()),
            "expected Alpha to be reported as new callsign"
        );
    }
}
