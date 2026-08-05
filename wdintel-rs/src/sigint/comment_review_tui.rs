use crate::entities::*;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::sigint::parser::ParsedComments;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode, OneoffReviewParsedSigintCommentsPs};
use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use sea_orm::prelude::Json;
use sea_orm::sea_query::Expr;
use sea_orm::*;
use std::io::{self, Stdout};
use std::time::Duration;

const DEFAULT_PAGE_LIMIT: u64 = 100;
const SCROLL_STEP: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReviewCursor {
    created_at: NaiveDateTime,
    id: i64,
}

#[derive(Debug, Clone, FromQueryResult)]
struct ReviewQueryRow {
    id: i64,
    created_at: NaiveDateTime,
    body: Option<String>,
    body_noheader: Option<Json>,
}

#[derive(Debug, Clone)]
struct ReviewEntry {
    id: i64,
    created_at: NaiveDateTime,
    body: String,
    body_noheader: String,
    parsed: ParsedComments,
}

#[derive(Debug, PartialEq, Eq)]
enum LoopOutcome {
    Done,
    Quit,
}

struct ReviewState {
    since_ts: NaiveDateTime,
    limit: u64,
    cursor: Option<ReviewCursor>,
    rows: Vec<ReviewEntry>,
    idx: usize,
    scroll: u16,
}

pub async fn run_comment_review_tui(
    mode: Mode,
    ps: &OneoffReviewParsedSigintCommentsPs,
) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let since_ts = parse_since_ts_or_default(ps.since_ts.as_deref()).c(h!())?;
    let limit = normalize_limit(ps.limit);
    let mut terminal = setup_terminal().c(h!())?;
    let res = run_loop(&db, &mut terminal, since_ts, limit).await;
    restore_terminal(&mut terminal).c(h!())?;
    if res? == LoopOutcome::Done {
        println!("done!");
    }
    Ok(())
}

fn setup_terminal() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend)
}

fn restore_terminal(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, cursor::Show)?;
    terminal.show_cursor()
}

async fn run_loop(
    db: &DatabaseConnection,
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    since_ts: NaiveDateTime,
    limit: u64,
) -> Result<LoopOutcome, AppError> {
    let mut state = ReviewState {
        since_ts,
        limit,
        cursor: None,
        rows: vec![],
        idx: 0,
        scroll: 0,
    };
    load_next_page(db, &mut state).await?;
    if state.rows.is_empty() {
        return Ok(LoopOutcome::Done);
    }

    let poll =
        Duration::from_millis(crate::config::SIGINT_INBOX_TUI_EVENT_POLL_MS);
    loop {
        terminal.draw(|frame| draw_ui(frame, &state)).c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        match event::read().c(h!())? {
            Event::Key(key) => match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    return Ok(LoopOutcome::Quit);
                }
                KeyCode::Enter | KeyCode::Right | KeyCode::Char('n') => {
                    if advance_entry(db, &mut state).await? {
                        return Ok(LoopOutcome::Done);
                    }
                }
                KeyCode::Left | KeyCode::Char('p') => {
                    if state.idx > 0 {
                        state.idx -= 1;
                        state.scroll = 0;
                    }
                }
                KeyCode::Up => {
                    state.scroll = state.scroll.saturating_sub(1);
                }
                KeyCode::Down => {
                    state.scroll = state.scroll.saturating_add(1);
                }
                KeyCode::PageUp => {
                    state.scroll = state.scroll.saturating_sub(SCROLL_STEP);
                }
                KeyCode::PageDown => {
                    state.scroll = state.scroll.saturating_add(SCROLL_STEP);
                }
                KeyCode::Home => {
                    state.scroll = 0;
                }
                _ => {}
            },
            Event::Resize(_, _) => {}
            _ => {}
        }
    }
}

async fn advance_entry(
    db: &DatabaseConnection,
    state: &mut ReviewState,
) -> Result<bool, AppError> {
    if state.idx + 1 < state.rows.len() {
        state.idx += 1;
        state.scroll = 0;
        return Ok(false);
    }
    load_next_page(db, state).await?;
    Ok(state.rows.is_empty())
}

async fn load_next_page(
    db: &DatabaseConnection,
    state: &mut ReviewState,
) -> Result<(), AppError> {
    let rows = fetch_review_page(db, state.since_ts, state.cursor, state.limit)
        .await?;
    state.cursor = rows.last().map(ReviewCursor::from_entry);
    state.rows = rows;
    state.idx = 0;
    state.scroll = 0;
    Ok(())
}

async fn fetch_review_page<C>(
    db: &C,
    since_ts: NaiveDateTime,
    cursor: Option<ReviewCursor>,
    limit: u64,
) -> Result<Vec<ReviewEntry>, AppError>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .select_only()
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Id)),
            "id",
        )
        .column_as(
            Expr::col((
                signal_message::Entity,
                signal_message::Column::CreatedAt,
            )),
            "created_at",
        )
        .column_as(
            Expr::col((signal_message::Entity, signal_message::Column::Body)),
            "body",
        )
        .column_as(
            Expr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::BodyNoheader,
            )),
            "body_noheader",
        )
        .filter(signal_message::Column::Body.is_not_null())
        .filter(signal_message::Column::CreatedAt.gte(since_ts))
        .filter(signal_message::Column::Deleted.eq(false));

    if let Some(cursor) = cursor {
        query = query.filter(build_cursor_filter(cursor));
    }

    let rows = query
        .order_by_asc(signal_message::Column::CreatedAt)
        .order_by_asc(signal_message::Column::Id)
        .limit(limit)
        .into_model::<ReviewQueryRow>()
        .all(db)
        .await
        .c(h!())?;

    let blacklist = crate::sigint::comments::load_blacklist(db).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| ReviewEntry::from_row(row, &blacklist))
        .collect())
}

