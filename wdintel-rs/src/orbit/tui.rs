use super::test_link::{
    ReviewInput, ReviewMatch, ReviewSession, ReviewSummary, ReviewUnit,
};
use crate::config::{
    ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE, ORBIT_TUI_EVENT_POLL_MS,
};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, List, ListItem, ListState, Paragraph, Wrap,
};
use ratatui::{Frame, Terminal};
use similar::{ChangeTag, TextDiff};
use std::io::{self, Stdout};
use std::ops::{Deref, DerefMut};
use std::time::Duration;

type RatatuiTerminal = Terminal<CrosstermBackend<Stdout>>;

pub struct OrbitTerminal {
    terminal: RatatuiTerminal,
    restored: bool,
}

impl OrbitTerminal {
    fn restore(&mut self) -> io::Result<()> {
        if self.restored {
            return Ok(());
        }
        let result = restore_terminal_state(&mut self.terminal);
        self.restored = result.is_ok();
        result
    }
}

impl Deref for OrbitTerminal {
    type Target = RatatuiTerminal;

    fn deref(&self) -> &Self::Target {
        &self.terminal
    }
}

impl DerefMut for OrbitTerminal {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.terminal
    }
}

impl Drop for OrbitTerminal {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            log::error!("failed to restore ORBIT terminal: {error}");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartAction {
    PrepareImport,
    Import,
    LinkUnits,
    MergeUnitDuplicates,
    ResolveUnparsedUnits,
    ReconcileSigintUnits,
    Reimport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkMode {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Skip,
    SkipAll,
    Quit,
}

pub(super) struct DuplicateReviewCandidate {
    pub unit: ReviewUnit,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DuplicateReviewDecision {
    Select(usize),
    Skip,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrichmentDecision {
    Confirm,
    Deny,
    ConfirmAll,
    DenyAll,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Delete,
    Merge,
}

impl Action {
    fn key(self) -> char {
        match self {
            Self::Delete => 'd',
            Self::Merge => 'm',
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Delete => "delete",
            Self::Merge => "merge",
        }
    }
}

pub fn prompt_start_action() -> Result<Option<StartAction>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_start_menu(&mut terminal);
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn prompt_link_mode() -> Result<Option<LinkMode>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_link_mode_menu(&mut terminal);
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn prompt_orbit_source_path() -> Result<Option<String>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_text_prompt(
        &mut terminal,
        "Path to the new ORBIT JSON revision (Enter: import, Esc: quit)",
    );
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn confirm_unchanged_archive(
    archive_md5: &str,
    synced_at: chrono::NaiveDateTime,
) -> Result<bool, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_unchanged_archive_confirmation(
        &mut terminal,
        archive_md5,
        synced_at,
    );
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn confirm_reimport() -> Result<bool, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_text_prompt(
        &mut terminal,
        "Type REIMPORT to erase all ORBIT data and reimport (Esc: cancel)",
    );
    restore_terminal(&mut terminal).c(h!())?;
    Ok(is_reimport_confirmed(result?.as_deref()))
}

pub fn confirm_sigint_unit_reconciliation() -> Result<bool, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_text_prompt(
        &mut terminal,
        "Type RECONCILE to review hierarchy enrichments and merge exact duplicates (Esc: cancel)",
    );
    restore_terminal(&mut terminal).c(h!())?;
    Ok(is_sigint_unit_reconciliation_confirmed(
        result.c(h!())?.as_deref(),
    ))
}

pub fn review_sigint_unit_enrichment(
    terminal: &mut OrbitTerminal,
    title: &str,
    lines: &[String],
    progress: &str,
) -> Result<EnrichmentDecision, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let mut scroll = 0_u16;
    loop {
        terminal
            .draw(|frame| {
                draw_sigint_unit_enrichment_review(
                    frame, title, lines, progress, scroll,
                )
            })
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if let Some(decision) = enrichment_decision_for_key(key) {
            return Ok(decision);
        }
        match key.code {
            KeyCode::Up => scroll = scroll.saturating_sub(1),
            KeyCode::Down => scroll = scroll.saturating_add(1),
            KeyCode::PageUp => scroll = scroll.saturating_sub(10),
            KeyCode::PageDown => scroll = scroll.saturating_add(10),
            KeyCode::Home => scroll = 0,
            _ => {}
        }
    }
}

fn is_reimport_confirmed(input: Option<&str>) -> bool {
    input == Some("REIMPORT")
}

fn is_sigint_unit_reconciliation_confirmed(input: Option<&str>) -> bool {
    input == Some("RECONCILE")
}

pub fn setup_terminal() -> io::Result<OrbitTerminal> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    if let Err(error) = execute!(stdout, EnterAlternateScreen, cursor::Hide) {
        if let Err(cleanup_error) = restore_stdout_state() {
            log::error!(
                "failed to restore ORBIT terminal after setup error: {cleanup_error}"
            );
        }
        return Err(error);
    }
    let terminal = match Terminal::new(CrosstermBackend::new(stdout)) {
        Ok(terminal) => terminal,
        Err(error) => {
            if let Err(cleanup_error) = restore_stdout_state() {
                log::error!(
                    "failed to restore ORBIT terminal after setup error: {cleanup_error}"
                );
            }
            return Err(error);
        }
    };
    Ok(OrbitTerminal {
        terminal,
        restored: false,
    })
}

