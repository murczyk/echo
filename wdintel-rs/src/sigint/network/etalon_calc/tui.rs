use crate::config::*;
use crate::entities::*;
use crate::types::{AppError, Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use chrono::{DateTime, NaiveDateTime, Utc};
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{BarChart, Block, Borders, Gauge, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use sea_orm::{DatabaseConnection, EntityTrait, QueryOrder};
use std::collections::HashMap;
use std::io::{self, Stdout};
use std::time::{Duration, Instant};

struct TuiSnapshot {
    fresh: TaskGroupSnapshot,
    old: TaskGroupSnapshot,
    last_update: DateTime<Utc>,
    unassigned: usize,
}

struct TaskGroupSnapshot {
    total: usize,
    completed: usize,
    in_progress: usize,
    pending: usize,
    last_completed_till_ts: Option<NaiveDateTime>,
    last_completed_ago_seconds: Option<i64>,
    chunks: Vec<ChunkSnapshot>,
    status_nm: String,
    status_time_elapsed: String,
}

struct ChunkSnapshot {
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    total: usize,
    completed: usize,
    percent_complete: u16,
}

pub async fn run_network_invalidation_tui(mode: Mode) -> Result<(), AppError> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut terminal = setup_terminal().c(h!())?;
    let res = run_loop(&db, &mut terminal).await;
    restore_terminal(&mut terminal).c(h!())?;
    res
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
) -> Result<(), AppError> {
    let refresh = Duration::from_millis(SIGINT_INBOX_TUI_REFRESH_MS);
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    let mut snapshot = load_snapshot(db).await?;
    let mut last_refresh = Instant::now();

    loop {
        if last_refresh.elapsed() >= refresh {
            snapshot = load_snapshot(db).await?;
            last_refresh = Instant::now();
        }

        terminal.draw(|frame| draw_ui(frame, &snapshot)).c(h!())?;

        if event::poll(poll).c(h!())? && matches_quit(event::read().c(h!())?) {
            break;
        }
    }

    Ok(())
}

fn matches_quit(event: Event) -> bool {
    matches!(
        event,
        Event::Key(key)
            if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc)
    )
}

async fn load_snapshot(
    db: &DatabaseConnection,
) -> Result<TuiSnapshot, AppError> {
    let tasks = network_invalidation_task::Entity::find()
        .order_by_asc(network_invalidation_task::Column::CreatedAt)
        .all(db)
        .await
        .c(h!())?;
    let (old_tasks, fresh_tasks, unassigned_tasks) = split_tasks(tasks);
    let workers = network_invalidation_worker::Entity::find()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|w| (w.tag.clone(), w))
        .collect::<HashMap<_, _>>();
    Ok(TuiSnapshot {
        fresh: build_group_snapshot(
            fresh_tasks,
            workers.get(NETWORK_INVALIDATION_TASK_TAG_RECENT),
        ),
        old: build_group_snapshot(
            old_tasks,
            workers.get(NETWORK_INVALIDATION_TASK_TAG_OLD),
        ),
        unassigned: unassigned_tasks.len(),
        last_update: Utc::now(),
    })
}

fn split_tasks(
    tasks: Vec<network_invalidation_task::Model>,
) -> (
    Vec<network_invalidation_task::Model>,
    Vec<network_invalidation_task::Model>,
    Vec<network_invalidation_task::Model>,
) {
    let mut old = Vec::new();
    let mut fresh = Vec::new();
    let mut unassigned = Vec::new();
    for task in tasks {
        match task.tag.as_str() {
            txt if txt
                .eq(crate::config::NETWORK_INVALIDATION_TASK_TAG_RECENT) =>
            {
                fresh.push(task)
            }
            txt if txt.eq(crate::config::NETWORK_INVALIDATION_TASK_TAG_OLD) => {
                old.push(task)
            }
            _ => unassigned.push(task),
        };
    }
    (old, fresh, unassigned)
}

