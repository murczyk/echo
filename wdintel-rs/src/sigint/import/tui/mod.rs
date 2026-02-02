use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::sigint::import::types::EtalonData;
use crate::sigint::unit::render_unit;
use crate::sigint::unit::types::Unit;
use crate::types::*;
use crate::{h, new_pg_pool_from_mode, ImportTuiPs};
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use sea_orm::*;
use std::io;
use std::io::Stdout;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

struct UnitData {
    data: HashMap<Tab, Vec<UnitRow>>,
}

#[derive(Clone)]
struct UnitRow {
    recording: UnitRec,
    target: Option<UnitRec>,
    target_candidates: Vec<UnitRec>,
    model: sigint_unit::Model,
}

#[derive(Clone, Debug)]
struct UnitRec {
    id: i64,
    full_name: String,
    // company: String,
    // battalion: String,
    // regiment: String,
    // division: String,
    // army: String,
}

impl UnitRec {
    fn render(&self) -> String {
        format!("{}] {}", self.id, self.full_name)
    }
}

#[derive(
    EnumIter, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug, Hash,
)]
enum Tab {
    New,
    Matched,
    Ignore,
}

enum Action {
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
}

impl Tab {
    fn next_tab(tab: Tab, is_fwd: bool) -> Tab {
        let tabs: Vec<_> = Tab::iter().collect();
        let idx = tabs.iter().position(|&t| t == tab).unwrap_or(0);
        let tabs_quantity = tabs.len();
        let new_idx = if is_fwd {
            idx + 1
        } else {
            idx + tabs_quantity - 1
        };
        tabs[new_idx % tabs_quantity]
    }
}

pub async fn run_import_unit_tui(
    mode: Mode,
    ps: ImportTuiPs,
) -> Result<(), AppError> {
    info!("loading data from {}...", ps.path);
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut file_read = File::open(ps.path).await.context(h!())?;
    let mut buffer = Vec::new();
    file_read.read_to_end(&mut buffer).await.context(h!())?;
    let etalon_txt = String::from_utf8_lossy(&buffer).to_string();
    let etalon_full: EtalonData =
        serde_json::from_str(&etalon_txt).context(h!())?;
    let units = etalon_full.sigint_unit;

    let mut terminal = setup_terminal().c(h!())?;
    let res = run_loop(&db, &mut terminal, units).await;
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
    units: Vec<sigint_unit::Model>,
) -> Result<(), AppError> {
    let units_len = units.len();
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    let unit_data = load_unit_data(db, units).await.c(h!())?;
    let mut current_tab = Tab::New;
    let mut line_num = 0;
    terminal
        .draw(|frame| draw_ui(frame, &unit_data, &current_tab, line_num))
        .c(h!())?;
    loop {
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let ev = event::read().c(h!())?;
        if matches_quit(&ev) {
            return Ok(());
        }
        if matches_confirm(&ev) {
            break;
        }
        let mut redraw = false;
        if let Some(new_action) = matches_action(&ev) {
            redraw = true;
            match new_action {
                Action::ScrollUp => {
                    if line_num <= 0 {
                        redraw = false;
                    } else {
                        line_num -= 1;
                    }
                }
                Action::ScrollDown => {
                    if line_num >= units_len {
                        redraw = false;
                    } else {
                        line_num += 1;
                    }
                }
                Action::ScrollLeft => {
                    current_tab = Tab::next_tab(current_tab, false);
                    line_num = 0;
                }
                Action::ScrollRight => {
                    current_tab = Tab::next_tab(current_tab, true);
                    line_num = 0;
                }
            }
        }
        if let Some(new_tab) = matches_tab(&ev) {
            if !current_tab.eq(&new_tab) {
                current_tab = new_tab;
                redraw = true;
                line_num = 0;
            }
        }
        if redraw {
            terminal
                .draw(|frame| {
                    draw_ui(frame, &unit_data, &current_tab, line_num)
                })
                .c(h!())?;
        }
    }
    import_data(unit_data.data.get(&Tab::New).cloned().unwrap_or(vec![]), db)
        .await
        .c(h!())?;
    Ok(())
}

async fn import_data(
    data: Vec<UnitRow>,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if data.is_empty() {
        warn!("nothing to import!");
        return Ok(());
    }
    for rec in data {
        let mut rec = rec.model.into_active_model();
        rec.id = NotSet;
        rec.created_at = NotSet;
        rec.insert(db).await.c(h!())?;
    }
    Ok(())
}

fn draw_ui(frame: &mut Frame, data: &UnitData, tab: &Tab, line_num: usize) {
    let tab_meta = data
        .data
        .iter()
        .map(|(k, v)| (*k, v.len()))
        .collect::<HashMap<_, _>>();
    let data = data.data.get(tab).cloned().unwrap_or(vec![]);
    let displayed_data = if data.len() == 0 {
        vec![]
    } else {
        let max_idx = data.len() - 1;
        let since_idx = line_num.min(max_idx);
        if max_idx < since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE {
            data[since_idx..].to_vec()
        } else {
            let till_idx_max = since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE;
            let till_idx = till_idx_max.min(max_idx);
            data[since_idx..=till_idx].to_vec()
        }
    };
    draw_rows(frame, displayed_data, tab_meta, tab);
}