pub fn restore_terminal(terminal: &mut OrbitTerminal) -> io::Result<()> {
    terminal.restore()
}

pub(super) fn run_test_link_review(
    terminal: &mut OrbitTerminal,
    session: &mut ReviewSession,
) -> Result<ReviewSummary, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    loop {
        if session.is_complete() {
            return Ok(session.completed_summary());
        }
        let terminal_area = terminal.size().c(h!())?;
        let maximum_scroll = test_link_maximum_scroll(terminal_area, session);
        let page_size = test_link_page_size(terminal_area);
        session.clamp_scroll(maximum_scroll);
        terminal
            .draw(|frame| draw_test_link_review(frame, session))
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        let Some(input) = test_link_input_for_key(key) else {
            continue;
        };
        if input == ReviewInput::RequestExit {
            if confirm_test_link_exit(terminal).c(h!())? {
                return Ok(session.finish_early());
            }
            continue;
        }
        if let Some(summary) = session.apply(input, maximum_scroll, page_size) {
            return Ok(summary);
        }
    }
}

pub(super) fn review_duplicate_unit_group(
    terminal: &mut OrbitTerminal,
    candidates: &[DuplicateReviewCandidate],
    group_index: usize,
    group_count: usize,
) -> Result<DuplicateReviewDecision, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let page_count = candidates
        .len()
        .div_ceil(ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE);
    let mut page = 0;
    let mut scroll = 0_u16;
    loop {
        terminal
            .draw(|frame| {
                draw_duplicate_unit_group_review(
                    frame,
                    candidates,
                    group_index,
                    group_count,
                    page,
                    page_count,
                    scroll,
                )
            })
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if let Some(decision) =
            duplicate_review_decision_for_key(key, page, candidates.len())
        {
            return Ok(decision);
        }
        if key.kind != KeyEventKind::Press || !key.modifiers.is_empty() {
            continue;
        }
        match key.code {
            KeyCode::Char('f') if page + 1 < page_count => {
                page += 1;
                scroll = 0;
            }
            KeyCode::Char('b') if page > 0 => {
                page -= 1;
                scroll = 0;
            }
            KeyCode::Up => scroll = scroll.saturating_sub(1),
            KeyCode::Down => scroll = scroll.saturating_add(1),
            KeyCode::PageUp => scroll = scroll.saturating_sub(10),
            KeyCode::PageDown => scroll = scroll.saturating_add(10),
            KeyCode::Home => scroll = 0,
            _ => {}
        }
    }
}

fn restore_stdout_state() -> io::Result<()> {
    let mut first_error = None;
    record_cleanup_error(&mut first_error, disable_raw_mode());
    let mut stdout = io::stdout();
    record_cleanup_error(
        &mut first_error,
        execute!(stdout, LeaveAlternateScreen, cursor::Show),
    );
    cleanup_result(first_error)
}

fn restore_terminal_state(terminal: &mut RatatuiTerminal) -> io::Result<()> {
    let mut first_error = None;
    record_cleanup_error(&mut first_error, disable_raw_mode());
    record_cleanup_error(
        &mut first_error,
        execute!(terminal.backend_mut(), LeaveAlternateScreen, cursor::Show),
    );
    record_cleanup_error(&mut first_error, terminal.show_cursor());
    cleanup_result(first_error)
}

fn record_cleanup_error(
    first_error: &mut Option<io::Error>,
    result: io::Result<()>,
) {
    if first_error.is_none() {
        *first_error = result.err();
    }
}