fn build_group_snapshot(
    tasks: Vec<network_invalidation_task::Model>,
    m_worker: Option<&network_invalidation_worker::Model>,
) -> TaskGroupSnapshot {
    let mut tasks = tasks;
    tasks.sort_by_key(|task| (task.since_ts, task.till_ts));

    let mut completed = 0;
    let mut in_progress = 0;
    let mut pending = 0;
    let mut last_completed_till_ts = None;
    let mut last_completed_at = None;
    let mut min_since_ts = None;
    let mut max_till_ts = None;

    for task in &tasks {
        match task_status_value(task) {
            2 => completed += 1,
            1 => in_progress += 1,
            _ => pending += 1,
        }
        if task.completed_at.is_some() {
            last_completed_till_ts = match last_completed_till_ts {
                None => Some(task.till_ts),
                Some(value) => Some(value.min(task.till_ts)),
            };
            last_completed_at = match last_completed_at {
                None => task.completed_at,
                Some(value) => {
                    task.completed_at.map(|done_at| value.max(done_at))
                }
            };
        }
        min_since_ts = match min_since_ts {
            None => Some(task.since_ts),
            Some(value) => Some(value.min(task.since_ts)),
        };
        max_till_ts = match max_till_ts {
            None => Some(task.till_ts),
            Some(value) => Some(value.max(task.till_ts)),
        };
    }

    let chunks = build_time_buckets(
        &tasks,
        min_since_ts,
        max_till_ts,
        SIGINT_INBOX_TUI_CHUNK_COUNT,
    );

    let total = tasks.len();
    let now = Utc::now().naive_utc();
    let last_completed_ago_seconds =
        last_completed_at.map(|done_at| (now - done_at).num_seconds().max(0));

    let (status_nm, status_time_elapsed) = match m_worker {
        Some(worker) => {
            let time = (now - worker.updated_at).num_seconds();
            (format!("{:?}", worker.status), format!("{time}s"))
        }
        None => ("???".to_string(), "???".to_string()),
    };

    TaskGroupSnapshot {
        total,
        completed,
        in_progress,
        pending,
        last_completed_till_ts,
        last_completed_ago_seconds,
        chunks,
        status_nm,
        status_time_elapsed,
    }
}

fn task_status_value(task: &network_invalidation_task::Model) -> u64 {
    if task.completed_at.is_some() {
        2
    } else if task.started_at.is_some() {
        1
    } else {
        0
    }
}

fn draw_ui(frame: &mut Frame<'_>, snapshot: &TuiSnapshot) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(48),
            Constraint::Percentage(48),
            Constraint::Length(1),
        ])
        .split(frame.size());

    render_group(
        frame,
        root[0],
        "Pipeline (is_for_old_worker=false)",
        &snapshot.fresh,
    );
    render_group(
        frame,
        root[1],
        "Pipeline (is_for_old_worker=true)",
        &snapshot.old,
    );
    render_footer(frame, root[2], snapshot.last_update, snapshot.unassigned);
}

fn render_group(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    group: &TaskGroupSnapshot,
) {
    let last_completed_txt =
        format_last_completed_task(group.last_completed_ago_seconds);
    let title_full = format!(
        "{title} | {} for {} | Last completed task: {last_completed_txt}",
        group.status_nm, group.status_time_elapsed,
    );
    let block = Block::default().borders(Borders::ALL).title(title_full);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(3),
            Constraint::Min(3),
        ])
        .split(inner);

    let summary = Paragraph::new(Line::from(format!(
        "Total: {}  Completed: {}  In progress: {}  Pending: {}",
        group.total, group.completed, group.in_progress, group.pending
    )));
    frame.render_widget(summary, chunks[0]);

    let gauge = Gauge::default()
        .block(Block::default().title("Progress").borders(Borders::ALL))
        .gauge_style(Style::default().fg(Color::Green))
        .label(format!(
            "{}% ({})",
            percent_complete(group),
            format_ts(group.last_completed_till_ts)
        ))
        .percent(percent_complete(group));
    frame.render_widget(gauge, chunks[1]);

    render_chart(frame, chunks[2], group);
}

