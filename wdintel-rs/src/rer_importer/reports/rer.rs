use crate::config::RER_REPORT_OTHER_TAG_LABEL;
use crate::delta::bgtask_log;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::info;
use crate::location::utils::to_location_list;
use crate::rer_importer::inbox::query::build_filtered_inbox_query;
use crate::rer_importer::report_chunking::{
    inbox_report_chunk_req, inbox_report_period_chunks, ReportPeriodEnd,
};
use crate::rer_importer::reports::types::ReportPreviewReq;
use crate::types::{Env, ShortContext};
use crate::utils::{dt_from_millis, dt_zoned_from_millis};
use anyhow::Context;
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, Utc};
use docx_rs::{
    AlignmentType, BreakType, Docx, LineSpacing, PageMargin, Paragraph, Run,
    RunFonts,
};
use log::error;
use sea_orm::sea_query::{
    extension::postgres::PgExpr, Alias, Expr, ExprTrait, SimpleExpr,
};
use sea_orm::*;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

const DOCX_FONT: &str = "Times New Roman";
const DOCX_FONT_SIZE: usize = 30;
const DOCX_LINE_SPACING: i32 = 360;
const DOCX_HEADING_LINE_SPACING: i32 = 480;
const DOCX_HEADING_SPACE_AFTER: u32 = 240;
const DOCX_A4_WIDTH: u32 = 11906;
const DOCX_A4_HEIGHT: u32 = 16838;
const DOCX_PAGE_MARGIN_20MM: i32 = 1134;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
struct UnitPath(Vec<String>);

impl UnitPath {
    fn parent_path(&self) -> UnitPath {
        UnitPath(vec![self.0[0].clone()])
    }