fn cleanup_result(first_error: Option<io::Error>) -> io::Result<()> {
    first_error.map_or(Ok(()), Err)
}

pub fn review(
    terminal: &mut OrbitTerminal,
    title: &str,
    context: Option<&str>,
    lines: &[String],
    progress: &str,
    action: Action,
    allow_skip_all: bool,
) -> Result<Decision, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let mut scroll = 0_u16;
    loop {
        terminal
            .draw(|frame| {
                draw_review(
                    frame,
                    title,
                    context,
                    lines,
                    progress,
                    action,
                    allow_skip_all,
                    scroll,
                )
            })
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if let Some(decision) = decision_for_key(key, action, allow_skip_all) {
            return Ok(decision);
        }
        match key.code {
            KeyCode::Up => scroll = scroll.saturating_sub(1),
            KeyCode::Down => scroll = scroll.saturating_add(1),
            KeyCode::PageUp => scroll = scroll.saturating_sub(10),
            KeyCode::PageDown => scroll = scroll.saturating_add(10),
            KeyCode::Home => scroll = 0,
            _ => {}
        }
    }
}

fn run_start_menu(
    terminal: &mut OrbitTerminal,
) -> Result<Option<StartAction>, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let actions = [
        StartAction::PrepareImport,
        StartAction::Import,
        StartAction::LinkUnits,
        StartAction::MergeUnitDuplicates,
        StartAction::ResolveUnparsedUnits,
        StartAction::ReconcileSigintUnits,
        StartAction::Reimport,
    ];
    let mut selected = 0;
    loop {
        terminal
            .draw(|frame| draw_start_menu(frame, selected))
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                return Ok(None);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                return Ok(Some(actions[selected]));
            }
            KeyCode::Up if key.modifiers.is_empty() => {
                selected = selected.saturating_sub(1)
            }
            KeyCode::Down if key.modifiers.is_empty() => {
                selected = (selected + 1).min(actions.len() - 1)
            }
            _ => {}
        }
    }
}

fn run_link_mode_menu(
    terminal: &mut OrbitTerminal,
) -> Result<Option<LinkMode>, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let modes = [LinkMode::Automatic, LinkMode::Manual];
    let mut selected = 0;
    loop {
        terminal
            .draw(|frame| draw_link_mode_menu(frame, selected))
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                return Ok(None);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                return Ok(Some(modes[selected]));
            }
            KeyCode::Up if key.modifiers.is_empty() => {
                selected = selected.saturating_sub(1)
            }
            KeyCode::Down if key.modifiers.is_empty() => {
                selected = (selected + 1).min(modes.len() - 1)
            }
            _ => {}
        }
    }
}

fn run_text_prompt(
    terminal: &mut OrbitTerminal,
    title: &str,
) -> Result<Option<String>, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let mut input = String::new();
    loop {
        terminal
            .draw(|frame| draw_text_prompt(frame, title, &input))
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                return Ok(None);
            }
            KeyCode::Enter
                if key.modifiers.is_empty() && !input.trim().is_empty() =>
            {
                return Ok(Some(input.trim().to_string()));
            }
            KeyCode::Backspace if key.modifiers.is_empty() => {
                input.pop();
            }
            KeyCode::Char(character)
                if key.modifiers.is_empty()
                    || key.modifiers == KeyModifiers::SHIFT =>
            {
                input.push(character)
            }
            _ => {}
        }
    }
}

fn run_unchanged_archive_confirmation(
    terminal: &mut OrbitTerminal,
    archive_md5: &str,
    synced_at: chrono::NaiveDateTime,
) -> Result<bool, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    loop {
        terminal
            .draw(|frame| {
                draw_unchanged_archive_warning(frame, archive_md5, synced_at)
            })
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Enter | KeyCode::Char('y') if key.modifiers.is_empty() => {
                return Ok(true);
            }
            KeyCode::Esc | KeyCode::Char('n') if key.modifiers.is_empty() => {
                return Ok(false);
            }
            KeyCode::Char('c')
                if key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                return Ok(false);
            }
            _ => {}
        }
    }
}

