use super::{session_log::SessionLog, Options};
use crate::{
    config::{AI_CONTROL_PANEL_LOG_LINES, AI_CONTROL_PANEL_POLL_MS},
    h,
    types::{Mode, ShortContext},
};
use anyhow::bail;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{
        disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Style},
    widgets::{Block, Borders, Clear, Paragraph, Row, Table, TableState, Wrap},
    Frame, Terminal,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{self, IsTerminal},
    path::PathBuf,
    sync::mpsc::Receiver,
    time::Duration,
};

struct Screen;
impl Drop for Screen {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

struct App {
    data: Value,
    cursor: usize,
    release: usize,
    selected: BTreeSet<String>,
    hosts: Vec<String>,
    logs: Vec<String>,
    session_log: SessionLog,
    input: Option<String>,
    preview: Option<String>,
    worker: Option<Receiver<Value>>,
    upgrading: bool,
    cancel_file: Option<PathBuf>,
    preview_recovery: bool,
    reconcile_orphans: bool,
}

impl App {
    fn rows(&self) -> &[Value] {
        self.data["hosts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn releases(&self) -> &[Value] {
        self.data["releases"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn eligibility(&self) -> &str {
        if self.reconcile_orphans {
            "eligibility_reconciled"
        } else {
            "eligibility"
        }
    }

    fn target(&self) -> &str {
        self.releases()
            .get(self.release)
            .and_then(|v| v["release"].as_str())
            .unwrap_or("")
    }

    fn log(&mut self, message: String) {
        self.persist(&message);
        self.push_log(message);
    }

    fn persist(&mut self, message: &str) {
        if let Err(error) = self.session_log.write(message) {
            self.push_log(format!("Could not write session log: {error:#}"));
        }
    }

    fn push_log(&mut self, message: String) {
        self.logs.push(message);
        if self.logs.len() > AI_CONTROL_PANEL_LOG_LINES {
            self.logs.remove(0);
        }
    }

    fn poll(&mut self) {
        let messages: Vec<_> = self
            .worker
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default();
        for message in messages {
            let entry = message["diagnostic"]
                .as_str()
                .or_else(|| message["message"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Worker event: {message}"));
            self.persist(&entry);
            if message.get("hosts").is_some() {
                let target = self.target().to_string();
                self.data = message;
                self.cursor =
                    self.cursor.min(self.rows().len().saturating_sub(1));
                self.release = self
                    .releases()
                    .iter()
                    .position(|v| v["release"] == target)
                    .unwrap_or(0);
            } else if message["done"] == true {
                self.worker = None;
                self.upgrading = false;
                if let Some(path) = self.cancel_file.take() {
                    let _ = std::fs::remove_file(path);
                }
            } else if let Some(message) = message["message"].as_str() {
                self.push_log(message.to_string());
            }
        }
    }
}

fn start_worker(
    app: &mut App,
    mode: Mode,
    options: &Options,
    action: &str,
    selected: Vec<String>,
) -> anyhow::Result<()> {
    if app.worker.is_some() {
        return Ok(());
    }
    app.cancel_file = Some(super::worker::cancel_file(options).c(h!())?);
    let request = json!({"hosts": app.hosts, "selected": selected, "release": app.target(), "snapshot": app.data, "cancel_file": app.cancel_file, "reconcile_orphans": app.reconcile_orphans});
    let rx = super::worker::start(mode, options, action, request).c(h!())?;
    app.worker = Some(rx);
    app.upgrading = action != "scan";
    Ok(())
}

fn render(frame: &mut Frame, app: &App) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Percentage(43),
            Constraint::Length(5),
            Constraint::Min(4),
            Constraint::Length(3),
        ])
        .split(frame.size());
    render_shared(frame, app, areas[0]);
    render_fleet(frame, app, areas[1]);
    render_releases(frame, app, areas[2]);
    render_details(frame, app, areas[3]);
    frame.render_widget(Paragraph::new("s Scan all   r Refresh   a Add   Space Select   o Orphan backups   u Upgrade   x Recover   c Cancel   q Quit").block(Block::default().borders(Borders::ALL)),areas[4]);
    render_dialog(frame, app);
}

fn render_shared(frame: &mut Frame, app: &App, area: Rect) {
    let shared = &app.data["shared"];
    let heading = format!(
        "Dispatcher: {}   Default template: {}   Target: {}   Orphan backups: {}   {}",
        string(shared, "dispatcher_release"),
        string(shared, "template_release"),
        app.target(),
        app.reconcile_orphans,
        if app.worker.is_some() {
            "WORKING"
        } else {
            "Ready"
        }
    );
    frame.render_widget(
        Paragraph::new(heading).block(
            Block::default()
                .borders(Borders::ALL)
                .title("AI control panel"),
        ),
        area,
    );
}

fn render_fleet(frame: &mut Frame, app: &App, area: Rect) {
    let rows = app.rows().iter().map(|host| {
        let id = string(host, "host");
        Row::new(vec![
            if app.selected.contains(id) {
                "[x]"
            } else {
                "[ ]"
            }
            .to_string(),
            id.to_string(),
            string(host, "namespace").to_string(),
            string(host, "deployed").to_string(),
            string(host, "required_release").to_string(),
            host[app.eligibility()][app.target()]
                .as_str()
                .unwrap_or("Scan required")
                .to_string(),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(3),
            Constraint::Percentage(18),
            Constraint::Percentage(17),
            Constraint::Percentage(18),
            Constraint::Length(14),
            Constraint::Min(18),
        ],
    )
    .header(
        Row::new([
            "",
            "Echo host",
            "Namespace",
            "Deployed",
            "Echo requires",
            "Upgrade status",
        ])
        .style(Style::default().fg(Color::Cyan)),
    )
    .highlight_style(Style::default().bg(Color::DarkGray))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title("Fleet — Space selects; ↑/↓ navigates"),
    );
    let mut state = TableState::default();
    state.select(Some(app.cursor));
    frame.render_stateful_widget(table, area, &mut state);
}

fn render_releases(frame: &mut Frame, app: &App, area: Rect) {
    let releases = app
        .releases()
        .iter()
        .skip(app.release.saturating_sub(1))
        .take(3)
        .map(|release| {
            format!(
                "{} {} ({})",
                if release["release"] == app.target() {
                    ">"
                } else {
                    " "
                },
                string(release, "release"),
                string(release, "availability")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    frame.render_widget(
        Paragraph::new(releases).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .title("Available harnesses — [ / ] selects target"),
        ),
        area,
    );
}

fn render_details(frame: &mut Frame, app: &App, area: Rect) {
    let details = app
        .rows()
        .get(app.cursor)
        .map(|row| {
            format!(
                "Build: {}   Scanned: {}\n{}",
                string(row, "build"),
                string(row, "scanned_at"),
                string(row, "details")
            )
        })
        .unwrap_or_default();
    let height = area.height.saturating_sub(5) as usize;
    let logs = app
        .logs
        .iter()
        .skip(app.logs.len().saturating_sub(height))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    frame.render_widget(
        Paragraph::new(format!("{details}\n{logs}"))
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(format!(
                "Details / progress — log: {}",
                app.session_log.path.display()
            ))),
        area,
    );
}

fn render_dialog(frame: &mut Frame, app: &App) {
    let popup = app
        .input
        .as_ref()
        .map(|input| format!("SSH alias: {input}\nEnter add · Esc cancel"))
        .or_else(|| app.preview.clone());
    if let Some(text) = popup {
        let rect = ratatui::layout::Rect::new(
            frame.size().width / 10,
            frame.size().height / 5,
            frame.size().width * 8 / 10,
            frame.size().height * 3 / 5,
        );
        frame.render_widget(Clear, rect);
        frame.render_widget(
            Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .block(Block::default().borders(Borders::ALL).title("Review")),
            rect,
        );
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("unknown")
}

fn upgrade_preview(app: &App) -> String {
    let hosts: Vec<_> = app
        .rows()
        .iter()
        .filter(|row| app.selected.contains(string(row, "host")))
        .collect();
    let mut lines = vec![
        format!("Target harness: {}", app.target()),
        "Order: local, staging, production. Stops on failure.".into(),
    ];
    for host in &hosts {
        lines.push(format!(
            "{}: {}",
            string(host, "host"),
            host[app.eligibility()][app.target()]
                .as_str()
                .unwrap_or("Unknown")
        ));
    }
    lines.push("The shared dispatcher/template may be prepared once. Only selected namespaces are replaced; stopped backups and recovery journals are retained.".into());
    lines.push(format!(
        "Retain stopped orphans as backups: {}",
        app.reconcile_orphans
    ));
    lines.push(format!(
        "CLI: just ai-control-panel upgrade {} --release {}{}",
        app.selected
            .iter()
            .map(|host| format!("--host {host}"))
            .collect::<Vec<_>>()
            .join(" "),
        app.target(),
        if app.reconcile_orphans {
            " --reconcile-orphans"
        } else {
            ""
        }
    ));
    lines.push("Enter executes the selected rollout · Esc cancels".into());
    lines.join("\n\n")
}

pub fn run(mode: Mode, mut options: Options) -> anyhow::Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("ai-control-panel requires a terminal");
    }
    options.repo = options.repo.canonicalize().c(h!())?;
    let mut app = App {
        data: json!({}),
        cursor: 0,
        release: 0,
        selected: BTreeSet::new(),
        hosts: options.host.clone(),
        logs: vec![],
        session_log: SessionLog::new().c(h!())?,
        input: None,
        preview: None,
        worker: None,
        upgrading: false,
        cancel_file: None,
        preview_recovery: false,
        reconcile_orphans: false,
    };
    app.log(format!(
        "Session started: mode={mode}, repo={}, build={}",
        options.repo.display(),
        include_str!("../../version.txt").trim()
    ));
    let result = run_terminal(&mut app, mode, &options);
    app.poll();
    match &result {
        Ok(()) => app.log("Panel closed".into()),
        Err(error) => app.log(format!("Panel failed: {error:#}")),
    }
    result.c(h!())
}

fn run_terminal(
    app: &mut App,
    mode: Mode,
    options: &Options,
) -> anyhow::Result<()> {
    enable_raw_mode().c(h!())?;
    let _screen = Screen;
    execute!(io::stdout(), EnterAlternateScreen).c(h!())?;
    let mut terminal =
        Terminal::new(CrosstermBackend::new(io::stdout())).c(h!())?;
    start_worker(app, mode, options, "scan", vec![]).c(h!())?;
    loop {
        app.poll();
        terminal.draw(|frame| render(frame, app)).c(h!())?;
        if !event::poll(Duration::from_millis(AI_CONTROL_PANEL_POLL_MS))
            .c(h!())?
        {
            continue;
        }
        let Event::Key(key) = event::read().c(h!())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        if handle_key(app, key.code, mode, options).c(h!())? {
            break;
        }
    }
    Ok(())
}

fn highlighted(app: &App) -> Vec<String> {
    app.rows()
        .get(app.cursor)
        .map(|row| vec![string(row, "host").to_string()])
        .unwrap_or_default()
}

fn handle_dialog(
    app: &mut App,
    key: KeyCode,
    mode: Mode,
    options: &Options,
) -> anyhow::Result<bool> {
    if let Some(input) = &mut app.input {
        match key {
            KeyCode::Esc => app.input = None,
            KeyCode::Backspace => {
                input.pop();
            }
            KeyCode::Char(ch) => input.push(ch),
            KeyCode::Enter => {
                let host = input.trim().to_string();
                if host.is_empty()
                    || host.len() > 253
                    || !host.as_bytes()[0].is_ascii_alphanumeric()
                    || !host.chars().all(|ch| {
                        ch.is_ascii_alphanumeric() || "_.@-".contains(ch)
                    })
                {
                    app.input = None;
                    app.log("Enter an SSH alias or user@hostname.".into());
                    return Ok(true);
                }
                if !host.is_empty() && !app.hosts.contains(&host) {
                    app.hosts.push(host);
                }
                app.input = None;
                start_worker(app, mode, options, "scan", vec![]).c(h!())?;
            }
            _ => {}
        }
        return Ok(true);
    }
    if app.preview.is_some() {
        match key {
            KeyCode::Esc => app.preview = None,
            KeyCode::Enter => {
                app.preview = None;
                let (action, selected) = if app.preview_recovery {
                    ("recover", highlighted(app))
                } else {
                    ("upgrade", app.selected.iter().cloned().collect())
                };
                start_worker(app, mode, options, action, selected).c(h!())?;
            }
            _ => {}
        }
        return Ok(true);
    }
    Ok(false)
}

fn handle_key(
    app: &mut App,
    key: KeyCode,
    mode: Mode,
    options: &Options,
) -> anyhow::Result<bool> {
    if handle_dialog(app, key, mode, options).c(h!())? {
        return Ok(false);
    }
    match key {
        KeyCode::Char('q') | KeyCode::Esc if !app.upgrading => return Ok(true),
        KeyCode::Char('q') | KeyCode::Esc => {
            app.log(
                "Rollout active. Press c to stop after the current namespace."
                    .into(),
            );
        }
        KeyCode::Char('c') if app.upgrading => {
            if let Some(path) = &app.cancel_file {
                std::fs::write(path, b"cancel").c(h!())?;
                app.log(
                    "Cancellation requested at the next safe boundary.".into(),
                );
            }
        }
        KeyCode::Down | KeyCode::Char('j') => {
            app.cursor =
                (app.cursor + 1).min(app.rows().len().saturating_sub(1));
        }
        KeyCode::Up | KeyCode::Char('k') => {
            app.cursor = app.cursor.saturating_sub(1)
        }
        KeyCode::Char(']') => {
            app.release = (app.release + 1) % app.releases().len().max(1)
        }
        KeyCode::Char('[') => app.release = app.release.saturating_sub(1),
        KeyCode::Char(' ') => {
            if let Some(host) = highlighted(app).pop() {
                if !app.selected.remove(&host) {
                    app.selected.insert(host);
                }
            }
        }
        KeyCode::Char('o') if app.worker.is_none() => {
            app.reconcile_orphans = !app.reconcile_orphans;
            app.log(format!(
                "Preserve stopped orphan agents as backups: {}",
                app.reconcile_orphans
            ));
        }
        KeyCode::Char('a') if app.worker.is_none() => {
            app.input = Some(String::new())
        }
        KeyCode::Char('s') => {
            start_worker(app, mode, options, "scan", vec![]).c(h!())?
        }
        KeyCode::Char('r') => {
            start_worker(app, mode, options, "scan", highlighted(app))
                .c(h!())?;
        }
        KeyCode::Char('u')
            if app.worker.is_none() && !app.selected.is_empty() =>
        {
            app.preview_recovery = false;
            app.preview = Some(upgrade_preview(app));
        }
        KeyCode::Char('x') if app.worker.is_none() => {
            app.preview_recovery = true;
            app.preview = Some(format!("Recover {} from its saved rollout journal. Completed shared changes remain installed.\n\nEnter recovers · Esc cancels", highlighted(app).join(", ")));
        }
        _ => {}
    }
    Ok(false)
}