    fn is_same_or_parent_of(&self, other: &UnitPath) -> bool {
        self.0.len() <= other.0.len()
            && self
                .0
                .iter()
                .zip(other.0.iter())
                .all(|(left, right)| left == right)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct UnitIdentity {
    path: UnitPath,
    parent_name: String,
    unit_name: String,
}

#[derive(Clone, Debug)]
struct ItemUnitCandidate {
    identity: UnitIdentity,
    network_location: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedItemUnit {
    identity: UnitIdentity,
    locations: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ItemUnitResolution {
    None,
    Target(ResolvedItemUnit),
    Conflict(Vec<UnitIdentity>),
}

#[derive(Clone, Debug)]
struct RerReportMessage {
    timestamp: NaiveDateTime,
    comment: String,
    body: String,
    points: BTreeSet<String>,
}

#[derive(Clone, Debug)]
struct UnitSection {
    identity: UnitIdentity,
    locations: BTreeSet<String>,
    callsigns: BTreeSet<String>,
    messages: BTreeMap<i64, RerReportMessage>,
}

#[derive(Clone, Debug)]
struct ParentSection {
    name: String,
    units: BTreeMap<UnitPath, UnitSection>,
}

#[derive(Clone, Debug, Default)]
struct RerReport {
    parents: BTreeMap<UnitPath, ParentSection>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SposobReportMessage {
    timestamp: NaiveDateTime,
    body: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SposobReportDay {
    date: NaiveDate,
    messages: Vec<SposobReportMessage>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SposobReportContent {
    unit_heading: String,
    days: Vec<SposobReportDay>,
}

#[derive(Clone, Debug, Default)]
struct SposobReport {
    unit_name: String,
    messages: BTreeMap<i64, SposobReportMessage>,
}

pub async fn report_docx_kind_rer(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
    bgtask_id: Option<i64>,
) -> Result<String, AppError> {
    let report = load_report(user_login, env, req, bgtask_id).await.c(h!())?;
    let report_till = format_report_till(req).c(h!())?;
    write_report_docx(&report, &report_till, outpath).c(h!())?;
    Ok(rer_report_filename(&report_till))
}

pub async fn report_docx_kind_sposob(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    outpath: &Path,
    _bgtask_id: Option<i64>,
) -> Result<String, AppError> {
    let report = load_sposob_report(user_login, env, req).await.c(h!())?;
    let (start_date, _end_date) = sposob_report_date_range(&report, req)?;
    write_sposob_report_docx(&report, start_date, outpath).c(h!())?;
    sposob_report_filename(&report, req)
}

fn write_report_docx(
    report: &RerReport,
    report_till: &str,
    outpath: &Path,
) -> Result<(), AppError> {
    let mut docx = Docx::new()
        .page_size(DOCX_A4_WIDTH, DOCX_A4_HEIGHT)
        .page_margin(
            PageMargin::new()
                .top(DOCX_PAGE_MARGIN_20MM)
                .right(DOCX_PAGE_MARGIN_20MM)
                .bottom(DOCX_PAGE_MARGIN_20MM)
                .left(DOCX_PAGE_MARGIN_20MM),
        )
        .default_size(DOCX_FONT_SIZE)
        .default_fonts(
            RunFonts::new()
                .ascii(DOCX_FONT)
                .east_asia(DOCX_FONT)
                .cs(DOCX_FONT),
        )
        .add_paragraph(title_paragraph("Звіт", true, false))
        .add_paragraph(title_paragraph(
            "Про результати аналізу радіоперехоплень",
            false,
            false,
        ))
        .add_paragraph(title_paragraph(
            &format!("станом на {report_till}"),
            false,
            true,
        ));

    for parent in report.parents.values() {
        docx = docx.add_paragraph(text_paragraph(
            &parent.name,
            true,
            false,
            AlignmentType::Center,
            true,
        ));

        for section in parent.units.values() {
            docx = docx
                .add_paragraph(text_paragraph(
                    &format_unit_heading(&section.identity, &section.locations),
                    true,
                    false,
                    AlignmentType::Left,
                    false,
                ))
                .add_paragraph(labelled_paragraph(
                    "Позивні: ",
                    &join_set_comma(&section.callsigns),
                ));
            let points = section
                .messages
                .values()
                .flat_map(|message| message.points.iter().cloned())
                .collect::<BTreeSet<_>>();
            docx = docx
                .add_paragraph(labelled_paragraph(
                    "Точки: ",
                    &join_set_semicolon(&points),
                ))
                .add_paragraph(blank_paragraph())
                .add_paragraph(blank_paragraph());

            let mut messages = section.messages.values().collect::<Vec<_>>();
            messages.sort_by_key(|message| message.timestamp);
            for message in messages {
                docx = docx
                    .add_paragraph(text_paragraph(
                        &format_message_heading(message),
                        false,
                        false,
                        AlignmentType::Left,
                        false,
                    ))
                    .add_paragraph(blank_paragraph())
                    .add_paragraph(text_paragraph(
                        &message.body,
                        false,
                        true,
                        AlignmentType::Left,
                        false,
                    ))
                    .add_paragraph(blank_paragraph())
                    .add_paragraph(blank_paragraph())
                    .add_paragraph(blank_paragraph());
            }
        }
    }

    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).c(h!())?;
    Ok(())
}

fn write_sposob_report_docx(
    report: &SposobReport,
    fallback_date: NaiveDate,
    outpath: &Path,
) -> Result<(), AppError> {
    let content = build_sposob_report_content(report, fallback_date);
    let mut docx = Docx::new()
        .page_size(DOCX_A4_WIDTH, DOCX_A4_HEIGHT)
        .page_margin(
            PageMargin::new()
                .top(DOCX_PAGE_MARGIN_20MM)
                .right(DOCX_PAGE_MARGIN_20MM)
                .bottom(DOCX_PAGE_MARGIN_20MM)
                .left(DOCX_PAGE_MARGIN_20MM),
        )
        .default_size(DOCX_FONT_SIZE)
        .default_fonts(
            RunFonts::new()
                .ascii(DOCX_FONT)
                .east_asia(DOCX_FONT)
                .cs(DOCX_FONT),
        )
        .add_paragraph(text_paragraph(
            &content.unit_heading,
            true,
            false,
            AlignmentType::Left,
            false,
        ));

    for day in &content.days {
        docx = docx.add_paragraph(sposob_date_paragraph(day.date));
        for message in &day.messages {
            docx = docx
                .add_paragraph(text_paragraph(
                    &format_sposob_message(message),
                    false,
                    false,
                    AlignmentType::Left,
                    false,
                ))
                .add_paragraph(blank_paragraph());
        }
    }

    let file = std::fs::File::create(outpath)?;
    docx.build().pack(file).c(h!())?;
    Ok(())
}

fn build_sposob_report_content(
    report: &SposobReport,
    fallback_date: NaiveDate,
) -> SposobReportContent {
    let mut messages = report.messages.values().cloned().collect::<Vec<_>>();
    messages.sort_by_key(|message| message.timestamp);

    let mut days: Vec<SposobReportDay> = Vec::new();
    for message in messages {
        let date = message.timestamp.date();
        if let Some(day) = days.last_mut().filter(|day| day.date == date) {
            day.messages.push(message);
        } else {
            days.push(SposobReportDay {
                date,
                messages: vec![message],
            });
        }
    }
    if days.is_empty() {
        days.push(SposobReportDay {
            date: fallback_date,
            messages: vec![],
        });
    }

    SposobReportContent {
        unit_heading: report.unit_name.clone(),
        days,
    }
}

#[cfg(test)]
fn format_sposob_report_content_text(content: &SposobReportContent) -> String {
    let mut parts = vec![content.unit_heading.clone()];
    for day in &content.days {
        parts.push(day.date.format("%Y-%m-%d").to_string());
        for message in &day.messages {
            parts.push(format_sposob_message(message));
            parts.push(String::new());
        }
    }
    parts.join("\n")
}

async fn load_report(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    bgtask_id: Option<i64>,
) -> Result<RerReport, AppError> {
    let dbx = &env.dbx;
    let item_ids = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "RER report candidate scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &req.req,
        ),
        |db| async move {
            load_candidate_item_ids(&db, user_login, env, req, true, true).await
        },
        |db| async move {
            load_candidate_item_ids(&db, user_login, env, req, true, true).await
        },
    )
    .await
    .c(h!())?;
    let callsigns_by_item_id =
        crate::inbox::callsigns::load_by_item_ids(dbx, &item_ids).await?;
    let blacklist = crate::sigint::comments::load_blacklist(dbx).await?;
    let mut report = RerReport::default();
    for item_id in item_ids {
        if item_has_other_tag(dbx, item_id).await.c(h!())? {
            continue;
        }
        let Some(item) = sigint_inbox_item::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(message) = signal_message::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(timestamp) = report_message_timestamp(&item, &message) else {
            continue;
        };
        let comments = load_non_empty_comments(dbx, item_id, &blacklist)
            .await
            .c(h!())?;
        if comments.is_empty() {
            continue;
        }
        let candidates =
            load_item_unit_candidates(dbx, item_id, req).await.c(h!())?;
        let Some(target) =
            resolve_item_unit(dbx, bgtask_id, "РЕР Звіт", item_id, &candidates)
                .await
                .c(h!())?
        else {
            continue;
        };
        let callsigns = callsigns_by_item_id
            .get(&item_id)
            .cloned()
            .unwrap_or_default()
            .effective();
        insert_report_message(
            &mut report,
            target,
            item_id,
            timestamp,
            comments.join("; "),
            message_body_without_duplicate_comments(
                &message, &comments, &blacklist,
            )
            .c(h!())?,
            parse_callsigns(&callsigns),
            parse_points(&item),
        );
    }
    Ok(report)
}

async fn load_sposob_report(
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
) -> Result<SposobReport, AppError> {
    let dbx = &env.dbx;
    let unit_name = sposob_report_unit_name(req)?;
    let item_ids = crate::rer_importer::analysis::with_analytics_read_fallback(
        env,
        "Sposob report candidate scan",
        crate::rer_importer::analysis::analytics_inbox_request_supported(
            &req.req,
        ),
        |db| async move {
            load_candidate_item_ids(&db, user_login, env, req, false, false)
                .await
        },
        |db| async move {
            load_candidate_item_ids(&db, user_login, env, req, false, false)
                .await
        },
    )
    .await
    .c(h!())?;
    let mut report = SposobReport {
        unit_name,
        messages: BTreeMap::new(),
    };
    for item_id in item_ids {
        let Some(item) = sigint_inbox_item::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(message) = signal_message::Entity::find_by_id(item_id)
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        let Some(timestamp) = sposob_report_message_timestamp(&item) else {
            continue;
        };
        insert_sposob_report_message(
            &mut report,
            item_id,
            timestamp,
            sposob_message_body_without_headers(&item, &message).c(h!())?,
        );
    }
    Ok(report)
}

fn insert_report_message(
    report: &mut RerReport,
    target: ResolvedItemUnit,
    item_id: i64,
    timestamp: NaiveDateTime,
    comment: String,
    body: String,
    callsigns: Vec<String>,
    points: Vec<String>,
) {
    let parent_path = target.identity.path.parent_path();
    let parent =
        report
            .parents
            .entry(parent_path)
            .or_insert_with(|| ParentSection {
                name: target.identity.parent_name.clone(),
                units: BTreeMap::new(),
            });
    let section = parent
        .units
        .entry(target.identity.path.clone())
        .or_insert_with(|| UnitSection {
            identity: target.identity.clone(),
            locations: BTreeSet::new(),
            callsigns: BTreeSet::new(),
            messages: BTreeMap::new(),
        });
    section.locations.extend(target.locations);
    section.callsigns.extend(callsigns);
    section
        .messages
        .entry(item_id)
        .and_modify(|message| {
            message.points.extend(points.iter().cloned());
            if !comment.is_empty() && message.comment.find(&comment).is_none() {
                message.comment = [message.comment.as_str(), comment.as_str()]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("; ");
            }
        })
        .or_insert_with(|| RerReportMessage {
            timestamp,
            comment,
            body,
            points: points.into_iter().collect(),
        });
}

fn insert_sposob_report_message(
    report: &mut SposobReport,
    item_id: i64,
    timestamp: NaiveDateTime,
    body: String,
) {
    report
        .messages
        .entry(item_id)
        .or_insert_with(|| SposobReportMessage { timestamp, body });
}

async fn load_candidate_item_ids(
    dbx: &DatabaseConnection,
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    require_network_link: bool,
    require_non_empty_comments: bool,
) -> Result<Vec<i64>, AppError> {
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks =
        inbox_report_period_chunks(&req.req, report_settings.chunking_hours)
            .context(h!())?;
    let mut item_ids = BTreeSet::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "RER report candidate chunk {}/{}: {}..{} ({:?})",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms,
            chunk.end
        );
        let mut chunk_req = req.clone();
        chunk_req.req = inbox_report_chunk_req(&req.req, chunk);
        item_ids.extend(
            load_candidate_item_ids_chunk(
                dbx,
                user_login,
                env,
                &chunk_req,
                chunk.end,
                require_network_link,
                require_non_empty_comments,
            )
            .await
            .context(h!())?,
        );
    }
    Ok(item_ids.into_iter().collect())
}

async fn load_candidate_item_ids_chunk(
    dbx: &DatabaseConnection,
    user_login: &uuid::Uuid,
    env: &Env,
    req: &ReportPreviewReq,
    period_end: ReportPeriodEnd,
    require_network_link: bool,
    require_non_empty_comments: bool,
) -> Result<Vec<i64>, AppError> {
    let (candidate_req, since_ms, till_ms) =
        candidate_query_req_without_date_bounds(req);
    let query =
        build_filtered_inbox_query(dbx, user_login, env, &candidate_req)
            .await
            .c(h!())?;
    let query = apply_candidate_item_filters(
        query,
        since_ms,
        till_ms,
        period_end,
        require_network_link,
        require_non_empty_comments,
    )?;

    Ok(query
        .select_only()
        .distinct()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?)
}

fn apply_candidate_item_filters(
    mut query: Select<signal_message::Entity>,
    since_ms: Option<i64>,
    till_ms: Option<i64>,
    period_end: ReportPeriodEnd,
    require_network_link: bool,
    require_non_empty_comments: bool,
) -> Result<Select<signal_message::Entity>, AppError> {
    let candidate_timestamp = candidate_report_timestamp_expr();
    if let Some(since_ms) = since_ms {
        query = query.filter(
            candidate_timestamp
                .clone()
                .gte(dt_from_millis(since_ms).context(h!())?),
        );
    }
    if let Some(till_ms) = till_ms {
        query = match period_end {
            ReportPeriodEnd::Inclusive => query.filter(
                candidate_timestamp.lte(dt_from_millis(till_ms).context(h!())?),
            ),
            ReportPeriodEnd::NonInclusive => query.filter(
                candidate_timestamp.lt(dt_from_millis(till_ms).context(h!())?),
            ),
        };
    }
    if require_network_link {
        query = query.filter(item_network_link_exists());
    }
    if require_non_empty_comments {
        query = query.filter(non_empty_comment_exists());
    }
    Ok(query)
}

fn candidate_query_req_without_date_bounds(
    req: &ReportPreviewReq,
) -> (
    crate::rer_importer::InboxMessagesReq,
    Option<i64>,
    Option<i64>,
) {
    let mut candidate_req = req.req.clone();
    let since_ms = candidate_req.since_date_inclusive_ms.take();
    let till_ms = candidate_req.till_date_inclusive_ms.take();
    if since_ms.is_some() && candidate_req.since_id_noninclusive.is_none() {
        candidate_req.since_id_noninclusive = Some(0);
    }
    (candidate_req, since_ms, till_ms)
}

fn candidate_report_timestamp_expr() -> SimpleExpr {
    Expr::cust(
        r#"COALESCE("sigint_inbox_item"."datetime", "signal_message"."timestamp")"#,
    )
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
    let linked_message = Alias::new("linked_message");
    let subquery = intel_prod::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(
            intel_prod::Column::RelationKind
                .eq(intel_prod::RELATION_KIND_COMMENT),
        )
        .join_as(
            JoinType::InnerJoin,
            intel_prod::Relation::SignalMessage1.def(),
            linked_message.clone(),
        )
        .filter(
            Expr::col((
                intel_prod::Entity,
                intel_prod::Column::ParentSignalMessageId,
            ))
            .equals((signal_message::Entity, signal_message::Column::Id)),
        )
        .filter(
            Expr::col((
                linked_message.clone(),
                signal_message::Column::Deleted,
            ))
            .eq(false),
        )
        .filter(
            Expr::col((linked_message, signal_message::Column::Body)).ne(""),
        )
        .into_query();

    let legacy_subquery = sigint_comment::Entity::find()
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
        .filter(sigint_comment::Column::Comment.ne(""))
        .into_query();

    Expr::exists(subquery).or(Expr::exists(legacy_subquery))
}

async fn load_non_empty_comments(
    dbx: &DatabaseConnection,
    item_id: i64,
    blacklist: &[String],
) -> Result<Vec<String>, AppError> {
    let comments =
        crate::sigint::comments::find_linked_message_comments(dbx, &[item_id])
            .await?
            .into_iter()
            .map(|comment| comment.comment)
            .collect();
    Ok(filter_report_comments(comments, blacklist))
}

fn filter_report_comments(
    comments: Vec<String>,
    blacklist: &[String],
) -> Vec<String> {
    comments
        .into_iter()
        .filter_map(|comment| {
            crate::sigint::parser::filter_blacklisted_comment(
                Some(comment),
                blacklist,
            )
        })
        .collect()
}

fn report_message_timestamp(
    item: &sigint_inbox_item::Model,
    message: &signal_message::Model,
) -> Option<NaiveDateTime> {
    item.datetime
        .or(message.timestamp)
        .map(utc_naive_to_kyiv_naive)
}

fn sposob_report_message_timestamp(
    item: &sigint_inbox_item::Model,
) -> Option<NaiveDateTime> {
    item.datetime.map(utc_naive_to_kyiv_naive)
}

fn utc_naive_to_kyiv_naive(datetime: NaiveDateTime) -> NaiveDateTime {
    DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc)
        .with_timezone(&crate::types::Kyiv)
        .naive_local()
}

fn message_body_without_headers(
    message: &signal_message::Model,
) -> Result<String, AppError> {
    let body = message.body.clone().unwrap_or_default();
    if let Some(meow_format) = crate::rer_importer::meow_format::parse(
        chrono::Utc::now().with_timezone(&crate::config::get_tz()),
        &body,
    ) {
        return Ok(meow_format.body_noheader.body);
    }
    Ok(crate::rer_importer::body_noheader::extract_text(&body)
        .c(h!())?
        .body)
}

fn message_body_without_duplicate_comments(
    message: &signal_message::Model,
    comments: &[String],
    blacklist: &[String],
) -> Result<String, AppError> {
    let body = message_body_without_headers(message).c(h!())?;
    let comments = parsed_report_comments(message, comments, blacklist);
    if comments.is_empty() {
        return Ok(body);
    }
    Ok(strip_comment_blocks(&body, &comments))
}

fn parsed_report_comments(
    message: &signal_message::Model,
    comments: &[String],
    blacklist: &[String],
) -> Vec<String> {
    let body = message.body.as_deref().unwrap_or_default();
    let parsed =
        crate::sigint::parser::parse_comments_with_blacklist(body, blacklist);
    let comments: HashSet<String> = comments
        .iter()
        .map(|comment| normalize_report_comment_text(comment))
        .filter(|comment| !comment.is_empty())
        .collect();
    let marker_candidates: HashSet<String> =
        crate::sigint::parser::marker_comment_strip_candidates(body, blacklist)
            .into_iter()
            .map(|comment| normalize_report_comment_text(&comment))
            .filter(|comment| !comment.is_empty())
            .collect();
    let mut out = Vec::new();
    for comment in [parsed.top, parsed.bottom].into_iter().flatten() {
        let comment = normalize_report_comment_text(&comment);
        if !comments.contains(&comment) {
            continue;
        }
        if marker_candidates.contains(&comment) {
            out.extend(marker_candidates.iter().cloned());
        } else {
            out.push(comment);
        }
    }
    out.sort();
    out.dedup();
    out
}

fn strip_comment_blocks(body: &str, comments: &[String]) -> String {
    let comments: HashSet<String> = comments.iter().cloned().collect();
    split_text_blocks(body)
        .into_iter()
        .filter(|block| {
            !comments.contains(&normalize_report_comment_text(block))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn split_text_blocks(body: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut block = Vec::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            if !block.is_empty() {
                blocks.push(block.join("\n"));
                block.clear();
            }
        } else {
            block.push(line.trim());
        }
    }
    if !block.is_empty() {
        blocks.push(block.join("\n"));
    }
    blocks
}

fn normalize_report_comment_text(text: &str) -> String {
    let mut text = text.trim().to_string();
    loop {
        let before = text.len();
        while text.ends_with(';') || text.ends_with('.') {
            text = text[..text.len() - 1].trim_end().to_string();
        }
        for (open, close) in [('"', '"'), ('«', '»'), ('(', ')')] {
            if text.starts_with(open)
                && text.ends_with(close)
                && text.chars().count() > 1
            {
                text = text[open.len_utf8()..text.len() - close.len_utf8()]
                    .trim()
                    .to_string();
            }
        }
        if text.len() == before {
            break;
        }
    }
    text
}

fn sposob_message_body_without_headers(
    item: &sigint_inbox_item::Model,
    message: &signal_message::Model,
) -> Result<String, AppError> {
    if let Some(body_noheader) = &item.body_noheader {
        let body_noheader = serde_json::from_value::<
            crate::rer_importer::body_noheader::NoHeadersBody,
        >(body_noheader.clone())
        .c(h!())?;
        return Ok(body_noheader.body);
    }
    message_body_without_headers(message)
}

pub(crate) fn sposob_report_unit_name(
    req: &ReportPreviewReq,
) -> Result<String, AppError> {
    let unit_name = req
        .sposob_unit_name
        .as_deref()
        .map(str::trim)
        .filter(|unit_name| !unit_name.is_empty())
        .ok_or_else(|| AppError::BL {
            msg: "Для звіту Способ потрібно вказати назву підрозділу"
                .to_string(),
        })?;
    Ok(unit_name.to_string())
}

async fn load_item_unit_candidates(
    dbx: &DatabaseConnection,
    item_id: i64,
    req: &ReportPreviewReq,
) -> Result<Vec<ItemUnitCandidate>, AppError> {
    let networks = load_item_networks(dbx, item_id, req).await.c(h!())?;
    let mut candidates = vec![];
    for network in networks {
        let units = load_network_units(dbx, network.id).await.c(h!())?;
        for unit in units {
            let Some(identity) = unit_identity(&unit) else {
                continue;
            };
            candidates.push(ItemUnitCandidate {
                identity,
                network_location: network.location.clone(),
            });
        }
    }
    Ok(candidates)
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

async fn load_network_units(
    dbx: &DatabaseConnection,
    network_id: i64,
) -> Result<Vec<sigint_unit::Model>, AppError> {
    Ok(sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .order_by_asc(sigint_unit::Column::Name)
        .all(dbx)
        .await
        .c(h!())?)
}

async fn item_has_other_tag(
    dbx: &DatabaseConnection,
    item_id: i64,
) -> Result<bool, AppError> {
    let count = sigint_inbox_item_tag::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_tag::Relation::Tag.def(),
        )
        .filter(sigint_inbox_item_tag::Column::SigintInboxItemId.eq(item_id))
        .filter(
            Expr::col((tag::Entity, tag::Column::Label))
                .ilike(RER_REPORT_OTHER_TAG_LABEL),
        )
        .count(dbx)
        .await
        .c(h!())?;
    Ok(count > 0)
}

async fn resolve_item_unit(
    dbx: &DatabaseConnection,
    bgtask_id: Option<i64>,
    report_name: &str,
    item_id: i64,
    candidates: &[ItemUnitCandidate],
) -> Result<Option<ResolvedItemUnit>, AppError> {
    match resolve_item_unit_candidates(candidates) {
        ItemUnitResolution::None => Ok(None),
        ItemUnitResolution::Target(target) => Ok(Some(target)),
        ItemUnitResolution::Conflict(identities) => {
            log_unrelated_unit_conflict(
                dbx,
                bgtask_id,
                report_name,
                item_id,
                &identities,
            )
            .await
            .c(h!())?;
            Ok(None)
        }
    }
}

fn resolve_item_unit_candidates(
    candidates: &[ItemUnitCandidate],
) -> ItemUnitResolution {
    let identities = candidates
        .iter()
        .map(|candidate| {
            (candidate.identity.path.clone(), candidate.identity.clone())
        })
        .collect::<BTreeMap<_, _>>();
    if identities.is_empty() {
        return ItemUnitResolution::None;
    }

    let retained = identities
        .values()
        .filter(|identity| {
            !identities.keys().any(|candidate_path| {
                candidate_path != &identity.path
                    && candidate_path.is_same_or_parent_of(&identity.path)
            })
        })
        .cloned()
        .collect::<Vec<_>>();

    if retained.len() != 1 {
        return ItemUnitResolution::Conflict(retained);
    }

    let identity = retained.into_iter().next().unwrap();
    let locations = candidates
        .iter()
        .filter(|candidate| {
            identity.path.is_same_or_parent_of(&candidate.identity.path)
        })
        .map(|candidate| candidate.network_location.trim().to_string())
        .filter(|location| !location.is_empty())
        .collect::<BTreeSet<_>>();

    ItemUnitResolution::Target(ResolvedItemUnit {
        identity,
        locations,
    })
}

async fn log_unrelated_unit_conflict(
    dbx: &DatabaseConnection,
    bgtask_id: Option<i64>,
    report_name: &str,
    item_id: i64,
    identities: &[UnitIdentity],
) -> Result<(), AppError> {
    let units = identities
        .iter()
        .map(format_unit_identity)
        .collect::<Vec<_>>()
        .join("; ");
    let message = format!(
        "{report_name}: пропущено перехоплення #{item_id}, повʼязане з неповʼязаними підрозділами: {units}"
    );
    error!("{message}");
    bgtask_log(bgtask_id, &message, dbx).await.c(h!())?;
    Ok(())
}

fn unit_identity(unit: &sigint_unit::Model) -> Option<UnitIdentity> {
    let hierarchy_segments = [
        unit.army.as_str(),
        unit.division.as_str(),
        unit.regiment.as_str(),
        unit.battalion.as_str(),
        unit.company.as_str(),
    ]
    .into_iter()
    .map(str::trim)
    .filter(|segment| !segment.is_empty())
    .map(ToString::to_string)
    .collect::<Vec<_>>();
    let segments = if hierarchy_segments.is_empty() {
        [unit.name.as_str()]
            .into_iter()
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    } else {
        hierarchy_segments
    };
    if segments.is_empty() {
        return None;
    }
    let parent_name = segments[0].clone();
    let unit_name = if segments.len() == 1 {
        segments[0].clone()
    } else {
        segments[1..].join(" ")
    };
    Some(UnitIdentity {
        path: UnitPath(segments),
        parent_name,
        unit_name,
    })
}

fn parse_callsigns(callsigns: &[String]) -> Vec<String> {
    callsigns
        .iter()
        .map(|callsign| callsign.trim().to_uppercase())
        .filter(|callsign| !callsign.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn parse_points(item: &sigint_inbox_item::Model) -> Vec<String> {
    let mut points = BTreeSet::new();
    if let Some(coords) = &item.coords {
        insert_non_empty(&mut points, coords);
    }
    if let Some(location_v2) = &item.location_v2 {
        for location in to_location_list(location_v2) {
            insert_non_empty(&mut points, &location);
        }
    }
    points.into_iter().collect()
}

fn format_report_till(req: &ReportPreviewReq) -> Result<String, AppError> {
    let till_dt = match req.req.till_date_inclusive_ms {
        Some(ms) => dt_zoned_from_millis(ms).c(h!())?.naive_local(),
        None => chrono::Utc::now()
            .with_timezone(&chrono_tz::Europe::Kyiv)
            .naive_local(),
    };
    Ok(format!(
        "{} {}",
        till_dt.format("%H.%M"),
        till_dt.format("%d.%m.%Y")
    ))
}

fn rer_report_filename(report_till: &str) -> String {
    sanitize_report_filename(&format!(
        "Звіт про результати аналізу радіоперехоплень станом на {report_till}.docx"
    ))
}

fn format_unit_heading(
    identity: &UnitIdentity,
    locations: &BTreeSet<String>,
) -> String {
    let names = if identity.parent_name == identity.unit_name {
        identity.unit_name.clone()
    } else {
        format!("{} {}", identity.unit_name, identity.parent_name)
    };
    if locations.is_empty() {
        names
    } else {
        format!("{names}: р-н {}", join_set_comma(locations))
    }
}

fn format_unit_identity(identity: &UnitIdentity) -> String {
    if identity.parent_name == identity.unit_name {
        identity.unit_name.clone()
    } else {
        format!("{} {}", identity.unit_name, identity.parent_name)
    }
}

fn format_message_heading(message: &RerReportMessage) -> String {
    let time = message.timestamp.format("%H:%M").to_string();
    if message.comment.trim().is_empty() {
        time
    } else {
        format!("{time} {}", message.comment)
    }
}

fn format_sposob_message(message: &SposobReportMessage) -> String {
    format!("{}\n{}", message.timestamp.format("%H-%M-%S"), message.body)
}

fn sposob_date_paragraph(date: NaiveDate) -> Paragraph {
    text_paragraph(
        &date.format("%Y-%m-%d").to_string(),
        true,
        false,
        AlignmentType::Left,
        false,
    )
}

fn sposob_report_date_range(
    report: &SposobReport,
    req: &ReportPreviewReq,
) -> Result<(NaiveDate, NaiveDate), AppError> {
    let mut dates = report
        .messages
        .values()
        .map(|message| message.timestamp.date())
        .collect::<Vec<_>>();
    dates.sort();
    if let (Some(start), Some(end)) = (dates.first(), dates.last()) {
        return Ok((*start, *end));
    }

    let start_date = req
        .req
        .since_date_inclusive_ms
        .map(sposob_req_date)
        .transpose()?;
    let end_date = req
        .req
        .till_date_inclusive_ms
        .map(sposob_req_date)
        .transpose()?;
    let today = Utc::now().with_timezone(&crate::types::Kyiv).date_naive();
    Ok((
        start_date.or(end_date).unwrap_or(today),
        end_date.or(start_date).unwrap_or(today),
    ))
}

fn sposob_req_date(ms: i64) -> Result<NaiveDate, AppError> {
    Ok(dt_zoned_from_millis(ms).c(h!())?.date_naive())
}

fn sposob_report_filename(
    report: &SposobReport,
    req: &ReportPreviewReq,
) -> Result<String, AppError> {
    let (start_date, end_date) = sposob_report_date_range(report, req)?;
    let prefix = if report.unit_name.trim().is_empty() {
        "Способ".to_string()
    } else {
        report.unit_name.clone()
    };
    Ok(sanitize_report_filename(&format!(
        "{prefix} {}.docx",
        format_sposob_date_range(start_date, end_date)
    )))
}

fn format_sposob_date_range(
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> String {
    if start_date == end_date {
        format!("{}", start_date.format("%d.%m.%Y"))
    } else if start_date.year() == end_date.year()
        && start_date.month() == end_date.month()
    {
        format!(
            "{:02}-{:02}.{:02}.{:02}",
            start_date.day(),
            end_date.day(),
            end_date.month(),
            end_date.year() % 100
        )
    } else if start_date.year() == end_date.year() {
        format!(
            "{:02}.{:02}-{:02}.{:02}.{:02}",
            start_date.day(),
            start_date.month(),
            end_date.day(),
            end_date.month(),
            end_date.year() % 100
        )
    } else {
        format!(
            "{:02}.{:02}.{:02}-{:02}.{:02}.{:02}",
            start_date.day(),
            start_date.month(),
            start_date.year() % 100,
            end_date.day(),
            end_date.month(),
            end_date.year() % 100
        )
    }
}

fn insert_non_empty(values: &mut BTreeSet<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        values.insert(value.to_string());
    }
}

fn join_set_comma(values: &BTreeSet<String>) -> String {
    let mut values = values.iter().cloned().collect::<Vec<_>>();
    values.sort_by(|left, right| cmp_uk(left, right));
    values.join(", ")
}

fn join_set_semicolon(values: &BTreeSet<String>) -> String {
    let mut values = values.iter().cloned().collect::<Vec<_>>();
    values.sort_by(|left, right| cmp_uk(left, right));
    values.join("; ")
}

fn sanitize_report_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            ch if ch.is_control() => ' ',
            ch => ch,
        })
        .collect::<String>();
    let sanitized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    if sanitized.is_empty() {
        "report.docx".to_string()
    } else {
        sanitized
    }
}

fn cmp_uk(left: &str, right: &str) -> Ordering {
    let mut left_chars = left.chars();
    let mut right_chars = right.chars();
    loop {
        match (left_chars.next(), right_chars.next()) {
            (Some(left), Some(right)) => {
                let ord = uk_char_order(left).cmp(&uk_char_order(right));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
}

fn uk_char_order(ch: char) -> (u32, char) {
    let upper = ch.to_uppercase().next().unwrap_or(ch);
    let order = match upper {
        'А' => 1,
        'Б' => 2,
        'В' => 3,
        'Г' => 4,
        'Ґ' => 5,
        'Д' => 6,
        'Е' => 7,
        'Є' => 8,
        'Ж' => 9,
        'З' => 10,
        'И' => 11,
        'І' => 12,
        'Ї' => 13,
        'Й' => 14,
        'К' => 15,
        'Л' => 16,
        'М' => 17,
        'Н' => 18,
        'О' => 19,
        'П' => 20,
        'Р' => 21,
        'С' => 22,
        'Т' => 23,
        'У' => 24,
        'Ф' => 25,
        'Х' => 26,
        'Ц' => 27,
        'Ч' => 28,
        'Ш' => 29,
        'Щ' => 30,
        'Ь' => 31,
        'Ю' => 32,
        'Я' => 33,
        _ => 1000 + upper as u32,
    };
    (order, upper)
}

fn title_paragraph(text: &str, bold: bool, italic: bool) -> Paragraph {
    text_paragraph(text, bold, italic, AlignmentType::Center, true)
}

fn text_paragraph(
    text: &str,
    bold: bool,
    italic: bool,
    alignment: AlignmentType,
    sparse_heading: bool,
) -> Paragraph {
    let spacing = if sparse_heading {
        LineSpacing::new()
            .line(DOCX_HEADING_LINE_SPACING)
            .after(DOCX_HEADING_SPACE_AFTER)
    } else {
        LineSpacing::new().line(DOCX_LINE_SPACING)
    };
    let mut paragraph = Paragraph::new().align(alignment).line_spacing(spacing);
    for (idx, line) in text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .enumerate()
    {
        if idx > 0 {
            paragraph = paragraph.add_run(
                default_run("", bold, italic)
                    .add_break(BreakType::TextWrapping),
            );
        }
        paragraph = paragraph.add_run(default_run(line, bold, italic));
    }
    paragraph
}

fn labelled_paragraph(label: &str, value: &str) -> Paragraph {
    Paragraph::new()
        .align(AlignmentType::Left)
        .line_spacing(LineSpacing::new().line(DOCX_LINE_SPACING))
        .add_run(default_run(label, true, false))
        .add_run(default_run(value, false, false))
}

fn blank_paragraph() -> Paragraph {
    Paragraph::new()
}

fn default_run(text: &str, bold: bool, italic: bool) -> Run {
    let mut run = Run::new()
        .fonts(
            RunFonts::new()
                .ascii(DOCX_FONT)
                .east_asia(DOCX_FONT)
                .cs(DOCX_FONT),
        )
        .size(DOCX_FONT_SIZE)
        .add_text(text);
    if bold {
        run = run.bold();
    }
    if italic {
        run = run.italic();
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone};
    use std::io::Read;
    use tempfile::NamedTempFile;
    use zip::ZipArchive;

    fn dt(hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 6, 27)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    fn dt_on(date: NaiveDate, hour: u32, minute: u32) -> NaiveDateTime {
        date.and_hms_opt(hour, minute, 0).unwrap()
    }

    fn signal_message(id: i64, body: &str) -> signal_message::Model {
        signal_message::Model {
            id,
            body: Some(body.to_string()),
            created_at: chrono::Utc::now().naive_utc(),
            timestamp: None,
            sender: None,
            format: None,
            deleted: false,
            external_id: None,
            echo_inbox_message_id: None,
            message_uid: None,
            datasource_group_id: None,
            operator_tags: None,
            attachments_hash: None,
        }
    }

    fn inbox_item(
        id: i64,
        datetime: Option<NaiveDateTime>,
        body_noheader: Option<serde_json::Value>,
    ) -> sigint_inbox_item::Model {
        sigint_inbox_item::Model {
            id,
            date: None,
            time: None,
            freq: None,
            coords: None,
            checked: None,
            reviewed: None,
            unit: None,
            callsign_tokens: None,
            keyword_tokens: None,
            unit_v2: None,
            lat: None,
            lng: None,
            nominatimres_id: None,
            location: None,
            tags: None,
            datetime,
            datetime_neo: datetime,
            signal_tokens: None,
            body_noheader,
            parsed_unit_v2: false,
            location_v2: None,
            post_id: None,
            device_name_id: None,
            network: None,
        }
    }

    fn unit(
        army: &str,
        division: &str,
        regiment: &str,
        battalion: &str,
        company: &str,
        name: &str,
    ) -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: company.to_string(),
            regiment: regiment.to_string(),
            brigade: String::new(),
            division: division.to_string(),
            corps: String::new(),
            army: army.to_string(),
            army_region: String::new(),
            military_district: String::new(),
            active: true,
            deleted: false,
            created_at: dt(0, 0),
            created_by_login_id: uuid::Uuid::nil(),
            name: name.to_string(),
            comment: String::new(),
            battalion: battalion.to_string(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
        }
    }

    fn candidate(identity: UnitIdentity, location: &str) -> ItemUnitCandidate {
        ItemUnitCandidate {
            identity,
            network_location: location.to_string(),
        }
    }

    fn report_preview_req_with_till(
        till_date_inclusive_ms: i64,
    ) -> ReportPreviewReq {
        ReportPreviewReq {
            kind: "rer".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                till_date_inclusive_ms: Some(till_date_inclusive_ms),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            tag_report_sort_by: None,
            report_1213_linked_networks_only: None,
            without_comments: None,
            babak_new_callsign_min_mentions: None,
            interception_keep_full_message: None,
            interception_keep_old_colors: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
            sposob_unit_name: None,
        }
    }

    #[test]
    fn candidate_query_req_removes_date_bounds_without_reenabling_default_window(
    ) {
        let req = ReportPreviewReq {
            kind: "rer".to_string(),
            req: crate::rer_importer::InboxMessagesReq {
                since_date_inclusive_ms: Some(1000),
                till_date_inclusive_ms: Some(2000),
                ..Default::default()
            },
            report_type: None,
            report_tags_only_this_unit: None,
            tag_report_sort_by: None,
            report_1213_linked_networks_only: None,
            without_comments: None,
            babak_new_callsign_min_mentions: None,
            interception_keep_full_message: None,
            interception_keep_old_colors: None,
            digest_omit_exo_id: None,
            digest_form_1_2_17: None,
            sposob_unit_name: None,
        };

        let (candidate_req, since_ms, till_ms) =
            candidate_query_req_without_date_bounds(&req);

        assert_eq!(since_ms, Some(1000));
        assert_eq!(till_ms, Some(2000));
        assert_eq!(candidate_req.since_date_inclusive_ms, None);
        assert_eq!(candidate_req.till_date_inclusive_ms, None);
        assert_eq!(candidate_req.since_id_noninclusive, Some(0));
    }

    #[test]
    fn candidate_report_timestamp_uses_datetime_then_signal_timestamp() {
        let sql = sea_orm::sea_query::Query::select()
            .expr(candidate_report_timestamp_expr())
            .to_string(sea_orm::sea_query::PostgresQueryBuilder);

        assert_eq!(
            sql,
            r#"SELECT COALESCE("sigint_inbox_item"."datetime", "signal_message"."timestamp")"#
        );
    }

    #[test]
    fn candidate_item_filters_make_network_link_optional() {
        let query_without_network = apply_candidate_item_filters(
            signal_message::Entity::find(),
            None,
            None,
            ReportPeriodEnd::Inclusive,
            false,
            false,
        )
        .unwrap();
        let sql_without_network =
            query_without_network.build(DbBackend::Postgres).to_string();

        let query_with_network = apply_candidate_item_filters(
            signal_message::Entity::find(),
            None,
            None,
            ReportPeriodEnd::Inclusive,
            true,
            false,
        )
        .unwrap();
        let sql_with_network =
            query_with_network.build(DbBackend::Postgres).to_string();

        assert!(!str::contains(
            &sql_without_network,
            "sigint_inbox_item_network"
        ));
        assert!(str::contains(
            &sql_with_network,
            "sigint_inbox_item_network"
        ));
    }

    #[test]
    fn candidate_item_filters_use_noninclusive_chunk_boundaries() {
        let query = apply_candidate_item_filters(
            signal_message::Entity::find(),
            Some(1_000),
            Some(2_000),
            ReportPeriodEnd::NonInclusive,
            false,
            false,
        )
        .unwrap();
        let sql = query.build(DbBackend::Postgres).to_string();

        assert!(str::contains(&sql, " >= "));
        assert!(str::contains(&sql, " < "));
        assert!(!str::contains(&sql, " <= "));
    }

    #[test]
    fn unit_identity_uses_highest_level_as_parent_and_lower_levels_as_unit() {
        let identity =
            unit_identity(&unit("6 А", "68 мсд", "423 мсп", "1 мсб", "", ""))
                .unwrap();

        assert_eq!(identity.parent_name, "6 А");
        assert_eq!(identity.unit_name, "68 мсд 423 мсп 1 мсб");
        assert_eq!(
            identity.path,
            UnitPath(vec![
                "6 А".to_string(),
                "68 мсд".to_string(),
                "423 мсп".to_string(),
                "1 мсб".to_string(),
            ])
        );
    }

    #[test]
    fn unit_identity_uses_hierarchy_instead_of_generated_name() {
        let identity = unit_identity(&unit(
            "6 А",
            "68 мсд",
            "423 мсп",
            "1 мсб",
            "",
            "1 мсб 423 мсп 68 мсд 6 А",
        ))
        .unwrap();

        assert_eq!(
            identity.path,
            UnitPath(vec![
                "6 А".to_string(),
                "68 мсд".to_string(),
                "423 мсп".to_string(),
                "1 мсб".to_string(),
            ])
        );
        assert_eq!(identity.unit_name, "68 мсд 423 мсп 1 мсб");
    }

    #[test]
    fn unit_identity_keeps_single_segment_as_leaf() {
        let identity =
            unit_identity(&unit("", "", "", "", "", "1843 омсб")).unwrap();

        assert_eq!(identity.parent_name, "1843 омсб");
        assert_eq!(identity.unit_name, "1843 омсб");
    }

    #[test]
    fn resolve_item_unit_candidates_deduplicates_same_unit_and_locations() {
        let identity =
            unit_identity(&unit("6 А", "68 мсд", "", "", "", "")).unwrap();
        let resolution = resolve_item_unit_candidates(&[
            candidate(identity.clone(), "район А"),
            candidate(identity.clone(), "район Б"),
        ]);

        let ItemUnitResolution::Target(target) = resolution else {
            panic!("expected target");
        };
        assert_eq!(target.identity, identity);
        assert_eq!(
            target.locations,
            BTreeSet::from(["район А".to_string(), "район Б".to_string()])
        );
    }

    #[test]
    fn resolve_item_unit_candidates_discards_child_when_parent_is_linked() {
        let parent = unit_identity(&unit("6 А", "", "", "", "", "")).unwrap();
        let child =
            unit_identity(&unit("6 А", "68 мсд", "", "", "", "")).unwrap();
        let resolution = resolve_item_unit_candidates(&[
            candidate(parent.clone(), "район штабу"),
            candidate(child, "район батальйону"),
        ]);

        let ItemUnitResolution::Target(target) = resolution else {
            panic!("expected target");
        };
        assert_eq!(target.identity, parent);
        assert_eq!(
            target.locations,
            BTreeSet::from([
                "район батальйону".to_string(),
                "район штабу".to_string(),
            ])
        );
    }

    #[test]
    fn resolve_item_unit_candidates_reports_unrelated_units() {
        let first =
            unit_identity(&unit("6 А", "68 мсд", "", "", "", "")).unwrap();
        let second =
            unit_identity(&unit("8 А", "20 мсд", "", "", "", "")).unwrap();
        let resolution = resolve_item_unit_candidates(&[
            candidate(first, "район А"),
            candidate(second, "район Б"),
        ]);

        let ItemUnitResolution::Conflict(conflicts) = resolution else {
            panic!("expected conflict");
        };
        assert_eq!(conflicts.len(), 2);
    }

    #[test]
    fn parse_points_uses_coords_and_pipe_delimited_location_v2() {
        let item = sigint_inbox_item::Model {
            id: 1,
            date: None,
            time: None,
            freq: None,
            coords: Some("48.1, 37.2".to_string()),
            checked: None,
            reviewed: None,
            unit: None,
            callsign_tokens: None,
            keyword_tokens: None,
            unit_v2: None,
            lat: None,
            lng: None,
            nominatimres_id: None,
            location: None,
            tags: None,
            datetime: None,
            datetime_neo: None,
            signal_tokens: None,
            body_noheader: None,
            parsed_unit_v2: false,
            location_v2: Some("|КУП'ЯНСЬК|СЕНЬКОВЕ|".to_string()),
            post_id: None,
            device_name_id: None,
            network: None,
        };

        assert_eq!(
            parse_points(&item),
            vec![
                "48.1, 37.2".to_string(),
                "КУП'ЯНСЬК".to_string(),
                "СЕНЬКОВЕ".to_string(),
            ]
        );
    }

    #[test]
    fn parse_callsigns_uppercases_and_deduplicates_values() {
        assert_eq!(
            parse_callsigns(&[
                "барс".to_string(),
                " БАРС ".to_string(),
                "сова".to_string(),
            ]),
            vec!["БАРС".to_string(), "СОВА".to_string()]
        );
    }

    #[test]
    fn join_set_comma_uses_ukrainian_alphabet_order() {
        let values = BTreeSet::from([
            "ДАР".to_string(),
            "ҐРУНТ".to_string(),
            "ГРАД".to_string(),
        ]);

        assert_eq!(join_set_comma(&values), "ГРАД, ҐРУНТ, ДАР");
    }

    #[test]
    fn format_report_till_uses_kyiv_time() {
        let cutoff = chrono_tz::Europe::Kyiv
            .with_ymd_and_hms(2026, 6, 27, 0, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let req = report_preview_req_with_till(cutoff);

        assert_eq!(format_report_till(&req).unwrap(), "00.30 27.06.2026");
    }

    #[test]
    fn rer_report_filename_uses_report_till() {
        assert_eq!(
            rer_report_filename("15.00 30.06.2026"),
            "Звіт про результати аналізу радіоперехоплень станом на 15.00 30.06.2026.docx"
        );
    }

    #[test]
    fn write_report_docx_renders_report_maker_text_order() {
        let identity =
            unit_identity(&unit("6 А", "68 мсд", "", "", "", "")).unwrap();
        let mut report = RerReport::default();
        insert_report_message(
            &mut report,
            ResolvedItemUnit {
                identity,
                locations: BTreeSet::from(["північ".to_string()]),
            },
            10,
            dt(9, 15),
            "важливо".to_string(),
            "Перший рядок\nДругий рядок".to_string(),
            vec!["БАРС".to_string()],
            vec!["точка А".to_string()],
        );
        let file = NamedTempFile::new().unwrap();

        write_report_docx(&report, "15.00 27.06.2026", file.path()).unwrap();

        let xml = document_xml(file.path());
        let expected_order = [
            "Звіт",
            "Про результати аналізу радіоперехоплень",
            "станом на 15.00 27.06.2026",
            "6 А",
            "68 мсд 6 А: р-н північ",
            "Позивні: ",
            "БАРС",
            "Точки: ",
            "точка А",
            "09:15 важливо",
            "Перший рядок",
            "Другий рядок",
        ];
        let mut prev_idx = 0;
        for value in expected_order {
            let idx = xml[prev_idx..].find(value).unwrap_or_else(|| {
                panic!("missing {value} after index {prev_idx}")
            }) + prev_idx;
            prev_idx = idx;
        }
        assert!(!str::contains(&xml, "Network"));
        assert!(str::contains(&xml, "<w:br"));
    }

    #[test]
    fn write_sposob_report_docx_groups_messages_by_date() {
        let mut report = SposobReport {
            unit_name: "ручний підрозділ".to_string(),
            messages: BTreeMap::new(),
        };
        report.messages.insert(
            10,
            SposobReportMessage {
                timestamp: dt(9, 15),
                body: "Перший рядок\nДругий рядок".to_string(),
            },
        );
        report.messages.insert(
            11,
            SposobReportMessage {
                timestamp: NaiveDate::from_ymd_opt(2026, 6, 28)
                    .unwrap()
                    .and_hms_opt(1, 2, 3)
                    .unwrap(),
                body: "Наступна доба".to_string(),
            },
        );
        let file = NamedTempFile::new().unwrap();

        write_sposob_report_docx(
            &report,
            NaiveDate::from_ymd_opt(2026, 6, 27).unwrap(),
            file.path(),
        )
        .unwrap();

        let xml = document_xml(file.path());
        let expected_order = [
            "ручний підрозділ",
            "2026-06-27",
            "09-15-00",
            "Перший рядок",
            "Другий рядок",
            "2026-06-28",
            "01-02-03",
            "Наступна доба",
        ];
        let mut prev_idx = 0;
        for value in expected_order {
            let idx = xml[prev_idx..].find(value).unwrap_or_else(|| {
                panic!("missing {value} after index {prev_idx}")
            }) + prev_idx;
            prev_idx = idx;
        }
        assert_blank_paragraph_after(&xml, "Другий рядок");
        assert_blank_paragraph_after(&xml, "Наступна доба");
        assert!(str::contains(&xml, "<w:br"));
    }

    #[test]
    fn sposob_report_content_uses_noheader_body_without_repeating_unit() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        let first = signal_message(10, "50 обрБпС | 2026-07-01\n06-45\nfoo");
        let second = signal_message(
            11,
            "50 обрБпС [33hhfg50d] | 2026-07-01_14-47-00\n14-47\nbar",
        );
        let mut report = SposobReport {
            unit_name: "ручний підрозділ".to_string(),
            messages: BTreeMap::new(),
        };

        insert_sposob_report_message(
            &mut report,
            first.id,
            dt_on(date, 6, 45),
            message_body_without_headers(&first).unwrap(),
        );
        insert_sposob_report_message(
            &mut report,
            second.id,
            dt_on(date, 14, 47),
            message_body_without_headers(&second).unwrap(),
        );
        let content = build_sposob_report_content(&report, date);
        let text = format_sposob_report_content_text(&content);
        println!("\n{text}");

        assert_eq!(
            text,
            "ручний підрозділ\n2026-07-01\n06-45-00\nfoo\n\n14-47-00\nbar\n"
        );
        assert!(!str::contains(&text, "50 обрБпС"));
        assert!(!str::contains(&text, "33hhfg50d"));
    }

    #[test]
    fn sposob_report_filename_uses_manual_unit_and_date_range() {
        let mut report = SposobReport {
            unit_name: "68/мсд".to_string(),
            messages: BTreeMap::new(),
        };
        report.messages.insert(
            1,
            SposobReportMessage {
                timestamp: NaiveDate::from_ymd_opt(2026, 6, 27)
                    .unwrap()
                    .and_hms_opt(1, 0, 0)
                    .unwrap(),
                body: String::new(),
            },
        );
        report.messages.insert(
            2,
            SposobReportMessage {
                timestamp: NaiveDate::from_ymd_opt(2026, 7, 1)
                    .unwrap()
                    .and_hms_opt(1, 0, 0)
                    .unwrap(),
                body: String::new(),
            },
        );
        let req = report_preview_req_with_till(0);

        assert_eq!(
            sposob_report_filename(&report, &req).unwrap(),
            "68 мсд 27.06-01.07.26.docx"
        );
    }

    #[test]
    fn sposob_report_filename_uses_single_date_for_same_day() {
        let mut report = SposobReport {
            unit_name: "1 пдб 100 дшп".to_string(),
            messages: BTreeMap::new(),
        };
        report.messages.insert(
            1,
            SposobReportMessage {
                timestamp: NaiveDate::from_ymd_opt(2026, 7, 1)
                    .unwrap()
                    .and_hms_opt(1, 12, 0)
                    .unwrap(),
                body: String::new(),
            },
        );
        report.messages.insert(
            2,
            SposobReportMessage {
                timestamp: NaiveDate::from_ymd_opt(2026, 7, 1)
                    .unwrap()
                    .and_hms_opt(23, 47, 0)
                    .unwrap(),
                body: String::new(),
            },
        );
        let req = report_preview_req_with_till(0);

        assert_eq!(
            sposob_report_filename(&report, &req).unwrap(),
            "1 пдб 100 дшп 01.07.2026.docx"
        );
    }

    #[test]
    fn format_sposob_date_range_handles_same_month_and_different_years() {
        assert_eq!(
            format_sposob_date_range(
                NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
            ),
            "01.07.2026"
        );
        assert_eq!(
            format_sposob_date_range(
                NaiveDate::from_ymd_opt(2026, 6, 27).unwrap(),
                NaiveDate::from_ymd_opt(2026, 6, 30).unwrap(),
            ),
            "27-30.06.26"
        );
        assert_eq!(
            format_sposob_date_range(
                NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
                NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
            ),
            "31.12.26-01.01.27"
        );
    }

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
            echo_inbox_message_id: None,
            message_uid: None,
            datasource_group_id: None,
            operator_tags: None,
            attachments_hash: None,
        };

        assert_eq!(
            message_body_without_headers(&message).unwrap(),
            "Перехоплення"
        );
    }

    #[test]
    fn message_body_without_headers_strips_meow_header() {
        let message = signal_message::Model {
            id: 1,
            body: Some(
                "50 обрБпС\n05.58 (МСК/Київ) +- 10хв\n\nПерехоплення"
                    .to_string(),
            ),
            created_at: chrono::Utc::now().naive_utc(),
            timestamp: None,
            sender: None,
            format: None,
            deleted: false,
            external_id: None,
            echo_inbox_message_id: None,
            message_uid: None,
            datasource_group_id: None,
            operator_tags: None,
            attachments_hash: None,
        };

        assert_eq!(
            message_body_without_headers(&message).unwrap(),
            "Перехоплення"
        );
    }

    #[test]
    fn report_body_strips_comments_already_loaded_from_sigint_comment() {
        let message = signal_message(
            1,
            "верхній коментар\n\n24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nнижній коментар",
        );
        let body = message_body_without_duplicate_comments(
            &message,
            &[
                "верхній коментар".to_string(),
                "нижній коментар".to_string(),
            ],
            &[],
        )
        .unwrap();

        assert!(!str::contains(&body, "верхній коментар"));
        assert!(!str::contains(&body, "нижній коментар"));
        assert!(str::contains(&body, "— репліка"));
    }

    #[test]
    fn report_comments_drop_blacklisted_rows() {
        let comments = filter_report_comments(
            vec!["+".to_string(), "важливе уточнення".to_string()],
            &["+".to_string()],
        );

        assert_eq!(comments, vec!["важливе уточнення"]);
    }

    #[test]
    fn report_body_strips_multiline_marker_comment_continuation() {
        let message = signal_message(
            1,
            "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nКоментар: перший рядок\nдругий рядок",
        );
        let body = message_body_without_duplicate_comments(
            &message,
            &["перший рядок\nдругий рядок".to_string()],
            &[],
        )
        .unwrap();

        assert!(!str::contains(&body, "другий рядок"));
        assert!(str::contains(&body, "— репліка"));
    }

    #[test]
    fn report_body_strips_tag_after_legacy_ignored_comment() {
        let message = signal_message(
            1,
            "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nКоментар: службовий радіообмін\n\nМітки перехоплення: 🚙 - Переміщення",
        );
        let body = message_body_without_duplicate_comments(
            &message,
            &["🚙 - Переміщення".to_string()],
            &[],
        )
        .unwrap();

        assert!(!str::contains(&body, "Переміщення"));
        assert!(str::contains(&body, "— репліка"));
    }

    #[test]
    fn report_body_strips_later_comment_after_blacklisted_marker() {
        let message = signal_message(
            1,
            "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nКоментар: +\n\nКоментар: важливе уточнення",
        );
        let body = message_body_without_duplicate_comments(
            &message,
            &["важливе уточнення".to_string()],
            &["+".to_string()],
        )
        .unwrap();

        assert!(!str::contains(&body, "важливе уточнення"));
        assert!(str::contains(&body, "— репліка"));
    }

    #[test]
    fn report_body_strips_filtered_multiline_marker() {
        let message = signal_message(
            1,
            "24.07.2025, 08:05:21\n149.7300\nУКХ\nНВ\n\n— репліка\n\nКоментар:\n+\nважливе уточнення",
        );
        let body = message_body_without_duplicate_comments(
            &message,
            &["важливе уточнення".to_string()],
            &["+".to_string()],
        )
        .unwrap();

        assert!(!str::contains(&body, "важливе уточнення"));
        assert!(!body.lines().any(|line| line.trim() == "+"));
        assert!(str::contains(&body, "— репліка"));
    }

    #[test]
    fn report_message_timestamp_falls_back_to_signal_timestamp() {
        let item = sigint_inbox_item::Model {
            id: 1,
            date: None,
            time: None,
            freq: None,
            coords: None,
            checked: None,
            reviewed: None,
            unit: None,
            callsign_tokens: None,
            keyword_tokens: None,
            unit_v2: None,
            lat: None,
            lng: None,
            nominatimres_id: None,
            location: None,
            tags: None,
            datetime: None,
            datetime_neo: None,
            signal_tokens: None,
            body_noheader: None,
            parsed_unit_v2: false,
            location_v2: None,
            post_id: None,
            device_name_id: None,
            network: None,
        };
        let message = signal_message::Model {
            id: 1,
            body: Some("Перехоплення".to_string()),
            created_at: dt(1, 0),
            timestamp: Some(dt(5, 58)),
            sender: None,
            format: None,
            deleted: false,
            external_id: None,
            echo_inbox_message_id: None,
            message_uid: None,
            datasource_group_id: None,
            operator_tags: None,
            attachments_hash: None,
        };

        assert_eq!(report_message_timestamp(&item, &message), Some(dt(8, 58)));
    }

    #[test]
    fn report_message_timestamp_converts_item_datetime_to_kyiv() {
        let item = sigint_inbox_item::Model {
            id: 1,
            date: None,
            time: None,
            freq: None,
            coords: None,
            checked: None,
            reviewed: None,
            unit: None,
            callsign_tokens: None,
            keyword_tokens: None,
            unit_v2: None,
            lat: None,
            lng: None,
            nominatimres_id: None,
            location: None,
            tags: None,
            datetime: Some(dt(5, 58)),
            datetime_neo: Some(dt(5, 58)),
            signal_tokens: None,
            body_noheader: None,
            parsed_unit_v2: false,
            location_v2: None,
            post_id: None,
            device_name_id: None,
            network: None,
        };
        let message = signal_message::Model {
            id: 1,
            body: Some("Перехоплення".to_string()),
            created_at: dt(1, 0),
            timestamp: Some(dt(6, 58)),
            sender: None,
            format: None,
            deleted: false,
            external_id: None,
            echo_inbox_message_id: None,
            message_uid: None,
            datasource_group_id: None,
            operator_tags: None,
            attachments_hash: None,
        };

        assert_eq!(report_message_timestamp(&item, &message), Some(dt(8, 58)));
    }

    fn document_xml(path: &Path) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let mut document = zip.by_name("word/document.xml").unwrap();
        let mut xml = String::new();
        document.read_to_string(&mut xml).unwrap();
        xml
    }