fn test_link_input_for_key(key: KeyEvent) -> Option<ReviewInput> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.code == KeyCode::Esc
        || key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        return Some(ReviewInput::RequestExit);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Enter | KeyCode::Char('y') => Some(ReviewInput::Accept(0)),
        KeyCode::Char(option @ '1'..='5') => Some(ReviewInput::Accept(
            option.to_digit(10).expect("digit key must be numeric") as usize
                - 1,
        )),
        KeyCode::Char('0') | KeyCode::Char('n') => Some(ReviewInput::Deny),
        KeyCode::Char('f') => Some(ReviewInput::NextMatchPage),
        KeyCode::Char('b') => Some(ReviewInput::PreviousMatchPage),
        KeyCode::Up => Some(ReviewInput::ScrollUp),
        KeyCode::Down => Some(ReviewInput::ScrollDown),
        KeyCode::PageUp => Some(ReviewInput::PageUp),
        KeyCode::PageDown => Some(ReviewInput::PageDown),
        KeyCode::Char('q') => Some(ReviewInput::RequestExit),
        _ => None,
    }
}

fn confirm_test_link_exit(
    terminal: &mut OrbitTerminal,
) -> Result<bool, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    loop {
        terminal.draw(draw_test_link_exit_confirmation).c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if let Some(confirmed) = test_link_exit_confirmation_for_key(key) {
            return Ok(confirmed);
        }
    }
}

fn test_link_exit_confirmation_for_key(key: KeyEvent) -> Option<bool> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.code == KeyCode::Char('c')
        && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        return Some(true);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('q') => Some(true),
        KeyCode::Esc | KeyCode::Char('n') => Some(false),
        _ => None,
    }
}

fn draw_test_link_review(frame: &mut Frame<'_>, session: &ReviewSession) {
    let sections = test_link_sections(frame.size());
    let (current, total) = session.progress();
    frame.render_widget(
        Paragraph::new(format!("Progress: {current} / {total}")),
        sections[0],
    );
    frame.render_widget(
        Paragraph::new(test_link_review_text(session))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("SIGINT–ORBIT match review"),
            )
            .scroll((session.scroll().min(u16::MAX as usize) as u16, 0))
            .wrap(Wrap { trim: false }),
        sections[1],
    );
    frame.render_widget(
        Paragraph::new(
            "Enter/y/1–5: accept option | f/b: next/previous 5 | 0/n: deny\n↑/↓/PgUp/PgDn: scroll | q/Esc/Ctrl-C: stop",
        ),
        sections[2],
    );
}

fn draw_duplicate_unit_group_review(
    frame: &mut Frame<'_>,
    candidates: &[DuplicateReviewCandidate],
    group_index: usize,
    group_count: usize,
    page: usize,
    page_count: usize,
    scroll: u16,
) {
    let sections = test_link_sections(frame.size());
    let start = page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE;
    let end =
        (start + ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE).min(candidates.len());
    frame.render_widget(
        Paragraph::new(format!(
            "Duplicate group {group_index} / {group_count} | candidates {}–{} | page {}/{}",
            start + 1,
            end,
            page + 1,
            page_count,
        )),
        sections[0],
    );
    frame.render_widget(
        Paragraph::new(Text::from(duplicate_unit_group_review_lines(
            &candidates[start..end],
        )))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Choose the SIGINT unit to keep"),
        )
        .scroll((scroll, 0))
        .wrap(Wrap { trim: false }),
        sections[1],
    );
    frame.render_widget(
        Paragraph::new(
            "Enter/y/1–5: keep option and merge the others | f/b: next/previous 5 | 0/n: skip group\n↑/↓/PgUp/PgDn: scroll | q/Esc/Ctrl-C: stop",
        ),
        sections[2],
    );
}

