use crate::ai_callsign::worker::WorkerConfig;
use crate::config::{
    CALLSIGN_REPROCESS_TUI_BODY_PREVIEW_CHARS,
    CALLSIGN_REPROCESS_TUI_CELL_MAX_CHARS,
    CALLSIGN_REPROCESS_TUI_EVENT_POLL_MS, CALLSIGN_REPROCESS_TUI_PAGE_STEP,
    CALLSIGN_REPROCESS_TUI_PREVIEW_HEIGHT,
    CALLSIGN_REPROCESS_TUI_PREVIEW_PAGE_STEP,
};
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::callsigns::{
    load_existing_callsigns, load_unreviewed_inbox_items,
    next_reprocess_window_end, parse_reprocess_period,
    persist_recomputed_inbox_item_callsigns, recompute_inbox_item_callsigns,
    reprocess_parser_banner, RecomputedInboxCallsigns,
};
use crate::types::{Mode, ShortContext};
use crate::{new_pg_pool_from_mode, OneoffReprocessCallsignsPs};
use chrono::NaiveDateTime;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{
    Block, Borders, Paragraph, Row, Table, TableState, Wrap,
};
use ratatui::{Frame, Terminal};
use sea_orm::{DatabaseConnection, TransactionTrait};
use std::collections::{HashMap, VecDeque};
use std::io::{self, Stdout};
use std::ops::{Deref, DerefMut};
use std::time::Duration;
use uuid::Uuid;

struct ReprocessRow {
    id: i64,
    datetime: NaiveDateTime,
    before: Vec<String>,
    after: Vec<String>,
    body: String,
}

impl ReprocessRow {
    fn from_recomputed(recomputed: RecomputedInboxCallsigns) -> Self {
        Self {
            id: recomputed.inbox_item_id,
            datetime: recomputed.datetime,
            before: recomputed.before,
            after: recomputed.after,
            body: recomputed.body,
        }
    }

    fn changed(&self) -> bool {
        self.before != self.after
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReprocessStatus {
    Running,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Focus {
    Table,
    Preview,
}

struct PendingHour {
    items: VecDeque<(sigint_inbox_item::Model, Option<signal_message::Model>)>,
    callsigns_by_item_id:
        HashMap<i64, crate::inbox::callsigns::InboxItemCallsigns>,
}

struct ReprocessApp {
    start_dt: NaiveDateTime,
    end_dt: NaiveDateTime,
    hour_start: NaiveDateTime,
    pending: PendingHour,
    rows: Vec<ReprocessRow>,
    table_state: TableState,
    show_all: bool,
    use_ai: bool,
    ai_config: Option<WorkerConfig>,
    follow_latest: bool,
    focus: Focus,
    preview_scroll: u16,
    preview_max_scroll: u16,
    previewed_id: Option<i64>,
    processed: u64,
    changed: u64,
    unchanged: u64,
    skipped: u64,
    status: ReprocessStatus,
    message: Option<String>,
}

impl ReprocessApp {
    fn new(
        start_dt: NaiveDateTime,
        end_dt: NaiveDateTime,
        ai_config: Option<WorkerConfig>,
    ) -> Self {
        let use_ai = ai_config.is_some();
        let message = Some(reprocess_parser_banner(ai_config.as_ref()));
        Self {
            start_dt,
            end_dt,
            hour_start: start_dt,
            pending: PendingHour {
                items: VecDeque::new(),
                callsigns_by_item_id: HashMap::new(),
            },
            rows: Vec::new(),
            table_state: TableState::default(),
            show_all: false,
            use_ai,
            ai_config,
            follow_latest: true,
            focus: Focus::Table,
            preview_scroll: 0,
            preview_max_scroll: 0,
            previewed_id: None,
            processed: 0,
            changed: 0,
            unchanged: 0,
            skipped: 0,
            status: ReprocessStatus::Running,
            message,
        }
    }

    fn visible_indexes(&self) -> Vec<usize> {
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, row)| self.show_all || row.changed())
            .map(|(index, _)| index)
            .collect()
    }

    fn selected_row(&self) -> Option<&ReprocessRow> {
        let visible = self.visible_indexes();
        let selected = self.table_state.selected()?;
        visible
            .get(selected)
            .and_then(|index| self.rows.get(*index))
    }

    fn select_visible(&mut self, index: Option<usize>) {
        let Some(last) = last_index(self.visible_indexes().len()) else {
            self.table_state.select(None);
            self.follow_latest = true;
            return;
        };
        let selected = index.unwrap_or(0).min(last);
        self.table_state.select(Some(selected));
        self.follow_latest = selected == last;
    }

    fn select_id(&mut self, inbox_item_id: Option<i64>) {
        let visible = self.visible_indexes();
        let selected = inbox_item_id.and_then(|inbox_item_id| {
            visible.iter().position(|index| {
                self.rows
                    .get(*index)
                    .is_some_and(|row| row.id == inbox_item_id)
            })
        });
        self.select_visible(selected.or_else(|| last_index(visible.len())));
    }

    fn select_offset(&mut self, delta: isize) {
        let Some(last) = last_index(self.visible_indexes().len()) else {
            self.select_visible(None);
            return;
        };
        let current = self.table_state.selected().unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, last as isize);
        self.select_visible(Some(next as usize));
    }

