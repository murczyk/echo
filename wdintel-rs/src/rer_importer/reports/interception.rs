use super::super::types::*;
use crate::config::{
    RER_INTERCEPTION_REPORT_HEADER_ROWS_NUM, TAG_MINIMUM_CONFIDENCE,
    XLSX_WORKSHEET_ROW_MAX,
};
use crate::entities::{prelude::*, *};
use crate::error::AppError;
use crate::rer_importer;
use crate::rer_importer::analysis::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::prelude::*;
use rer_importer::body_noheader::extract_text;
// Import necessary items from rust_xlsxwriter
use rust_xlsxwriter::{
    Color, ExcelDateTime, Format, FormatAlign, FormatBorder, RowNum, Workbook,
    Worksheet,
};
use sea_orm::{prelude::Expr, *};
use sea_query::*;
use serde_json::json;
use std::path::PathBuf;

mod palette;

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
    inbox_tags: Option<serde_json::Value>,
    important: Option<i64>,
}

struct SheetRowData<'a> {
    row_number: RowNum,
    date: ExcelDateTime,
    time: String,
    message: &'a InboxMessage,
    without_model_tags: bool,
    keep_full_message: bool,
}

pub async fn report_xlsx_kind_interception(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &super::types::ReportPreviewReq,
    outpath: &PathBuf,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new(); // Use rust_xlsxwriter
    let sheet1 = get_worksheet(&mut workbook)?;
    let mut inbox_req = req.req.clone();
    inbox_req.report_tags_only_this_unit = req.report_tags_only_this_unit;
    let without_model_tags = inbox_req.without_model_tags.unwrap_or(false);
    let keep_full_message = req.interception_keep_full_message.unwrap_or(false);
    let keep_old_colors = req.interception_keep_old_colors.unwrap_or(false);
    // Define formats using rust_xlsxwriter

    set_colors_and_formats_for_sheet(sheet1, keep_old_colors)?;

    let read_db = env.replica();
    let all_tags = get_all_tags(&read_db).await?;

    let analytics_req = &inbox_req;
    let postgres_req = &inbox_req;
    let messages = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "interception report message scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &inbox_req,
        ),
        |db| async move {
            get_inbox_messages_report(&db, user_login, env, analytics_req).await
        },
        |db| async move {
            get_inbox_messages_report(&db, user_login, env, postgres_req).await
        },
    )
    .await
    .context(h!())?;
    ensure_interception_report_row_limit(user_login, messages.len())?;
    process_messages_for_interception_report(
        sheet1,
        messages,
        all_tags,
        without_model_tags,
        keep_full_message,
    )?;

    workbook.save(outpath).context(h!())?; // Save the workbook

    Ok(())
}

fn get_worksheet(workbook: &mut Workbook) -> Result<&mut Worksheet, AppError> {
    Ok(workbook.add_worksheet().set_name("Пеленги").context(h!())?) // Use rust_xlsxwriter
}

fn set_colors_and_formats_for_sheet(
    sheet1: &mut Worksheet,
    keep_old_colors: bool,
) -> Result<(), AppError> {
    let colors = palette::for_keep_old_colors(keep_old_colors);
    let coltitle_base = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_font_size(12.0);

    let coltitle_blue = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.blue));
    let coltitle_yellow = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.yellow));
    let coltitle_gray = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.gray));
    let coltitle_orange = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.orange));
    let coltitle_pink = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.pink));
    let coltitle_green = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.green));
    let coltitle_brown = coltitle_base
        .clone()
        .set_background_color(Color::RGB(colors.brown));

    let format_blue = Format::new()
        .set_background_color(Color::RGB(colors.blue))
        .set_border(FormatBorder::Thin);
    let format_yellow = Format::new()
        .set_background_color(Color::RGB(colors.yellow))
        .set_border(FormatBorder::Thin);
    let format_gray = Format::new()
        .set_background_color(Color::RGB(colors.gray))
        .set_border(FormatBorder::Thin);
    let format_blue_wrap = format_blue.clone().set_text_wrap();
    let format_orange = Format::new()
        .set_background_color(Color::RGB(colors.orange))
        .set_border(FormatBorder::Thin);
    let format_pink_wrap = Format::new()
        .set_background_color(Color::RGB(colors.pink))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let format_green_wrap = Format::new()
        .set_background_color(Color::RGB(colors.green))
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let format_brown_wrap = Format::new()
        .set_background_color(Color::RGB(colors.brown))
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

    Ok(())
}