fn duplicate_unit_group_review_lines(
    candidates: &[DuplicateReviewCandidate],
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (option, candidate) in candidates.iter().enumerate() {
        let orbit_match = candidate
            .unit
            .matches
            .first()
            .expect("duplicate review candidate must have an ORBIT match");
        lines.push(Line::styled(
            format!(
                "[{}] SIGINT unit ID: {} | active: {} | name: {}",
                option + 1,
                candidate.unit.sigint_unit_id,
                candidate.active,
                candidate.unit.sigint_unit_name,
            ),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
        lines.extend(test_link_match_lines(
            option + 1,
            &candidate.unit,
            orbit_match,
        ));
        lines.push(Line::default());
    }
    lines
}

fn duplicate_review_decision_for_key(
    key: KeyEvent,
    page: usize,
    candidate_count: usize,
) -> Option<DuplicateReviewDecision> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.code == KeyCode::Esc
        || key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        return Some(DuplicateReviewDecision::Quit);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    let visible_count = candidate_count
        .saturating_sub(page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE)
        .min(ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE);
    match key.code {
        KeyCode::Char('q') => Some(DuplicateReviewDecision::Quit),
        KeyCode::Char('0') | KeyCode::Char('n') => {
            Some(DuplicateReviewDecision::Skip)
        }
        KeyCode::Enter | KeyCode::Char('y') if visible_count > 0 => {
            Some(DuplicateReviewDecision::Select(
                page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE,
            ))
        }
        KeyCode::Char(option @ '1'..='5') => {
            let option = option.to_digit(10).expect("digit must be numeric")
                as usize
                - 1;
            (option < visible_count).then_some(DuplicateReviewDecision::Select(
                page * ORBIT_TEST_LINK_UNITS_MATCH_PAGE_SIZE + option,
            ))
        }
        _ => None,
    }
}

fn draw_test_link_exit_confirmation(frame: &mut Frame<'_>) {
    let area = centered_area(frame, 70, 7);
    frame.render_widget(
        Paragraph::new(
            "Stop the review and leave all remaining units unreviewed?\n\nEnter/y/q/Ctrl-C: stop | n/Esc: continue",
        )
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::ALL).title("Confirm stop"))
        .wrap(Wrap { trim: false }),
        area,
    );
}

fn test_link_sections(area: Rect) -> std::rc::Rc<[Rect]> {
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(area)
}

fn test_link_review_text(session: &ReviewSession) -> Text<'static> {
    Text::from(test_link_review_lines(session))
}

fn test_link_review_lines(session: &ReviewSession) -> Vec<Line<'static>> {
    let unit = session.current_unit().expect("review unit must exist");
    let visible_matches = session.visible_matches();
    let mut lines = vec![
        Line::from(format!(
            "{} ID: {}",
            unit.subject_kind.label(),
            unit.sigint_unit_id
        )),
        Line::from(format!("Name: {}", unit.sigint_unit_name)),
        Line::from(format!("Echelons: ({})", unit.echelons.join(", "))),
        Line::default(),
        Line::styled(
            format!("Potential ORBIT matches: {}", unit.matches.len()),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Line::from(test_link_match_page_label(session)),
    ];
    if unit.matches.is_empty() {
        lines.push(Line::styled(
            "No ORBIT matches exist.",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));
        return lines;
    }
    for (option, candidate) in visible_matches.iter().enumerate() {
        lines.extend(test_link_match_lines(option + 1, unit, candidate));
        lines.push(Line::default());
    }
    lines
}

fn test_link_match_page_label(session: &ReviewSession) -> String {
    let (match_page, match_page_count) = session.match_page_progress();
    let first_match = session.first_visible_match_number();
    let last_match =
        first_match + session.visible_matches().len().saturating_sub(1);
    format!(
        "Showing options {first_match}–{last_match} (page {match_page}/{match_page_count})"
    )
}

fn test_link_match_lines(
    option: usize,
    unit: &ReviewUnit,
    candidate: &ReviewMatch,
) -> Vec<Line<'static>> {
    let sigint_name = unit.echelons.join(" / ");
    let [sigint_diff, orbit_diff] =
        test_link_name_diff_lines(&sigint_name, &candidate.orbit_name);
    vec![
        Line::styled(
            format!(
                "[{option}] rating: {}, Levenshtein distance: {}",
                candidate.rating, candidate.distance,
            ),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Line::from(format!("ORBIT UUID: {}", candidate.unit_id)),
        sigint_diff,
        orbit_diff,
    ]
}

fn test_link_name_diff_lines(
    sigint_name: &str,
    orbit_name: &str,
) -> [Line<'static>; 2] {
    let label_style = Style::default().add_modifier(Modifier::BOLD);
    let matched_style = Style::default().fg(Color::Green);
    let mismatched_style = Style::default().fg(Color::Red);
    let mut sigint_spans = vec![Span::styled("INPUT: ", label_style)];
    let mut orbit_spans = vec![Span::styled(" ORBIT: ", label_style)];
    for change in
        TextDiff::from_words(sigint_name, orbit_name).iter_all_changes()
    {
        let value = change.value().to_string();
        match change.tag() {
            ChangeTag::Equal => {
                sigint_spans.push(Span::styled(value.clone(), matched_style));
                orbit_spans.push(Span::styled(value, matched_style));
            }
            ChangeTag::Delete => {
                sigint_spans.push(Span::styled(value, mismatched_style));
            }
            ChangeTag::Insert => {
                orbit_spans.push(Span::styled(value, mismatched_style));
            }
        }
    }
    [Line::from(sigint_spans), Line::from(orbit_spans)]
}