fn render_chart(frame: &mut Frame<'_>, area: Rect, group: &TaskGroupSnapshot) {
    if group.total == 0 {
        let empty = Paragraph::new("No tasks in this pipeline.")
            .block(Block::default().title("-").borders(Borders::ALL))
            .wrap(Wrap { trim: true });
        frame.render_widget(empty, area);
        return;
    }

    let block = Block::default()
        .title("Progress chronologically")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(inner);

    let (bucket_width, gap) =
        bucket_layout_width(sections[2].width as usize, group.chunks.len());
    let counts = Paragraph::new(Line::from(build_bucket_counts_line(
        group,
        bucket_width,
        gap,
    )))
    .wrap(Wrap { trim: false });
    frame.render_widget(counts, sections[0]);

    let dates = Paragraph::new(Line::from(build_bucket_dates_line(
        group,
        bucket_width,
        gap,
    )))
    .wrap(Wrap { trim: false });
    frame.render_widget(dates, sections[1]);

    let till = Paragraph::new(Line::from(build_bucket_till_line(
        group,
        bucket_width,
        gap,
    )))
    .wrap(Wrap { trim: false });
    frame.render_widget(till, sections[2]);

    render_chunk_bars(frame, sections[3], group, bucket_width, gap);
}

fn render_footer(
    frame: &mut Frame<'_>,
    area: Rect,
    last_update: DateTime<Utc>,
    unassigned_qty: usize,
) {
    let footer = Paragraph::new(Line::from(format!(
        "Last update: {} | Unassigned tasks: {unassigned_qty} | q or Esc to quit",
        last_update.format("%Y-%m-%d %H:%M:%S"),
    )));
    frame.render_widget(footer, area);
}

fn render_chunk_bars(
    frame: &mut Frame<'_>,
    area: Rect,
    group: &TaskGroupSnapshot,
    bucket_width: usize,
    gap: usize,
) {
    let (labels, data) = build_chart_data(group);
    let bar_pairs: Vec<(&str, u64)> =
        labels.iter().map(String::as_str).zip(data).collect();

    let chart = BarChart::default()
        .data(&bar_pairs)
        .bar_width(bucket_width as u16)
        .bar_gap(gap as u16)
        .max(100)
        .style(Style::default().fg(Color::Cyan))
        .value_style(Style::default().fg(Color::Black).bg(Color::Cyan));
    frame.render_widget(chart, area);
}

fn build_chart_data(group: &TaskGroupSnapshot) -> (Vec<String>, Vec<u64>) {
    let mut labels = Vec::with_capacity(group.chunks.len());
    let mut data = Vec::with_capacity(group.chunks.len());
    for chunk in &group.chunks {
        labels.push(" ".to_string());
        data.push(chunk.percent_complete as u64);
    }
    (labels, data)
}

fn percent_complete(group: &TaskGroupSnapshot) -> u16 {
    if group.total == 0 {
        return 0;
    }
    ((group.completed * 100) / group.total) as u16
}

