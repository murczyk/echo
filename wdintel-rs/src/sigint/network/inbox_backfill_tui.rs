use crate::entities::*;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode, OneoffBackfillInboxNetworkUnitsTuiPs};
use chrono::{NaiveDate, NaiveDateTime};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{
    Block, Borders, Clear, Paragraph, Row, Table, TableState, Wrap,
};
use ratatui::{Frame, Terminal};
use sea_orm::*;
use std::collections::{BTreeSet, HashMap};
use std::io::{self, Stdout};
use std::time::Duration;

const DEFAULT_PAGE_LIMIT: u64 = 100;
const TABLE_PAGE_STEP: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BackfillCursor {
    datetime: NaiveDateTime,
    id: i64,
}

#[derive(Debug, Clone, FromQueryResult)]
struct BackfillRow {
    id: i64,
    datetime: NaiveDateTime,
    body: String,
    unit: Option<String>,
    unit_v2: Option<String>,
    network: Option<String>,
}

#[derive(Debug, Clone)]
struct BackfillEntry {
    id: i64,
    datetime: NaiveDateTime,
    body: String,
    network_id: i64,
    current_network: Option<String>,
    current_unit: Option<String>,
    proposed_network: Option<String>,
    proposed_unit: Option<String>,
    status: BackfillStatus,
}

#[derive(Debug, Clone)]
enum BackfillStatus {
    Ready,
    Applied,
    Stale(String),
    Error(String),
}

impl BackfillStatus {
    fn label(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Applied => "applied",
            Self::Stale(_) => "stale",
            Self::Error(_) => "error",
        }
    }

    fn details(&self) -> Option<&str> {
        match self {
            Self::Stale(details) | Self::Error(details) => Some(details),
            Self::Ready | Self::Applied => None,
        }
    }

    fn can_apply(&self) -> bool {
        matches!(self, Self::Ready)
    }
}

struct BackfillLoad {
    rows: Vec<BackfillEntry>,
    scanned: usize,
}

struct BackfillApp {
    since_ts: NaiveDateTime,
    limit: u64,
    rows: Vec<BackfillEntry>,
    table_state: TableState,
    scanned: usize,
    applied: u64,
    stale: u64,
    failed: u64,
    confirm_apply_all: bool,
    message: Option<String>,
}

impl BackfillApp {
    fn new(since_ts: NaiveDateTime, limit: u64, load: BackfillLoad) -> Self {
        let mut table_state = TableState::default();
        if !load.rows.is_empty() {
            table_state.select(Some(0));
        }
        Self {
            since_ts,
            limit,
            rows: load.rows,
            table_state,
            scanned: load.scanned,
            applied: 0,
            stale: 0,
            failed: 0,
            confirm_apply_all: false,
            message: None,
        }
    }

    fn selected_index(&self) -> Option<usize> {
        self.table_state.selected()
    }

    fn selected_entry(&self) -> Option<&BackfillEntry> {
        self.selected_index().and_then(|index| self.rows.get(index))
    }

    fn ready_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|entry| entry.status.can_apply())
            .count()
    }

    fn select_next(&mut self) {
        if self.rows.is_empty() {
            self.table_state.select(None);
            return;
        }
        let next = self
            .selected_index()
            .map(|index| (index + 1).min(self.rows.len() - 1))
            .unwrap_or(0);
        self.table_state.select(Some(next));
    }

    fn select_previous(&mut self) {
        if self.rows.is_empty() {
            self.table_state.select(None);
            return;
        }
        let previous = self.selected_index().unwrap_or(0).saturating_sub(1);
        self.table_state.select(Some(previous));
    }

    fn select_page(&mut self, forwards: bool) {
        if self.rows.is_empty() {
            self.table_state.select(None);
            return;
        }
        let index = self.selected_index().unwrap_or(0);
        let selected = if forwards {
            index
                .saturating_add(TABLE_PAGE_STEP)
                .min(self.rows.len() - 1)
        } else {
            index.saturating_sub(TABLE_PAGE_STEP)
        };
        self.table_state.select(Some(selected));
    }
}