async fn get_all_tags(
    read_db: &DatabaseConnection,
) -> Result<HashMap<i64, String>, AppError> {
    let all_tags = {
        let tags_vec = tag::Entity::find()
            .columns([tag::Column::Id, tag::Column::Title])
            .into_tuple::<(i64, String)>()
            .all(read_db)
            .await
            .context(h!())?;
        let mut tags = HashMap::new();
        for tag in tags_vec {
            tags.insert(tag.0, tag.1);
        }
        tags
    };
    Ok(all_tags)
}

async fn get_inbox_messages_report(
    read_db: &DatabaseConnection,
    user_login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<Vec<InboxMessage>, AppError> {
    let combined_query =
        build_inbox_messages_report_sql(user_login, env, req).await?;

    let results = read_db
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query,
        ))
        .await
        .context(h!())?;

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

fn process_messages_for_interception_report(
    sheet1: &mut Worksheet,
    messages: Vec<InboxMessage>,
    all_tags: HashMap<i64, String>,
    without_model_tags: bool,
    keep_full_message: bool,
) -> Result<(), AppError> {
    let mut index = 0;
    for message in messages {
        // ... existing data processing ...
        let Some(date) = message.date.as_ref() else {
            continue;
        };

        let Some(time) = message.time.as_ref() else {
            continue;
        };

        // parse date from format like 2023-12-22
        let date = get_parsed_date(date).context(h!())?;

        write_data_to_sheet(
            sheet1,
            &all_tags,
            SheetRowData {
                row_number: index as RowNum
                    + RER_INTERCEPTION_REPORT_HEADER_ROWS_NUM as RowNum,
                message: &message,
                date,
                time: time.clone(),
                without_model_tags,
                keep_full_message,
            },
        )
        .context(h!())?;
        index += 1;
    }

    Ok(())
}

fn ensure_interception_report_row_limit(
    user_login: &uuid::Uuid,
    rows_count: usize,
) -> Result<(), AppError> {
    let max_rows =
        XLSX_WORKSHEET_ROW_MAX - RER_INTERCEPTION_REPORT_HEADER_ROWS_NUM;
    if rows_count <= max_rows {
        return Ok(());
    }

    log::error!(
        "interception report row limit exceeded: user={user_login}, rows={rows_count}, max_rows={max_rows}",
    );

    Err(AppError::BL {
        msg: format!(
            "Звіт містить {rows_count} рядків, максимум для XLSX: {max_rows}. Зменшіть період або фільтри."
        ),
    })
}

fn get_parsed_date(date: &String) -> Result<ExcelDateTime, AppError> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").context(h!())?;
    Ok(ExcelDateTime::from_ymd(
        date.year() as u16,
        date.month() as u8,
        date.day() as u8,
    )
    .context(h!())?)
}