fn build_cursor_filter(cursor: ReviewCursor) -> Condition {
    Condition::any()
        .add(signal_message::Column::CreatedAt.gt(cursor.created_at))
        .add(
            Condition::all()
                .add(signal_message::Column::CreatedAt.eq(cursor.created_at))
                .add(signal_message::Column::Id.gt(cursor.id)),
        )
}

fn draw_ui(frame: &mut Frame<'_>, state: &ReviewState) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(frame.size());

    render_header(frame, root[0], state);
    render_entry(frame, root[1], state);
    render_footer(frame, root[2]);
}

fn render_header(frame: &mut Frame<'_>, area: Rect, state: &ReviewState) {
    let entry = &state.rows[state.idx];
    let text = format!(
        "Message #{} | {} | page item {}/{} | since {} | scroll {}",
        entry.id,
        entry.created_at,
        state.idx + 1,
        state.rows.len(),
        state.since_ts,
        state.scroll
    );
    frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), area);
}

fn render_entry(frame: &mut Frame<'_>, area: Rect, state: &ReviewState) {
    let entry = &state.rows[state.idx];
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);
    render_text_pane(frame, cols[0], "Full body", &entry.body, state.scroll);

    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(cols[1]);
    render_text_pane(
        frame,
        right[0],
        "Body no header preview",
        &entry.body_noheader,
        state.scroll,
    );
    render_text_pane(
        frame,
        right[1],
        "Parsed comments",
        &format_comments(&entry.parsed),
        state.scroll,
    );
}

fn render_text_pane(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    text: &str,
    scroll: u16,
) {
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(text.to_string())
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        inner,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(
        Paragraph::new(
            "Enter/Right/n next | Left/p previous | Up/Down/PageUp/PageDown scroll | q/Esc quit",
        ),
        area,
    );
}

fn format_comments(parsed: &ParsedComments) -> String {
    if parsed.is_empty() {
        return "<no parsed comments>".to_string();
    }
    format!(
        "top:\n{}\n\nbottom:\n{}",
        parsed.top.as_deref().unwrap_or("<empty>"),
        parsed.bottom.as_deref().unwrap_or("<empty>")
    )
}

fn body_noheader_to_text(value: Option<Json>) -> String {
    let Some(value) = value else {
        return "<body_noheader is empty>".to_string();
    };
    match serde_json::from_value::<NoHeadersBody>(value) {
        Ok(body_noheader) => body_noheader.body,
        Err(err) => format!("<invalid body_noheader: {err}>"),
    }
}

pub fn parse_since_ts_or_default(
    value: Option<&str>,
) -> Result<NaiveDateTime, AppError> {
    match value {
        Some(value) => parse_since_ts(value),
        None => Ok(Utc::now().naive_utc() - ChronoDuration::weeks(1)),
    }
}

pub fn parse_since_ts(value: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .map_err(|err| AppError::BL {
            msg: format!("invalid since_ts `{value}`: {err}"),
        })
}

fn normalize_limit(limit: Option<u64>) -> u64 {
    std::cmp::max(limit.unwrap_or(DEFAULT_PAGE_LIMIT), 1)
}

impl ReviewCursor {
    fn from_entry(entry: &ReviewEntry) -> Self {
        Self {
            created_at: entry.created_at,
            id: entry.id,
        }
    }
}

impl ReviewEntry {
    fn from_row(row: ReviewQueryRow, blacklist: &[String]) -> Option<Self> {
        let body = row.body?;
        let parsed = crate::sigint::parser::parse_comments_with_blacklist(
            &body, blacklist,
        );
        let body_noheader =
            crate::sigint::parser::extract_text_without_top_comment(&body)
                .map(|body_noheader| body_noheader.body)
                .unwrap_or_else(|_| body_noheader_to_text(row.body_noheader));
        Some(Self {
            id: row.id,
            created_at: row.created_at,
            body,
            body_noheader,
            parsed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use sea_orm::sea_query::{PostgresQueryBuilder, Query};

    #[test]
    fn parse_since_ts_accepts_t_separator() {
        assert_eq!(
            parse_since_ts("2026-07-02T14:30:00").unwrap(),
            dt(2026, 7, 2, 14, 30, 0)
        );
    }

    #[test]
    fn parse_since_ts_accepts_space_separator() {
        assert_eq!(
            parse_since_ts("2026-07-02 14:30:00").unwrap(),
            dt(2026, 7, 2, 14, 30, 0)
        );
    }

    #[test]
    fn parse_since_ts_rejects_invalid_value() {
        assert!(parse_since_ts("2026-07-02").is_err());
    }

    #[test]
    fn normalize_limit_defaults_to_100_and_never_returns_zero() {
        assert_eq!(normalize_limit(None), 100);
        assert_eq!(normalize_limit(Some(0)), 1);
        assert_eq!(normalize_limit(Some(17)), 17);
    }

    #[test]
    fn cursor_filter_contains_created_at_and_id_comparison() {
        let cursor = ReviewCursor {
            created_at: dt(2026, 7, 2, 14, 30, 0),
            id: 42,
        };
        let mut query = Query::select();
        query
            .column(signal_message::Column::Id)
            .from(signal_message::Entity)
            .cond_where(build_cursor_filter(cursor));

        let sql = query.to_string(PostgresQueryBuilder);
        assert!(sql.contains(r#""created_at" >"#), "{sql}");
        assert!(sql.contains(r#""created_at" ="#), "{sql}");
        assert!(sql.contains(r#""id" > 42"#), "{sql}");
    }

    fn dt(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, second)
            .unwrap()
    }
}