pub async fn run_inbox_network_unit_backfill_tui(
    mode: Mode,
    ps: &OneoffBackfillInboxNetworkUnitsTuiPs,
) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let since_ts = parse_start_date(&ps.start)?;
    let limit = std::cmp::max(ps.limit.unwrap_or(DEFAULT_PAGE_LIMIT), 1);
    let load = load_backfill_entries(&db, since_ts, limit).await?;
    if load.rows.is_empty() {
        let newest = newest_eligible_datetime(&db).await?;
        println!("{}", empty_result_message(since_ts, load.scanned, newest));
        return Ok(());
    }

    let mut app = BackfillApp::new(since_ts, limit, load);
    let mut terminal = setup_terminal().c(h!())?;
    let run_result = run_app(&db, &mut terminal, &mut app).await;
    restore_terminal(&mut terminal).c(h!())?;
    run_result?;
    println!(
        "done! applied={} stale={} failed={}",
        app.applied, app.stale, app.failed
    );
    Ok(())
}

fn parse_start_date(value: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::BL {
            msg: format!(
                "invalid --start `{value}`; expected YYYY-MM-DD, for example `2026-07-01`"
            ),
        })?
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::BL {
            msg: format!("failed to get start of day for `{value}`"),
        })
}

fn setup_terminal() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;
    Terminal::new(CrosstermBackend::new(stdout))
}

fn restore_terminal(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, cursor::Show)?;
    terminal.show_cursor()
}

async fn run_app(
    db: &DatabaseConnection,
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    app: &mut BackfillApp,
) -> Result<(), AppError> {
    let poll =
        Duration::from_millis(crate::config::SIGINT_INBOX_TUI_EVENT_POLL_MS);
    loop {
        terminal.draw(|frame| draw_ui(frame, app)).c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if handle_key(db, app, key.code, key.modifiers).await? {
            return Ok(());
        }
    }
}

async fn handle_key(
    db: &DatabaseConnection,
    app: &mut BackfillApp,
    code: KeyCode,
    modifiers: KeyModifiers,
) -> Result<bool, AppError> {
    if app.confirm_apply_all {
        return handle_apply_all_confirmation(db, app, code, modifiers).await;
    }

    match code {
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Ok(true);
        }
        KeyCode::Char('q') | KeyCode::Esc => return Ok(true),
        KeyCode::Up => app.select_previous(),
        KeyCode::Down => app.select_next(),
        KeyCode::PageUp => app.select_page(false),
        KeyCode::PageDown => app.select_page(true),
        KeyCode::Home => {
            app.table_state.select((!app.rows.is_empty()).then_some(0))
        }
        KeyCode::End => app
            .table_state
            .select((!app.rows.is_empty()).then_some(app.rows.len() - 1)),
        KeyCode::Char('a') | KeyCode::Enter => {
            apply_selected_entry(db, app).await;
        }
        KeyCode::Char('A') => {
            if app.ready_count() == 0 {
                app.message = Some("no ready rows to apply".to_string());
            } else {
                app.confirm_apply_all = true;
                app.message = None;
            }
        }
        KeyCode::Char('r') => reload_entries(db, app).await,
        _ => {}
    }
    Ok(false)
}

async fn handle_apply_all_confirmation(
    db: &DatabaseConnection,
    app: &mut BackfillApp,
    code: KeyCode,
    modifiers: KeyModifiers,
) -> Result<bool, AppError> {
    match code {
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Ok(true);
        }
        KeyCode::Esc => app.confirm_apply_all = false,
        KeyCode::Enter => {
            app.confirm_apply_all = false;
            apply_all_entries(db, app).await;
        }
        _ => {}
    }
    Ok(false)
}

async fn load_backfill_entries(
    db: &DatabaseConnection,
    since_ts: NaiveDateTime,
    limit: u64,
) -> Result<BackfillLoad, AppError> {
    let mut cursor = None;
    let mut scanned = 0;
    let mut entries = vec![];
    loop {
        let rows = fetch_backfill_rows(db, since_ts, cursor, limit).await?;
        cursor = rows.last().map(BackfillCursor::from_row);
        if rows.is_empty() {
            return Ok(BackfillLoad {
                rows: entries,
                scanned,
            });
        }
        scanned += rows.len();
        entries.extend(build_backfill_entries(db, rows).await?);
    }
}

