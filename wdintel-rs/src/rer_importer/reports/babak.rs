use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::rer_importer::types::{AnalysisStatsReq, InboxMessagesReq};
use crate::types::*;
use crate::utils::*;
use actix_identity::Identity;
use chrono::prelude::*;
use docx_rs::*;
use sea_orm::{sea_query::PostgresQueryBuilder, *};
use sea_query::{Alias, CommonTableExpression, Expr, Func, Query, SimpleExpr};
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Debug;
use std::path::PathBuf;

pub async fn report_docx_kind_babak(
    user: Identity,
    env: &Env,
    req: &super::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let user_id = &user.id()?;
    let Some(since_date_inclusive_ms) = req.req.since_date_inclusive_ms else {
        return Err("Since date must be specified".into());
    };
    let Some(till_date_inclusive_ms) = req.req.till_date_inclusive_ms else {
        return Err("Until date must be specified".into());
    };
    let date_from_dt = dt_from_millis(since_date_inclusive_ms)?;
    let date_to_dt = dt_from_millis(till_date_inclusive_ms)?;
    let tz = crate::config::get_tz();
    let date_from_dt_tz =
        Utc.from_utc_datetime(&date_from_dt).with_timezone(&tz);
    let date_to_dt_tz = Utc.from_utc_datetime(&date_to_dt).with_timezone(&tz);

    let file = std::fs::File::create(outpath.clone())?;

    let units = get_inbox_messages_report_unit(user, env, &req.req).await?;

    let new_callsing_req = AnalysisStatsReq {
        since_date_inclusive_ms: req.req.since_date_inclusive_ms.unwrap_or(0),
        till_date_noninclusive_ms: req.req.till_date_inclusive_ms.unwrap_or(0),
        selected_groups: req.req.selected_groups.clone(),
        selected_senders: req.req.selected_senders.clone(),
        selected_freqs: req.req.selected_freqs.clone(),
        selected_posts: req.req.selected_posts.clone(),
        selected_callsigns: req.req.selected_callsigns.clone(),
        selected_units: req.req.selected_units.clone(),
        selected_locations: req.req.selected_locations.clone(),
        or_with_extended_form: req.req.or_with_extended_form,
        or_bookmarked: req.req.or_bookmarked,
        or_important: req.req.or_important,
        or_with_coords: req.req.or_with_coords,
        search: req.req.search.clone(),
        selected_tags: req.req.selected_tags.clone(),
        include_peleng_locations: req.req.include_peleng_locations,
        units_exact_match_only: req.req.units_exact_match_only,
        filter_tags_option: req.req.filter_tags_option,
    };
    let new_callsigns_res = bi_new_callsigns(user_id, env, &new_callsing_req)
        .await
        .context(h!())?;

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
        .add_paragraph(Paragraph::new())
        .add_paragraph(
            Paragraph::new()
                .style(head)
                .add_run(
                    Run::new()
                        .add_text("Характер дій противника за звітний період"),
                )
                .align(docx_rs::alignment_type::AlignmentType::Left),
        )
        .add_paragraph(Paragraph::new());

    #[derive(Clone, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
    pub struct Comment {
        datetime: Option<chrono::NaiveDateTime>,
        comment: Option<String>,
        text: Option<String>,
    }

    for unit in &units {
        let comments: Vec<Comment> = serde_json::from_value(
            unit.comments.clone().unwrap_or(Vec::<Value>::new().into()),
        )
        .unwrap_or(vec![]);
        let comments = uniq_via_btreeset(&comments);

        if comments
            .clone()
            .into_iter()
            .filter(|c| c.comment.is_some() && c.datetime.is_some())
            .collect::<Vec<_>>().is_empty()
        {
            continue;
        }

        doc = doc
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text(unit.unit.clone().unwrap_or("НВ".to_string()))
                        .bold(),
                ),
            )
            .add_paragraph(Paragraph::new());

        for comment in comments.clone() {
            if let Some(c) = comment.comment {
                if let Some(d) = comment.datetime {
                    let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                    doc = doc
                        .add_paragraph(
                            Paragraph::new()
                                .add_run(Run::new().add_text(format!(
                                    "{} {}",
                                    d_tz.format("%d/%m %H:%M"),
                                    c
                                )))
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
        let losses_comments: Vec<Comment> = serde_json::from_value(
            unit.losses_comments
                .clone()
                .unwrap_or(Vec::<Value>::new().into()),
        )
        .unwrap_or(vec![]);
        let losses_comments = uniq_via_btreeset(&losses_comments);

        if losses_comments
            .clone()
            .into_iter()
            .filter(|c| c.comment.is_some() && c.datetime.is_some())
            .collect::<Vec<_>>().is_empty()
        {
            continue;
        }

        doc = doc
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text(unit.unit.clone().unwrap_or("НВ".to_string()))
                        .bold(),
                ),
            )
            .add_paragraph(Paragraph::new());

        for comment in losses_comments.clone() {
            if let Some(c) = comment.comment {
                if let Some(d) = comment.datetime {
                    let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                    doc = doc
                        .add_paragraph(
                            Paragraph::new()
                                .add_run(Run::new().add_text(format!(
                                    "{} {}\n\r{}",
                                    d_tz.format("%d/%m %H:%M"),
                                    c,
                                    comment.text.unwrap_or("".to_string()),
                                )))
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
        let others_comments: Vec<Comment> = serde_json::from_value(
            unit.others_comments
                .clone()
                .unwrap_or(Vec::<Value>::new().into()),
        )
        .unwrap_or(vec![]);
        let others_comments = uniq_via_btreeset(&others_comments);

        if others_comments
            .clone()
            .into_iter()
            .filter(|c| c.text.is_some() && c.datetime.is_some())
            .collect::<Vec<_>>().is_empty()
        {
            continue;
        }

        doc = doc
            .add_paragraph(
                Paragraph::new().add_run(
                    Run::new()
                        .add_text(unit.unit.clone().unwrap_or("НВ".to_string()))
                        .bold(),
                ),
            )
            .add_paragraph(Paragraph::new());

        for comment in others_comments.clone() {
            if let Some(text) = comment.text {
                if let Some(d) = comment.datetime {
                    let d_tz = Utc.from_utc_datetime(&d).with_timezone(&tz);
                    doc = doc
                        .add_paragraph(
                            Paragraph::new()
                                .add_run(Run::new().add_text(
                                    d_tz.format("%d/%m %H:%M").to_string(),
                                ))
                                .add_run(
                                    Run::new()
                                        .add_text(
                                            comment
                                                .comment
                                                .unwrap_or("".to_string()),
                                        )
                                        .bold(),
                                )
                                .add_run(Run::new().add_text(text))
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

pub async fn get_inbox_messages_report_unit(
    user: Identity,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<StatsPerUnitReport>, AppError> {
    let login = user.id()?;
    let logins = crate::users::get_organism_logins(&env.dbx, user).await?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let mut q = signal_message::Entity::find()
        .select_only()
        // creare a unique id for each message, using either duplicate_of or sigint_inbox_item.id to filter out duplicates
        .expr_as(
            Expr::cust(
                r#"coalesce(signal_message.duplicate_of,
                            sigint_inbox_item.id)"#,
            ),
            "id",
        ).clone()
        .columns(vec![
            // sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::Lat,
            sigint_inbox_item::Column::Lng,
            sigint_inbox_item::Column::Tags,
        ])
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
        // .join(
        //     JoinType::LeftJoin,
        //     signal_message::Relation::SigintComment.def(),
        // )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(Condition::any()
            .add(sigint_network::Column::Deleted.eq(false))
            .add(sigint_network::Column::Deleted.is_null())
        )
        .filter(Condition::any()
            .add(sigint_unit::Column::Deleted.eq(false))
            .add(sigint_unit::Column::Deleted.is_null())
        )
        .filter(signal_message::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ));

    if !req.or_with_extended_form.unwrap_or(false) {
        q = q.join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintComment.def(),
        );
    } else {
        q = q.join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintComment.def(),
        );
        q = q.filter(sigint_comment::Column::Comment.eq("").not());
    }

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
    if req.report_tags_only_this_unit == Some(true) {
        q = q.filter(sigint_comment::Column::Login.is_in(logins));
    }
    // let q = q.filter(signal_message::Column::DuplicateOf.is_null());
    let q = filter_selected_groups(q, &req.selected_groups)?;
    let q = filter_selected_senders(q, &req.selected_senders)?;
    let q = filter_denied_senders(q, &req.denied_senders)?;
    let q = filter_selected_freqs(q, &req.selected_freqs)?;
    let q = filter_selected_posts(q, &req.selected_posts)?;
    let q = filter_denied_freqs(q, &req.denied_freqs)?;
    let q = filter_selected_callsigns(q, &req.selected_callsigns)?;
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let mut q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &Some(false),
        &req.filter_tags_option,
        &login,
        false,
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
    let q = q.group_by(Expr::cust("1,2,3,4,5,6,7,8"));
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
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(bpla_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("bpla"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(rer_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("reb"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(arta_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("arta"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(software_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("software"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "COUNT(*) FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("losses"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "json_agg(jsonb_build_object('datetime', datetime, 'comment', comment, 'text', body) ORDER BY \"datetime\") FILTER (WHERE tags @> $1)",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
                    ),
                    Alias::new("losses_comments"),
                )
                .expr_as(
                    Expr::cust_with_expr(
                        "json_agg(jsonb_build_object('datetime', datetime, 'comment', comment, 'text', body) ORDER BY \"datetime\") FILTER (WHERE NOT(tags @> $1))",
                        SimpleExpr::SubQuery(None, Box::new(Query::select().from(tag::Entity).expr(Expr::cust("jsonb_agg(id)")).and_where(tag::Column::Label.eq(losses_tag)).clone().into_sub_query_statement())),
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

    Ok(env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            raw_query.to_string(),
        ))
        .await?
        .iter()
        .map(|row| StatsPerUnitReport::from_query_result(row, "").unwrap())
        .collect::<Vec<StatsPerUnitReport>>())
}