fn draw_rows(
    frame: &mut Frame,
    rows: Vec<UnitRow>,
    tab_meta: HashMap<Tab, usize>,
    current_tab: &Tab,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(1),
        ])
        .split(frame.size());

    let header =
        Paragraph::new(Line::from("Review mode. Press ENTER to confirm"));
    frame.render_widget(header, root[0]);

    let green = Style::default().fg(Color::Green);
    let tab_labels = [
        format!("New ({})", tab_meta.get(&Tab::New).copied().unwrap_or(0),),
        format!(
            "Matched ({})",
            tab_meta.get(&Tab::Matched).copied().unwrap_or(0),
        ),
        format!(
            "Ignore ({})",
            tab_meta.get(&Tab::Ignore).copied().unwrap_or(0),
        ),
    ];
    let tab_order = [Tab::New, Tab::Matched, Tab::Ignore];
    let mut tab_spans = Vec::new();
    for (idx, label) in tab_labels.iter().enumerate() {
        if idx > 0 {
            tab_spans.push(Span::raw("  "));
        }
        tab_spans.push(Span::styled(label.clone(), green));
    }
    let mut underline = String::new();
    for (idx, label) in tab_labels.iter().enumerate() {
        if idx > 0 {
            underline.push_str("  ");
        }
        let ch = if current_tab == &tab_order[idx] {
            '_'
        } else {
            '-'
        };
        underline.push_str(
            &std::iter::repeat(ch).take(label.len()).collect::<String>(),
        );
    }
    let tabs_lines = vec![
        Line::from(tab_spans),
        Line::from(Span::styled(underline, green)),
    ];
    frame.render_widget(
        Paragraph::new(tabs_lines).wrap(Wrap { trim: false }),
        root[1],
    );

    let (imported_lines, matched_lines, other_lines) = build_row_lines(&rows);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(33),
            Constraint::Percentage(33),
            Constraint::Percentage(34),
        ])
        .split(root[2]);

    render_column(frame, cols[0], "Imported data", imported_lines);
    render_column(frame, cols[1], "Matched row(s)", matched_lines);
    render_column(frame, cols[2], "Other matches", other_lines);
}

enum ColumnLine {
    Text(String),
    Separator,
}

fn build_row_lines(
    rows: &[UnitRow],
) -> (Vec<ColumnLine>, Vec<ColumnLine>, Vec<ColumnLine>) {
    let mut imported_lines = Vec::new();
    let mut matched_lines = Vec::new();
    let mut other_lines = Vec::new();

    for (idx, row) in rows.iter().enumerate() {
        let imported = row.recording.render();
        let matched =
            row.target.as_ref().map(UnitRec::render).unwrap_or_default();
        let other = row
            .target_candidates
            .iter()
            .map(UnitRec::render)
            .collect::<Vec<_>>();

        let other_count = other.len().max(1);
        imported_lines.push(ColumnLine::Text(imported));
        matched_lines.push(ColumnLine::Text(matched));

        if other.is_empty() {
            other_lines.push(ColumnLine::Text(String::new()));
        } else {
            for line in other {
                other_lines.push(ColumnLine::Text(line));
            }
        }

        for _ in 1..other_count {
            imported_lines.push(ColumnLine::Text(String::new()));
            matched_lines.push(ColumnLine::Text(String::new()));
        }

        if idx + 1 < rows.len() {
            imported_lines.push(ColumnLine::Separator);
            matched_lines.push(ColumnLine::Separator);
            other_lines.push(ColumnLine::Separator);
        }
    }

    (imported_lines, matched_lines, other_lines)
}