async fn newest_eligible_datetime<C>(
    db: &C,
) -> Result<Option<NaiveDateTime>, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .select_only()
        .column(sigint_inbox_item::Column::Datetime)
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Body.is_not_null())
        .order_by_desc(sigint_inbox_item::Column::Datetime)
        .limit(1)
        .into_tuple::<NaiveDateTime>()
        .one(db)
        .await
        .c(h!())?)
}

fn empty_result_message(
    since_ts: NaiveDateTime,
    scanned: usize,
    newest: Option<NaiveDateTime>,
) -> String {
    if scanned > 0 {
        return format!(
            "no backfill candidates since {}; scanned {scanned} eligible messages and all fields already match",
            since_ts.date(),
        );
    }
    match newest {
        Some(newest) => format!(
            "no eligible linked messages on or after {}; newest eligible message is {}; try --start {}",
            since_ts.date(),
            newest,
            newest.date(),
        ),
        None => format!(
            "no eligible linked messages on or after {}; the database has no linked messages to backfill",
            since_ts.date(),
        ),
    }
}

async fn fetch_backfill_rows<C>(
    db: &C,
    since_ts: NaiveDateTime,
    cursor: Option<BackfillCursor>,
    limit: u64,
) -> Result<Vec<BackfillRow>, AppError>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .select_only()
        .distinct()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::Datetime)
        .column(sigint_inbox_item::Column::Unit)
        .column(sigint_inbox_item::Column::UnitV2)
        .column(sigint_inbox_item::Column::Network)
        .column_as(signal_message::Column::Body, "body")
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(since_ts))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Body.is_not_null());

    if let Some(cursor) = cursor {
        query = query.filter(build_cursor_filter(cursor));
    }

    Ok(query
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id)
        .limit(limit)
        .into_model::<BackfillRow>()
        .all(db)
        .await
        .c(h!())?)
}

fn build_cursor_filter(cursor: BackfillCursor) -> Condition {
    Condition::any()
        .add(sigint_inbox_item::Column::Datetime.gt(cursor.datetime))
        .add(
            Condition::all()
                .add(sigint_inbox_item::Column::Datetime.eq(cursor.datetime))
                .add(sigint_inbox_item::Column::Id.gt(cursor.id)),
        )
}

async fn build_backfill_entries<C>(
    db: &C,
    rows: Vec<BackfillRow>,
) -> Result<Vec<BackfillEntry>, AppError>
where
    C: ConnectionTrait,
{
    let message_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let mut network_ids_by_message = HashMap::<i64, BTreeSet<i64>>::new();
    for (message_id, network_id) in sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintInboxItemId)
        .column(sigint_inbox_item_network::Column::SigintNetworkId)
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(message_ids),
        )
        .into_tuple::<(i64, i64)>()
        .all(db)
        .await
        .c(h!())?
    {
        network_ids_by_message
            .entry(message_id)
            .or_default()
            .insert(network_id);
    }
    let network_ids = network_ids_by_message
        .values()
        .filter(|network_ids| network_ids.len() == 1)
        .flat_map(|network_ids| network_ids.iter().copied())
        .collect::<BTreeSet<_>>();
    if network_ids.is_empty() {
        return Ok(vec![]);
    }

    let networks_by_id = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids.iter().copied()))
        .filter(sigint_network::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|network| (network.id, network.name))
        .collect::<HashMap<_, _>>();
    let mut unit_names_by_network = HashMap::<i64, BTreeSet<String>>::new();
    for (network_id, unit_name) in sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .column(sigint_network_unit::Column::NetworkId)
        .column_as(sigint_unit::Column::Name, "unit_name")
        .filter(
            sigint_network_unit::Column::NetworkId
                .is_in(network_ids.iter().copied()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .into_tuple::<(i64, String)>()
        .all(db)
        .await
        .c(h!())?
    {
        unit_names_by_network
            .entry(network_id)
            .or_default()
            .insert(unit_name);
    }

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            build_backfill_entry(
                row,
                &network_ids_by_message,
                &networks_by_id,
                &unit_names_by_network,
            )
        })
        .collect())
}