    fn toggle_show_all(&mut self) {
        let selected_id = self.selected_row().map(|row| row.id);
        self.show_all = !self.show_all;
        self.select_id(selected_id);
    }

    fn toggle_use_ai(&mut self) {
        if self.ai_config.is_none() {
            self.message = Some(
                "AI worker is not configured on this instance".to_string(),
            );
            return;
        }
        self.use_ai = !self.use_ai;
        self.message = Some(if self.use_ai {
            format!(
                "next items use AI parsing ({})",
                self.ai_config
                    .as_ref()
                    .map(|ai| ai.ai_engine.name.as_str())
                    .unwrap_or("AI")
            )
        } else {
            "next items use regular parser".to_string()
        });
    }

    fn active_ai_config(&self) -> Option<&WorkerConfig> {
        self.use_ai.then_some(self.ai_config.as_ref()).flatten()
    }

    fn push_row(&mut self, row: ReprocessRow) {
        let changed = row.changed();
        let row_id = row.id;
        self.rows.push(row);
        if changed {
            self.changed += 1;
        } else {
            self.unchanged += 1;
        }
        if self.focus == Focus::Table
            && self.follow_latest
            && (self.show_all || changed)
        {
            self.select_id(Some(row_id));
        }
    }

    fn toggle_focus(&mut self) {
        self.focus = match self.focus {
            Focus::Table => Focus::Preview,
            Focus::Preview => Focus::Table,
        };
    }

    fn scroll_preview(&mut self, delta: i32) {
        let next = i32::from(self.preview_scroll).saturating_add(delta);
        self.preview_scroll =
            next.clamp(0, i32::from(self.preview_max_scroll)) as u16;
    }

    fn sync_preview_row(&mut self) {
        let id = self.selected_row().map(|row| row.id);
        if id != self.previewed_id {
            self.previewed_id = id;
            self.preview_scroll = 0;
        }
    }
}

pub async fn run(
    mode: Mode,
    ps: &OneoffReprocessCallsignsPs,
) -> Result<(), AppError> {
    let (start_dt, end_dt) = parse_reprocess_period(&ps.start, &ps.end)?;
    if start_dt >= end_dt {
        return Err(AppError::BL {
            msg: "--start must be earlier than --end".to_string(),
        });
    }
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let rq = reqwest::Client::new();
    let system_login_id = crate::users::system_login_id(&db).await.c(h!())?;
    let ai_config = crate::ai_callsign::worker::load_worker_config(&db).await?;
    let mut app = ReprocessApp::new(start_dt, end_dt, ai_config);
    let mut terminal = RestoringTerminal::new().c(h!())?;
    let run_result = {
        let _quiet_logs = QuietLogs::new();
        run_app(&db, &rq, system_login_id, &mut terminal, &mut app).await
    };
    terminal.restore().c(h!())?;
    run_result?;
    println!(
        "done! processed={} changed={} unchanged={} skipped={}",
        app.processed, app.changed, app.unchanged, app.skipped
    );
    Ok(())
}

struct QuietLogs {
    previous: log::LevelFilter,
}

impl QuietLogs {
    fn new() -> Self {
        let previous = log::max_level();
        log::set_max_level(log::LevelFilter::Off);
        Self { previous }
    }
}

impl Drop for QuietLogs {
    fn drop(&mut self) {
        log::set_max_level(self.previous);
    }
}

struct RestoringTerminal {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    restored: bool,
}

impl RestoringTerminal {
    fn new() -> io::Result<Self> {
        match setup_terminal() {
            Ok(terminal) => Ok(Self {
                terminal,
                restored: false,
            }),
            Err(error) => {
                let _ = restore_stdout();
                Err(error)
            }
        }
    }

