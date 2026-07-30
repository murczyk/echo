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
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::io::{self, Stdout};
use std::path::PathBuf;
use std::time::Duration;

pub type OrbitTerminal = Terminal<CrosstermBackend<Stdout>>;

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

pub fn prompt_path() -> Result<Option<PathBuf>, AppError> {
    let mut terminal = setup_terminal().c(h!())?;
    let result = run_path_prompt(&mut terminal);
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

fn run_path_prompt(
    terminal: &mut OrbitTerminal,
) -> Result<Option<PathBuf>, AppError> {
    let poll = Duration::from_millis(ORBIT_TUI_EVENT_POLL_MS);
    let mut input = String::new();
    loop {
        terminal
            .draw(|frame| draw_path_prompt(frame, &input))
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
                return Ok(Some(PathBuf::from(input.trim())))
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

fn draw_path_prompt(frame: &mut Frame<'_>, input: &str) {
    let area = centered_area(frame, 80, 5);
    let paragraph = Paragraph::new(input)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title("ORBIT JSON path (Enter: continue, Esc: quit)"),
        )
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn draw_review(
    frame: &mut Frame<'_>,
    title: &str,
    lines: &[String],
    progress: &str,
    action: Action,
    allow_skip_all: bool,
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