fn build_backfill_entry(
    row: BackfillRow,
    network_ids_by_message: &HashMap<i64, BTreeSet<i64>>,
    networks_by_id: &HashMap<i64, String>,
    unit_names_by_network: &HashMap<i64, BTreeSet<String>>,
) -> Option<BackfillEntry> {
    let network_ids = network_ids_by_message.get(&row.id)?;
    if network_ids.len() != 1 {
        return None;
    }
    let network_id = *network_ids.iter().next()?;
    let network_name = networks_by_id.get(&network_id)?.trim();
    if network_name.is_empty() {
        return None;
    }

    let current_network = normalized(row.network.as_deref());
    let stored_unit_v2 = normalized(row.unit_v2.as_deref());
    let current_unit =
        stored_unit_v2.or_else(|| normalized(row.unit.as_deref()));
    let proposed_network = (current_network != Some(network_name))
        .then(|| network_name.to_string());
    let network_unit = unit_names_by_network
        .get(&network_id)
        .map(|names| names.iter().cloned().collect::<Vec<_>>().join(", "))
        .filter(|names| !names.is_empty());
    let proposed_unit = network_unit
        .filter(|network_unit| stored_unit_v2 != Some(network_unit.as_str()));
    if proposed_network.is_none() && proposed_unit.is_none() {
        return None;
    }

    Some(BackfillEntry {
        id: row.id,
        datetime: row.datetime,
        body: row.body,
        network_id,
        current_network: current_network.map(ToString::to_string),
        current_unit: current_unit.map(ToString::to_string),
        proposed_network,
        proposed_unit,
        status: BackfillStatus::Ready,
    })
}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

enum ApplyEntryOutcome {
    Applied,
    Stale(String),
}

async fn apply_selected_entry(db: &DatabaseConnection, app: &mut BackfillApp) {
    let Some(index) = app.selected_index() else {
        app.message = Some("no row selected".to_string());
        return;
    };
    if !app.rows[index].status.can_apply() {
        app.message = Some("selected row is not ready to apply".to_string());
        return;
    }
    let id = app.rows[index].id;
    apply_entry_at_index(db, app, index).await;
    let status = &app.rows[index].status;
    app.message = Some(format!("message #{id}: {}", status.label()));
}

async fn apply_all_entries(db: &DatabaseConnection, app: &mut BackfillApp) {
    let ready = app
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.status.can_apply().then_some(index))
        .collect::<Vec<_>>();
    let applied_before = app.applied;
    let stale_before = app.stale;
    let failed_before = app.failed;
    for index in ready {
        apply_entry_at_index(db, app, index).await;
    }
    app.message = Some(format!(
        "apply all finished: {} applied, {} stale, {} failed",
        app.applied - applied_before,
        app.stale - stale_before,
        app.failed - failed_before,
    ));
}

async fn apply_entry_at_index(
    db: &DatabaseConnection,
    app: &mut BackfillApp,
    index: usize,
) {
    let entry = app.rows[index].clone();
    let status = match apply_backfill_entry(db, &entry).await {
        Ok(ApplyEntryOutcome::Applied) => {
            app.applied += 1;
            BackfillStatus::Applied
        }
        Ok(ApplyEntryOutcome::Stale(details)) => {
            app.stale += 1;
            BackfillStatus::Stale(details)
        }
        Err(error) => {
            app.failed += 1;
            BackfillStatus::Error(format!("{error:?}"))
        }
    };
    app.rows[index].status = status;
}