    fn restore(&mut self) -> io::Result<()> {
        if self.restored {
            return Ok(());
        }
        let result = restore_terminal(&mut self.terminal);
        if result.is_ok() {
            self.restored = true;
        }
        result
    }
}

impl Deref for RestoringTerminal {
    type Target = Terminal<CrosstermBackend<Stdout>>;

    fn deref(&self) -> &Self::Target {
        &self.terminal
    }
}

impl DerefMut for RestoringTerminal {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.terminal
    }
}

impl Drop for RestoringTerminal {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            log::error!(
                "failed to restore callsign reprocess terminal: {error}"
            );
        }
    }
}

fn setup_terminal() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;
    Terminal::new(CrosstermBackend::new(stdout))
}

fn restore_stdout() -> io::Result<()> {
    let raw = disable_raw_mode();
    let leave = execute!(io::stdout(), LeaveAlternateScreen, cursor::Show);
    raw.and(leave)
}

fn restore_terminal(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
) -> io::Result<()> {
    let stdout = restore_stdout();
    let cursor = terminal.show_cursor();
    stdout.and(cursor)
}

fn last_index(len: usize) -> Option<usize> {
    len.checked_sub(1)
}

async fn run_app(
    db: &DatabaseConnection,
    rq: &reqwest::Client,
    system_login_id: Uuid,
    terminal: &mut RestoringTerminal,
    app: &mut ReprocessApp,
) -> Result<(), AppError> {
    let poll = Duration::from_millis(CALLSIGN_REPROCESS_TUI_EVENT_POLL_MS);
    loop {
        terminal.draw(|frame| draw_ui(frame, app)).c(h!())?;
        if event::poll(Duration::from_millis(0)).c(h!())? {
            if handle_event(app, event::read().c(h!())?) {
                return Ok(());
            }
            continue;
        }
        if app.status == ReprocessStatus::Running {
            advance_work(db, rq, system_login_id, app).await?;
            continue;
        }
        if !event::poll(poll).c(h!())? {
            continue;
        }
        if handle_event(app, event::read().c(h!())?) {
            return Ok(());
        }
    }
}

fn handle_event(app: &mut ReprocessApp, event: Event) -> bool {
    let Event::Key(key) = event else {
        return false;
    };
    if key.kind != KeyEventKind::Press {
        return false;
    }
    match key.code {
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            true
        }
        KeyCode::Char('q') | KeyCode::Esc => true,
        KeyCode::Tab | KeyCode::BackTab => {
            app.toggle_focus();
            false
        }
        _ if app.focus == Focus::Preview => handle_preview_key(app, key.code),
        KeyCode::Up => {
            app.select_offset(-1);
            false
        }
        KeyCode::Down => {
            app.select_offset(1);
            false
        }
        KeyCode::PageUp => {
            app.select_offset(-(CALLSIGN_REPROCESS_TUI_PAGE_STEP as isize));
            false
        }
        KeyCode::PageDown => {
            app.select_offset(CALLSIGN_REPROCESS_TUI_PAGE_STEP as isize);
            false
        }
        KeyCode::Home => {
            app.select_visible(
                last_index(app.visible_indexes().len()).map(|_| 0),
            );
            false
        }
        KeyCode::End => {
            app.select_visible(last_index(app.visible_indexes().len()));
            false
        }
        KeyCode::Char(' ') | KeyCode::Char('s') => {
            app.toggle_show_all();
            false
        }
        KeyCode::Char('a') => {
            app.toggle_use_ai();
            false
        }
        _ => false,
    }
}

fn handle_preview_key(app: &mut ReprocessApp, code: KeyCode) -> bool {
    match code {
        KeyCode::Up => app.scroll_preview(-1),
        KeyCode::Down => app.scroll_preview(1),
        KeyCode::PageUp => {
            app.scroll_preview(-i32::from(
                CALLSIGN_REPROCESS_TUI_PREVIEW_PAGE_STEP,
            ));
        }
        KeyCode::PageDown => {
            app.scroll_preview(i32::from(
                CALLSIGN_REPROCESS_TUI_PREVIEW_PAGE_STEP,
            ));
        }
        KeyCode::Home => app.preview_scroll = 0,
        KeyCode::End => app.preview_scroll = app.preview_max_scroll,
        KeyCode::Char(' ') | KeyCode::Char('s') => app.toggle_show_all(),
        KeyCode::Char('a') => app.toggle_use_ai(),
        _ => {}
    }
    false
}

