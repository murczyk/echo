use crate::config::ORBIT_TUI_EVENT_POLL_MS;
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
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{
    Block, Borders, List, ListItem, ListState, Paragraph, Wrap,
};
use ratatui::{Frame, Terminal};
use std::io::{self, Stdout};
use std::time::Duration;

pub type OrbitTerminal = Terminal<CrosstermBackend<Stdout>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartAction {
    Import,
    FindMatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchOption {
    pub unit_id: uuid::Uuid,
    pub operational_full_name: String,
    pub generative_full_name: String,
    pub original_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Skip,
    SkipAll,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Create,
    Update,
    Reactivate,
    Delete,
}

impl Action {
    fn key(self) -> char {
        match self {
            Self::Create => 'c',
            Self::Update => 'u',
            Self::Reactivate => 'r',
            Self::Delete => 'd',
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Reactivate => "reactivate",
            Self::Delete => "delete",
        }
    }
}

pub fn prompt_start_action() -> Result<Option<StartAction>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_start_menu(&mut terminal);
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn prompt_sigint_unit_name() -> Result<Option<String>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_text_prompt(
        &mut terminal,
        "Exact SIGINT unit full name (Enter: continue, Esc: quit)",
    );
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn select_match(
    options: &[MatchOption],
) -> Result<Option<usize>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_match_selector(&mut terminal, options);
    restore_terminal(&mut terminal).c(h!())?;
    result
}

pub fn setup_terminal() -> io::Result<OrbitTerminal> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, cursor::Hide)?;
    Terminal::new(CrosstermBackend::new(stdout))
}

pub fn restore_terminal(terminal: &mut OrbitTerminal) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, cursor::Show)?;
    terminal.show_cursor()
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
    let actions = [StartAction::Import, StartAction::FindMatch];
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
                return Ok(Some(actions[selected]))
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
                return Ok(Some(input.trim().to_string()))
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

fn run_match_selector(
    terminal: &mut OrbitTerminal,
    options: &[MatchOption],
) -> Result<Option<usize>, AppError> {
    if options.is_empty() {
        return Ok(None);
    }
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let mut selected = 0;
    loop {
        terminal
            .draw(|frame| draw_match_selector(frame, options, selected))
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
                return Ok(Some(selected))
            }
            KeyCode::Up if key.modifiers.is_empty() => {
                selected = selected.saturating_sub(1)
            }
            KeyCode::Down if key.modifiers.is_empty() => {
                selected = (selected + 1).min(options.len() - 1)
            }
            KeyCode::Home if key.modifiers.is_empty() => selected = 0,
            KeyCode::End if key.modifiers.is_empty() => {
                selected = options.len() - 1
            }
            _ => {}
        }
    }
}

fn draw_start_menu(frame: &mut Frame<'_>, selected: usize) {
    let area = centered_area(frame, 70, 6);
    let options = [
        "Import new ORBIT units from the latest snapshot",
        "Search an ORBIT unit by SIGINT unit name",
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

fn draw_text_prompt(frame: &mut Frame<'_>, title: &str, input: &str) {
    let area = centered_area(frame, 80, 5);
    let paragraph = Paragraph::new(input)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn draw_match_selector(
    frame: &mut Frame<'_>,
    options: &[MatchOption],
    selected: usize,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(frame.size());
    let items = options.iter().enumerate().map(|(index, option)| {
        ListItem::new(format!(
            "{}. ORBIT unit ID: {}\n   Operational full name: {}\n   Generative full name: {}\n   Original name: {}",
            index + 1,
            option.unit_id,
            option.operational_full_name,
            option.generative_full_name,
            option.original_name,
        ))
    });
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!("Closest ORBIT matches ({})", options.len())),
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
    frame.render_stateful_widget(list, root[0], &mut state);
    frame.render_widget(
        Paragraph::new(
            "↑/↓/Home/End: select | Enter: import and link | Esc: quit",
        ),
        root[1],
    );
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
                Action::Create,
                false
            ),
            Some(Decision::Quit)
        );
    }
}