async fn apply_backfill_entry(
    db: &DatabaseConnection,
    expected: &BackfillEntry,
) -> Result<ApplyEntryOutcome, AppError> {
    let txn = db.begin().await.c(h!())?;
    let Some(item) = sigint_inbox_item::Entity::find_by_id(expected.id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
    else {
        txn.rollback().await.c(h!())?;
        return Ok(ApplyEntryOutcome::Stale(
            "inbox item no longer exists".to_string(),
        ));
    };
    let signal_message = signal_message::Entity::find_by_id(expected.id)
        .one(&txn)
        .await
        .c(h!())?;
    let current = signal_message
        .filter(|message| !message.deleted)
        .and_then(|message| message.body)
        .zip(item.datetime)
        .map(|(body, datetime)| BackfillRow {
            id: item.id,
            datetime,
            body,
            unit: item.unit.clone(),
            unit_v2: item.unit_v2.clone(),
            network: item.network.clone(),
        });
    let latest = match current {
        Some(current) => build_backfill_entries(&txn, vec![current])
            .await?
            .into_iter()
            .next(),
        None => None,
    };
    let Some(latest) = latest else {
        txn.rollback().await.c(h!())?;
        return Ok(ApplyEntryOutcome::Stale(
            "message is no longer an eligible backfill candidate".to_string(),
        ));
    };
    if !same_preview(expected, &latest) {
        txn.rollback().await.c(h!())?;
        return Ok(ApplyEntryOutcome::Stale(
            "stored fields or linked network changed after preview".to_string(),
        ));
    }

    let mut item = item.into_active_model();
    if let Some(network) = &expected.proposed_network {
        item.network = Set(Some(network.clone()));
    }
    if let Some(unit) = &expected.proposed_unit {
        item.unit = Set(Some(unit.clone()));
        item.unit_v2 = Set(Some(unit.clone()));
        item.parsed_unit_v2 = Set(true);
    }
    item.update(&txn).await.c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_message(
        &txn,
        expected.id,
        format!("updated network/unit for inbox message {}", expected.id),
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(ApplyEntryOutcome::Applied)
}

fn same_preview(expected: &BackfillEntry, latest: &BackfillEntry) -> bool {
    expected.datetime == latest.datetime
        && expected.body == latest.body
        && expected.network_id == latest.network_id
        && expected.current_network == latest.current_network
        && expected.current_unit == latest.current_unit
        && expected.proposed_network == latest.proposed_network
        && expected.proposed_unit == latest.proposed_unit
}

async fn reload_entries(db: &DatabaseConnection, app: &mut BackfillApp) {
    match load_backfill_entries(db, app.since_ts, app.limit).await {
        Ok(load) => {
            app.rows = load.rows;
            app.scanned = load.scanned;
            app.table_state = TableState::default()
                .with_selected((!app.rows.is_empty()).then_some(0));
            app.message = Some(format!(
                "reloaded: {} candidates from {} eligible messages",
                app.rows.len(),
                app.scanned,
            ));
        }
        Err(error) => {
            app.message = Some(format!("reload failed: {error:?}"));
        }
    }
}

fn draw_ui(frame: &mut Frame<'_>, app: &mut BackfillApp) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(10),
            Constraint::Length(12),
            Constraint::Length(4),
        ])
        .split(frame.size());
    render_summary(frame, root[0], app);
    render_table(frame, root[1], app);
    render_preview(frame, root[2], app);
    render_footer(frame, root[3]);
    if app.confirm_apply_all {
        render_apply_all_confirmation(frame, app.ready_count());
    }
}

fn render_summary(frame: &mut Frame<'_>, area: Rect, app: &BackfillApp) {
    let text = vec![
        Line::from(format!(
            "Start {} | scanned {} | candidates {} | ready {} | applied {} | stale {} | failed {}",
            app.since_ts.date(),
            app.scanned,
            app.rows.len(),
            app.ready_count(),
            app.applied,
            app.stale,
            app.failed,
        )),
        Line::from(
            app.message
                .as_deref()
                .unwrap_or("Review each preview before applying changes."),
        ),
    ];
    frame.render_widget(
        Paragraph::new(text)
            .block(Block::default().borders(Borders::ALL).title("Summary")),
        area,
    );
}