    fn assert_blank_paragraph_after(xml: &str, marker: &str) {
        let marker_idx = xml.find(marker).unwrap_or_else(|| {
            panic!("missing marker {marker}");
        });
        let paragraph_end =
            xml[marker_idx..].find("</w:p>").unwrap_or_else(|| {
                panic!("missing paragraph end after {marker}");
            }) + marker_idx
                + "</w:p>".len();
        let after = xml[paragraph_end..].trim_start();
        let next_end = after.find("</w:p>").unwrap_or_else(|| {
            panic!("missing next paragraph after {marker}");
        }) + "</w:p>".len();
        let next_paragraph = &after[..next_end];
        assert!(next_paragraph.starts_with("<w:p"));
        assert!(
            !next_paragraph.contains("<w:t")
                && !next_paragraph.contains("<w:br"),
            "expected blank paragraph after {marker}"
        );
    }

    #[test]
    fn sposob_report_message_timestamp_requires_inbox_datetime() {
        let item = inbox_item(1, None, None);
        assert_eq!(sposob_report_message_timestamp(&item), None);

        let item = inbox_item(
            1,
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 1)
                    .unwrap()
                    .and_hms_opt(11, 47, 3)
                    .unwrap(),
            ),
            None,
        );

        assert_eq!(
            sposob_report_message_timestamp(&item),
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 1)
                    .unwrap()
                    .and_hms_opt(14, 47, 3)
                    .unwrap()
            )
        );
    }

    #[test]
    fn sposob_message_body_without_headers_uses_stored_body_noheader() {
        let item = inbox_item(
            1,
            None,
            Some(
                serde_json::to_value(
                    crate::rer_importer::body_noheader::NoHeadersBody {
                        body: "Перехоплення\n(Коментар: передмова)".to_string(),
                        start: 42,
                        end: 78,
                    },
                )
                .unwrap(),
            ),
        );
        let message = signal_message(
            1,
            "передмова\naudio | 2026-07-01_14-47-03\nПерехоплення",
        );

        assert_eq!(
            sposob_message_body_without_headers(&item, &message).unwrap(),
            "Перехоплення\n(Коментар: передмова)"
        );
    }
}