fn test_link_page_size(area: Rect) -> usize {
    test_link_sections(area)[1].height.saturating_sub(2).max(1) as usize
}

fn test_link_maximum_scroll(area: Rect, session: &ReviewSession) -> usize {
    let content_area = test_link_sections(area)[1];
    let width = content_area.width.saturating_sub(2).max(1) as usize;
    let line_count = test_link_review_lines(session)
        .into_iter()
        .map(|line| line.width().max(1).div_ceil(width))
        .sum::<usize>();
    line_count.saturating_sub(test_link_page_size(area))
}

fn draw_start_menu(frame: &mut Frame<'_>, selected: usize) {
    let area = centered_area(frame, 78, 10);
    let options = [
        "IMPORT NEW ORBIT DATA REVISION",
        "Sync ORBIT units",
        "Link ORBIT units to SIGINT units",
        "Merge duplicate SIGINT units linked to one ORBIT unit",
        "Resolve unparsed unit labels through ORBIT links",
        "Reconcile linked SIGINT units and merge exact duplicates",
        "Erase and reimport all ORBIT data",
    ];
    let items = options.into_iter().map(ListItem::new);
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Choose an action (↑/↓, Enter, Esc: quit)"),
        )
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");
    let mut state = ListState::default();
    state.select(Some(selected));
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_link_mode_menu(frame: &mut Frame<'_>, selected: usize) {
    let area = centered_area(frame, 70, 6);
    let options = [
        "Automatic: link unique closest exact-rating match with distance ≤ 10",
        "Manual: review every potential match (no distance limit)",
    ];
    let items = options.into_iter().map(ListItem::new);
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("Choose linking mode (↑/↓, Enter, Esc: quit)"),
        )
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("> ");
    let mut state = ListState::default();
    state.select(Some(selected));
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_unchanged_archive_warning(
    frame: &mut Frame<'_>,
    archive_md5: &str,
    synced_at: chrono::NaiveDateTime,
) {
    let area = centered_area(frame, 80, 9);
    let warning = Paragraph::new(format!(
        "The latest ORBIT archive has not changed.\n\nMD5: {archive_md5}\nLast synchronized: {synced_at}\n\nProceed with database-only synchronization? (Enter/y: proceed, n/Esc: cancel)"
    ))
    .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
    .block(Block::default().borders(Borders::ALL).title("Warning"))
    .wrap(Wrap { trim: false });
    frame.render_widget(warning, area);
}

fn draw_text_prompt(frame: &mut Frame<'_>, title: &str, input: &str) {
    let area = centered_area(frame, 80, 5);
    let paragraph = Paragraph::new(input)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn draw_review(
    frame: &mut Frame<'_>,
    title: &str,
    context: Option<&str>,
    lines: &[String],
    progress: &str,
    action: Action,
    allow_skip_all: bool,
    scroll: u16,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(if context.is_some() { 3 } else { 2 }),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(frame.size());
    let header = context.map_or_else(
        || format!("{progress}\n{title}"),
        |context| format!("{progress}\n{title}\n{context}"),
    );
    frame.render_widget(Paragraph::new(header), root[0]);
    frame.render_widget(
        Paragraph::new(lines.join("\n"))
            .block(Block::default().borders(Borders::ALL).title("Details"))
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false }),
        root[1],
    );
    let skip_all = if allow_skip_all { " | a: skip all" } else { "" };
    frame.render_widget(
        Paragraph::new(format!(
            "Enter/{}: {} | s: skip{skip_all} | ↑/↓/PgUp/PgDn: scroll | q/Esc: quit",
            action.key(),
            action.label(),
        )),
        root[2],
    );
}

fn draw_sigint_unit_enrichment_review(
    frame: &mut Frame<'_>,
    title: &str,
    lines: &[String],
    progress: &str,
    scroll: u16,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(frame.size());
    frame
        .render_widget(Paragraph::new(format!("{progress}\n{title}")), root[0]);
    frame.render_widget(
        Paragraph::new(lines.join("\n"))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("Proposed changes"),
            )
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false }),
        root[1],
    );
    frame.render_widget(
        Paragraph::new(
            "Enter/y: confirm | n: deny | a: confirm all | d: deny all | q/Esc: cancel",
        ),
        root[2],
    );
}