fn build_time_buckets(
    tasks: &[network_invalidation_task::Model],
    min_since_ts: Option<NaiveDateTime>,
    max_till_ts: Option<NaiveDateTime>,
    bucket_count: usize,
) -> Vec<ChunkSnapshot> {
    let bucket_count = bucket_count.max(1);
    let Some(min_since_ts) = min_since_ts else {
        return Vec::new();
    };
    let Some(max_till_ts) = max_till_ts else {
        return Vec::new();
    };

    let min_ms = min_since_ts.and_utc().timestamp_millis();
    let max_ms = max_till_ts.and_utc().timestamp_millis();
    let total_range = (max_ms - min_ms).max(1);
    let bucket_ms = (total_range / bucket_count as i64).max(1);

    let mut buckets: Vec<ChunkSnapshot> = (0..bucket_count)
        .map(|_| ChunkSnapshot {
            since_ts: None,
            till_ts: None,
            total: 0,
            completed: 0,
            percent_complete: 0,
        })
        .collect();

    for task in tasks {
        let since_ms = task.since_ts.and_utc().timestamp_millis();
        let mut idx = ((since_ms - min_ms) / bucket_ms) as usize;
        if idx >= bucket_count {
            idx = bucket_count - 1;
        }
        let bucket = &mut buckets[idx];
        bucket.total += 1;
        if task.completed_at.is_some() {
            bucket.completed += 1;
        }
        bucket.since_ts = match bucket.since_ts {
            None => Some(task.since_ts),
            Some(value) => Some(value.min(task.since_ts)),
        };
        bucket.till_ts = match bucket.till_ts {
            None => Some(task.till_ts),
            Some(value) => Some(value.max(task.till_ts)),
        };
    }

    for bucket in &mut buckets {
        if bucket.total == 0 {
            bucket.percent_complete = 0;
        } else {
            bucket.percent_complete =
                ((bucket.completed * 100) / bucket.total) as u16;
        }
    }

    buckets
}

fn build_bucket_counts_line(
    group: &TaskGroupSnapshot,
    bucket_width: usize,
    gap: usize,
) -> String {
    let mut line = String::new();
    for (idx, chunk) in group.chunks.iter().enumerate() {
        let label = format!("{}/{}", chunk.completed, chunk.total);
        let padded = format!("{label:^width$}", width = bucket_width);
        line.push_str(&padded);
        if idx + 1 < group.chunks.len() {
            line.push_str(&" ".repeat(gap));
        }
    }
    line
}

fn build_bucket_dates_line(
    group: &TaskGroupSnapshot,
    bucket_width: usize,
    gap: usize,
) -> String {
    let mut line = String::new();
    for (idx, chunk) in group.chunks.iter().enumerate() {
        let label = chunk
            .since_ts
            .map(|value| value.format("%d.%m.%y %H:%M").to_string())
            .unwrap_or_else(|| "-".to_string());
        let padded = format!("{label:^width$}", width = bucket_width);
        line.push_str(&padded);
        if idx + 1 < group.chunks.len() {
            line.push_str(&" ".repeat(gap));
        }
    }
    line
}

fn build_bucket_till_line(
    group: &TaskGroupSnapshot,
    bucket_width: usize,
    gap: usize,
) -> String {
    let mut line = String::new();
    for (idx, chunk) in group.chunks.iter().enumerate() {
        let label = chunk
            .till_ts
            .map(|value| value.format("%d.%m.%y %H:%M").to_string())
            .unwrap_or_else(|| "-".to_string());
        let padded = format!("{label:^width$}", width = bucket_width);
        line.push_str(&padded);
        if idx + 1 < group.chunks.len() {
            line.push_str(&" ".repeat(gap));
        }
    }
    line
}

fn bucket_layout_width(area_width: usize, count: usize) -> (usize, usize) {
    let count = count.max(1);
    let mut gap = SIGINT_INBOX_TUI_BUCKET_GAP.min(area_width.saturating_sub(1));
    let mut total_gap = gap.saturating_mul(count.saturating_sub(1));
    if total_gap >= area_width {
        gap = 0;
        total_gap = 0;
    }
    let mut bucket_width = (area_width.saturating_sub(total_gap)) / count;
    if bucket_width == 0 {
        bucket_width = 1;
    }
    (bucket_width, gap)
}

fn format_ts(ts: Option<NaiveDateTime>) -> String {
    ts.map(|value| value.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string())
}

fn format_last_completed_task(
    last_completed_ago_seconds: Option<i64>,
) -> String {
    match last_completed_ago_seconds {
        Some(seconds) => format!("{seconds}s ago"),
        None => "N/A".to_string(),
    }
}