fn render_table(frame: &mut Frame<'_>, area: Rect, app: &mut BackfillApp) {
    let header = Row::new([
        "Status",
        "ID",
        "Datetime",
        "Stored full name",
        "Proposed full name",
        "Stored unit",
        "Proposed unit",
    ])
    .style(
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    );
    let rows = app.rows.iter().map(|entry| {
        let stored_full_name = network_with_unit(
            entry.current_network.as_deref(),
            entry.current_unit.as_deref(),
            "<empty>",
        );
        let proposed_full_name = network_with_unit(
            entry
                .proposed_network
                .as_deref()
                .or(entry.current_network.as_deref()),
            entry
                .proposed_unit
                .as_deref()
                .or(entry.current_unit.as_deref()),
            "<empty>",
        );
        Row::new([
            entry.status.label().to_string(),
            entry.id.to_string(),
            entry.datetime.to_string(),
            compact_cell(Some(&stored_full_name), "<empty>", 44),
            compact_cell(Some(&proposed_full_name), "<empty>", 44),
            compact_cell(entry.current_unit.as_deref(), "<empty>", 30),
            compact_cell(entry.proposed_unit.as_deref(), "<unchanged>", 30),
        ])
        .style(status_style(&entry.status))
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(9),
            Constraint::Length(10),
            Constraint::Length(19),
            Constraint::Percentage(14),
            Constraint::Percentage(14),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title("Backfill candidates"),
    )
    .column_spacing(1)
    .highlight_style(
        Style::default()
            .bg(Color::Rgb(34, 54, 76))
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )
    .highlight_symbol("▶ ");
    frame.render_stateful_widget(table, area, &mut app.table_state);
}

fn network_with_unit(
    network: Option<&str>,
    unit: Option<&str>,
    fallback: &str,
) -> String {
    let Some(network) = normalized(network) else {
        return fallback.to_string();
    };
    match normalized(unit) {
        Some(unit) => format!("{network} — {unit}"),
        None => network.to_string(),
    }
}

fn compact_cell(
    value: Option<&str>,
    fallback: &str,
    max_chars: usize,
) -> String {
    let value = value.unwrap_or(fallback);
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut compact = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    compact.push('…');
    compact
}

fn status_style(status: &BackfillStatus) -> Style {
    match status {
        BackfillStatus::Ready => Style::default(),
        BackfillStatus::Applied => Style::default().fg(Color::Green),
        BackfillStatus::Stale(_) => Style::default().fg(Color::Yellow),
        BackfillStatus::Error(_) => Style::default().fg(Color::Red),
    }
}

fn render_preview(frame: &mut Frame<'_>, area: Rect, app: &BackfillApp) {
    let text = match app.selected_entry() {
        Some(entry) => {
            let stored_full_name = network_with_unit(
                entry.current_network.as_deref(),
                entry.current_unit.as_deref(),
                "<empty>",
            );
            let proposed_full_name = network_with_unit(
                entry
                    .proposed_network
                    .as_deref()
                    .or(entry.current_network.as_deref()),
                entry
                    .proposed_unit
                    .as_deref()
                    .or(entry.current_unit.as_deref()),
                "<empty>",
            );
            let details = entry
                .status
                .details()
                .map(|details| format!("\nDetails: {details}"))
                .unwrap_or_default();
            format!(
                "Message #{} | {} | linked network #{} | status: {}{}\nFull name: {} -> {}\nBody: {}",
                entry.id,
                entry.datetime,
                entry.network_id,
                entry.status.label(),
                details,
                stored_full_name,
                proposed_full_name,
                entry.body,
            )
        }
        None => {
            "No candidates remain. Press r to reload or q to exit.".to_string()
        }
    };
    frame.render_widget(
        Paragraph::new(text)
            .block(Block::default().borders(Borders::ALL).title("Preview"))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect) {
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(
                "Up/Down/PageUp/PageDown/Home/End: move    a/Enter: apply selected",
            ),
            Line::from(
                "A: apply all ready rows    r: reload    q/Esc/Ctrl+C: exit",
            ),
        ])
        .block(Block::default().borders(Borders::ALL).title("Keys")),
        area,
    );
}

fn render_apply_all_confirmation(frame: &mut Frame<'_>, ready: usize) {
    let area = centered_rect(frame.size(), 52, 7);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(format!("Apply all {ready} ready rows?")),
            Line::from(""),
            Line::from("Enter: apply all    Esc: cancel"),
        ])
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Confirm apply all"),
        ),
        area,
    );
}

fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    let width = std::cmp::min(width, area.width);
    let height = std::cmp::min(height, area.height);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