fn render_column(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    lines: Vec<ColumnLine>,
) {
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let separator_width = inner.width as usize;
    let separator = if separator_width == 0 {
        String::new()
    } else {
        "-".repeat(separator_width)
    };
    let rendered_lines = lines
        .into_iter()
        .map(|line| match line {
            ColumnLine::Text(value) => Line::from(value),
            ColumnLine::Separator => Line::from(Span::raw(separator.clone())),
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(rendered_lines).wrap(Wrap { trim: false }),
        inner,
    );
}

async fn load_unit_data(
    db: &DatabaseConnection,
    units: Vec<sigint_unit::Model>,
) -> anyhow::Result<UnitData> {
    let mut data = HashMap::<Tab, Vec<UnitRow>>::new();
    let local_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|u| render_unit(&u).ok().map(|u1| (u, u1)))
        .collect::<Vec<_>>();
    for unit in units {
        if unit.deleted {
            continue;
        }
        let dto = render_unit(&unit).c(h!())?;
        let unit_name =
            crate::sigint::unit::unit_name(&dto).trim().to_lowercase();
        if unit_name.is_empty() {
            continue;
        }
        let mut perfect_matches = vec![];
        let mut matches = vec![];
        let mut fuzzy_matches = vec![];
        for l in &local_units {
            let (_, lu) = l;
            let n2 = crate::sigint::unit::unit_name(&lu).trim().to_lowercase();
            if n2.is_empty() {
                continue;
            }
            if names_match(&dto, lu) {
                let lu_name =
                    crate::sigint::unit::unit_name(lu).trim().to_lowercase();
                if lu_name.eq(&unit_name) {
                    perfect_matches.push(l.clone());
                } else {
                    matches.push(l.clone());
                }
            } else {
                let n1 = unit_name.trim().to_lowercase();
                if n1.contains(&n2) || n2.contains(&n1) {
                    fuzzy_matches.push(l.clone());
                }
            }
        }
        if perfect_matches.len() > 0 {
            for m in matches {
                fuzzy_matches.push(m);
            }
            matches = perfect_matches;
        }
        let mut unit_row = UnitRow {
            model: unit.clone(),
            recording: from_unit(unit, dto),
            target: None,
            target_candidates: vec![],
        };
        let matches = matches
            .into_iter()
            .map(|(u1, u2)| from_unit(u1, u2))
            .collect_vec();
        let fuzzy_matches = fuzzy_matches
            .into_iter()
            .map(|(u1, u2)| from_unit(u1, u2))
            .collect_vec();
        let tab = if matches.len() == 1 {
            unit_row.target = matches.into_iter().next();
            unit_row.target_candidates = fuzzy_matches;
            Tab::Matched
        } else if matches.len() == 0 {
            unit_row.target = None;
            unit_row.target_candidates = fuzzy_matches;
            Tab::New
        } else {
            unit_row.target = None;
            unit_row.target_candidates = [matches, fuzzy_matches].concat();
            Tab::Ignore
        };
        data.entry(tab).or_insert_with(|| vec![]).push(unit_row);
    }
    Ok(UnitData { data })
}

fn names_match(u1: &Unit, u2: &Unit) -> bool {
    fn check_name_segments_match(
        s1: &str,
        s2: &str,
        is_non_strict_match: bool,
    ) -> (bool, bool) {
        let s1 = s1.trim().to_lowercase();
        let s2 = s2.trim().to_lowercase();
        if is_non_strict_match {
            return (
                s1.is_empty() || s2.is_empty() || s1.eq(&s2),
                is_non_strict_match,
            );
        }
        if s1.is_empty() {
            (s2.is_empty(), true)
        } else {
            (s1.eq(&s2), false)
        }
    }
    let mut is_non_strict_match = false;

    let (matches, is_empty) = check_name_segments_match(
        &u1.company,
        &u2.company,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.battalion,
        &u2.battalion,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.regiment,
        &u2.regiment,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, is_empty) = check_name_segments_match(
        &u1.division,
        &u2.division,
        is_non_strict_match,
    );
    if !matches {
        return false;
    }
    is_non_strict_match = is_non_strict_match || !is_empty;

    let (matches, _is_empty) =
        check_name_segments_match(&u1.army, &u2.army, is_non_strict_match);
    matches
}

fn from_unit(model: sigint_unit::Model, unit: Unit) -> UnitRec {
    let mut full_name = crate::sigint::unit::unit_name(&unit);
    let comment = model.comment.trim();
    if !comment.is_empty() {
        full_name = format!("{full_name} ({comment})");
    }
    UnitRec {
        id: unit.id,
        full_name,
        // company: unit.company,
        // battalion: unit.battalion,
        // regiment: unit.regiment,
        // division: unit.division,
        // army: unit.army,
    }
}

fn matches_tab(event: &Event) -> Option<Tab> {
    if matches_key(event, 'n') {
        Some(Tab::New)
    } else if matches_key(event, 'm') {
        Some(Tab::Matched)
    } else if matches_key(event, 'i') {
        Some(Tab::Ignore)
    } else {
        None
    }
}

fn matches_action(event: &Event) -> Option<Action> {
    if matches_keycode(event, KeyCode::Up) {
        Some(Action::ScrollUp)
    } else if matches_keycode(event, KeyCode::Down) {
        Some(Action::ScrollDown)
    } else if matches_keycode(event, KeyCode::Left) {
        Some(Action::ScrollLeft)
    } else if matches_keycode(event, KeyCode::Right) {
        Some(Action::ScrollRight)
    } else {
        None
    }
}

fn matches_quit(event: &Event) -> bool {
    matches_key(event, 'c') || matches_keycode(event, KeyCode::Esc)
}

fn matches_confirm(event: &Event) -> bool {
    matches_key(event, 'c') || matches_keycode(event, KeyCode::Enter)
}

fn matches_key(event: &Event, c: char) -> bool {
    matches_keycode(event, KeyCode::Char(c))
}

fn matches_keycode(event: &Event, k: KeyCode) -> bool {
    match event {
        Event::Key(e) => e.code.eq(&k),
        _ => false,
    }
}
