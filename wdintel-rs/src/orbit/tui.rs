use crate::config::SIGINT_INBOX_TUI_EVENT_POLL_MS;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crossterm::event::{self, Event, KeyCode};
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
    actions: &str,
    allow_skip_all: bool,
) -> Result<Decision, AppError> {
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    let mut scroll = 0_u16;
    loop {
        terminal
            .draw(|frame| {
                draw_review(frame, title, lines, progress, actions, scroll)
            })
            .c(h!())?;
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => return Ok(Decision::Quit),
            KeyCode::Enter
            | KeyCode::Char('c')
            | KeyCode::Char('u')
            | KeyCode::Char('r')
            | KeyCode::Char('d') => return Ok(Decision::Accept),
            KeyCode::Char('s') => return Ok(Decision::Skip),
            KeyCode::Char('a') if allow_skip_all => {
                return Ok(Decision::SkipAll)
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

fn run_path_prompt(
    terminal: &mut OrbitTerminal,
) -> Result<Option<PathBuf>, AppError> {
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
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
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Enter if !input.trim().is_empty() => {
                return Ok(Some(PathBuf::from(input.trim())))
            }
            KeyCode::Backspace => {
                input.pop();
            }
            KeyCode::Char(character) => input.push(character),
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
    actions: &str,
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
    frame.render_widget(
        Paragraph::new(format!(
            "{actions} | ↑/↓/PgUp/PgDn: scroll | q/Esc: quit"
        )),
        root[2],
    );
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