async fn advance_work(
    db: &DatabaseConnection,
    rq: &reqwest::Client,
    system_login_id: Uuid,
    app: &mut ReprocessApp,
) -> Result<(), AppError> {
    if app.pending.items.is_empty() {
        load_next_hour(db, app).await?;
        return Ok(());
    }
    process_next_item(db, rq, system_login_id, app).await
}

async fn load_next_hour(
    db: &DatabaseConnection,
    app: &mut ReprocessApp,
) -> Result<(), AppError> {
    if app.start_dt >= app.end_dt {
        app.status = ReprocessStatus::Done;
        app.message = Some("finished period".to_string());
        return Ok(());
    }
    let hour_end = next_reprocess_window_end(app.start_dt, app.end_dt);
    app.hour_start = app.start_dt;
    let items = load_unreviewed_inbox_items(db, app.start_dt, hour_end).await?;
    let callsigns_by_item_id = load_existing_callsigns(
        db,
        items.iter().map(|(inbox_item, _)| inbox_item.id),
    )
    .await?;
    app.pending = PendingHour {
        items: items.into(),
        callsigns_by_item_id,
    };
    app.start_dt += chrono::Duration::hours(1);
    app.message = Some(format!(
        "loaded {} unreviewed messages for {} .. {}",
        app.pending.items.len(),
        app.hour_start,
        hour_end
    ));
    Ok(())
}

async fn process_next_item(
    db: &DatabaseConnection,
    rq: &reqwest::Client,
    system_login_id: Uuid,
    app: &mut ReprocessApp,
) -> Result<(), AppError> {
    let Some((inbox_item, message)) = app.pending.items.pop_front() else {
        return Ok(());
    };
    let existing = app
        .pending
        .callsigns_by_item_id
        .remove(&inbox_item.id)
        .unwrap_or_default();
    let inbox_item_id = inbox_item.id;
    let recomputed = match recompute_inbox_item_callsigns(
        db,
        rq,
        &inbox_item,
        message.as_ref(),
        existing,
        app.active_ai_config(),
    )
    .await
    {
        Ok(recomputed) => recomputed,
        Err(error) => {
            app.skipped += 1;
            app.message =
                Some(format!("parse failed for {inbox_item_id}: {error}"));
            return Ok(());
        }
    };
    let Some(recomputed) = recomputed else {
        app.skipped += 1;
        return Ok(());
    };
    let txn = db.begin().await.c(h!())?;
    persist_recomputed_inbox_item_callsigns(
        &txn,
        inbox_item,
        &recomputed,
        system_login_id,
    )
    .await?;
    txn.commit().await.c(h!())?;
    app.processed += 1;
    app.push_row(ReprocessRow::from_recomputed(recomputed));
    Ok(())
}

fn draw_ui(frame: &mut Frame<'_>, app: &mut ReprocessApp) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5),
            Constraint::Min(8),
            Constraint::Length(CALLSIGN_REPROCESS_TUI_PREVIEW_HEIGHT),
            Constraint::Length(4),
        ])
        .split(frame.size());
    render_summary(frame, root[0], app);
    render_table(frame, root[1], app);
    app.sync_preview_row();
    render_preview(frame, root[2], app);
    render_footer(frame, root[3], app);
}

fn render_summary(frame: &mut Frame<'_>, area: Rect, app: &ReprocessApp) {
    let status = match app.status {
        ReprocessStatus::Running => "running",
        ReprocessStatus::Done => "done",
    };
    let text = vec![
        Line::from(format!(
            "{status} | window {} | processed {} | changed {} | unchanged {} | skipped {}",
            app.hour_start,
            app.processed,
            app.changed,
            app.unchanged,
            app.skipped,
        )),
        Line::from(format!(
            "{} Show all    {} AI parsing    visible {} / stored {}",
            show_all_checkbox(app.show_all),
            show_all_checkbox(app.use_ai),
            app.visible_indexes().len(),
            app.rows.len(),
        )),
        Line::from(
            app.message
                .as_deref()
                .unwrap_or("Reprocessing unreviewed inbox callsigns."),
        ),
    ];
    frame.render_widget(
        Paragraph::new(text)
            .block(Block::default().borders(Borders::ALL).title("Summary")),
        area,
    );
}

fn show_all_checkbox(show_all: bool) -> &'static str {
    if show_all {
        "[x]"
    } else {
        "[ ]"
    }
}

