use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::sigint::import::types::EtalonData;
use crate::sigint::unit::render_unit;
use crate::sigint::unit::types::Unit;
use crate::types::*;
use crate::{h, new_pg_pool_from_mode, ImportTuiPs};
use anyhow::Context;
use crossterm::event::{self, Event, KeyCode};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute};
use dialoguer::{theme::ColorfulTheme, Confirm};
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
use types::*;

pub mod types;

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
    let data_to_import = load_unit_data(&db, units, true).await.c(h!())?;

    let mut terminal = setup_terminal().c(h!())?;
    let res_data =
        run_import_loop("UNITS", &mut terminal, &data_to_import.data).await;
    restore_terminal(&mut terminal).c(h!())?;
    if let Some(data) = res_data.c(h!())? {
        import_data(data, data_to_import, &db).await.c(h!())?;
    }
    Ok(())
}
pub async fn run_import_network_tui(
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
    let unit_data = load_unit_data(&db, units, false).await.c(h!())?;
    let imported_network_units: Vec<sigint_network_unit::Model> =
        etalon_full.sigint_network_unit;
    let imported_networks: Vec<sigint_network::Model> =
        etalon_full.sigint_network;
    let network_data = load_network_data(
        &db,
        unit_data,
        imported_network_units,
        imported_networks,
    )
    .await
    .c(h!())?;

    let mut terminal = setup_terminal().c(h!())?;
    let res_data =
        run_import_loop("NETWORKS", &mut terminal, &network_data.data).await;
    restore_terminal(&mut terminal).c(h!())?;
    if let Some(data) = res_data.c(h!())? {
        import_network_data(data, network_data, &db).await.c(h!())?;
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

async fn run_import_loop(
    title: &str,
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    tabs_data: &HashMap<Tab, Vec<DataRow>>,
) -> Result<Option<Vec<DataRow>>, AppError> {
    let poll = Duration::from_millis(SIGINT_INBOX_TUI_EVENT_POLL_MS);
    let mut current_tab = Tab::New;
    let mut line_num = 0;
    terminal
        .draw(|frame| draw_ui(title, frame, tabs_data, &current_tab, line_num))
        .c(h!())?;
    loop {
        if !event::poll(poll).c(h!())? {
            continue;
        }
        let ev = event::read().c(h!())?;
        if matches_quit(&ev) {
            return Ok(None);
        }
        if matches_confirm(&ev) {
            break;
        }
        let mut redraw = false;
        let tab_len = tabs_data
            .get(&current_tab)
            .map(|rows| rows.len())
            .unwrap_or(0);
        let (first_visible, last_visible) = visible_range(tab_len, line_num);
        if let Some(new_action) = matches_action(&ev) {
            redraw = true;
            match new_action {
                Action::ScrollUp => {
                    if line_num == 0 {
                        redraw = false;
                    } else {
                        line_num -= 1;
                    }
                }
                Action::ScrollDown => {
                    if tab_len == 0 || line_num >= tab_len - 1 {
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
                Action::PageUp => {
                    if tab_len == 0 || first_visible == 0 {
                        redraw = false;
                    } else {
                        line_num = first_visible.saturating_sub(
                            NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE,
                        );
                    }
                }
                Action::PageDown => {
                    if tab_len == 0 || last_visible >= tab_len - 1 {
                        redraw = false;
                    } else {
                        line_num = last_visible + 1;
                    }
                }
            }
        }
        if redraw {
            terminal
                .draw(|frame| {
                    draw_ui(title, frame, tabs_data, &current_tab, line_num)
                })
                .c(h!())?;
        }
    }
    Ok(Some(tabs_data.get(&Tab::New).cloned().unwrap_or_default()))
}

async fn import_network_data(
    data: Vec<DataRow>,
    network: NetworkData,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if data.is_empty() {
        warn!("nothing to import!");
        return Ok(());
    }
    let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Are you sure you want to import {} networks?",
            data.len()
        ))
        .default(true)
        .interact()
        .context(h!())?;
    if !import_confirmed {
        info!("Import aborted.");
        return Ok(());
    }
    let txn = db.begin().await.c(h!())?;
    for row in data {
        let rec = network.models.get(&row.recording.id).cloned().c(h!())?;
        let unit_id = network
            .model_to_unit_id
            .get(&row.recording.id)
            .cloned()
            .c(h!())?;
        let mut rec = rec.into_active_model();
        rec.id = NotSet;
        rec.created_at = NotSet;
        let new_network = rec.insert(&txn).await.c(h!())?;
        sigint_network_unit::ActiveModel {
            id: NotSet,
            network_id: Set(new_network.id),
            unit_id: Set(unit_id),
            created_at: NotSet,
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    info!("Import completed.");
    Ok(())
}

async fn import_data(
    data: Vec<DataRow>,
    units: UnitData,
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if data.is_empty() {
        warn!("nothing to import!");
        return Ok(());
    }
    let import_confirmed = Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Are you sure you want to import {} units?",
            data.len()
        ))
        .default(true)
        .interact()
        .context(h!())?;
    if !import_confirmed {
        info!("Import aborted.");
        return Ok(());
    }
    let txn = db.begin().await.c(h!())?;
    for row in data {
        let rec = units.models.get(&row.recording.id).cloned().c(h!())?;
        let mut rec = rec.into_active_model();
        rec.id = NotSet;
        rec.created_at = NotSet;
        rec.insert(&txn).await.c(h!())?;
    }
    txn.commit().await.c(h!())?;
    info!("Import completed.");
    Ok(())
}

fn draw_ui(
    title: &str,
    frame: &mut Frame,
    data: &HashMap<Tab, Vec<DataRow>>,
    tab: &Tab,
    line_num: usize,
) {
    let tab_meta = data
        .iter()
        .map(|(k, v)| (*k, v.len()))
        .collect::<HashMap<_, _>>();
    let data = data.get(tab).cloned().unwrap_or(vec![]);
    let displayed_data = if data.is_empty() {
        vec![]
    } else {
        let (since_idx, till_idx) = visible_range(data.len(), line_num);
        data[since_idx..=till_idx].to_vec()
    };
    draw_rows(title, frame, displayed_data, tab_meta, tab);
}

fn visible_range(data_len: usize, line_num: usize) -> (usize, usize) {
    if data_len == 0 {
        return (0, 0);
    }
    let max_idx = data_len - 1;
    let since_idx = line_num.min(max_idx);
    let till_idx =
        if max_idx < since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE {
            max_idx
        } else {
            since_idx + NETWORKS_IMPORT_TUI_ROWS_NUM_PAGE_SIZE
        };
    (since_idx, till_idx)
}

fn draw_rows(
    title: &str,
    frame: &mut Frame,
    rows: Vec<DataRow>,
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

    let header = Paragraph::new(Line::from(format!(
        "{title}: Review mode. Press ENTER to confirm or ESCAPE to quit"
    )));
    frame.render_widget(header, root[0]);

    let green = Style::default().fg(Color::Green);
    let tab_labels = [
        format!("new ({})", tab_meta.get(&Tab::New).copied().unwrap_or(0),),
        format!(
            "matched ({})",
            tab_meta.get(&Tab::Matched).copied().unwrap_or(0),
        ),
        format!(
            "ignore ({})",
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
            &std::iter::repeat_n(ch, label.len()).collect::<String>(),
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
    render_column(frame, cols[1], "Matched row", matched_lines);
    render_column(frame, cols[2], "Other matches", other_lines);
}

enum ColumnLine {
    Text(String),
    Separator,
}

fn build_row_lines(
    rows: &[DataRow],
) -> (Vec<ColumnLine>, Vec<ColumnLine>, Vec<ColumnLine>) {
    let mut imported_lines = Vec::new();
    let mut matched_lines = Vec::new();
    let mut other_lines = Vec::new();

    for (idx, row) in rows.iter().enumerate() {
        let imported = row.recording.render();
        let matched =
            row.target.as_ref().map(DataRec::render).unwrap_or_default();
        let other = row
            .target_candidates
            .iter()
            .map(DataRec::render)
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

async fn load_network_data(
    db: &DatabaseConnection,
    mut unit_data: UnitData,
    all_imported_network_units: Vec<sigint_network_unit::Model>,
    imported_networks: Vec<sigint_network::Model>,
) -> anyhow::Result<NetworkData> {
    let models = imported_networks
        .clone()
        .into_iter()
        .map(|x| (x.id, x))
        .collect();
    let mut data = HashMap::new();
    let mut model_to_unit_id = HashMap::new();

    let local_networks = sigint_network::Entity::find()
        .find_with_related(sigint_network_unit::Entity)
        .filter(sigint_network::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;

    let mut local_unit_networks = HashMap::new();
    for (local_network, local_network_units) in local_networks {
        for local_network_unit in local_network_units {
            local_unit_networks
                .entry(local_network_unit.unit_id)
                .or_insert_with(Vec::new)
                .push(local_network.clone());
        }
    }

    let mut local_unit_dictionary = HashMap::new();
    let mut imported_unit_id_to_local_unit_id_map = HashMap::new();
    let mut imported_unit_id_to_ignored_local_unit_ids_map = HashMap::new();
    for unit in unit_data.data.remove(&Tab::Matched).unwrap_or_default() {
        let source_unit_id = unit.recording.id;
        for ignored_local_unit in unit.target_candidates {
            imported_unit_id_to_ignored_local_unit_ids_map
                .entry(source_unit_id)
                .or_insert_with(Vec::new)
                .push(ignored_local_unit);
        }
        let Some(target) = unit.target else {
            continue;
        };
        let target_unit_id = target.id;
        local_unit_dictionary.insert(target_unit_id, target);
        imported_unit_id_to_local_unit_id_map
            .insert(source_unit_id, target_unit_id);
    }
    for unit in unit_data.data.remove(&Tab::Ignore).unwrap_or_default() {
        let source_unit_id = unit.recording.id;
        for ignored_local_unit in unit.target_candidates {
            imported_unit_id_to_ignored_local_unit_ids_map
                .entry(source_unit_id)
                .or_insert_with(Vec::new)
                .push(ignored_local_unit);
        }
    }

    for imported_network in imported_networks {
        if imported_network.deleted {
            continue;
        }
        let mut network_row = DataRow {
            recording: from_network(imported_network.clone(), None),
            target: None,
            target_candidates: vec![],
        };

        let imported_network_units = all_imported_network_units
            .iter()
            .filter(|u| u.network_id.eq(&imported_network.id))
            .collect_vec();
        if imported_network_units.len() > 1 {
            let units = imported_network_units
                .iter()
                .map(|u| {
                    unit_data
                        .models
                        .get(&u.unit_id)
                        .map(|u| u.name.clone())
                        .unwrap_or("НВ".to_string())
                })
                .join(", ");
            network_row.recording.full_name = format!(
                "!! {} MAPPED TO MULTIPLE UNITS: {units}",
                network_row.recording.full_name
            );
            data.entry(Tab::Ignore)
                .or_insert_with(Vec::new)
                .push(network_row);
            continue;
        }
        let imported_unit_id =
            imported_network_units.into_iter().next().map(|x| x.unit_id);
        let ignored_local_units = imported_unit_id
            .and_then(|id| {
                imported_unit_id_to_ignored_local_unit_ids_map
                    .get(&id)
                    .cloned()
            })
            .unwrap_or_default();
        let ignored_matches = collect_matching_unit_networks(
            &local_unit_networks,
            ignored_local_units,
        );
        network_row.target_candidates = ignored_matches;
        let imported_unit = imported_unit_id
            .and_then(|unit_id| unit_data.models.get(&unit_id))
            .and_then(|u| {
                render_unit(u).ok().map(|u2| from_unit(u.clone(), u2))
            });
        network_row.recording =
            from_network(imported_network.clone(), imported_unit);
        let local_unit = imported_unit_id
            .and_then(|unit_id| {
                imported_unit_id_to_local_unit_id_map.get(&unit_id).cloned()
            })
            .and_then(|id| local_unit_dictionary.get(&id).cloned());
        let Some(local_unit) = local_unit else {
            data.entry(Tab::Ignore)
                .or_insert_with(Vec::new)
                .push(network_row);
            continue;
        };
        model_to_unit_id.insert(network_row.recording.id, local_unit.id);
        let matches = collect_matching_unit_networks(
            &local_unit_networks,
            vec![local_unit],
        );
        let tab = if matches.len() == 1 {
            network_row.target = matches.into_iter().next();
            Tab::Matched
        } else if matches.is_empty() {
            network_row.target = None;
            Tab::New
        } else {
            network_row.target = None;
            for m in matches {
                network_row.target_candidates.push(m);
            }
            Tab::Ignore
        };
        data.entry(tab).or_insert_with(Vec::new).push(network_row);
    }
    Ok(NetworkData {
        data,
        models,
        model_to_unit_id,
    })
}

fn collect_matching_unit_networks(
    local_unit_networks: &HashMap<i64, Vec<sigint_network::Model>>,
    local_units: Vec<DataRec>,
) -> Vec<DataRec> {
    let mut matches = vec![];
    let units_dictionary = local_units
        .into_iter()
        .map(|x| (x.id, x))
        .collect::<HashMap<_, _>>();
    for (unit_id, local_unit_networks) in local_unit_networks {
        let Some(unit) = units_dictionary.get(unit_id).cloned() else {
            continue;
        };
        local_unit_networks
            .iter()
            .map(|network| from_network(network.clone(), Some(unit.clone())))
            .for_each(|m| matches.push(m));
    }
    matches
}

async fn load_unit_data(
    db: &DatabaseConnection,
    units: Vec<sigint_unit::Model>,
    exact_match: bool,
) -> anyhow::Result<UnitData> {
    let mut data = HashMap::<Tab, Vec<DataRow>>::new();
    let local_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|u| render_unit(&u).ok().map(|u1| (u, u1)))
        .collect::<Vec<_>>();
    let mut models = HashMap::new();
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
            let n2 = crate::sigint::unit::unit_name(lu).trim().to_lowercase();
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
        if !perfect_matches.is_empty() {
            for m in matches {
                fuzzy_matches.push(m);
            }
            matches = perfect_matches;
        }
        let fuzzy_target = if matches.len() > 1 {
            matches
                .iter()
                .reduce(|a, b| if a.0.id < b.0.id { a } else { b })
                .cloned()
                .map(|(m, u)| from_unit(m, u))
        } else {
            None
        };
        models.insert(unit.id, unit.clone());
        let mut unit_row = DataRow {
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
        } else if !exact_match && fuzzy_target.is_some() {
            let fuzzy_target = fuzzy_target.c(h!())?;
            unit_row.target_candidates = matches
                .into_iter()
                .filter(|r| r.id != fuzzy_target.id)
                .collect();
            unit_row.target = Some(fuzzy_target);
            Tab::Matched
        } else if matches.is_empty() {
            unit_row.target = None;
            unit_row.target_candidates = fuzzy_matches;
            Tab::New
        } else {
            unit_row.target = None;
            unit_row.target_candidates = [matches, fuzzy_matches].concat();
            Tab::Ignore
        };
        data.entry(tab).or_insert_with(Vec::new).push(unit_row);
    }
    Ok(UnitData { data, models })
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

fn from_unit(model: sigint_unit::Model, unit: Unit) -> DataRec {
    let mut full_name = crate::sigint::unit::unit_name(&unit);
    let comment = model.comment.trim();
    if !comment.is_empty() {
        full_name = format!("{full_name} ({comment})");
    }
    DataRec {
        id: unit.id,
        full_name,
    }
}

fn from_network(
    network: sigint_network::Model,
    unit: Option<DataRec>,
) -> DataRec {
    let unit_name = unit.map(|unit| unit.full_name).unwrap_or("нв".to_string());
    let network_name = network.name.trim();
    let full_name = format!("{network_name} {unit_name}");
    DataRec {
        id: network.id,
        full_name,
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
    } else if matches_keycode(event, KeyCode::PageUp) {
        Some(Action::PageUp)
    } else if matches_keycode(event, KeyCode::PageDown) {
        Some(Action::PageDown)
    } else {
        None
    }
}

fn matches_quit(event: &Event) -> bool {
    matches_keycode(event, KeyCode::Esc)
}

fn matches_confirm(event: &Event) -> bool {
    matches_keycode(event, KeyCode::Enter)
}

fn matches_keycode(event: &Event, k: KeyCode) -> bool {
    match event {
        Event::Key(e) => e.code.eq(&k),
        _ => false,
    }
}