fn decision_for_key(
    key: KeyEvent,
    action: Action,
    allow_skip_all: bool,
) -> Option<Decision> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.code == KeyCode::Esc
        || key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        return Some(Decision::Quit);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Char('q') => Some(Decision::Quit),
        KeyCode::Enter => Some(Decision::Accept),
        KeyCode::Char(character) if character == action.key() => {
            Some(Decision::Accept)
        }
        KeyCode::Char('s') => Some(Decision::Skip),
        KeyCode::Char('a') if allow_skip_all => Some(Decision::SkipAll),
        _ => None,
    }
}

fn enrichment_decision_for_key(key: KeyEvent) -> Option<EnrichmentDecision> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.code == KeyCode::Esc
        || key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        return Some(EnrichmentDecision::Quit);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Enter | KeyCode::Char('y') => {
            Some(EnrichmentDecision::Confirm)
        }
        KeyCode::Char('n') => Some(EnrichmentDecision::Deny),
        KeyCode::Char('a') => Some(EnrichmentDecision::ConfirmAll),
        KeyCode::Char('d') => Some(EnrichmentDecision::DenyAll),
        KeyCode::Char('q') => Some(EnrichmentDecision::Quit),
        _ => None,
    }
}

fn centered_area(
    frame: &Frame<'_>,
    percent_x: u16,
    height: u16,
) -> ratatui::layout::Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(0),
            Constraint::Length(height),
            Constraint::Min(0),
        ])
        .split(frame.size());
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1])[1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_link_match_lines_show_identity_and_generative_hierarchy() {
        let unit = ReviewUnit {
            sigint_unit_id: 273,
            sigint_unit_name: "4 мсб (АТ)".to_string(),
            subject_kind:
                crate::orbit::test_link::ReviewSubjectKind::SigintUnit,
            echelons: vec![
                "4 мсб (АТ)".to_string(),
                "752 мсп".to_string(),
                "3 мсд".to_string(),
            ],
            matches: Vec::new(),
        };
        let candidate = ReviewMatch {
            unit_id: uuid::Uuid::nil(),
            rating: 100,
            distance: 2,
            orbit_name: "4 мсб (ат) / 752 мсп / 3 мсд".to_string(),
        };

        assert_eq!(
            test_link_match_lines(1, &unit, &candidate)
                .iter()
                .map(line_text)
                .collect::<Vec<_>>(),
            vec![
                "[1] rating: 100, Levenshtein distance: 2",
                "ORBIT UUID: 00000000-0000-0000-0000-000000000000",
                "INPUT: 4 мсб (АТ) / 752 мсп / 3 мсд",
                " ORBIT: 4 мсб (ат) / 752 мсп / 3 мсд",
            ]
        );
    }

    #[test]
    fn test_link_name_diff_colors_matching_and_mismatching_words() {
        let [sigint, orbit] = test_link_name_diff_lines(
            "3 мсб / 347 мсп / 47 тд / 1 ТА",
            "3 мсб / 347 мсп / 47 тд / 1 ТА / МВО",
        );

        for line in [&sigint, &orbit] {
            assert!(line
                .spans
                .iter()
                .any(|span| span.style.fg == Some(Color::Green)));
        }
        assert!(orbit.spans.iter().any(|span| {
            span.style.fg == Some(Color::Red) && span.content.contains("МВО")
        }));
    }

    #[test]
    fn duplicate_review_uses_test_link_visual_diff() {
        let candidates = [DuplicateReviewCandidate {
            unit: ReviewUnit {
                sigint_unit_id: 273,
                sigint_unit_name: "4 мсб (АТ)".to_string(),
                subject_kind:
                    crate::orbit::test_link::ReviewSubjectKind::SigintUnit,
                echelons: vec![
                    "4 мсб (АТ)".to_string(),
                    "752 мсп".to_string(),
                ],
                matches: vec![ReviewMatch {
                    unit_id: uuid::Uuid::nil(),
                    rating: 100,
                    distance: 2,
                    orbit_name: "4 мсб (ат) / 752 мсп".to_string(),
                }],
            },
            active: true,
        }];

        let lines = duplicate_unit_group_review_lines(&candidates);

        assert!(lines.iter().any(|line| line.spans.iter().any(|span| {
            span.style.fg == Some(Color::Green)
        })));
        assert!(lines.iter().any(|line| line.spans.iter().any(|span| {
            span.style.fg == Some(Color::Red)
        })));
        assert!(lines.iter().map(line_text).any(|line| {
            line == "INPUT: 4 мсб (АТ) / 752 мсп"
        }));
        assert!(lines.iter().map(line_text).any(|line| {
            line == " ORBIT: 4 мсб (ат) / 752 мсп"
        }));
    }

    #[test]
    fn duplicate_review_keys_select_from_the_visible_page() {
        let plain = KeyModifiers::NONE;

        assert_eq!(
            duplicate_review_decision_for_key(
                KeyEvent::new(KeyCode::Char('2'), plain),
                1,
                7,
            ),
            Some(DuplicateReviewDecision::Select(6)),
        );
        assert_eq!(
            duplicate_review_decision_for_key(
                KeyEvent::new(KeyCode::Char('3'), plain),
                1,
                7,
            ),
            None,
        );
        assert_eq!(
            duplicate_review_decision_for_key(
                KeyEvent::new(KeyCode::Char('n'), plain),
                0,
                7,
            ),
            Some(DuplicateReviewDecision::Skip),
        );
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn test_link_keys_map_to_review_inputs() {
        let plain = KeyModifiers::NONE;
        for (key, expected) in [
            (KeyCode::Enter, ReviewInput::Accept(0)),
            (KeyCode::Char('y'), ReviewInput::Accept(0)),
            (KeyCode::Char('1'), ReviewInput::Accept(0)),
            (KeyCode::Char('2'), ReviewInput::Accept(1)),
            (KeyCode::Char('5'), ReviewInput::Accept(4)),
            (KeyCode::Char('0'), ReviewInput::Deny),
            (KeyCode::Char('n'), ReviewInput::Deny),
            (KeyCode::Char('f'), ReviewInput::NextMatchPage),
            (KeyCode::Char('b'), ReviewInput::PreviousMatchPage),
            (KeyCode::Up, ReviewInput::ScrollUp),
            (KeyCode::Down, ReviewInput::ScrollDown),
            (KeyCode::PageUp, ReviewInput::PageUp),
            (KeyCode::PageDown, ReviewInput::PageDown),
            (KeyCode::Char('q'), ReviewInput::RequestExit),
            (KeyCode::Esc, ReviewInput::RequestExit),
        ] {
            assert_eq!(
                test_link_input_for_key(KeyEvent::new(key, plain)),
                Some(expected)
            );
        }
        assert_eq!(
            test_link_input_for_key(KeyEvent::new(
                KeyCode::Char('c'),
                KeyModifiers::CONTROL
            )),
            Some(ReviewInput::RequestExit)
        );
    }

    #[test]
    fn test_link_exit_confirmation_keys_confirm_or_continue() {
        let plain = KeyModifiers::NONE;
        assert_eq!(
            test_link_exit_confirmation_for_key(KeyEvent::new(
                KeyCode::Enter,
                plain
            )),
            Some(true)
        );
        assert_eq!(
            test_link_exit_confirmation_for_key(KeyEvent::new(
                KeyCode::Esc,
                plain
            )),
            Some(false)
        );
    }

    #[test]
    fn review_keys_only_accept_the_current_action() {
        let plain = KeyModifiers::NONE;
        assert_eq!(
            decision_for_key(
                KeyEvent::new(KeyCode::Char('d'), plain),
                Action::Delete,
                true
            ),
            Some(Decision::Accept)
        );
        assert_eq!(
            decision_for_key(
                KeyEvent::new(KeyCode::Char('c'), plain),
                Action::Delete,
                true
            ),
            None
        );
        assert_eq!(
            decision_for_key(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                Action::Delete,
                false
            ),
            Some(Decision::Quit)
        );
        assert_eq!(
            decision_for_key(
                KeyEvent::new(KeyCode::Char('m'), plain),
                Action::Merge,
                false
            ),
            Some(Decision::Accept)
        );
        assert_eq!(
            decision_for_key(
                KeyEvent::new(KeyCode::Char('d'), plain),
                Action::Merge,
                false
            ),
            None
        );
    }

    #[test]
    fn reimport_confirmation_requires_exact_confirmation_text() {
        assert!(is_reimport_confirmed(Some("REIMPORT")));
        assert!(!is_reimport_confirmed(Some("reimport")));
        assert!(!is_reimport_confirmed(None));
    }
}