impl BackfillCursor {
    fn from_row(row: &BackfillRow) -> Self {
        Self {
            datetime: row.datetime,
            id: row.id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn row(id: i64) -> BackfillRow {
        BackfillRow {
            id,
            datetime: NaiveDate::from_ymd_opt(2026, 7, 30)
                .unwrap()
                .and_hms_opt(7, 41, 0)
                .unwrap(),
            body: "message".to_string(),
            unit: None,
            unit_v2: None,
            network: None,
        }
    }

    fn entry(id: i64) -> BackfillEntry {
        BackfillEntry {
            id,
            datetime: row(id).datetime,
            body: "message".to_string(),
            network_id: 5,
            current_network: None,
            current_unit: None,
            proposed_network: Some("network".to_string()),
            proposed_unit: Some("unit".to_string()),
            status: BackfillStatus::Ready,
        }
    }

    #[test]
    fn builds_preview_from_one_calculated_network() {
        let entry = build_backfill_entry(
            row(3008768),
            &HashMap::from([(3008768, BTreeSet::from([5]))]),
            &HashMap::from([(5, "💻".to_string())]),
            &HashMap::from([(
                5,
                BTreeSet::from(["4 зБпС 50 обрБпС".to_string()]),
            )]),
        )
        .unwrap();

        assert_eq!(entry.proposed_network.as_deref(), Some("💻"));
        assert_eq!(entry.proposed_unit.as_deref(), Some("4 зБпС 50 обрБпС"));
    }

    #[test]
    fn combines_network_and_unit_for_display() {
        assert_eq!(
            network_with_unit(Some("💻"), Some("4 зБпС 50 обрБпС"), "<empty>",),
            "💻 — 4 зБпС 50 обрБпС",
        );
    }

    #[test]
    fn parses_start_date_at_midnight() {
        assert_eq!(
            parse_start_date("2026-07-01").unwrap(),
            NaiveDate::from_ymd_opt(2026, 7, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        );
    }

    #[test]
    fn rejects_start_datetime() {
        assert!(parse_start_date("2026-07-01T00:00:00").is_err());
    }

    #[test]
    fn empty_range_reports_newest_eligible_date() {
        let since_ts = NaiveDate::from_ymd_opt(2027, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let newest = NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(7, 51, 49)
            .unwrap();

        let message = empty_result_message(since_ts, 0, Some(newest));

        assert!(message.contains("newest eligible message is 2026-07-30"));
        assert!(message.contains("try --start 2026-07-30"));
    }

    #[test]
    fn scanned_range_without_candidates_reports_matching_fields() {
        let since_ts = NaiveDate::from_ymd_opt(2026, 7, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();

        let message = empty_result_message(since_ts, 42, None);

        assert!(message.contains("scanned 42 eligible messages"));
        assert!(message.contains("all fields already match"));
    }

    #[test]
    fn table_navigation_stays_within_loaded_rows() {
        let since_ts = row(1).datetime;
        let mut app = BackfillApp::new(
            since_ts,
            100,
            BackfillLoad {
                rows: vec![entry(1), entry(2)],
                scanned: 2,
            },
        );

        assert_eq!(app.selected_index(), Some(0));
        app.select_previous();
        assert_eq!(app.selected_index(), Some(0));
        app.select_next();
        app.select_next();
        assert_eq!(app.selected_index(), Some(1));
        app.select_page(false);
        assert_eq!(app.selected_index(), Some(0));
    }

    #[test]
    fn preview_revalidation_detects_changed_body() {
        let expected = entry(1);
        let mut latest = expected.clone();
        latest.body = "changed message".to_string();

        assert!(!same_preview(&expected, &latest));
    }

    #[test]
    fn skips_ambiguous_calculated_networks() {
        let entry = build_backfill_entry(
            row(1),
            &HashMap::from([(1, BTreeSet::from([5, 6]))]),
            &HashMap::from([
                (5, "network 5".to_string()),
                (6, "network 6".to_string()),
            ]),
            &HashMap::new(),
        );

        assert!(entry.is_none());
    }

    #[test]
    fn skips_fields_that_already_match_the_linked_network() {
        let mut row = row(1);
        row.network = Some("calculated network".to_string());
        row.unit_v2 = Some("calculated unit".to_string());
        let entry = build_backfill_entry(
            row,
            &HashMap::from([(1, BTreeSet::from([5]))]),
            &HashMap::from([(5, "calculated network".to_string())]),
            &HashMap::from([(
                5,
                BTreeSet::from(["calculated unit".to_string()]),
            )]),
        );

        assert!(entry.is_none());
    }

    #[test]
    fn linked_network_takes_precedence_over_stored_freeform_fields() {
        let mut row = row(1);
        row.network = Some("freeform network".to_string());
        row.unit_v2 = Some("freeform unit".to_string());
        let entry = build_backfill_entry(
            row,
            &HashMap::from([(1, BTreeSet::from([5]))]),
            &HashMap::from([(5, "linked network".to_string())]),
            &HashMap::from([(5, BTreeSet::from(["linked unit".to_string()]))]),
        )
        .unwrap();

        assert_eq!(entry.proposed_network.as_deref(), Some("linked network"));
        assert_eq!(entry.proposed_unit.as_deref(), Some("linked unit"));
    }
}
