use super::super::types::*;
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::rer_importer::analysis::*;
use crate::types::*;
use actix_identity::Identity;
use chrono::prelude::*;
// Import necessary items from rust_xlsxwriter
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use sea_orm::{prelude::Expr, *};
use sea_query::*;
use serde_json::json;
use std::path::PathBuf;

#[derive(FromQueryResult)]
struct InboxMessage {
    date: Option<String>,
    time: Option<String>,
    freq: Option<String>,
    unit: Option<String>,
    callsigns: Option<JsonValue>,
    body: Option<String>,
    comment: Option<String>,
    coords: Option<String>,
    tags: Option<JsonValue>,
    important: Option<i64>,
}

async fn get_inbox_messages_report(
    user: Identity,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMessage>, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let login = user.id().context(h!())?;
    let read_db = env.replica();
    let logins = crate::users::get_organism_logins(&read_db, user)
        .await
        .context(h!())?;
    let mut q = SignalMessage::find()
        .inner_join(sigint_inbox_item::Entity)
        .column(sigint_inbox_item::Column::Datetime)
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Tags)
        .column(signal_message::Column::Body)
        .column_as(sigint_inbox_item::Column::CallsignsAlg1, "callsigns")
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::DuplicateOf,
            ))
            .if_null(Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            ))),
            "dedup_key",
        )
        .column_as(
            SimpleExpr::Custom(r#"
                COALESCE(
                    array_to_string(
                        NULLIF(
                            array_agg(DISTINCT 
                                sigint_network_freq.kind || ' р/м ' || sigint_network.name || ' ' || sigint_unit.name || ' (' || UPPER(sigint_network.location) || ')'
                            ) 
                            FILTER 
                            (WHERE sigint_unit.name IS NOT NULL),
                        '{}'),
                        ', '
                    ),
                    sigint_inbox_item.unit_v2
                )
            "#.to_string()),
            "unit",
        )
        .column_as(
            SimpleExpr::Custom(r#"
                STRING_AGG(DISTINCT sigint_comment.comment, E'\n')
            "#.to_string()),
            "comment",
        )
        .column(sigint_inbox_item::Column::Coords)
        .column_as(sigint_important::Column::SignalMessageId,"important")
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
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
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintComment.def(),
        )
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintImportant
                .def()
                .on_condition(|_left, right| {
                    Expr::col((right, sigint_important::Column::Deleted))
                        .not()
                        .into_condition()
                }),
        )
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .group_by(signal_message::Column::DuplicateOf)
        .group_by(sigint_important::Column::SignalMessageId)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.is_in(
            crate::messenger::group::get_identity_sigint_groups(&read_db, &login)
                .await
                .c(h!())?,
        ));

    if req.report_tags_only_this_unit == Some(true) {
        q = q.filter(sigint_comment::Column::Login.is_in(logins));
    }
    q = crate::rer_importer::inbox::query::get_pagination_filters(
        env,
        req,
        q.clone(),
    )
    .await
    .c(h!())?;

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
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
    let q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &login,
    )?;
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q =
        filter_selected_networks(q, &req.selected_networks).context(h!())?;

    let inbox_cte_alias = Alias::new("inbox_items_cte");
    let inbox_cte = CommonTableExpression::new()
        .query(q.clone().into_query())
        .table_name(inbox_cte_alias.clone())
        .to_owned();

    // Step 2: Build deduplication CTE using DISTINCT ON (dedup_key)
    let dedup_key_alias = Alias::new("dedup_key");
    let mut dedup_q = Query::select()
        .column(ColumnRef::Asterisk)
        .from(inbox_cte_alias.clone())
        .distinct_on([dedup_key_alias.clone()])
        .order_by(dedup_key_alias.clone(), Order::Asc)
        // emulate NULLS FIRST: order nulls before non-nulls
        .order_by_expr(
            Expr::cust("(inbox_items_cte.duplicate_of IS NULL)"),
            Order::Desc,
        )
        .to_owned();

    dedup_q = crate::rer_importer::inbox::query::get_pagination_filter_real_lower_bound_stmt(env, req, dedup_q)
        .await
        .context(h!())?;
    dedup_q =
        crate::rer_importer::inbox::query::get_bl_ordering_stmt(req, dedup_q)
            .await
            .context(h!())?;

    // Step 3: Combine CTEs and main query, add filter by initial window values and business logic ordering
    let combined_query = Query::with()
        .cte(inbox_cte)
        .clone()
        .query(dedup_q)
        .to_string(PostgresQueryBuilder);

    // println!("Interception report SQL: {combined_query}");

    // First execute the query to get QueryResult
    let results = read_db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query,
        ))
        .await
        .context(h!())?;

    // Then convert results to InboxMessage struct
    let messages: Vec<InboxMessage> = results
        .iter()
        .map(|qr| InboxMessage::from_query_result(qr, ""))
        .collect::<Result<Vec<_>, DbErr>>()
        .context(h!())?;

    let mut keys = HashSet::new();
    let mut result = vec![];
    for m in messages {
        let key = (m.date.clone(), m.time.clone(), m.body.clone());
        if keys.contains(&key) {
            continue;
        }
        keys.insert(key);
        result.push(m);
    }
    Ok(result)
}