fn render_table(frame: &mut Frame<'_>, area: Rect, app: &mut ReprocessApp) {
    let header = Row::new(["ID", "Datetime", "Before", "After"]).style(
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    );
    let rows = app.visible_indexes().into_iter().filter_map(|index| {
        let row = app.rows.get(index)?;
        Some(
            Row::new([
                row.id.to_string(),
                row.datetime.to_string(),
                compact_cell(&format_callsigns(&row.before)),
                compact_cell(&format_callsigns(&row.after)),
            ])
            .style(if row.changed() {
                Style::default().fg(Color::Yellow)
            } else {
                Style::default()
            }),
        )
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(10),
            Constraint::Length(19),
            Constraint::Percentage(40),
            Constraint::Percentage(40),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(table_title(app.show_all, app.focus))
            .border_style(focus_border(app.focus == Focus::Table)),
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

fn table_title(show_all: bool, focus: Focus) -> &'static str {
    match (show_all, focus) {
        (true, Focus::Table) => "Callsigns (all, focused)",
        (true, Focus::Preview) => "Callsigns (all)",
        (false, Focus::Table) => "Callsigns (changed only, focused)",
        (false, Focus::Preview) => "Callsigns (changed only)",
    }
}

fn focus_border(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default()
    }
}

fn render_preview(frame: &mut Frame<'_>, area: Rect, app: &mut ReprocessApp) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(preview_title(app.focus))
        .border_style(focus_border(app.focus == Focus::Preview));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let text = preview_text(app);
    let line_count = wrapped_line_count(&text, inner.width);
    let max_scroll = line_count.saturating_sub(inner.height as usize);
    app.preview_max_scroll = u16::try_from(max_scroll).unwrap_or(u16::MAX);
    app.preview_scroll = app.preview_scroll.min(app.preview_max_scroll);
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .scroll((app.preview_scroll, 0)),
        inner,
    );
}

fn preview_title(focus: Focus) -> &'static str {
    if focus == Focus::Preview {
        "Preview (focused, Tab back, Up/Down scroll)"
    } else {
        "Preview (Tab to focus)"
    }
}

fn preview_text(app: &ReprocessApp) -> String {
    match app.selected_row() {
        Some(row) => format!(
            "Message #{} | {} | {}\nBefore: {}\nAfter: {}\nBody:\n{}",
            row.id,
            row.datetime,
            if row.changed() {
                "changed"
            } else {
                "unchanged"
            },
            format_callsigns(&row.before),
            format_callsigns(&row.after),
            preview_body(&row.body),
        ),
        None => empty_preview(app),
    }
}

fn wrapped_line_count(text: &str, width: u16) -> usize {
    let width = usize::from(width.max(1));
    text.split('\n')
        .map(|line| {
            let chars = line.chars().count();
            if chars == 0 {
                1
            } else {
                chars.div_ceil(width)
            }
        })
        .sum()
}

fn empty_preview(app: &ReprocessApp) -> String {
    match app.status {
        ReprocessStatus::Running => {
            "Waiting for a changed row. Space shows unchanged rows too."
                .to_string()
        }
        ReprocessStatus::Done => {
            "No matching rows. Space shows unchanged rows, q exits.".to_string()
        }
    }
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, app: &ReprocessApp) {
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(format!(
                "Tab: table/preview    Space/s: {} Show all    a: {} AI parsing",
                show_all_checkbox(app.show_all),
                show_all_checkbox(app.use_ai),
            )),
            Line::from(
                "Up/Down/PgUp/PgDn/Home/End: move or scroll    q/Esc/Ctrl+C: exit",
            ),
        ])
        .block(Block::default().borders(Borders::ALL).title("Keys")),
        area,
    );
}

fn format_callsigns(callsigns: &[String]) -> String {
    if callsigns.is_empty() {
        return "<empty>".to_string();
    }
    callsigns.join(", ")
}

fn compact_cell(value: &str) -> String {
    if value.chars().count() <= CALLSIGN_REPROCESS_TUI_CELL_MAX_CHARS {
        return value.to_string();
    }
    let mut compact = value
        .chars()
        .take(CALLSIGN_REPROCESS_TUI_CELL_MAX_CHARS.saturating_sub(1))
        .collect::<String>();
    compact.push('…');
    compact
}

fn preview_body(body: &str) -> String {
    let body = body.replace('\r', "");
    if body.chars().count() <= CALLSIGN_REPROCESS_TUI_BODY_PREVIEW_CHARS {
        return body;
    }
    let mut preview = body
        .chars()
        .take(CALLSIGN_REPROCESS_TUI_BODY_PREVIEW_CHARS.saturating_sub(1))
        .collect::<String>();
    preview.push('…');
    preview
}