async fn build_inbox_messages_report_sql(
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
) -> Result<String, AppError> {
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);
    let read_db = env.replica();
    let login_ids = crate::users::get_organism_login_ids_by_id(&read_db, login)
        .await
        .context(h!())?;
    let owner_organism_id =
        crate::tags::query::current_user_organism_id(&read_db, login)
            .await
            .c(h!())?;
    let mut visible_tag_query = Query::select();
    visible_tag_query
        .column(tag::Column::Id)
        .from(tag::Entity)
        .cond_where(crate::tags::query::accessible_tag_condition(
            owner_organism_id,
        ));
    let report_tags_only_this_unit =
        req.report_tags_only_this_unit == Some(true);
    let logins2 = login_ids.clone();
    let comment_join = if report_tags_only_this_unit {
        signal_message::Relation::SigintComment.def().on_condition(
            move |_left, right| {
                Expr::col((right, sigint_comment::Column::LoginId))
                    .is_in(logins2.clone())
                    .into_condition()
            },
        )
    } else {
        signal_message::Relation::SigintComment.def()
    };
    let tags_join = sigint_inbox_item_tag::Relation::SigintInboxItem
        .def()
        .rev()
        .on_condition(move |_left, right| {
            let mut condition = Expr::col((
                right.clone(),
                sigint_inbox_item_tag::Column::Confidence,
            ))
            .gte(TAG_MINIMUM_CONFIDENCE)
            .into_condition();
            condition = condition.add(
                Expr::col((
                    right.clone(),
                    sigint_inbox_item_tag::Column::TagId,
                ))
                .in_subquery(visible_tag_query.clone()),
            );
            if report_tags_only_this_unit {
                condition = condition.add(
                    Expr::col((right, sigint_inbox_item_tag::Column::LoginId))
                        .is_in(login_ids.clone()),
                );
            }
            condition
        });
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&read_db, login)
            .await
            .c(h!())?;
    let mut q = SignalMessage::find()
        .inner_join(sigint_inbox_item::Entity)
        .column(sigint_inbox_item::Column::Datetime)
        .column(sigint_inbox_item::Column::Date)
        .column(sigint_inbox_item::Column::Time)
        .column(sigint_inbox_item::Column::Freq)
        .column(signal_message::Column::Body)
        .expr_as(
            Expr::cust(
                "jsonb_agg(sigint_inbox_item_tag.*) FILTER (WHERE sigint_inbox_item_tag.id is not null)",
            ),
            "inbox_tags",
        )
        .column_as(sigint_inbox_item::Column::CallsignsAlg1, "callsigns")
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::Id,
            )),
            "dedup_key",
        )
        .column_as(
            SimpleExpr::Custom(r#"
                COALESCE(
                    array_to_string(
                        NULLIF(
                            array_agg(DISTINCT
                                sigint_network_freq.modulation || ' р/м ' || sigint_network.name || ' ' || sigint_unit.name || ' (' || UPPER(sigint_network.location) || ')'
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
            comment_join,
        )
        .join(
            JoinType::LeftJoin,
            tags_join,
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
        .group_by(sigint_important::Column::SignalMessageId)
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        );

    if req.without_model_tags == Some(true) {
        q = q.filter(sigint_inbox_item_tag::Column::Model.is_null());
    }

    q = rer_importer::inbox::query::get_pagination_filters(env, req, q.clone())
        .await
        .c(h!())?;

    if req.only_show_unprocessed == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Reviewed.ne(Some(true)));
    }
    if req.checked_only == Some(true) {
        q = q.filter(sigint_inbox_item::Column::Checked.eq(Some(true)));
    }
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
    let q = filter_search(q, &req.search)?;
    let q = filter_selected_units(
        q,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let q = filter_selected_tags(
        q,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
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
    let q = filter_selected_locations(
        q,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    let q = filter_selected_aors(q, &req.selected_aors).context(h!())?;
    let q = filter_selected_networks(
        q,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let q = filter_selected_metadata_for_inbox_messages(q, req)?;

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
        .to_owned();

    dedup_q = rer_importer::inbox::query::get_pagination_filter_real_lower_bound_stmt(env, req, dedup_q)
        .await
        .context(h!())?;
    dedup_q = rer_importer::inbox::query::get_bl_ordering_stmt(req, dedup_q)
        .await
        .context(h!())?;

    // Step 3: Combine CTEs and main query, add filter by initial window values and business logic ordering
    let combined_query = Query::with()
        .cte(inbox_cte)
        .clone()
        .query(dedup_q)
        .to_string(PostgresQueryBuilder);

    Ok(combined_query)
}

fn write_data_to_sheet(
    sheet1: &mut Worksheet,
    all_tags: &HashMap<i64, String>,
    data: SheetRowData,
) -> Result<(), AppError> {
    let i = data.row_number;
    let date = data.date;
    let date_fmt = Format::new().set_num_format("dd.mm.yyyy");
    let time = data.time;
    let m = data.message;
    let freq = m.freq.to_owned().unwrap_or("".to_string());
    let without_model_tags = data.without_model_tags;
    let keep_full_message = data.keep_full_message;
    let m_body = select_report_message_body(
        &m.body.clone().unwrap_or("".to_string()),
        keep_full_message,
    )?;
    let unit = m.unit.to_owned().unwrap_or("".to_string());
    let comment = m.comment.to_owned().unwrap_or("".to_string());
    let coords = m.coords.to_owned().unwrap_or("".to_string());
    let important = m.important.map_or("", |_| "Так").to_string();

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
    let from = from.clone().to_uppercase();
    let to = to.clone().to_uppercase();

    let inbox_tags: Vec<InboxMessageTag> = m
        .inbox_tags
        .clone()
        .map(|val| serde_json::from_value(val).unwrap_or_default())
        .unwrap_or_default();
    let mes_tags = inbox_tags
        .into_iter()
        .filter(|tag| tag.confidence >= TAG_MINIMUM_CONFIDENCE)
        .filter(|tag| !without_model_tags || tag.model.is_none())
        .filter_map(|tag| all_tags.get(&tag.tag_id))
        .map(|s| s.to_string())
        .join(",");

    // Write data using rust_xlsxwriter
    sheet1
        .write_datetime_with_format(i, 0, date, &date_fmt)
        .context(h!())?;
    sheet1.write_string(i, 1, time).context(h!())?;
    sheet1.write_string(i, 2, freq).context(h!())?;
    sheet1.write_string(i, 3, unit).context(h!())?;
    sheet1.write_string(i, 4, from).context(h!())?;
    sheet1.write_string(i, 5, to).context(h!())?;
    sheet1.write_string(i, 6, m_body).context(h!())?;
    sheet1.write_string(i, 7, comment).context(h!())?;
    sheet1.write_string(i, 8, coords).context(h!())?;
    sheet1.write_string(i, 9, &mes_tags).context(h!())?;
    sheet1.write_string(i, 10, important).context(h!())?;

    Ok(())
}

fn select_report_message_body(
    full_message: &str,
    keep_full_message: bool,
) -> Result<String, AppError> {
    if keep_full_message {
        return Ok(full_message.to_string());
    }

    let body_text = extract_text(full_message)?.body;

    Ok(eject_body_from_message(body_text).unwrap_or(full_message.to_string()))
}

fn eject_body_from_message(body: String) -> Option<String> {
    let lines: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();

    let mut result = Vec::new();

    for line in lines {
        if is_body_line(line) {
            result.push(line);
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(result.join("\n"))
    }
}

fn is_body_line(line: &str) -> bool {
    let s = line.trim();

    if s.len() < 2 {
        return false;
    }

    if s == "—" || s == "-" {
        return false;
    }

    if is_only_dashes(s) {
        return false;
    }

    // Skip obvious metadata
    if looks_like_datetime(s) {
        return false;
    }

    if looks_like_code(s) {
        return false;
    }

    // "- text" / "--text" / "-- text"
    if s.starts_with("- ") || s.starts_with("--") {
        return true;
    }

    // "— text"
    if s.starts_with("—") {
        return true;
    }

    // "1 — text"
    if starts_with_number_long_dash(s) {
        return true;
    }

    // "1 - text"
    if starts_with_number_short_dash(s) {
        return true;
    }

    // "1. text"
    if starts_with_number_dot_text(s) {
        return true;
    }

    false
}

fn looks_like_datetime(s: &str) -> bool {
    // 01.01.2026
    // 1:17
    // 01.01.2026 1:17:25
    // 01.01.2026, 00:00:42

    let normalized = s.replace(',', " ");
    let parts: Vec<&str> = normalized.split_whitespace().collect();

    if parts.is_empty() {
        return false;
    }

    if parts.len() == 1 {
        return is_date(parts[0]) || is_time(parts[0]);
    }

    parts
        .windows(2)
        .any(|pair| is_date(pair[0]) && is_time(pair[1]))
}

fn is_date(s: &str) -> bool {
    let mut chunks = s.split('.');
    let Some(day) = chunks.next() else {
        return false;
    };
    let Some(month) = chunks.next() else {
        return false;
    };
    let Some(year) = chunks.next() else {
        return false;
    };

    if chunks.next().is_some() {
        return false;
    }

    day.len() == 2
        && month.len() == 2
        && year.len() == 4
        && day.chars().all(|c| c.is_ascii_digit())
        && month.chars().all(|c| c.is_ascii_digit())
        && year.chars().all(|c| c.is_ascii_digit())
}

fn is_time(s: &str) -> bool {
    let chunks: Vec<&str> = s.split(':').collect();

    if !(chunks.len() == 2 || chunks.len() == 3) {
        return false;
    }

    let hour = chunks[0];
    let minute = chunks[1];
    let second = if chunks.len() == 3 {
        Some(chunks[2])
    } else {
        None
    };

    if !(hour.len() == 1 || hour.len() == 2) {
        return false;
    }

    if minute.len() != 2 {
        return false;
    }

    if !hour.chars().all(|c| c.is_ascii_digit())
        || !minute.chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }

    if let Some(second) = second {
        if second.len() != 2 || !second.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }

    true
}

fn looks_like_code(s: &str) -> bool {
    // "37U CP 78127 61039"

    let uppercase = s.chars().filter(|c| c.is_ascii_uppercase()).count();

    let digits = s.chars().filter(|c| c.is_ascii_digit()).count();

    uppercase >= 2 && digits >= 4
}

fn is_only_dashes(s: &str) -> bool {
    s.chars().all(|c| c == '-' || c == '—')
}

fn starts_with_number_short_dash(s: &str) -> bool {
    let Some((left_raw, right_raw)) = s.split_once('-') else {
        return false;
    };

    let left = left_raw.trim();
    if left.is_empty() || !left.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    let has_space_before_dash = left_raw
        .chars()
        .last()
        .map(|c| c.is_whitespace())
        .unwrap_or(false);
    let has_space_after_dash = right_raw
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(false);

    if !has_space_before_dash && !has_space_after_dash {
        return false;
    }

    !right_raw.trim().is_empty()
}

fn starts_with_number_long_dash(s: &str) -> bool {
    let Some((left_raw, right_raw)) = s.split_once('—') else {
        return false;
    };

    let left = left_raw.trim();
    if left.is_empty() || !left.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    !right_raw.trim().is_empty()
}

fn starts_with_number_dot_text(s: &str) -> bool {
    let Some(dot_pos) = s.find('.') else {
        return false;
    };

    let (left, right) = s.split_at(dot_pos);

    if left.is_empty() {
        return false;
    }

    if !left.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    // after dot must contain actual text
    let text = right.trim_start_matches('.').trim();

    if text.is_empty() {
        return false;
    }

    // reject dates like 01.01.2026
    !text.chars().next().unwrap_or(' ').is_ascii_digit()
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

#[cfg(test)]
mod tests {
    use super::{
        eject_body_from_message, ensure_interception_report_row_limit,
        select_report_message_body,
    };
    use crate::config::XLSX_WORKSHEET_ROW_MAX;

    #[test]
    fn eject_body_keeps_only_number_long_dash_lines() {
        let input = r#"01.01.2026, 00:00:42
148.1261
УКХ р/м управління шр 89 тп, придана до 77 омсп 49 ЗА (р-н ЯБЛУНІВКА - ОЛЕКСАНДРО-КАЛИНОВЕ)
КОРМУШКА (124)
НВ

1 —  Тихий я Кормушка доложи обстановку
1 —  Тихий, Тихий на связь, Тихий на связь, Тихий на связь."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some(
                "1 —  Тихий я Кормушка доложи обстановку\n1 —  Тихий, Тихий на связь, Тихий на связь, Тихий на связь.".to_string()
            )
        );
    }

    #[test]
    fn eject_body_keeps_only_number_dot_lines() {
        let input = r#"23:58
31.12.2025
148.070
йм. 85 омсбр
р-н Соледар-Васюківка
1. Принял, принял тебя Берсерк, плюс."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some("1. Принял, принял тебя Берсерк, плюс.".to_string())
        );
    }

    #[test]
    fn eject_body_keeps_only_lines_with_long_dash_prefix() {
        let input = r#"Отримано з поста "18 Бр НГУ БСП ДОНБАС"
--------------------------------------
01.01.2026, 00:00:03
148.0095
УКХ р/м управління підрозділу зі складу 24 мсп 70 мсд (р-н Часів Яр)
НВ
НВ

— Удачи Океану, еще 2 прилета, азимут 290.
— Удача принял."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some(
                "— Удачи Океану, еще 2 прилета, азимут 290.\n— Удача принял."
                    .to_string()
            )
        );
    }

    #[test]
    fn eject_body_keeps_number_dot_lines_without_frequency() {
        let input = r#"23:57
31.12.2025
шр мсб 85 омсбр
р-н Соледар-Васюківка-Миколаївка
1. Штиль, Штиль, Бирюк на приеме, говори.
1. Штиль, да, принял."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some(
                "1. Штиль, Штиль, Бирюк на приеме, говори.\n1. Штиль, да, принял.".to_string()
            )
        );
    }

    #[test]
    fn eject_body_keeps_dialogue_with_parentheses_line() {
        let input = r#"01.01.2026, 00:00:28
159.3900
УКХ р/м управління 1 мсб 255 мсп 20 мсд (р-н НОВООЛЕНІВКА - РУСИН ЯР)
ЧИЖ (2551387)
МАЙОР (5513156)

1 —  Майор, Майор, я Чиж, на приеме.
2 —  (...)
1 —  Да, плюс,да плюс."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some(
                "1 —  Майор, Майор, я Чиж, на приеме.\n2 —  (...)\n1 —  Да, плюс,да плюс.".to_string()
            )
        );
    }

    #[test]
    fn eject_body_returns_none_when_no_message_body_exists_case_one() {
        let input = r#"01.01.2026 0:01:09
148.310
x:53-48839
y:73-71279
37U CP 70970 46277
Пд.Мирноград"#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, None);
    }

    #[test]
    fn eject_body_returns_none_for_numeric_line_without_long_dash() {
        let input = r#"148310"#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, None);
    }

    #[test]
    fn eject_body_returns_none_when_only_metadata_exists_case_two() {
        let input = r#"Частота: 155.126(МГц)
Локація: ПдСх Рівне
Підрозділ: УКХ р/м НВ підрозділу
Координати: 37U CP 68638 49448


Дата: 01.01.2026
Час: 00:05:34"#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, None);
    }

    #[test]
    fn eject_body_returns_none_when_len_less_than_two() {
        let input = r#"—"#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, None);
    }

    #[test]
    fn eject_body_keeps_lines_with_double_hyphen_prefix() {
        let input = r#"01.01.2026, 00:00:42
148.1261
-- Тихий я Кормушка доложи обстановку
-- Тихий, Тихий на связь."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(
            output,
            Some(
                "-- Тихий я Кормушка доложи обстановку\n-- Тихий, Тихий на связь.".to_string()
            )
        );
    }

    #[test]
    fn eject_body_keeps_lines_with_double_hyphen_without_space() {
        let input = r#"01.01.2026, 00:00:42
148.1261
--Морган плюс.
--Принял."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, Some("--Морган плюс.\n--Принял.".to_string()));
    }

    #[test]
    fn eject_body_filters_separator_lines_of_dashes() {
        let input = r#"--------------------------------------------
————————————————————
--Морган плюс."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, Some("--Морган плюс.".to_string()));
    }

    #[test]
    fn eject_body_when_message_has_header_with_numbers_and_callsigns() {
        let input = r#"КУЗЯ
42-Й, 651-Й, 78-Й

— 42, 42, Кузя по постам 0 8.
— Кузя, Кузя, 42 принял.
— 7 8, 7 8, я 6 5 1, по постам 0 8.
— Я 7 8, принял."#;

        let output = eject_body_from_message(input.to_string());

        assert_eq!(output, Some("— 42, 42, Кузя по постам 0 8.\n— Кузя, Кузя, 42 принял.\n— 7 8, 7 8, я 6 5 1, по постам 0 8.\n— Я 7 8, принял.".to_string()));
    }

    // Tests: Keep full message body
    #[test]
    fn select_report_message_body_falls_back_to_full_message_when_trimmed_empty(
    ) {
        let input = r#"01.01.2026 0:01:09
148.310
x:53-48839
y:73-71279
37U CP 70970 46277
Пд.Мирноград"#;

        let output = select_report_message_body(input, false).unwrap();

        assert_eq!(output, input.to_string());
    }

    #[test]
    fn select_report_message_body_keeps_full_message_when_flag_is_on() {
        let input = r#"01.01.2026, 00:00:42
148.1261
УКХ р/м управління шр 89 тп
1 — Тихий я Кормушка доложи обстановку"#;

        let output = select_report_message_body(input, true).unwrap();

        assert_eq!(output, input.to_string());
    }

    #[test]
    fn interception_report_row_limit_allows_excel_max_data_rows() {
        assert!(ensure_interception_report_row_limit(
            &uuid::Uuid::nil(),
            XLSX_WORKSHEET_ROW_MAX - 1
        )
        .is_ok());
    }

    #[test]
    fn interception_report_row_limit_rejects_overflow() {
        assert!(ensure_interception_report_row_limit(
            &uuid::Uuid::nil(),
            XLSX_WORKSHEET_ROW_MAX
        )
        .is_err());
    }
}