fn process_callsigns(callsigns: Vec<String>) -> (String, String) {
    if callsigns.is_empty() {
        ("НВ".to_string(), "НВ".to_string())
    } else {
        let from = callsigns.first().unwrap().clone();
        let to: Vec<String> = callsigns.iter().skip(1).cloned().collect();
        let to_str = if to.is_empty() {
            "НВ".to_string()
        } else {
            to.join(", ")
        };
        (from, to_str)
    }
}

pub async fn report_xlsx_kind_interception(
    user: Identity,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new(); // Use rust_xlsxwriter
    let sheet1 = workbook.add_worksheet().set_name("Пеленги").context(h!())?; // Use rust_xlsxwriter
    let date_format = Format::new().set_num_format("dd.mm.yyyy");
    // Define formats using rust_xlsxwriter
    let coltitle_base = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_font_size(12.0);

    let coltitle_blue = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0x5b9bd5));
    let coltitle_yellow = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0xfef2cb));
    let coltitle_gray = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0xd8d8d8));
    let coltitle_orange = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0xffc000));
    let coltitle_pink = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0xff33cc));
    let coltitle_green = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0x77bc65));
    let coltitle_brown = coltitle_base
        .clone()
        .set_background_color(Color::RGB(0xf67315));

    let format_blue = Format::new()
        .set_background_color(Color::RGB(0x5b9bd5))
        .set_border(FormatBorder::Thin);
    let format_yellow = Format::new()
        .set_background_color(Color::RGB(0xfef2cb))
        .set_border(FormatBorder::Thin);
    let format_gray = Format::new()
        .set_background_color(Color::RGB(0xd8d8d8))
        .set_border(FormatBorder::Thin);
    let format_blue_wrap = format_blue.clone().set_text_wrap();
    let format_orange = Format::new()
        .set_background_color(Color::RGB(0xffc000))
        .set_border(FormatBorder::Thin);
    let format_pink_wrap = Format::new()
        .set_background_color(Color::RGB(0xff33cc))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let format_green_wrap = Format::new()
        .set_background_color(Color::RGB(0x77bc65))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let format_brown_wrap = Format::new()
        .set_background_color(Color::RGB(0xf67315))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();

    // Write headers with formats
    sheet1
        .write_string_with_format(0, 0, "Дата", &coltitle_blue)
        .context(h!())?;
    sheet1.set_column_width(0, 10.0).context(h!())?; // Set width
    sheet1.set_column_format(0, &format_blue).context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 1, "Час", &coltitle_yellow)
        .context(h!())?;
    sheet1.set_column_width(1, 10.0).context(h!())?; // Set width
    sheet1.set_column_format(1, &format_yellow).context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 2, "Частота", &coltitle_gray)
        .context(h!())?;
    sheet1.set_column_width(2, 10.0).context(h!())?; // Set width
    sheet1.set_column_format(2, &format_gray).context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 3, "Назва р\\м", &coltitle_blue)
        .context(h!())?;
    sheet1.set_column_width(3, 40.0).context(h!())?; // Set width
    sheet1
        .set_column_format(3, &format_blue_wrap)
        .context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 4, "хто", &coltitle_orange)
        .context(h!())?;
    sheet1.set_column_width(4, 20.0).context(h!())?; // Set width
    sheet1.set_column_format(4, &format_orange).context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 5, "кому", &coltitle_orange)
        .context(h!())?;
    sheet1.set_column_width(5, 20.0).context(h!())?; // Set width
    sheet1.set_column_format(5, &format_orange).context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 6, "р\\обмін", &coltitle_blue)
        .context(h!())?;
    sheet1.set_column_width(6, 60.0).context(h!())?; // Set width
    sheet1
        .set_column_format(6, &format_blue_wrap)
        .context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 7, "примітки", &coltitle_pink)
        .context(h!())?;
    sheet1.set_column_width(7, 40.0).context(h!())?; // Set width
    sheet1
        .set_column_format(7, &format_pink_wrap)
        .context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 8, "координати", &coltitle_green)
        .context(h!())?;
    sheet1.set_column_width(8, 30.0).context(h!())?; // Set width
    sheet1
        .set_column_format(8, &format_green_wrap)
        .context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 9, "теги", &coltitle_brown)
        .context(h!())?;
    sheet1.set_column_width(9, 30.0).context(h!())?; // Set width
    sheet1
        .set_column_format(9, &format_brown_wrap)
        .context(h!())?; // Set format
    sheet1
        .write_string_with_format(0, 10, "важливе", &coltitle_gray)
        .context(h!())?;
    sheet1.set_column_width(10, 10.0).context(h!())?; // Set width
    sheet1.set_column_format(10, &format_gray).context(h!())?; // Set format

    let read_db = env.replica();
    let all_tags = {
        let tags_vec = tag::Entity::find()
            .columns([tag::Column::Id, tag::Column::Title])
            .into_tuple::<(i64, String)>()
            .all(&read_db)
            .await
            .context(h!())?;
        let mut tags = HashMap::new();
        for tag in tags_vec {
            tags.insert(tag.0, tag.1);
        }
        tags
    };

    let mut i = 1;
    for m in get_inbox_messages_report(user, env, &req.req)
        .await
        .context(h!())?
    {
        // ... existing data processing ...
        let Some(date) = m.date.as_ref() else {
            continue;
        };
        // parse date from format like 2023-12-22
        let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
        let Some(time) = m.time.as_ref() else {
            continue;
        };
        let freq = m.freq.unwrap_or("".to_string());
        let date = rust_xlsxwriter::ExcelDateTime::from_ymd(
            date.year() as u16,
            date.month() as u8,
            date.day() as u8,
        )
        .context(h!())?;

        // Write data using rust_xlsxwriter
        sheet1
            .write_datetime_with_format(i, 0, date, &date_format)
            .context(h!())?;
        sheet1.write_string(i, 1, time.to_string()).context(h!())?;
        sheet1.write_string(i, 2, &freq).context(h!())?;
        sheet1
            .write_string(i, 3, m.unit.clone().unwrap_or("".to_string()))
            .context(h!())?;

        let (from, to) = process_callsigns(
            m.callsigns
                .clone()
                .unwrap_or(json!([]))
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect::<Vec<String>>(),
        );
        sheet1
            .write_string(i, 4, from.to_uppercase())
            .context(h!())?;
        sheet1.write_string(i, 5, to.to_uppercase()).context(h!())?;
        sheet1
            .write_string(i, 6, m.body.clone().unwrap_or("".to_string()))
            .context(h!())?;
        sheet1
            .write_string(i, 7, m.comment.clone().unwrap_or("".to_string()))
            .context(h!())?;
        sheet1
            .write_string(i, 8, m.coords.clone().unwrap_or("".to_string()))
            .context(h!())?;

        let mes_tags = m
            .tags
            .clone()
            .unwrap_or(json!([]))
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|x| x.as_i64())
            .filter_map(|x| all_tags.get(&x))
            .map(|s| s.to_string())
            .join(",");
        sheet1.write_string(i, 9, &mes_tags).context(h!())?;
        sheet1
            .write_string(i, 10, m.important.map_or("", |_| "Так"))
            .context(h!())?;
        i += 1;
    }

    workbook.save(outpath).context(h!())?; // Save the workbook

    Ok(())
}