#[cfg(test)]
mod tests {
    use super::{
        format_callsigns, last_index, preview_body, show_all_checkbox,
        table_title, wrapped_line_count, Focus, ReprocessApp, ReprocessRow,
    };
    use chrono::NaiveDateTime;

    fn sample_row(id: i64, before: &[&str], after: &[&str]) -> ReprocessRow {
        ReprocessRow {
            id,
            datetime: NaiveDateTime::parse_from_str(
                "2026-08-08T00:00:00",
                "%Y-%m-%dT%H:%M:%S",
            )
            .unwrap(),
            before: before
                .iter()
                .map(|callsign| callsign.to_string())
                .collect(),
            after: after.iter().map(|callsign| callsign.to_string()).collect(),
            body: "body".to_string(),
        }
    }

    #[test]
    fn preview_body_keeps_line_breaks() {
        let body = "header\n\n— Клим, слышишь?\n— Принял.";
        assert_eq!(preview_body(body), body);
        assert!(preview_body(body).contains('\n'));
    }

    #[test]
    fn formats_empty_and_joined_callsigns() {
        assert_eq!(format_callsigns(&[]), "<empty>");
        assert_eq!(
            format_callsigns(&["ярус".to_string(), "светлый".to_string()]),
            "ярус, светлый"
        );
    }

    #[test]
    fn last_index_is_none_for_empty() {
        assert_eq!(last_index(0), None);
        assert_eq!(last_index(1), Some(0));
        assert_eq!(last_index(108), Some(107));
    }

    #[test]
    fn checkbox_and_title_follow_show_all() {
        assert_eq!(show_all_checkbox(false), "[ ]");
        assert_eq!(show_all_checkbox(true), "[x]");
        assert_eq!(
            table_title(false, Focus::Table),
            "Callsigns (changed only, focused)"
        );
        assert_eq!(table_title(true, Focus::Preview), "Callsigns (all)");
    }

    #[test]
    fn wrapped_line_count_keeps_blank_lines() {
        assert_eq!(wrapped_line_count("a\n\nbcde", 3), 4);
    }

    #[test]
    fn tab_focuses_preview_and_scroll_clamps() {
        let mut app = app_for_period();
        app.push_row(sample_row(1, &["a"], &["b"]));
        assert_eq!(app.focus, Focus::Table);
        app.toggle_focus();
        assert_eq!(app.focus, Focus::Preview);
        app.preview_max_scroll = 3;
        app.scroll_preview(10);
        assert_eq!(app.preview_scroll, 3);
        app.scroll_preview(-100);
        assert_eq!(app.preview_scroll, 0);
    }

    fn app_for_period() -> ReprocessApp {
        let start = NaiveDateTime::parse_from_str(
            "2026-08-08T00:00:00",
            "%Y-%m-%dT%H:%M:%S",
        )
        .unwrap();
        let end = NaiveDateTime::parse_from_str(
            "2026-08-09T00:00:00",
            "%Y-%m-%dT%H:%M:%S",
        )
        .unwrap();
        ReprocessApp::new(start, end, None)
    }

    #[test]
    fn hides_unchanged_rows_until_show_all() {
        let mut app = app_for_period();
        app.push_row(sample_row(1, &["a"], &["a"]));
        app.push_row(sample_row(2, &["a"], &["b"]));
        assert_eq!(app.visible_indexes(), vec![1]);
        app.toggle_show_all();
        assert_eq!(app.visible_indexes(), vec![0, 1]);
    }

    #[test]
    fn toggling_ai_without_config_stays_off() {
        let mut app = app_for_period();
        assert!(!app.use_ai);
        app.toggle_use_ai();
        assert!(!app.use_ai);
        assert!(app
            .message
            .as_deref()
            .is_some_and(|message| message.contains("not configured")));
    }

    #[test]
    fn toggling_show_all_off_with_only_unchanged_rows_clears_selection() {
        let mut app = app_for_period();
        app.push_row(sample_row(1, &["мирный"], &["мирный"]));
        app.toggle_show_all();
        assert_eq!(app.visible_indexes(), vec![0]);
        assert_eq!(app.table_state.selected(), Some(0));
        app.toggle_show_all();
        assert!(app.visible_indexes().is_empty());
        assert_eq!(app.table_state.selected(), None);
    }
}
