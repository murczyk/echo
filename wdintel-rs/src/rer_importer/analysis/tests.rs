use crate::config::SYSTEM_LOGIN_NAME;
use crate::functest::tests::*;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::rer_importer::*;
use actix_web::web::{Data, Json};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    FromQueryResult, QueryFilter,
};
use serial_test::serial;

struct GroupFixture {
    signal_group: signal_group::Model,
    datasource_group: datasource_group::Model,
}

struct NetworkFixture {
    network: sigint_network::Model,
}

struct RerAnalysisFixture {
    env: Arc<Env>,
    north_aor: area_of_responsibility::Model,
    south_aor: area_of_responsibility::Model,
    wide_aor: area_of_responsibility::Model,
    alpha: GroupFixture,
    beta: GroupFixture,
    secret_live: GroupFixture,
    secret_empty: GroupFixture,
    secret_hidden: GroupFixture,
    network_wide: NetworkFixture,
    network_south: NetworkFixture,
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
}

struct AorFilterFixture {
    env: Arc<Env>,
    aor_a: area_of_responsibility::Model,
    group_x: GroupFixture,
    group_y: GroupFixture,
    network_k: NetworkFixture,
    network_l: NetworkFixture,
    created_at: NaiveDateTime,
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
}

async fn test_identity_login_id(
    env: &Env,
    test_identity: &TestIdentity,
) -> uuid::Uuid {
    crate::users::login_id_by_name(&env.dbx, &test_identity.login)
        .await
        .unwrap()
}

fn test_dt(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
) -> NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .unwrap()
        .and_hms_opt(hour, minute, 0)
        .unwrap()
}

fn short_state_filter(
    groups_selected: Option<Vec<String>>,
) -> RerDutyQueryStateWf {
    RerDutyQueryStateWf {
        groups_selected,
        groups_denied: None,
        senders_selected: None,
        denied_senders: None,
        freqs_selected: None,
        freqs_denied: None,
        posts_selected: None,
        posts_denied: None,
        units_selected: None,
        units_denied: None,
        units_exact_match_only: None,
        last_viewed_message_id: None,
        highlight_keywords_enabled: None,
        highlight_keyword_set_id: None,
    }
}

fn short_state(groups_selected: Option<Vec<String>>) -> RerDutyQueryState {
    RerDutyQueryState {
        waterfalls: Some(vec![(
            "mf-0".to_string(),
            short_state_filter(groups_selected),
        )]),
    }
}

fn mk_analysis_stats_req(
    since_date_inclusive_ms: i64,
    till_date_noninclusive_ms: i64,
) -> AnalysisStatsReq {
    AnalysisStatsReq {
        since_date_inclusive_ms,
        till_date_noninclusive_ms,
        selected_groups: None,
        selected_senders: None,
        selected_freqs: None,
        selected_posts: None,
        selected_callsigns: None,
        selected_units: None,
        selected_locations: None,
        selected_aors: None,
        or_with_extended_form: None,
        or_bookmarked: None,
        or_important: None,
        or_with_coords: None,
        or_without_coords: None,
        search: None,
        selected_tags: None,
        denied_tags: None,
        tag_presence: None,
        selected_networks: None,
        without_network: None,
        metadata_cc: None,
        metadata_sender: None,
        metadata_receiver: None,
        metadata_hash: None,
        only_with_metadata: None,
        without_metadata: None,
        include_peleng_locations: None,
        units_exact_match_only: None,
        filter_tags_option: None,
        without_model_tags: None,
        report_tags_only_this_unit: None,
    }
}

fn analysis_stats_req0(fixture: &RerAnalysisFixture) -> AnalysisStatsReq {
    mk_analysis_stats_req(
        fixture.since_date_inclusive_ms,
        fixture.till_date_noninclusive_ms,
    )
}

fn analysis_stats_req_for_aor_fixture(
    fixture: &AorFilterFixture,
) -> AnalysisStatsReq {
    mk_analysis_stats_req(
        fixture.since_date_inclusive_ms,
        fixture.till_date_noninclusive_ms,
    )
}

async fn mk_group_fixture(
    db: &DatabaseConnection,
    datasource: &datasource::Model,
    zone: &sigint_zone::Model,
    name: &str,
    master_key: &str,
    aor_id: i64,
    is_secret: bool,
    created_at: NaiveDateTime,
) -> Result<GroupFixture, AppError> {
    let signal_group = mk_signal_group(
        db,
        signal_group::ActiveModel {
            master_key: Set(master_key.to_string()),
            name: Set(Some(name.to_string())),
            datasource_id: Set(Some(datasource.id)),
            created_at: Set(created_at),
            is_secret: Set(is_secret),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    let datasource_group = mk_datasource_group(
        db,
        datasource_group::ActiveModel {
            group_master_key: Set(signal_group.master_key.clone()),
            datasource_id: Set(datasource.id),
            last_sync_at: Set(created_at),
            created_at: Set(created_at),
            name: Set(name.to_string()),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    mk_sigint_zone_datasource(
        db,
        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone.id),
            datasource_id: Set(datasource.id),
            group_master_key: Set(signal_group.master_key.clone()),
            created_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    mk_signal_group_aor(
        db,
        signal_group_aor::ActiveModel {
            master_key: Set(signal_group.master_key.clone()),
            aor_id: Set(aor_id),
            created_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    Ok(GroupFixture {
        signal_group,
        datasource_group,
    })
}

async fn mk_network_fixture(
    db: &DatabaseConnection,
    name: &str,
    freq: &str,
    aor_id: i64,
    active_from: NaiveDateTime,
) -> Result<NetworkFixture, AppError> {
    mk_network_fixture_with_window(db, name, freq, aor_id, active_from, None)
        .await
}

async fn mk_network_fixture_with_window(
    db: &DatabaseConnection,
    name: &str,
    freq: &str,
    aor_id: i64,
    active_from: NaiveDateTime,
    active_to: Option<NaiveDateTime>,
) -> Result<NetworkFixture, AppError> {
    let network = mk_sigint_network(
        db,
        sigint_network::ActiveModel {
            name: Set(name.to_string()),
            location: Set(String::new()),
            created_at: Set(active_from),
            updated_at: Set(active_from),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    mk_sigint_network_aor(
        db,
        sigint_network_aor::ActiveModel {
            network_id: Set(network.id),
            aor_id: Set(aor_id),
            created_at: Set(active_from),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    add_network_freq_window(
        db,
        network.id,
        freq,
        active_from,
        active_from,
        active_to,
    )
    .await?;
    Ok(NetworkFixture { network })
}

async fn mk_analysis_message(
    db: &DatabaseConnection,
    label: &str,
    freq: &str,
    datetime: NaiveDateTime,
    groups: &[&GroupFixture],
    network_ids: &[i64],
    with_peleng: bool,
) -> Result<signal_message::Model, AppError> {
    mk_analysis_message_with_location(
        db,
        label,
        freq,
        datetime,
        groups,
        network_ids,
        with_peleng,
        None,
    )
    .await
}

async fn mk_analysis_message_with_location(
    db: &DatabaseConnection,
    label: &str,
    freq: &str,
    datetime: NaiveDateTime,
    groups: &[&GroupFixture],
    network_ids: &[i64],
    with_peleng: bool,
    location_v2: Option<&str>,
) -> Result<signal_message::Model, AppError> {
    let primary_group = groups.first().context(h!())?;
    let body_noheader = crate::rer_importer::body_noheader::extract_text(label)
        .context(h!())?;
    let signal_message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            body: Set(Some(label.to_string())),
            created_at: Set(datetime),
            timestamp: Set(Some(datetime)),
            message_uid: Set(Some(label.to_string())),
            datasource_group_id: Set(Some(primary_group.datasource_group.id)),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            id: Set(signal_message.id),
            freq: Set(Some(freq.to_string())),
            date: Set(Some(datetime.date().to_string())),
            time: Set(Some(datetime.time().format("%H:%M:%S").to_string())),
            location_v2: Set(location_v2.map(str::to_string)),
            body_noheader: Set(Some(
                serde_json::to_value(&body_noheader).context(h!())?,
            )),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    crate::sigint::worker::incoming_message_after_insert(db, signal_message.id)
        .await
        .context(h!())?;
    for group in groups {
        mk_signal_message_group(
            db,
            signal_message_group::ActiveModel {
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(
                    group.signal_group.master_key.clone(),
                )),
                datasource_group_id: Set(Some(group.datasource_group.id)),
                sender: Set(Some(format!("{label}-sender"))),
                message_uid: Set(Some(label.to_string())),
                created_at: Set(datetime),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
    }
    for network_id in network_ids {
        mk_sigint_inbox_item_network(
            db,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(signal_message.id),
                sigint_network_id: Set(*network_id),
                created_at: Set(datetime),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
    }
    if with_peleng {
        mk_sigint_peleng(
            db,
            sigint_peleng::ActiveModel {
                source_inbox_item_id: Set(signal_message.id),
                lat: Set(48.0),
                lng: Set(37.0),
                created_at: Set(datetime),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
    }
    Ok(signal_message)
}

async fn add_group_aor(
    db: &DatabaseConnection,
    group: &GroupFixture,
    aor_id: i64,
    created_at: NaiveDateTime,
) -> Result<(), AppError> {
    mk_signal_group_aor(
        db,
        signal_group_aor::ActiveModel {
            master_key: Set(group.signal_group.master_key.clone()),
            aor_id: Set(aor_id),
            created_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn add_network_freq_window(
    db: &DatabaseConnection,
    network_id: i64,
    freq: &str,
    created_at: NaiveDateTime,
    active_from: NaiveDateTime,
    active_to: Option<NaiveDateTime>,
) -> Result<(), AppError> {
    mk_sigint_network_freq(
        db,
        sigint_network_freq::ActiveModel {
            network_id: Set(network_id),
            freq: Set(freq.to_string()),
            created_at: Set(created_at),
            active_from: Set(active_from),
            active_to: Set(active_to),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn mk_rer_analysis_fixture() -> Result<RerAnalysisFixture, AppError> {
    let env = cleanup().await?;
    let db = &env.dbx;
    let created_at = test_dt(2026, 3, 1, 7, 0);
    let north_aor = find_test_aor(db).await?;
    let south_aor = mk_aor(
        db,
        area_of_responsibility::ActiveModel {
            name: Set("South AOR".to_string()),
            left_bound: Set(200.0),
            right_bound: Set(300.0),
            is_top_level: Set(true),
            created_at: Set(created_at),
            updated_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    let wide_aor = mk_aor(
        db,
        area_of_responsibility::ActiveModel {
            name: Set("Wide AOR".to_string()),
            left_bound: Set(0.0),
            right_bound: Set(300.0),
            is_top_level: Set(true),
            created_at: Set(created_at),
            updated_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    let organism = find_test_organism(db).await?;
    mk_organism_aor(
        db,
        organism_aor::ActiveModel {
            organism_id: Set(organism.id),
            aor_id: Set(south_aor.id),
            created_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;

    let datasource = find_test_datasource(db).await?;
    let zone = find_test_sigint_zone(db).await?;
    let alpha = GroupFixture {
        signal_group: find_test_signal_group(db).await?,
        datasource_group: find_test_datasource_group(db).await?,
    };
    let beta = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "South Group",
        "south-group-master-key",
        south_aor.id,
        false,
        created_at,
    )
    .await?;
    let secret_live = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "Secret Live Group",
        "secret-live-group-master-key",
        north_aor.id,
        true,
        created_at,
    )
    .await?;
    let secret_empty = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "Secret Empty Group",
        "secret-empty-group-master-key",
        north_aor.id,
        true,
        created_at,
    )
    .await?;
    let secret_hidden = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "Secret Hidden Group",
        "secret-hidden-group-master-key",
        north_aor.id,
        true,
        created_at,
    )
    .await?;

    let login = find_test_login(db).await?;
    for group in [&secret_live, &secret_empty] {
        mk_secret_group_user(
            db,
            secret_group_user::ActiveModel {
                master_key: Set(group.signal_group.master_key.clone()),
                login_id: Set(login.id),
                ..Default::default()
            },
        )
        .await
        .context(h!())?;
    }

    let network_wide = mk_network_fixture(
        db,
        "Wide Network",
        "333.3",
        wide_aor.id,
        created_at,
    )
    .await?;
    let network_south = mk_network_fixture(
        db,
        "South Network",
        "444.4",
        south_aor.id,
        created_at,
    )
    .await?;

    mk_analysis_message(
        db,
        "msg-alpha",
        "111.1",
        test_dt(2026, 3, 1, 10, 0),
        &[&alpha],
        &[],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-secret-live",
        "222.2",
        test_dt(2026, 3, 1, 10, 1),
        &[&secret_live],
        &[],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-wide-network",
        "333.3",
        test_dt(2026, 3, 1, 10, 2),
        &[&alpha],
        &[network_wide.network.id],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-south-network",
        "444.4",
        test_dt(2026, 3, 1, 10, 3),
        &[&beta],
        &[network_south.network.id],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-multi-group",
        "555.5",
        test_dt(2026, 3, 1, 10, 4),
        &[&alpha, &beta],
        &[],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-peleng",
        "666.6",
        test_dt(2026, 3, 1, 10, 5),
        &[&beta],
        &[],
        true,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-south-no-network",
        "777.7",
        test_dt(2026, 3, 1, 10, 6),
        &[&beta],
        &[],
        false,
    )
    .await?;
    mk_analysis_message(
        db,
        "msg-secret-hidden",
        "888.8",
        test_dt(2026, 3, 1, 10, 7),
        &[&secret_hidden],
        &[],
        false,
    )
    .await?;

    Ok(RerAnalysisFixture {
        env,
        north_aor,
        south_aor,
        wide_aor,
        alpha,
        beta,
        secret_live,
        secret_empty,
        secret_hidden,
        network_wide,
        network_south,
        since_date_inclusive_ms: test_dt(2026, 3, 1, 8, 0)
            .and_utc()
            .timestamp_millis(),
        till_date_noninclusive_ms: test_dt(2026, 3, 1, 8, 10)
            .and_utc()
            .timestamp_millis(),
    })
}

async fn mk_aor_filter_fixture() -> Result<AorFilterFixture, AppError> {
    let env = cleanup().await?;
    let db = &env.dbx;
    let created_at = test_dt(2026, 3, 2, 7, 0);
    let aor_a = find_test_aor(db).await?;
    let aor_b = mk_aor(
        db,
        area_of_responsibility::ActiveModel {
            name: Set("Document AOR B".to_string()),
            left_bound: Set(200.0),
            right_bound: Set(300.0),
            is_top_level: Set(true),
            created_at: Set(created_at),
            updated_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    let organism = find_test_organism(db).await?;
    mk_organism_aor(
        db,
        organism_aor::ActiveModel {
            organism_id: Set(organism.id),
            aor_id: Set(aor_b.id),
            created_at: Set(created_at),
            ..Default::default()
        },
    )
    .await
    .context(h!())?;
    let datasource = find_test_datasource(db).await?;
    let zone = find_test_sigint_zone(db).await?;
    let group_x = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "Document Group X",
        "document-group-x-master-key",
        aor_a.id,
        false,
        created_at,
    )
    .await?;
    let group_y = mk_group_fixture(
        db,
        &datasource,
        &zone,
        "Document Group Y",
        "document-group-y-master-key",
        aor_b.id,
        false,
        created_at,
    )
    .await?;
    let network_k = mk_network_fixture(
        db,
        "Document Network K",
        "910.1",
        aor_a.id,
        created_at,
    )
    .await?;
    let network_l = mk_network_fixture(
        db,
        "Document Network L",
        "910.2",
        aor_b.id,
        created_at,
    )
    .await?;

    Ok(AorFilterFixture {
        env,
        aor_a,
        group_x,
        group_y,
        network_k,
        network_l,
        created_at,
        since_date_inclusive_ms: test_dt(2026, 3, 2, 8, 0)
            .and_utc()
            .timestamp_millis(),
        till_date_noninclusive_ms: test_dt(2026, 3, 2, 8, 10)
            .and_utc()
            .timestamp_millis(),
    })
}

fn group_counts(groups: Vec<AnalysisStatsGroup>) -> BTreeMap<String, i64> {
    groups
        .into_iter()
        .map(|group| (group.master_key, group.count))
        .collect()
}

fn freq_counts(freqs: Vec<AnalysisStatsFreq>) -> BTreeMap<String, i64> {
    freqs
        .into_iter()
        .map(|freq| (freq.freq, freq.count))
        .collect()
}

fn aor_counts(aors: Vec<AnalysisStatsAor>) -> BTreeMap<i64, i64> {
    aors.into_iter()
        .map(|aor| (aor.aor_id, aor.count))
        .collect()
}

fn network_counts(networks: Vec<AnalysisStatsNetwork>) -> BTreeMap<i64, i64> {
    networks
        .into_iter()
        .map(|network| (network.network_id, network.count))
        .collect()
}

fn sender_counts(
    stats_senders: Vec<AnalysisStatsSender>,
) -> BTreeMap<String, i64> {
    stats_senders
        .into_iter()
        .map(|sender| (sender.uuid, sender.count))
        .collect()
}

fn callsign_counts(
    callsigns: Vec<AnalysisStatsCallsign>,
) -> BTreeMap<String, i64> {
    callsigns
        .into_iter()
        .map(|callsign| (callsign.callsign, callsign.count))
        .collect()
}

fn tag_counts(tags: Vec<AnalysisStatsTag>) -> BTreeMap<i64, i64> {
    tags.into_iter()
        .map(|tag| (tag.tag_id, tag.count))
        .collect()
}

fn metadata_value_counts(
    values: Vec<AnalysisStatsMetadataValue>,
) -> BTreeMap<String, i64> {
    values
        .into_iter()
        .map(|value| (value.value, value.count))
        .collect()
}

async fn analysis_login_and_master_keys(
    env: &Env,
) -> Result<(uuid::Uuid, Vec<String>), AppError> {
    let test_identity = mk_test_identity().await?;
    let login_id =
        crate::users::login_id_by_name(&env.dbx, &test_identity.login).await?;
    let master_keys = get_identity_sigint_groups(&env.dbx, &login_id)
        .await
        .context(h!())?;
    Ok((login_id, master_keys))
}

async fn fetch_group_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let groups = stats::fetch_groups_for_login(req, &login, &env, master_keys)
        .await
        .context(h!())?;
    Ok(group_counts(groups))
}

async fn fetch_group_counts_with_secret_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let groups =
        stats::fetch_groups_for_login(req, &login, &env, master_keys.clone())
            .await
            .context(h!())?;
    let groups = include_missing_secret_groups(&env.dbx, groups, &master_keys)
        .await
        .context(h!())?;
    Ok(group_counts(groups))
}

async fn fetch_freq_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let freqs = stats::fetch_freqs_for_login(req, &login, &env, master_keys)
        .await
        .context(h!())?;
    Ok(freq_counts(freqs))
}

async fn fetch_sender_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let stats_senders =
        stats::fetch_senders_for_login(req, &login, &env, master_keys)
            .await
            .context(h!())?;
    Ok(sender_counts(stats_senders))
}

async fn fetch_aor_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<i64, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let aors = stats::fetch_aors_for_login(req, &login, &env, master_keys)
        .await
        .context(h!())?;
    Ok(aor_counts(aors))
}

async fn fetch_analytics_aor_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<i64, i64>, AppError> {
    #[derive(FromQueryResult)]
    struct AorQueryResult {
        aor_id: i64,
        count: i64,
    }

    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let statement = stats::build_aors_analytics_query(
        req,
        &login,
        crate::utils::dt_from_millis(req.since_date_inclusive_ms)?,
        crate::utils::dt_from_millis(req.till_date_noninclusive_ms)?,
        master_keys,
    )?;
    let aors = AorQueryResult::find_by_statement(statement)
        .all(&env.dbx)
        .await
        .context(h!())?;
    Ok(aors
        .into_iter()
        .map(|aor| (aor.aor_id, aor.count))
        .collect())
}

#[derive(FromQueryResult)]
struct AnalyticsCountQueryResult {
    count: i64,
}

async fn fetch_analytics_network_count_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<i64, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let tag_access = stats::resolve_analytics_tag_access(
        &env.dbx,
        &login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .await?;
    let statement = stats::build_networks_analytics_count_query(
        req,
        &login,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        crate::utils::dt_from_millis(req.since_date_inclusive_ms)?,
        crate::utils::dt_from_millis(req.till_date_noninclusive_ms)?,
        master_keys,
    )?;
    assert!(statement.sql.contains("UNION ALL"));
    assert!(statement.sql.contains("COUNT(DISTINCT network_id)"));
    assert!(!statement.sql.contains("SELECT DISTINCT"));
    assert!(!statement.sql.contains("WITH "));
    assert!(!statement.sql.contains("FROM \"login\""));
    assert!(!statement.sql.contains("JOIN \"login\""));
    Ok(AnalyticsCountQueryResult::find_by_statement(statement)
        .one(&env.dbx)
        .await
        .context(h!())?
        .map(|result| result.count)
        .unwrap_or(0))
}

async fn fetch_analytics_network_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<i64, i64>, AppError> {
    #[derive(FromQueryResult)]
    struct NetworkQueryResult {
        network_id: i64,
        msg_count: i64,
    }

    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let tag_access = stats::resolve_analytics_tag_access(
        &env.dbx,
        &login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .await?;
    let statement = stats::build_networks_analytics_query(
        req,
        &login,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        crate::utils::dt_from_millis(req.since_date_inclusive_ms)?,
        crate::utils::dt_from_millis(req.till_date_noninclusive_ms)?,
        master_keys,
        false,
    )?;
    Ok(NetworkQueryResult::find_by_statement(statement)
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|row| (row.network_id, row.msg_count))
        .collect())
}

async fn fetch_analytics_tag_count_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<i64, AppError> {
    let (login_id, master_keys) = analysis_login_and_master_keys(env).await?;
    let tag_access = stats::resolve_analytics_tag_access(
        &env.dbx,
        &login_id,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .await?;
    let query = stats::build_tags_analytics_count_query(
        req,
        &login_id,
        &tag_access.accessible_tag_ids,
        &tag_access.unit_login_ids,
        crate::utils::dt_from_millis(req.since_date_inclusive_ms)?,
        crate::utils::dt_from_millis(req.till_date_noninclusive_ms)?,
        master_keys,
    )?;
    let statement = query.build(DbBackend::Postgres);
    assert!(statement.sql.contains("COUNT(DISTINCT"));
    assert!(!statement.sql.contains("owner_organism_id"));
    assert!(!statement.sql.contains("FROM \"login\""));
    assert!(!statement.sql.contains("JOIN \"login\""));
    Ok(query
        .into_model::<AnalyticsCountQueryResult>()
        .one(&env.dbx)
        .await
        .context(h!())?
        .map(|result| result.count)
        .unwrap_or(0))
}

async fn fetch_network_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<i64, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let networks =
        stats::fetch_networks_for_login(req, &login, &env.dbx, master_keys)
            .await
            .context(h!())?;
    Ok(network_counts(networks))
}

async fn fetch_location_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let locations =
        stats::fetch_locations_for_login(req, &login, &env, master_keys)
            .await
            .context(h!())?;
    Ok(locations
        .into_iter()
        .map(|location| (location.location, location.count))
        .collect())
}

async fn fetch_callsign_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<String, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let callsigns =
        stats::fetch_callsigns_for_login(req, &login, &env, master_keys)
            .await
            .context(h!())?;
    Ok(callsign_counts(callsigns))
}

async fn fetch_tag_counts_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<BTreeMap<i64, i64>, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    let tags = stats::fetch_tags_for_login(req, &login, &env, master_keys)
        .await
        .context(h!())?;
    Ok(tag_counts(tags))
}

async fn fetch_metadata_stats_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<MetadataStatsRsp, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let env = Data::from(env.clone());
    Ok(
        stats::fetch_metadata_stats_for_login(req, &login, &env, master_keys)
            .await
            .context(h!())?,
    )
}

async fn fetch_selected_count_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<i64, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    let (_, count_selected) = stats::fetch_counts_for_login(
        &Json(req.clone()),
        &login,
        env.as_ref(),
        master_keys,
    )
    .await
    .context(h!())?;
    Ok(count_selected)
}

async fn set_message_callsigns(
    db: &DatabaseConnection,
    signal_message_id: i64,
    callsigns: serde_json::Value,
) -> Result<(), AppError> {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.callsigns = Set(Some(callsigns));
    inbox_item.update(db).await.context(h!())?;
    Ok(())
}

async fn set_message_unit(
    db: &DatabaseConnection,
    signal_message_id: i64,
    unit: Option<&str>,
) -> Result<(), AppError> {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.unit_v2 = Set(unit.map(str::to_string));
    inbox_item.update(db).await.context(h!())?;
    Ok(())
}

async fn set_message_post(
    db: &DatabaseConnection,
    signal_message_id: i64,
    post_name: &str,
) -> Result<(), AppError> {
    let post_id = crate::sigint::post::get_or_create_post_id(
        db,
        &Some(post_name.to_string()),
    )
    .await
    .context(h!())?
    .context(h!())?;
    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.post_id = Set(Some(post_id));
    inbox_item.update(db).await.context(h!())?;
    Ok(())
}

async fn set_message_freq(
    db: &DatabaseConnection,
    signal_message_id: i64,
    freq: Option<&str>,
) -> Result<(), AppError> {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.freq = Set(freq.map(str::to_string));
    inbox_item.update(db).await.context(h!())?;
    Ok(())
}

#[test]
fn filter_selected_metadata_without_metadata_ignores_concrete_filters() {
    let q = signal_message::Entity::find();
    let q = filter_selected_metadata(
        q,
        &None,
        &Some(vec!["123".to_string()]),
        &None,
        &None,
        &Some(false),
        &Some(true),
    )
    .unwrap();

    let sql = q.build(DbBackend::Postgres).to_string();

    assert!(sql.contains("NOT EXISTS"));
    assert!(!sql.contains("sender_id"));
    assert!(!sql.contains("sender_name"));
}

#[tokio::test]
#[serial]
async fn rer_analysis_search_matches_plain_prefix() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    mk_analysis_message(
        &fixture.env.dbx,
        "Беркуту передали координати",
        "999.9",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.search = Some("Берку".to_string());

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_search_matches_dotted_body_text() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    mk_analysis_message(
        &fixture.env.dbx,
        r#"Отримано з поста "DOT.HEADER"
--------------------------------------
16.02, 22:44:57
432.1500
УКХ р/м

BODY.DOT передали координати"#,
        "999.9",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.search = Some("BODY.DOT".to_string());
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );

    req.search = Some(r#""BODY.DOT""#.to_string());
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );

    req.search = Some(r#""DOT.HEADER""#.to_string());
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_group_stats_hide_unrelated_and_secret_groups() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let counts = fetch_group_counts_with_secret_for_req(
        &fixture.env,
        &analysis_stats_req0(&fixture),
    )
    .await
    .unwrap();

    assert_eq!(counts.get(&fixture.alpha.signal_group.master_key), Some(&3));
    assert_eq!(counts.get(&fixture.beta.signal_group.master_key), Some(&4));
    assert_eq!(
        counts.get(&fixture.secret_live.signal_group.master_key),
        Some(&1)
    );
    assert_eq!(
        counts.get(&fixture.secret_empty.signal_group.master_key),
        Some(&0)
    );
    assert!(
        !counts.contains_key(&fixture.secret_hidden.signal_group.master_key)
    );

    let test_identity = mk_test_identity().await.unwrap();
    let login_id =
        crate::users::login_id_by_name(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let env = Data::from(fixture.env.clone());
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(&fixture.env.dbx, &login_id)
        .await
        .unwrap();
    let counts = group_counts(
        stats::fetch_groups_for_login(&req.0, &login_id, &env, master_keys)
            .await
            .unwrap(),
    );

    assert_eq!(counts.len(), 1);
    assert!(!counts.contains_key(&fixture.alpha.signal_group.master_key));
    assert_eq!(counts.get(&fixture.beta.signal_group.master_key), Some(&4));
    assert!(!counts.contains_key(&fixture.secret_empty.signal_group.master_key));
}

#[tokio::test]
#[serial]
async fn rer_analysis_aor_filter_hides_groups_outside_selected_aor() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-1-x",
        "901.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-1-y",
        "901.2",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_y],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    let counts = fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        counts,
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 1,)])
    );

    req.selected_groups =
        Some(vec![fixture.group_y.signal_group.master_key.clone()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_aor_filter_keeps_groups_with_overlapping_group_aors() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    add_group_aor(db, &fixture.group_y, fixture.aor_a.id, fixture.created_at)
        .await
        .unwrap();
    mk_analysis_message(
        db,
        "doc-case-2-x",
        "902.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-2-y",
        "902.2",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_y],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    let counts = fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        counts,
        BTreeMap::from([
            (fixture.group_x.signal_group.master_key.clone(), 1),
            (fixture.group_y.signal_group.master_key.clone(), 1),
        ])
    );

    req.selected_groups =
        Some(vec![fixture.group_y.signal_group.master_key.clone()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_group_dropdown_hides_network_matched_groups() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-3-x-none",
        "903.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-3-x-k",
        "910.1",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-3-x-l",
        "910.2",
        test_dt(2026, 3, 2, 10, 2),
        &[&fixture.group_x],
        &[fixture.network_l.network.id],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-3-y-none",
        "903.2",
        test_dt(2026, 3, 2, 10, 3),
        &[&fixture.group_y],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-3-y-k",
        "910.1",
        test_dt(2026, 3, 2, 10, 4),
        &[&fixture.group_y],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-3-y-l",
        "910.2",
        test_dt(2026, 3, 2, 10, 5),
        &[&fixture.group_y],
        &[fixture.network_l.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    let counts = fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        counts,
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 3)])
    );

    req.selected_groups =
        Some(vec![fixture.group_y.signal_group.master_key.clone()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_network_dropdown_hides_unrelated_networks() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-4-x-none",
        "904.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-4-x-k",
        "910.1",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-4-x-l",
        "910.2",
        test_dt(2026, 3, 2, 10, 2),
        &[&fixture.group_x],
        &[fixture.network_l.network.id],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-4-y-k",
        "910.1",
        test_dt(2026, 3, 2, 10, 3),
        &[&fixture.group_y],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    let group_counts = fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        group_counts,
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 3)])
    );

    let network_counts = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(network_counts.get(&fixture.network_k.network.id), Some(&1));
    assert!(!network_counts.contains_key(&fixture.network_l.network.id));
}

#[tokio::test]
#[serial]
async fn rer_analysis_shared_messages_hide_groups_outside_selected_aor() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-5-shared",
        "905.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x, &fixture.group_y],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 1)])
    );
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );

    req.selected_groups =
        Some(vec![fixture.group_x.signal_group.master_key.clone()]);
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 1)])
    );
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_network_aor_overlap_keeps_messages_and_networks() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    req.selected_freqs = Some(vec!["333.3".to_string()]);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::new()
    );
    assert_eq!(
        fetch_network_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.network_wide.network.id, 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_network_aor_match_does_not_show_group_option() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-8-y-k",
        "910.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_y],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::new()
    );
    assert!(fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_without_network_filters_remove_networked_values() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "doc-case-10-no-network",
        "906.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "doc-case-10-no-network-empty-freq",
        "",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    let no_network_null_freq = mk_analysis_message(
        db,
        "doc-case-10-no-network-null-freq",
        "906.2",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_freq(db, no_network_null_freq.id, None)
        .await
        .unwrap();
    mk_analysis_message(
        db,
        "doc-case-10-networked",
        "910.1",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);
    req.without_network = Some(true);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("906.1".to_string(), 1)])
    );
    assert!(fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());

    req.selected_networks = Some(vec![fixture.network_k.network.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
    assert!(fetch_freq_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
    assert!(fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_selected_network_filter_uses_explicit_network_links() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let competing_network = mk_network_fixture(
        db,
        "Competing Network",
        "910.1",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();

    mk_analysis_message(
        db,
        "network-link-match",
        "910.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_networks = Some(vec![fixture.network_k.network.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );

    req.selected_networks = Some(vec![competing_network.network.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_network_stats_use_explicit_network_links_without_freq_match(
) {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "network-link-without-freq-match",
        "906.3",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);
    assert_eq!(
        fetch_network_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.network_k.network.id, 1)])
    );

    req.selected_networks = Some(vec![fixture.network_k.network.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_deleted_networks_behave_like_missing_networks() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "deleted-network-only",
        "906.2",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[fixture.network_k.network.id],
        false,
    )
    .await
    .unwrap();

    let deleted_network_id = fixture.network_k.network.id;
    let mut deleted_network =
        fixture.network_k.network.clone().into_active_model();
    deleted_network.deleted = Set(true);
    deleted_network.update(db).await.unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);
    req.without_network = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert!(fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());

    req.without_network = None;
    req.selected_networks = Some(vec![deleted_network_id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_network_stats_follow_activity_windows() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let network_old = mk_network_fixture_with_window(
        db,
        "Old Network",
        "920.1",
        fixture.aor_a.id,
        fixture.created_at,
        Some(test_dt(2026, 3, 2, 7, 59)),
    )
    .await
    .unwrap();
    let network_live = mk_network_fixture_with_window(
        db,
        "Live Network",
        "920.1",
        fixture.aor_a.id,
        fixture.created_at,
        None,
    )
    .await
    .unwrap();

    mk_analysis_message(
        db,
        "doc-case-12-window",
        "920.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);
    req.selected_freqs = Some(vec!["920.1".to_string()]);

    let network_counts = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        network_counts,
        BTreeMap::from([(network_live.network.id, 1)])
    );
    assert!(!network_counts.contains_key(&network_old.network.id));
}

#[tokio::test]
#[serial]
async fn rer_analysis_aor_dropdown_includes_group_and_network_aors() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    req.selected_freqs = Some(vec!["333.3".to_string()]);

    assert_eq!(
        fetch_aor_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(fixture.north_aor.id, 1), (fixture.wide_aor.id, 1),])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_peleng_locations_filter_does_not_leak_unrelated_locations(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_freq_location(
        db,
        freq_location::ActiveModel {
            freq: Set("666.6".to_string()),
            location: Set("Peleng Town".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 7, 0)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_analysis_message_with_location(
        db,
        "msg-unrelated-location",
        "112.2",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
        Some("Unrelated Town"),
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_locations = Some(vec!["Peleng Town".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_location_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());

    req.include_peleng_locations = Some(true);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    let location_counts = fetch_location_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert!(!location_counts.contains_key("Unrelated Town"));
}

#[tokio::test]
#[serial]
async fn rer_analysis_location_filter_recalculates_values() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let location_a = crate::location::utils::format_location("Location A");
    let location_b = crate::location::utils::format_location("Location B");

    mk_analysis_message_with_location(
        db,
        "msg-location-a",
        "112.3",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
        Some(&location_a),
    )
    .await
    .unwrap();
    mk_analysis_message_with_location(
        db,
        "msg-location-b",
        "112.4",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
        Some(&location_b),
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_locations = Some(vec!["Location A".to_string()]);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("112.3".to_string(), 1)])
    );
    assert_eq!(
        fetch_location_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([("LOCATION A".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_callsign_and_tag_stats_follow_tag_like_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let tag_bookmark = find_test_bpla_tag(db).await.unwrap();
    let tag_important = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("important-tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let tag_comment = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("comment-tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let organism = find_test_organism(db).await.unwrap();
    let other_organism = mk_organism(
        db,
        organism::ActiveModel {
            name: Set("Other Comment Organism".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let same_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("SameOrgCommenter".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("OtherOrgCommenter".to_string()),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_bookmark = mk_analysis_message(
        db,
        "msg-bookmark-filter",
        "930.1",
        test_dt(2026, 3, 1, 10, 6),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, msg_bookmark.id, serde_json::json!(["CS-BOOK"]))
        .await
        .unwrap();
    mk_sigint_bookmark(
        db,
        sigint_bookmark::ActiveModel {
            login_id: Set(crate::users::login_id_by_name(db, "Tester")
                .await
                .unwrap()),
            signal_message_id: Set(msg_bookmark.id),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_bookmark.id),
            tag_id: Set(tag_bookmark.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_important = mk_analysis_message(
        db,
        "msg-important-filter",
        "930.2",
        test_dt(2026, 3, 1, 10, 7),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, msg_important.id, serde_json::json!(["CS-IMP"]))
        .await
        .unwrap();
    mk_sigint_important(
        db,
        sigint_important::ActiveModel {
            signal_message_id: Set(msg_important.id),
            created_at: Set(test_dt(2026, 3, 1, 10, 7)),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_important.id),
            tag_id: Set(tag_important.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_comment = mk_analysis_message(
        db,
        "msg-comment-filter",
        "930.3",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, msg_comment.id, serde_json::json!(["CS-COM"]))
        .await
        .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(crate::users::login_id_by_name(db, "Tester")
                .await
                .unwrap()),
            signal_message_id: Set(msg_comment.id),
            comment: Set("filled".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 8)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_comment.id),
            tag_id: Set(tag_comment.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let msg_same_org_comment = mk_analysis_message(
        db,
        "msg-same-org-comment-filter",
        "930.4",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(
        db,
        msg_same_org_comment.id,
        serde_json::json!(["CS-COM-SAME-ORG"]),
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(same_org_login.id),
            signal_message_id: Set(msg_same_org_comment.id),
            comment: Set("same org".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 9)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_same_org_comment.id),
            tag_id: Set(tag_comment.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let msg_other_org_comment = mk_analysis_message(
        db,
        "msg-other-org-comment-filter",
        "930.5",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(
        db,
        msg_other_org_comment.id,
        serde_json::json!(["CS-COM-OTHER-ORG"]),
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(other_org_login.id),
            signal_message_id: Set(msg_other_org_comment.id),
            comment: Set("other org".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 9)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_other_org_comment.id),
            tag_id: Set(tag_comment.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.or_bookmarked = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_callsign_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([("CS-BOOK".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(tag_bookmark.id, 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.or_important = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_callsign_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([("CS-IMP".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(tag_important.id, 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.or_with_extended_form = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        fetch_callsign_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([
            ("CS-COM".to_string(), 1),
            ("CS-COM-OTHER-ORG".to_string(), 1),
            ("CS-COM-SAME-ORG".to_string(), 1),
        ])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(tag_comment.id, 3)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_comments_api_returns_other_organism_comment_for_accessible_message(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let other_organism = mk_organism(
        db,
        organism::ActiveModel {
            name: Set("Commenter Other Organism".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("CommenterOtherOrg".to_string()),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_analysis_message(
        db,
        "msg-other-org-comment-api",
        "940.7",
        test_dt(2026, 3, 1, 10, 5),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(other_org_login.id),
            signal_message_id: Set(message.id),
            comment: Set("other organism visible comment".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let logins = crate::users::get_organism_login_ids_by_id(db, &login.id)
        .await
        .unwrap();
    let messages = crate::rer_importer::inbox::get_inbox_messages(
        &login.id,
        &logins,
        &fixture.env,
        &crate::rer_importer::types::InboxMessagesReq {
            since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
            till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
            or_with_extended_form: Some(true),
            nolimit: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(messages.iter().any(|(id, _)| *id == message.id));

    let comments = batch_message_comments_bl(db, &login.id, &[message.id])
        .await
        .unwrap();
    let entry = comments
        .data
        .iter()
        .find(|entry| entry.message_id == message.id)
        .unwrap();
    assert_eq!(entry.comments.len(), 1);
    assert_eq!(entry.comments[0].login, other_org_login.login);
    assert_eq!(entry.comments[0].comment, "other organism visible comment");
    assert_eq!(entry.comments[0].sigint_post_name, None);
}

#[tokio::test]
#[serial]
async fn rer_analysis_comments_api_hides_same_organism_editable_comment() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let same_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("CommenterSameOrg".to_string()),
            organism_id: Set(login.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_analysis_message(
        db,
        "msg-same-org-comment-api",
        "940.8",
        test_dt(2026, 3, 1, 10, 5),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(same_org_login.id),
            signal_message_id: Set(message.id),
            comment: Set("same organism editable comment".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let logins = crate::users::get_organism_login_ids_by_id(db, &login.id)
        .await
        .unwrap();
    let messages = crate::rer_importer::inbox::get_inbox_messages(
        &login.id,
        &logins,
        &fixture.env,
        &crate::rer_importer::types::InboxMessagesReq {
            since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
            till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
            or_with_extended_form: Some(true),
            nolimit: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let entry = messages
        .iter()
        .find(|(id, _)| *id == message.id)
        .expect("message must be visible");
    assert_eq!(
        entry.1.extended_form.as_deref(),
        Some("same organism editable comment")
    );

    let comments = batch_message_comments_bl(db, &login.id, &[message.id])
        .await
        .unwrap();
    assert!(comments.data.is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_comments_api_returns_post_name_for_auto_comment() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let message = mk_analysis_message(
        db,
        "msg-auto-post-comment-api",
        "940.75",
        test_dt(2026, 3, 1, 10, 5),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let sigint_post_name = format!("Пост Альфа {}", message.id);
    let sigint_post = sigint_post::ActiveModel {
        name: Set(sigint_post_name.clone()),
        deleted: Set(false),
        created_at: Set(test_dt(2026, 3, 1, 10, 4)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    if login::Entity::find()
        .filter(login::Column::Login.eq(SYSTEM_LOGIN_NAME))
        .one(db)
        .await
        .unwrap()
        .is_none()
    {
        mk_login(
            db,
            login::ActiveModel {
                id: NotSet,
                login: Set(SYSTEM_LOGIN_NAME.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(crate::users::system_login_id(db).await.unwrap()),
            signal_message_id: Set(message.id),
            comment: Set("auto extracted comment".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            sigint_post_id: Set(Some(sigint_post.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let comments = batch_message_comments_bl(db, &login.id, &[message.id])
        .await
        .unwrap();
    let entry = comments
        .data
        .iter()
        .find(|entry| entry.message_id == message.id)
        .unwrap();

    assert_eq!(entry.comments.len(), 1);
    assert_eq!(entry.comments[0].login, SYSTEM_LOGIN_NAME);
    assert_eq!(entry.comments[0].comment, "auto extracted comment");
    assert_eq!(
        entry.comments[0].sigint_post_name.as_deref(),
        Some(sigint_post_name.as_str())
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_comments_batch_skips_inaccessible_messages() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let message = mk_analysis_message(
        db,
        "msg-hidden-comment-api",
        "940.8",
        test_dt(2026, 3, 1, 10, 6),
        &[&fixture.secret_hidden],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(login.id),
            signal_message_id: Set(message.id),
            comment: Set("hidden comment".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 7)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let comments = batch_message_comments_bl(db, &login.id, &[message.id])
        .await
        .unwrap();

    assert!(comments.data.is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_tag_filters_handle_or_and_and_all_tags() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let tag_a = find_test_bpla_tag(db).await.unwrap();
    let tag_b = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("paired-tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_bookmark_only = mk_analysis_message(
        db,
        "msg-bookmark-only",
        "941.1",
        test_dt(2026, 3, 1, 10, 6),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_bookmark(
        db,
        sigint_bookmark::ActiveModel {
            login_id: Set(crate::users::login_id_by_name(db, "Tester")
                .await
                .unwrap()),
            signal_message_id: Set(msg_bookmark_only.id),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_tag_a = mk_analysis_message(
        db,
        "msg-tag-a",
        "941.2",
        test_dt(2026, 3, 1, 10, 7),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_tag_a.id),
            tag_id: Set(tag_a.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_tag_ab = mk_analysis_message(
        db,
        "msg-tag-ab",
        "941.3",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_tag_ab.id),
            tag_id: Set(tag_a.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_tag_ab.id),
            tag_id: Set(tag_b.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login_id: Set(crate::users::login_id_by_name(db, "Tester")
                .await
                .unwrap()),
            signal_message_id: Set(msg_tag_ab.id),
            comment: Set("extended".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 10, 8)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![tag_a.id]);
    req.or_bookmarked = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([
            ("941.1".to_string(), 1),
            ("941.2".to_string(), 1),
            ("941.3".to_string(), 1),
        ])
    );

    req.or_with_extended_form = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("941.3".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![tag_a.id, tag_b.id]);
    req.filter_tags_option = Some(TagFilterOption::AllTags);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("941.3".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_tag_scope_checkboxes_filter_messages_correctly() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let organism = find_test_organism(db).await.unwrap();
    let other_organism = mk_organism(
        db,
        organism::ActiveModel {
            name: Set("Other Organism".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let same_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("SameOrgTagger".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_org_login = mk_login(
        db,
        login::ActiveModel {
            id: NotSet,
            login: Set("OtherOrgTagger".to_string()),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("unit-scope-tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_model = mk_analysis_message(
        db,
        "msg-model-tag",
        "941.4",
        test_dt(2026, 3, 1, 10, 7),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_model.id),
            tag_id: Set(tag.id),
            model: Set(Some("classifier".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_same_org = mk_analysis_message(
        db,
        "msg-same-org-tag",
        "941.5",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_same_org.id),
            tag_id: Set(tag.id),
            login_id: Set(Some(same_org_login.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_other_org = mk_analysis_message(
        db,
        "msg-other-org-tag",
        "941.6",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_other_org.id),
            tag_id: Set(tag.id),
            login_id: Set(Some(other_org_login.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![tag.id]);
    req.without_model_tags = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("941.5".to_string(), 1), ("941.6".to_string(), 1),])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![tag.id]);
    req.report_tags_only_this_unit = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("941.5".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.report_tags_only_this_unit = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("941.5".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_sender_callsign_and_post_filters_recalculate_values() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let tag_alpha = find_test_bpla_tag(db).await.unwrap();
    let tag_beta = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("callsign-beta-tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_alpha = mk_analysis_message(
        db,
        "msg-sender-alpha",
        "942.1",
        test_dt(2026, 3, 1, 10, 6),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, msg_alpha.id, serde_json::json!(["CALL-1"]))
        .await
        .unwrap();
    set_message_post(db, msg_alpha.id, "Post Alpha")
        .await
        .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_alpha.id),
            tag_id: Set(tag_alpha.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_beta = mk_analysis_message(
        db,
        "msg-sender-beta",
        "942.2",
        test_dt(2026, 3, 1, 10, 7),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, msg_beta.id, serde_json::json!(["CALL-2"]))
        .await
        .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(msg_beta.id),
            tag_id: Set(tag_beta.id),
            login_id: Set(Some(
                crate::users::login_id_by_name(db, "Tester").await.unwrap(),
            )),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_senders = Some(vec!["msg-sender-alpha-sender".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("942.1".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_callsigns = Some(vec!["CALL-2".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("942.2".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(tag_beta.id, 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_posts = Some(vec!["".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        8
    );
    let freq_counts =
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap();
    assert!(!freq_counts.contains_key("942.1"));
    assert!(freq_counts.contains_key("942.2"));
}

#[tokio::test]
#[serial]
async fn rer_analysis_sender_breakdowns_sum_to_sender_total() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let (login, master_keys) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();
    let env = Data::from(fixture.env.clone());
    let stats_senders = stats::fetch_senders_for_login(
        &analysis_stats_req0(&fixture),
        &login,
        &env,
        master_keys,
    )
    .await
    .unwrap();

    assert!(!stats_senders.is_empty());
    for sender in stats_senders {
        assert_eq!(sender.count, sender.per_day.values().copied().sum::<i64>());
        assert_eq!(
            sender.count,
            sender
                .freq_breakdown
                .iter()
                .map(|breakdown| breakdown.count)
                .sum::<i64>()
        );
    }
}

#[tokio::test]
#[serial]
async fn rer_analysis_sender_and_group_filters_share_same_group_row() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    let msg = mk_analysis_message(
        db,
        "sender-group-shared",
        "942.5",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x, &fixture.group_y],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut group_x_row = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(msg.id))
        .filter(
            signal_message_group::Column::GroupMasterKey.eq(fixture
                .group_x
                .signal_group
                .master_key
                .clone()),
        )
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    group_x_row.sender = Set(Some("sender-a".to_string()));
    group_x_row.update(db).await.unwrap();

    let mut group_y_row = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(msg.id))
        .filter(
            signal_message_group::Column::GroupMasterKey.eq(fixture
                .group_y
                .signal_group
                .master_key
                .clone()),
        )
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    group_y_row.sender = Set(Some("sender-b".to_string()));
    group_y_row.update(db).await.unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_senders = Some(vec!["sender-a".to_string()]);
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 1,)])
    );

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_groups =
        Some(vec![fixture.group_x.signal_group.master_key.clone()]);
    assert_eq!(
        fetch_sender_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([("sender-a".to_string(), 1)])
    );

    req.selected_senders = Some(vec!["sender-b".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_metadata_and_important_filters_follow_surviving_messages()
{
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    let msg_important = mk_analysis_message(
        db,
        "msg-important-only",
        "943.1",
        test_dt(2026, 3, 1, 10, 6),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_important(
        db,
        sigint_important::ActiveModel {
            signal_message_id: Set(msg_important.id),
            created_at: Set(test_dt(2026, 3, 1, 10, 6)),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_metadata = mk_analysis_message(
        db,
        "msg-metadata",
        "943.2",
        test_dt(2026, 3, 1, 10, 7),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_metadata(
        db,
        sigint_inbox_item_metadata::ActiveModel {
            sigint_inbox_item_id: Set(msg_metadata.id),
            color_code: Set(Some("CC-01".to_string())),
            sender_name: Set(Some("Meta Sender".to_string())),
            call_group_id: Set(Some("Receiver-01".to_string())),
            hash_id: Set(Some("Hash-01".to_string())),
            created_at: Set(test_dt(2026, 3, 1, 10, 7)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_metadata_similar = mk_analysis_message(
        db,
        "msg-metadata-similar",
        "943.4",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_metadata(
        db,
        sigint_inbox_item_metadata::ActiveModel {
            sigint_inbox_item_id: Set(msg_metadata_similar.id),
            color_code: Set(Some("CC-01-extra".to_string())),
            sender_name: Set(Some("Meta Sender Extra".to_string())),
            call_group_name: Set(Some("Receiver-01 Extra".to_string())),
            hash_id: Set(Some("Hash-01-extra".to_string())),
            created_at: Set(test_dt(2026, 3, 1, 10, 8)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let _msg_plain = mk_analysis_message(
        db,
        "msg-plain",
        "943.3",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.or_important = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.1".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.only_with_metadata = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.2".to_string(), 1), ("943.4".to_string(), 1),])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_sender = Some(vec!["Meta Sender".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.2".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_cc = Some(vec!["CC-01".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.2".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_receiver = Some(vec!["Receiver-01".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.2".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_receiver = Some(vec!["Receiver-01 Extra".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.4".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_hash = Some(vec!["Hash-01".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("943.2".to_string(), 1)])
    );

    let mut req = analysis_stats_req0(&fixture);
    req.without_metadata = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        9
    );
    let freq_counts =
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap();
    assert!(!freq_counts.contains_key("943.2"));
    assert!(!freq_counts.contains_key("943.4"));
    assert!(freq_counts.contains_key("943.1"));
    assert!(freq_counts.contains_key("943.3"));

    let mut req = analysis_stats_req0(&fixture);
    req.metadata_sender = Some(vec!["Meta Sender".to_string()]);
    req.without_metadata = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        9
    );
    let freq_counts =
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap();
    assert!(!freq_counts.contains_key("943.2"));
    assert!(!freq_counts.contains_key("943.4"));
    assert!(freq_counts.contains_key("943.1"));
    assert!(freq_counts.contains_key("943.3"));

    let mut req = analysis_stats_req0(&fixture);
    req.only_with_metadata = Some(true);
    req.without_metadata = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
    assert!(fetch_freq_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_metadata_stats_use_ids_and_text_names() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    let msg = mk_analysis_message(
        db,
        "msg-metadata-values",
        "943.5",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_metadata(
        db,
        sigint_inbox_item_metadata::ActiveModel {
            sigint_inbox_item_id: Set(msg.id),
            sender_id: Set(Some("SID-01".to_string())),
            sender_name: Set(Some("Sender Name".to_string())),
            call_group_id: Set(Some("RID-01".to_string())),
            call_group_name: Set(Some("Receiver Name".to_string())),
            created_at: Set(test_dt(2026, 3, 1, 10, 9)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_metadata(
        db,
        sigint_inbox_item_metadata::ActiveModel {
            sigint_inbox_item_id: Set(msg.id),
            sender_id: Set(Some("SAME-SENDER".to_string())),
            sender_name: Set(Some("SAME-SENDER".to_string())),
            call_group_id: Set(Some("SAME-RECEIVER".to_string())),
            call_group_name: Set(Some("SAME-RECEIVER".to_string())),
            created_at: Set(test_dt(2026, 3, 1, 10, 9)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let req = analysis_stats_req0(&fixture);
    let metadata = fetch_metadata_stats_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let sender_values = metadata_value_counts(metadata.senders);
    let receiver_values = metadata_value_counts(metadata.receivers);

    assert_eq!(
        sender_values,
        BTreeMap::from([
            ("SAME-SENDER".to_string(), 1),
            ("SID-01".to_string(), 1),
            ("Sender Name".to_string(), 1),
        ])
    );
    assert_eq!(
        receiver_values,
        BTreeMap::from([
            ("RID-01".to_string(), 1),
            ("Receiver Name".to_string(), 1),
            ("SAME-RECEIVER".to_string(), 1),
        ])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_units_exact_and_undefined_filters_work() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let etalon_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Etalon Unit".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let etalon_network = mk_network_fixture(
        db,
        "Unit Match Network",
        "944.1",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(etalon_network.network.id),
            unit_id: Set(etalon_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_etalon = mk_analysis_message(
        db,
        "msg-unit-etalon",
        "944.1",
        test_dt(2026, 3, 2, 10, 6),
        &[&fixture.group_x],
        &[etalon_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_etalon.id, Some("Header Noise"))
        .await
        .unwrap();

    let msg_header_only = mk_analysis_message(
        db,
        "msg-unit-header",
        "944.2",
        test_dt(2026, 3, 2, 10, 7),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_header_only.id, Some("Header Unit"))
        .await
        .unwrap();

    mk_analysis_message(
        db,
        "msg-unit-unknown",
        "944.3",
        test_dt(2026, 3, 2, 10, 8),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_units = Some(vec!["Header Unit".to_string()]);
    req.units_exact_match_only = Some(false);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.2".to_string(), 1)])
    );

    req.units_exact_match_only = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert!(fetch_freq_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_units = Some(vec!["Etalon Unit".to_string()]);
    req.units_exact_match_only = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.1".to_string(), 1)])
    );

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_units = Some(vec!["Не визначено".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.3".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_units_match_etalon_units_during_active_window() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let etalon_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Active Etalon Unit".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let etalon_network = mk_network_fixture_with_window(
        db,
        "Active Unit Match Network",
        "944.4",
        fixture.aor_a.id,
        test_dt(2026, 2, 28, 0, 0),
        Some(test_dt(2026, 6, 1, 0, 0)),
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(etalon_network.network.id),
            unit_id: Set(etalon_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_etalon = mk_analysis_message(
        db,
        "msg-unit-active-etalon",
        "944.4",
        test_dt(2026, 3, 2, 10, 6),
        &[&fixture.group_x],
        &[etalon_network.network.id],
        true,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_etalon.id, Some("Header Noise"))
        .await
        .unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_units = Some(vec!["Active Etalon Unit".to_string()]);
    req.units_exact_match_only = Some(false);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.4".to_string(), 1)])
    );

    req.units_exact_match_only = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.4".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_map_unit_filter_uses_message_network_links() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let selected_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Selected Unit".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Other Unit".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let selected_network = mk_network_fixture(
        db,
        "Selected Unit Network",
        "944.5",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    let other_network = mk_network_fixture(
        db,
        "Other Unit Network",
        "944.5",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(selected_network.network.id),
            unit_id: Set(selected_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(other_network.network.id),
            unit_id: Set(other_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_selected = mk_analysis_message(
        db,
        "msg-selected-network",
        "944.5",
        test_dt(2026, 3, 2, 10, 10),
        &[&fixture.group_x],
        &[selected_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_selected.id, Some("Header Noise"))
        .await
        .unwrap();

    let msg_other = mk_analysis_message(
        db,
        "msg-other-network",
        "944.5",
        test_dt(2026, 3, 2, 10, 11),
        &[&fixture.group_x],
        &[other_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_other.id, Some("Other Header"))
        .await
        .unwrap();

    let test_identity = mk_test_identity().await.unwrap();
    let base_req = crate::rer_importer::types::InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_units: Some(vec!["Selected Unit".to_string()]),
        units_exact_match_only: Some(false),
        nolimit: Some(true),
        ..Default::default()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &base_req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_selected.id]
    );

    let req = crate::rer_importer::types::InboxMessagesReq {
        units_exact_match_only: Some(true),
        ..base_req.clone()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_selected.id]
    );
}

#[tokio::test]
#[serial]
async fn rer_duty_unit_filter_includes_child_units_in_fuzzy_mode() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let _parent_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("2 бат 1 полк".to_string()),
            battalion: Set("2 бат".to_string()),
            regiment: Set("1 полк".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let _short_parent_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("2 бат".to_string()),
            battalion: Set("2 бат".to_string()),
            regiment: Set("1 полк".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("3 рота 2 бат 1 полк".to_string()),
            company: Set("3 рота".to_string()),
            battalion: Set("2 бат".to_string()),
            regiment: Set("1 полк".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("3 рота 2 бат 2 полк".to_string()),
            company: Set("3 рота".to_string()),
            battalion: Set("2 бат".to_string()),
            regiment: Set("2 полк".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_network = mk_network_fixture(
        db,
        "Child Unit Network",
        "944.6",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    let other_network = mk_network_fixture(
        db,
        "Other Child Unit Network",
        "944.7",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(child_network.network.id),
            unit_id: Set(child_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(other_network.network.id),
            unit_id: Set(other_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_child = mk_analysis_message(
        db,
        "msg-child-unit",
        "944.6",
        test_dt(2026, 3, 2, 10, 5),
        &[&fixture.group_x],
        &[child_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_child.id, Some("Header Noise"))
        .await
        .unwrap();
    let msg_other = mk_analysis_message(
        db,
        "msg-other-child-unit",
        "944.7",
        test_dt(2026, 3, 2, 10, 6),
        &[&fixture.group_x],
        &[other_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_other.id, Some("Header Noise"))
        .await
        .unwrap();

    let test_identity = mk_test_identity().await.unwrap();
    let base_req = crate::rer_importer::types::InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_units: Some(vec!["2 бат 1 полк".to_string()]),
        units_exact_match_only: Some(false),
        nolimit: Some(true),
        ..Default::default()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &base_req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_child.id]
    );

    let req = crate::rer_importer::types::InboxMessagesReq {
        selected_units: Some(vec!["2 бат".to_string()]),
        ..base_req.clone()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_child.id]
    );

    let req = crate::rer_importer::types::InboxMessagesReq {
        units_exact_match_only: Some(true),
        ..base_req
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert!(items.is_empty());

    let req = crate::rer_importer::types::InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        denied_units: Some(vec!["2 бат".to_string()]),
        units_exact_match_only: Some(false),
        nolimit: Some(true),
        ..Default::default()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_other.id]
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_unit_filter_includes_child_units_by_name_suffix_in_fuzzy_mode(
) {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let _parent_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("100 pbr".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("1 pdb 100 pbr".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("1 pdb 200 pbr".to_string()),
            created_by_login_id: Set(crate::users::login_id_by_name(
                db, "Tester",
            )
            .await
            .unwrap()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_network = mk_network_fixture(
        db,
        "Child Unit Name Network",
        "944.8",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    let other_network = mk_network_fixture(
        db,
        "Other Unit Name Network",
        "944.9",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(child_network.network.id),
            unit_id: Set(child_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(other_network.network.id),
            unit_id: Set(other_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let msg_child = mk_analysis_message(
        db,
        "msg-child-unit-name-suffix",
        "944.8",
        test_dt(2026, 3, 2, 10, 7),
        &[&fixture.group_x],
        &[child_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_child.id, Some("Header Noise"))
        .await
        .unwrap();
    let msg_other = mk_analysis_message(
        db,
        "msg-other-unit-name-suffix",
        "944.9",
        test_dt(2026, 3, 2, 10, 8),
        &[&fixture.group_x],
        &[other_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_other.id, Some("Header Noise"))
        .await
        .unwrap();

    let test_identity = mk_test_identity().await.unwrap();
    let base_req = crate::rer_importer::types::InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_units: Some(vec!["100 pbr".to_string()]),
        units_exact_match_only: Some(false),
        nolimit: Some(true),
        ..Default::default()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &base_req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_child.id]
    );

    let req = crate::rer_importer::types::InboxMessagesReq {
        units_exact_match_only: Some(true),
        ..base_req.clone()
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert!(items.is_empty());

    let req = crate::rer_importer::types::InboxMessagesReq {
        selected_units: None,
        denied_units: Some(vec!["100 pbr".to_string()]),
        units_exact_match_only: Some(false),
        ..base_req
    };
    let items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &req,
    )
    .await
    .unwrap();
    assert_eq!(
        items.iter().map(|item| item.id).collect_vec(),
        vec![msg_other.id]
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_freq_stats_follow_group_and_network_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = Data::from(fixture.env.clone());

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );

    assert_eq!(
        counts,
        BTreeMap::from([
            ("111.1".to_string(), 1),
            ("333.3".to_string(), 1),
            ("555.5".to_string(), 1),
        ])
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );

    assert_eq!(
        counts,
        BTreeMap::from([("333.3".to_string(), 1), ("555.5".to_string(), 1),])
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.without_network = Some(true);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );

    assert_eq!(
        counts,
        BTreeMap::from([
            ("111.1".to_string(), 1),
            ("222.2".to_string(), 1),
            ("555.5".to_string(), 1),
            ("666.6".to_string(), 1),
            ("777.7".to_string(), 1),
        ])
    );
    assert!(!counts.contains_key("888.8"));
}

#[tokio::test]
#[serial]
async fn summary_table_uses_message_groups_for_access() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let message = mk_analysis_message(
        db,
        "summary-accessible-secondary-group",
        "999.9",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.secret_hidden, &fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let (login, master_keys) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();

    let ids = build_summary_table_filtered_messages_query(
        &login,
        &analysis_stats_req0(&fixture),
        &master_keys,
    )
    .unwrap()
    .select_only()
    .column(signal_message::Column::Id)
    .filter(signal_message::Column::Id.eq(message.id))
    .into_tuple::<i64>()
    .all(db)
    .await
    .unwrap();

    assert_eq!(ids, vec![message.id]);
}

#[test]
fn summary_table_report_message_limit_allows_maximum() {
    assert!(ensure_summary_table_report_message_limit(
        &uuid::Uuid::nil(),
        RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX,
    )
    .is_ok());
}

#[test]
fn summary_table_report_message_limit_rejects_overflow() {
    let err = ensure_summary_table_report_message_limit(
        &uuid::Uuid::nil(),
        RER_SUMMARY_TABLE_REPORT_MESSAGE_MAX + 1,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        AppError::BL { msg }
            if msg == RER_SUMMARY_TABLE_REPORT_MESSAGE_LIMIT_ERROR_CODE
    ));
}

#[test]
fn summary_table_xlsx_chunks_merge_without_coordinate_data() {
    let first_dt = test_dt(2026, 3, 1, 10, 0);
    let last_dt = test_dt(2026, 3, 1, 11, 0);
    let row =
        |count, callsigns: Vec<&str>, units: Vec<&str>| SummaryTableFreqRow {
            freq: "111.1".to_string(),
            count,
            callsigns: callsigns.into_iter().map(str::to_string).collect(),
            units: units.into_iter().map(str::to_string).collect(),
            locations: vec!["Location".to_string()],
            coords: vec![LatLng {
                lat: count as f64,
                lng: 30.0,
            }],
            locality_coords: vec![LocalityCoords {
                locality: "Locality".to_string(),
                count,
                coords: vec![LatLng {
                    lat: count as f64,
                    lng: 30.0,
                }],
            }],
        };
    let chunks = vec![
        SummaryTableChunkData {
            summary_table: SummaryTableFreq {
                rows: vec![row(2, vec!["Zulu"], vec!["B"])],
            },
            last_datetime_by_freq: BTreeMap::from([(
                "111.1".to_string(),
                first_dt,
            )]),
            related_networks_by_freq: BTreeMap::from([(
                "111.1".to_string(),
                vec!["Network B".to_string()],
            )]),
        },
        SummaryTableChunkData {
            summary_table: SummaryTableFreq {
                rows: vec![row(3, vec!["Alpha", "Zulu"], vec!["A"])],
            },
            last_datetime_by_freq: BTreeMap::from([(
                "111.1".to_string(),
                last_dt,
            )]),
            related_networks_by_freq: BTreeMap::from([(
                "111.1".to_string(),
                vec!["Network A".to_string(), "Network B".to_string()],
            )]),
        },
    ];

    let merged =
        merge_summary_table_chunks("description".to_string(), chunks).unwrap();

    assert_eq!(merged.summary_table.rows[0].count, 5);
    assert_eq!(
        merged.summary_table.rows[0].callsigns,
        vec!["Alpha".to_string(), "Zulu".to_string()]
    );
    assert_eq!(
        merged.summary_table.rows[0].units,
        vec!["A".to_string(), "B".to_string()]
    );
    assert_eq!(merged.last_datetime_by_freq["111.1"], last_dt);
    assert!(merged.summary_table.rows[0].coords.is_empty());
    assert!(merged.summary_table.rows[0].locality_coords.is_empty());
    assert_eq!(
        merged.related_networks_by_freq["111.1"],
        vec!["Network A".to_string(), "Network B".to_string()]
    );
}

#[test]
fn summary_table_coordinate_data_keeps_geocoded_localities() {
    let rows = vec![
        SummaryTableCoordinateRow {
            freq: Some("111.1".to_string()),
            lat: 46.63,
            lng: 32.62,
            nominatimres_id: Some(7),
            count: 2,
        },
        SummaryTableCoordinateRow {
            freq: Some("111.1".to_string()),
            lat: 46.64,
            lng: 32.63,
            nominatimres_id: Some(7),
            count: 3,
        },
    ];
    let nominatimres_by_id = BTreeMap::from([(
        7,
        nominatimres::Model {
            id: 7,
            created_at: test_dt(2026, 3, 1, 10, 0),
            res: serde_json::Value::Null,
            nominatim_display_name: "Херсон, область".to_string(),
        },
    )]);

    let data = collect_summary_table_coordinate_data(rows, &nominatimres_by_id);
    let data = &data["111.1"];

    assert_eq!(data.coords.len(), 2);
    assert_eq!(data.locality_coords.len(), 1);
    assert_eq!(data.locality_coords[0].locality, "Херсон, область");
    assert_eq!(data.locality_coords[0].count, 5);
    assert_eq!(data.locality_coords[0].coords, data.coords);
}

#[tokio::test]
#[serial]
async fn summary_table_chunked_collection_matches_single_window() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let geocoded_at = test_dt(2026, 3, 1, 10, 30);
    let nominatimres = nominatimres::ActiveModel {
        created_at: Set(geocoded_at),
        res: Set(serde_json::Value::Null),
        nominatim_display_name: Set("Херсон, область".to_string()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let geocoded_message = mk_analysis_message(
        db,
        "geocoded-summary-message",
        "999.9",
        geocoded_at,
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    sigint_inbox_item::Entity::update_many()
        .col_expr(sigint_inbox_item::Column::Lat, Expr::value(46.63))
        .col_expr(sigint_inbox_item::Column::Lng, Expr::value(32.62))
        .col_expr(
            sigint_inbox_item::Column::NominatimresId,
            Expr::value(nominatimres.id),
        )
        .col_expr(
            sigint_inbox_item::Column::Callsigns,
            Expr::value(serde_json::json!(["Geo"])),
        )
        .filter(sigint_inbox_item::Column::Id.eq(geocoded_message.id))
        .exec(db)
        .await
        .unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.since_date_inclusive_ms =
        test_dt(2026, 3, 1, 7, 30).and_utc().timestamp_millis();
    req.till_date_noninclusive_ms =
        test_dt(2026, 3, 1, 9, 0).and_utc().timestamp_millis();
    req.selected_freqs = Some(vec!["999.9".to_string()]);

    let master_keys =
        crate::messenger::group::get_identity_sigint_groups(db, &login.id)
            .await
            .unwrap();
    let api_summary = summary_table_freq_by_login(
        &login.id,
        &fixture.env,
        &req,
        &master_keys,
    )
    .await
    .unwrap();
    let geocoded_api_row = api_summary
        .rows
        .iter()
        .find(|row| row.freq == "999.9")
        .unwrap();
    assert!(geocoded_api_row.coords.contains(&LatLng {
        lat: 46.63,
        lng: 32.62,
    }));
    assert!(geocoded_api_row
        .locality_coords
        .iter()
        .any(|locality| locality.locality == "Херсон, область"));

    set_report_chunking_hours(db, 24).await;
    let single =
        collect_summary_table_report_data(&login.id, &fixture.env, &req)
            .await
            .unwrap();
    let geocoded_row = single
        .summary_table
        .rows
        .iter()
        .find(|row| row.freq == "999.9")
        .unwrap();
    assert!(geocoded_row.coords.is_empty());
    assert!(geocoded_row.locality_coords.is_empty());

    set_report_chunking_hours(db, 1).await;
    let chunked =
        collect_summary_table_report_data(&login.id, &fixture.env, &req)
            .await
            .unwrap();

    assert_eq!(chunked.description, single.description);
    assert_eq!(chunked.summary_table, single.summary_table);
    assert_eq!(chunked.last_datetime_by_freq, single.last_datetime_by_freq);
    assert_eq!(
        chunked.related_networks_by_freq,
        single.related_networks_by_freq
    );
}

async fn set_report_chunking_hours(db: &DatabaseConnection, hours: i32) {
    let result = system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::ReportChunkingHours,
            Expr::value(hours),
        )
        .filter(system_settings::Column::Deleted.eq(false))
        .exec(db)
        .await
        .unwrap();
    if result.rows_affected == 0 {
        system_settings::ActiveModel {
            report_chunking_hours: Set(hours),
            limit_big_reports: Set(false),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
}

#[test]
fn new_callsigns_are_classified_relative_to_original_report_start() {
    let report_since = test_dt(2026, 3, 2, 12, 0);
    let callsigns = BTreeSet::from([
        "new".to_string(),
        "week".to_string(),
        "recent".to_string(),
    ]);
    let last_seen = BTreeMap::from([
        (
            "recent".to_string(),
            report_since - chrono::Duration::hours(1),
        ),
        ("week".to_string(), report_since - chrono::Duration::days(2)),
    ]);

    let result = classify_new_callsigns(callsigns, &last_seen, report_since);

    assert_eq!(
        result.not_seen_24h,
        vec!["new".to_string(), "week".to_string()]
    );
    assert_eq!(result.not_seen_7days, vec!["new".to_string()]);
    assert_eq!(result.not_seen_30days, vec!["new".to_string()]);
}

#[tokio::test]
#[serial]
async fn rer_analysis_count_stats_follow_aor_frequency_and_peleng_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = Data::from(fixture.env.clone());

    let test_identity = mk_test_identity().await.unwrap();
    let req = Json(analysis_stats_req0(&fixture));
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let master_keys_noimport = master_keys.clone();
    let groups = stats::fetch_groups_for_login(
        &req.0,
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &env,
        master_keys_noimport.clone(),
    )
    .await
    .unwrap();
    let groups = include_missing_secret_groups(
        &fixture.env.dbx,
        groups,
        &master_keys_noimport,
    )
    .await
    .unwrap();
    let (count_overall, count_selected) = stats::fetch_counts_for_login(
        &req,
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        master_keys.clone(),
    )
    .await
    .unwrap();
    let rsp = CountStatsRsp {
        count_overall,
        count_selected,
        groups_count: groups.len() as i64,
        senders_count: 0,
        freqs_count: stats::fetch_freqs_for_login(
            &req.0,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys.clone(),
        )
        .await
        .unwrap()
        .len() as i64,
        posts_count: 0,
        callsigns_count: 0,
        units_count: 0,
        units_exact_matches_count: 0,
        units_non_exact_matches_count: 0,
        locations_count: 0,
        tags_count: 0,
        aors_count: 0,
        networks_count: 0,
    };
    assert_eq!(rsp.count_overall, 7);
    assert_eq!(rsp.count_selected, 7);
    assert_eq!(rsp.groups_count, 4);
    assert_eq!(rsp.freqs_count, 7);

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        5
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        2
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["555.5".to_string()]);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        1
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.without_network = Some(true);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        5
    );

    let peleng_msg = signal_message::Entity::find()
        .filter(signal_message::Column::MessageUid.eq("msg-peleng"))
        .one(&fixture.env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut peleng_item = sigint_inbox_item::Entity::find_by_id(peleng_msg.id)
        .one(&fixture.env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    peleng_item.coords = Set(Some("36U XB 70367 06497".to_string()));
    peleng_item.update(&fixture.env.dbx).await.unwrap();

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.or_with_coords = Some(true);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        1
    );

    let peleng_only_msg = mk_analysis_message(
        &fixture.env.dbx,
        "msg-peleng-legacy",
        "998.8",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.beta],
        &[],
        false,
    )
    .await
    .unwrap();
    let mut peleng_only_item =
        sigint_inbox_item::Entity::find_by_id(peleng_only_msg.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    peleng_only_item.coords = Set(None);
    peleng_only_item.update(&fixture.env.dbx).await.unwrap();
    mk_sigint_peleng(
        &fixture.env.dbx,
        sigint_peleng::ActiveModel {
            source_inbox_item_id: Set(peleng_only_msg.id),
            lat: Set(48.0),
            lng: Set(37.0),
            created_at: Set(test_dt(2026, 3, 1, 10, 9)),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let coords_only_msg = mk_analysis_message(
        &fixture.env.dbx,
        "msg-coords-only",
        "999.9",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.beta],
        &[],
        false,
    )
    .await
    .unwrap();
    let mut coords_only_item =
        sigint_inbox_item::Entity::find_by_id(coords_only_msg.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    coords_only_item.coords = Set(Some("36U XB 70367 06497".to_string()));
    coords_only_item.update(&fixture.env.dbx).await.unwrap();

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["999.9".to_string()]);
    req.or_with_coords = Some(true);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        1
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["998.8".to_string()]);
    req.or_with_coords = Some(true);
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        1
    );

    let test_identity = mk_test_identity().await.unwrap();
    let map_req = crate::rer_importer::types::InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_freqs: Some(vec!["998.8".to_string()]),
        or_with_coords: Some(true),
        nolimit: Some(true),
        ..Default::default()
    };
    let inbox_items = crate::rer_importer::inbox::bl::get_inbox_map_items(
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        &map_req,
    )
    .await
    .unwrap();
    assert_eq!(
        inbox_items.iter().map(|item| item.id).collect_vec(),
        vec![peleng_only_msg.id]
    );
    assert_eq!(inbox_items[0].coords, None);
    let pelengs = crate::location::peleng::collect_inbox_item_pelengs(
        &inbox_items,
        &fixture.env.dbx,
    )
    .await
    .unwrap();
    let points = crate::rer_importer::inbox::bl::collect_map_points(
        inbox_items,
        pelengs,
    )
    .unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].message_id, peleng_only_msg.id);
    assert_eq!(points[0].lat, 48.0);
    assert_eq!(points[0].lng, 37.0);
}

#[tokio::test]
#[serial]
async fn rer_analysis_count_uses_aggregated_count_for_open_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.till_date_noninclusive_ms =
        req.since_date_inclusive_ms + 30 * 60 * 1000;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).unwrap();
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).unwrap();
    crate::stats::recalculate_group_stats(
        &fixture.env.dbx,
        dt_since,
        dt_till,
        false,
        true,
    )
    .await
    .unwrap();
    mk_analysis_message(
        &fixture.env.dbx,
        "msg-after-stats",
        "999.9",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let req = Json(req);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();

    let (count_overall, count_selected) = stats::fetch_counts_for_login(
        &req,
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        master_keys,
    )
    .await
    .unwrap();

    assert_eq!(count_overall, 7);
    assert_eq!(count_selected, 7);
}

#[tokio::test]
#[serial]
async fn rer_analysis_deleted_messages_do_not_contribute_to_filter_values() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    mk_analysis_message(
        db,
        "active-message",
        "944.1",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    let deleted_msg = mk_analysis_message(
        db,
        "deleted-message",
        "944.2",
        test_dt(2026, 3, 2, 10, 1),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();

    let mut deleted_msg = deleted_msg.into_active_model();
    deleted_msg.deleted = Set(true);
    deleted_msg.update(db).await.unwrap();

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_aors = Some(vec![fixture.aor_a.id]);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([(fixture.group_x.signal_group.master_key.clone(), 1,)])
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.1".to_string(), 1)])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_aor_and_network_stats_render_only_relevant_values() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = Data::from(fixture.env.clone());

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["444.4".to_string()]);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = aor_counts(
        stats::fetch_aors_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );
    assert_eq!(counts, BTreeMap::from([(fixture.south_aor.id, 1)]));

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["333.3".to_string()]);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = aor_counts(
        stats::fetch_aors_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        counts,
        BTreeMap::from([(fixture.north_aor.id, 1), (fixture.wide_aor.id, 1),])
    );

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let master_keys = get_identity_sigint_groups(
        &fixture.env.dbx,
        &test_identity_login_id(&fixture.env, &test_identity).await,
    )
    .await
    .unwrap();
    let counts = network_counts(
        stats::fetch_networks_for_login(
            &req,
            &test_identity_login_id(&fixture.env, &test_identity).await,
            &fixture.env.dbx,
            master_keys,
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        counts,
        BTreeMap::from([
            (fixture.network_south.network.id, 1),
            (fixture.network_wide.network.id, 1),
        ])
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_aor_query_matches_postgres_query() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["555.5".to_string()]);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    req.selected_senders = Some(vec!["msg-multi-group-sender".to_string()]);
    let expected =
        BTreeMap::from([(fixture.north_aor.id, 1), (fixture.south_aor.id, 1)]);
    assert_eq!(
        fetch_aor_counts_for_req(&fixture.env, &req).await.unwrap(),
        expected
    );
    assert_eq!(
        fetch_analytics_aor_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["444.4".to_string()]);
    let expected = BTreeMap::from([(fixture.south_aor.id, 1)]);
    assert_eq!(
        fetch_aor_counts_for_req(&fixture.env, &req).await.unwrap(),
        expected
    );
    assert_eq!(
        fetch_analytics_aor_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_network_count_matches_postgres_query() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    let req = analysis_stats_req0(&fixture);
    let expected_counts = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let expected = expected_counts.len() as i64;
    assert_eq!(
        fetch_analytics_network_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );
    assert_eq!(
        fetch_analytics_network_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected_counts
    );

    let login = find_test_login(db).await.unwrap();
    let public_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics network filter tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = signal_message::Entity::find()
        .filter(signal_message::Column::MessageUid.eq("msg-wide-network"))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            tag_id: Set(public_tag.id),
            login_id: Set(Some(login.id)),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![public_tag.id]);
    req.report_tags_only_this_unit = Some(true);
    let expected = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .len() as i64;
    assert_eq!(expected, 1);
    assert_eq!(
        fetch_analytics_network_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let expected = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .len() as i64;
    assert_eq!(
        fetch_analytics_network_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );
}

#[tokio::test]
#[serial]
async fn group_stats_raw_timeline_matches_message_activity() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let dt_since =
        crate::utils::dt_from_millis(fixture.since_date_inclusive_ms).unwrap();
    let dt_till =
        crate::utils::dt_from_millis(fixture.till_date_noninclusive_ms)
            .unwrap();

    let timelines = crate::stats::read_group_stats_timeline_raw(
        &fixture.env.dbx,
        vec![
            fixture.alpha.signal_group.master_key.clone(),
            fixture.beta.signal_group.master_key.clone(),
            fixture.secret_empty.signal_group.master_key.clone(),
        ],
        dt_since,
        dt_till,
    )
    .await
    .unwrap()
    .into_iter()
    .map(|timeline| (timeline.master_key, timeline.points))
    .collect::<BTreeMap<_, _>>();

    assert_eq!(
        timelines[&fixture.alpha.signal_group.master_key]
            .iter()
            .map(|point| point.count)
            .collect::<Vec<_>>(),
        vec![3]
    );
    assert_eq!(
        timelines[&fixture.beta.signal_group.master_key]
            .iter()
            .map(|point| point.count)
            .collect::<Vec<_>>(),
        vec![2, 2]
    );
    assert!(timelines[&fixture.secret_empty.signal_group.master_key].is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_tag_count_matches_postgres_query() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let owner_organism_id = login.organism_id.unwrap();
    let other_organism = mk_organism(
        db,
        organism::ActiveModel {
            name: Set("Other tag owner".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let public_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics public tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let owner_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics owner tag".to_string()),
            enabled: Set(true),
            owner_organism_id: Set(Some(owner_organism_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let inaccessible_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics inaccessible tag".to_string()),
            enabled: Set(true),
            owner_organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_analysis_message(
        db,
        "msg-analytics-tags",
        "919.1",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    for tag_id in [public_tag.id, owner_tag.id, inaccessible_tag.id] {
        mk_sigint_inbox_item_tag(
            db,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                tag_id: Set(tag_id),
                login_id: Set(Some(login.id)),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    let req = analysis_stats_req0(&fixture);
    let expected = fetch_tag_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .len() as i64;
    assert_eq!(expected, 2);
    assert_eq!(
        fetch_analytics_tag_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );

    let mut req = analysis_stats_req0(&fixture);
    req.selected_tags = Some(vec![public_tag.id, owner_tag.id]);
    req.tag_presence = Some(TagPresenceFilter::WithTags);
    req.report_tags_only_this_unit = Some(true);
    let expected = fetch_tag_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .len() as i64;
    assert_eq!(expected, 2);
    assert_eq!(
        fetch_analytics_tag_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_tag_access_matches_source_authorization() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let organism_id = login.organism_id.unwrap();
    let other_organism = mk_organism(
        db,
        organism::ActiveModel {
            name: Set("Other analytics tag access organism".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let same_organism_login = mk_login(
        db,
        login::ActiveModel {
            login: Set("AnalyticsSameOrganism".to_string()),
            organism_id: Set(Some(organism_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism_login = mk_login(
        db,
        login::ActiveModel {
            login: Set("AnalyticsOtherOrganism".to_string()),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let no_organism_login = mk_login(
        db,
        login::ActiveModel {
            login: Set("AnalyticsNoOrganism".to_string()),
            organism_id: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let deleted_login = mk_login(
        db,
        login::ActiveModel {
            login: Set("AnalyticsDeletedLogin".to_string()),
            organism_id: Set(Some(organism_id)),
            deleted_permanently: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let public_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics access public tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let owner_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics access owner tag".to_string()),
            enabled: Set(true),
            owner_organism_id: Set(Some(organism_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Analytics access other tag".to_string()),
            enabled: Set(true),
            owner_organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let access = stats::resolve_analytics_tag_access(db, &login.id, true)
        .await
        .unwrap();
    assert!(access.accessible_tag_ids.contains(&public_tag.id));
    assert!(access.accessible_tag_ids.contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.contains(&other_tag.id));
    assert!(access.unit_login_ids.contains(&login.id));
    assert!(access.unit_login_ids.contains(&same_organism_login.id));
    assert!(access.unit_login_ids.contains(&deleted_login.id));
    assert!(!access.unit_login_ids.contains(&other_organism_login.id));
    assert!(!access.unit_login_ids.contains(&no_organism_login.id));

    let access =
        stats::resolve_analytics_tag_access(db, &other_organism_login.id, true)
            .await
            .unwrap();
    assert!(access.accessible_tag_ids.contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.contains(&owner_tag.id));
    assert!(access.accessible_tag_ids.contains(&other_tag.id));
    assert!(access.unit_login_ids.contains(&other_organism_login.id));
    assert!(!access.unit_login_ids.contains(&login.id));

    let access =
        stats::resolve_analytics_tag_access(db, &no_organism_login.id, true)
            .await
            .unwrap();
    assert!(access.accessible_tag_ids.contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.contains(&other_tag.id));
    assert!(access.unit_login_ids.is_empty());

    let access =
        stats::resolve_analytics_tag_access(db, &deleted_login.id, true)
            .await
            .unwrap();
    assert!(access.accessible_tag_ids.contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.contains(&other_tag.id));
    assert!(access.unit_login_ids.contains(&login.id));

    let mut owner_tag = owner_tag.into_active_model();
    owner_tag.owner_organism_id = Set(Some(other_organism.id));
    let owner_tag = owner_tag.update(db).await.unwrap();
    let access = stats::resolve_analytics_tag_access(db, &login.id, false)
        .await
        .unwrap();
    assert!(!access.accessible_tag_ids.contains(&owner_tag.id));
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_dedup_reuses_id_and_refreshes_ttl() {
    let env = cleanup().await.unwrap();
    let state = short_state(Some(vec!["group-1".to_string()]));
    let payload = serde_json::to_string(&RerDutyShortStateGetRsp {
        state: state.clone(),
    })
    .unwrap();
    let hash = sha256::digest(payload.as_bytes());
    let hash_key = rer_duty_short_state_hash_key(&hash);
    let mut redis = env.redis.clone();
    let _: () = redis.del(&hash_key).await.unwrap();

    let (first_id, reused_first) =
        rer_duty_short_state_create_or_reuse(&mut redis, state.clone())
            .await
            .unwrap();
    let ttl_before: i64 = redis
        .ttl(rer_duty_short_state_key(&first_id))
        .await
        .unwrap();

    let (second_id, reused_second) =
        rer_duty_short_state_create_or_reuse(&mut redis, state)
            .await
            .unwrap();
    let ttl_after: i64 = redis
        .ttl(rer_duty_short_state_key(&second_id))
        .await
        .unwrap();

    assert!(!reused_first);
    assert!(reused_second);
    assert_eq!(first_id, second_id);
    assert!(ttl_before > 0);
    assert!(ttl_after > 0);

    let stored_id: Option<String> = redis.get(&hash_key).await.unwrap();
    assert_eq!(stored_id.as_deref(), Some(first_id.as_str()));
    let raw: Option<String> = redis
        .get(rer_duty_short_state_key(&first_id))
        .await
        .unwrap();
    assert_eq!(raw.as_deref(), Some(payload.as_str()));
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_new_id_for_different_state() {
    let env = cleanup().await.unwrap();
    let mut redis = env.redis.clone();
    let first_state = short_state(Some(vec!["group-a".to_string()]));
    let first_payload = serde_json::to_string(&RerDutyShortStateGetRsp {
        state: first_state.clone(),
    })
    .unwrap();
    let first_hash = sha256::digest(first_payload.as_bytes());
    let first_hash_key = rer_duty_short_state_hash_key(&first_hash);

    let second_state = short_state(Some(vec!["group-b".to_string()]));
    let second_payload = serde_json::to_string(&RerDutyShortStateGetRsp {
        state: second_state.clone(),
    })
    .unwrap();
    let second_hash = sha256::digest(second_payload.as_bytes());
    let second_hash_key = rer_duty_short_state_hash_key(&second_hash);

    let _: () = redis.del(&first_hash_key).await.unwrap();
    let _: () = redis.del(&second_hash_key).await.unwrap();

    let (first_id, reused_first) =
        rer_duty_short_state_create_or_reuse(&mut redis, first_state)
            .await
            .unwrap();
    let (second_id, reused_second) =
        rer_duty_short_state_create_or_reuse(&mut redis, second_state)
            .await
            .unwrap();

    assert!(!reused_first);
    assert!(!reused_second);
    assert_ne!(first_id, second_id);
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_hash_collision_creates_new_id() {
    let env = cleanup().await.unwrap();
    let mut redis = env.redis.clone();
    let state = short_state(Some(vec!["group-1".to_string()]));
    let payload = serde_json::to_string(&RerDutyShortStateGetRsp {
        state: state.clone(),
    })
    .unwrap();
    let hash = sha256::digest(payload.as_bytes());
    let hash_key = rer_duty_short_state_hash_key(&hash);

    let fake_id = "fake-id".to_string();
    let _: () = redis
        .set_ex(
            rer_duty_short_state_key(&fake_id),
            "{\"state\":{}}".to_string(),
            RER_DUTY_SHORT_STATE_TTL_SEC,
        )
        .await
        .unwrap();
    let _: () = redis
        .set_ex(&hash_key, fake_id.clone(), RER_DUTY_SHORT_STATE_TTL_SEC)
        .await
        .unwrap();

    let (id, reused) = rer_duty_short_state_create_or_reuse(&mut redis, state)
        .await
        .unwrap();

    assert!(!reused);
    assert_ne!(id, fake_id);
    let stored_id: Option<String> = redis.get(&hash_key).await.unwrap();
    assert_eq!(stored_id.as_deref(), Some(id.as_str()));
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_get_refreshes_ttl() {
    let env = cleanup().await.unwrap();
    let mut redis = env.redis.clone();
    let (id, _reused) = rer_duty_short_state_create_or_reuse(
        &mut redis,
        short_state(Some(vec!["group-1".to_string()])),
    )
    .await
    .unwrap();
    let ttl_before: i64 =
        redis.ttl(rer_duty_short_state_key(&id)).await.unwrap();

    let rsp = rer_duty_short_state_get_and_refresh(&mut redis, &id)
        .await
        .unwrap();
    let ttl_after: i64 =
        redis.ttl(rer_duty_short_state_key(&id)).await.unwrap();

    assert_eq!(
        rsp.state.waterfalls.as_ref().unwrap()[0].1.groups_selected,
        Some(vec!["group-1".to_string()])
    );
    assert!(ttl_before > 0);
    assert!(ttl_after > 0);
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_missing_returns_not_found() {
    let env = cleanup().await.unwrap();
    let mut redis = env.redis.clone();
    let err = rer_duty_short_state_get_and_refresh(&mut redis, "missing")
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound));
}

#[test]
fn rer_duty_short_state_serialization_stable() {
    let state = short_state(Some(vec!["group-1".to_string()]));
    let payload_a = serde_json::to_string(&RerDutyShortStateGetRsp {
        state: state.clone(),
    })
    .unwrap();
    let payload_b =
        serde_json::to_string(&RerDutyShortStateGetRsp { state }).unwrap();
    assert_eq!(payload_a, payload_b);
}

#[tokio::test]
#[serial]
async fn rer_duty_short_state_get_works_without_hash_key() {
    let env = cleanup().await.unwrap();
    let mut redis = env.redis.clone();
    let (id, _reused) = rer_duty_short_state_create_or_reuse(
        &mut redis,
        short_state(Some(vec!["group-1".to_string()])),
    )
    .await
    .unwrap();
    let hash = sha256::digest(
        serde_json::to_string(&RerDutyShortStateGetRsp {
            state: short_state(Some(vec!["group-1".to_string()])),
        })
        .unwrap()
        .as_bytes(),
    );
    let hash_key = rer_duty_short_state_hash_key(&hash);
    let _: () = redis.del(&hash_key).await.unwrap();

    let rsp = rer_duty_short_state_get_and_refresh(&mut redis, &id)
        .await
        .unwrap();
    assert_eq!(
        rsp.state.waterfalls.as_ref().unwrap()[0].1.groups_selected,
        Some(vec!["group-1".to_string()])
    );
}

#[tokio::test]
async fn count_stats_analytics_success_skips_postgres() {
    let postgres_polled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let postgres_polled_query = postgres_polled.clone();
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
    let analytics_query = async { Ok::<_, AppError>("analytics") };
    let postgres_query = async move {
        postgres_polled_query.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok::<_, AppError>("postgres")
    };

    let result = with_count_stats_analytics_fallback(
        Some(analytics_query),
        core::time::Duration::from_secs(1),
        postgres_query,
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "analytics");
    assert!(!postgres_polled.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
}

#[tokio::test]
async fn count_stats_analytics_error_retries_postgres_once() {
    let postgres_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let postgres_attempts_query = postgres_attempts.clone();
    let retry_state = std::sync::atomic::AtomicU64::new(0);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
    let analytics_query = async {
        Err::<&str, AppError>(anyhow::anyhow!("analytics unavailable").into())
    };
    let postgres_query = async move {
        postgres_attempts_query
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok::<_, AppError>("postgres")
    };

    let result = with_count_stats_analytics_fallback(
        Some(analytics_query),
        core::time::Duration::from_secs(1),
        postgres_query,
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
    assert_eq!(
        postgres_attempts.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert!(
        retry_state.load(std::sync::atomic::Ordering::Acquire)
            > analytics_unix_ms()
    );
    assert!(analytics_retry_attempt(&retry_state).is_none());
}

#[tokio::test]
async fn count_stats_without_analytics_uses_postgres() {
    let result = with_count_stats_analytics_fallback(
        None::<std::future::Ready<Result<&str, AppError>>>,
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        None,
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
}

#[test]
fn count_stats_analytics_supports_tag_filters() {
    let mut req = mk_analysis_stats_req(0, 1);
    assert!(analytics_count_request_supported(&req));

    req.selected_tags = Some(vec![1]);
    assert!(analytics_count_request_supported(&req));

    req.selected_tags = None;
    req.denied_tags = Some(vec![1]);
    assert!(analytics_count_request_supported(&req));

    req.denied_tags = None;
    req.tag_presence = Some(TagPresenceFilter::WithTags);
    assert!(analytics_count_request_supported(&req));

    req.tag_presence = None;
    req.or_bookmarked = Some(true);
    assert!(analytics_count_request_supported(&req));

    req.or_bookmarked = None;
    req.or_important = Some(true);
    assert!(analytics_count_request_supported(&req));

    req.or_important = None;
    req.or_with_coords = Some(true);
    assert!(analytics_count_request_supported(&req));

    req.or_with_coords = None;
    req.or_without_coords = Some(true);
    assert!(analytics_count_request_supported(&req));

    req.or_without_coords = None;
    req.or_with_extended_form = Some(true);
    assert!(analytics_count_request_supported(&req));

    req.or_with_extended_form = None;
    req.report_tags_only_this_unit = Some(true);
    assert!(analytics_count_request_supported(&req));
}

#[test]
fn count_stats_analytics_supports_callsign_filters_but_rejects_search() {
    let mut req = mk_analysis_stats_req(0, 1);

    req.search = Some("callsign".to_string());
    assert!(!analytics_count_request_supported(&req));

    req.search = None;
    req.selected_callsigns = Some(vec!["ALPHA".to_string()]);
    assert!(analytics_count_request_supported(&req));
}

#[test]
fn analytical_inbox_reads_support_callsign_filters_but_reject_search() {
    let mut req = InboxMessagesReq::default();
    assert!(analytics_inbox_request_supported(&req));

    req.search = Some("callsign".to_string());
    assert!(!analytics_inbox_request_supported(&req));

    req.search = None;
    req.selected_callsigns = Some(vec!["ALPHA".to_string()]);
    assert!(analytics_inbox_request_supported(&req));
}

#[tokio::test]
#[serial]
async fn analytics_read_without_pool_uses_postgres_path() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    assert!(fixture.env.analytics.is_none());

    let result = with_analytics_read_fallback(
        &fixture.env,
        "analytics fallback test",
        true,
        |_db| async {
            panic!("analytics must not run without a configured pool")
        },
        |_db| async { Ok::<_, AppError>("postgres") },
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
}

#[tokio::test]
async fn count_stats_analytics_timeout_retries_postgres() {
    let analytics_query = std::future::pending::<Result<&str, AppError>>();
    let result = with_count_stats_analytics_fallback(
        Some(analytics_query),
        core::time::Duration::ZERO,
        async { Ok::<_, AppError>("postgres") },
        None,
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
}

#[test]
fn count_stats_closed_circuit_allows_concurrent_analytics_attempts() {
    let retry_state = std::sync::atomic::AtomicU64::new(0);

    let first = analytics_retry_attempt(&retry_state).unwrap();
    let second = analytics_retry_attempt(&retry_state).unwrap();

    assert_eq!(first.kind, AnalyticsRetryAttemptKind::Closed);
    assert_eq!(second.kind, AnalyticsRetryAttemptKind::Closed);
}

#[test]
fn count_stats_analytics_open_circuit_allows_one_half_open_attempt() {
    const ATTEMPT_COUNT: usize = 8;
    let retry_state = Arc::new(std::sync::atomic::AtomicU64::new(1));
    let barrier = Arc::new(std::sync::Barrier::new(ATTEMPT_COUNT));
    let winners = std::thread::scope(|scope| {
        let attempts = (0..ATTEMPT_COUNT)
            .map(|_| {
                let retry_state = retry_state.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    analytics_retry_attempt(&retry_state).is_some()
                })
            })
            .collect::<Vec<_>>();
        attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|won| *won)
            .count()
    });

    assert_eq!(winners, 1);
    assert_eq!(
        retry_state.load(std::sync::atomic::Ordering::Acquire),
        u64::MAX
    );
    assert!(analytics_retry_attempt(&retry_state).is_none());
}

#[test]
fn dropping_half_open_cancellation_guard_releases_retry_probe() {
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();

    {
        let _retry_cancellation_guard = retry_attempt.cancellation_guard();
        assert_eq!(
            retry_state.load(std::sync::atomic::Ordering::Acquire),
            u64::MAX
        );
    }

    assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
    assert!(analytics_retry_attempt(&retry_state).is_some());
}

#[tokio::test]
async fn count_stats_analytics_closed_success_does_not_clear_concurrent_failure(
) {
    let retry_state = std::sync::atomic::AtomicU64::new(0);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
    let concurrent_deadline =
        analytics_retry_deadline(core::time::Duration::from_secs(60));
    let analytics_query = async {
        retry_state
            .store(concurrent_deadline, std::sync::atomic::Ordering::Release);
        Ok::<_, AppError>("analytics")
    };

    let result = with_count_stats_analytics_fallback(
        Some(analytics_query),
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "analytics");
    assert_eq!(
        retry_state.load(std::sync::atomic::Ordering::Acquire),
        concurrent_deadline
    );
}

#[tokio::test]
async fn count_stats_analytics_half_open_failure_reopens_circuit() {
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();

    let result = with_count_stats_analytics_fallback(
        Some(async {
            Err::<&str, AppError>(
                anyhow::anyhow!("analytics unavailable").into(),
            )
        }),
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
    let retry_deadline = retry_state.load(std::sync::atomic::Ordering::Acquire);
    assert_ne!(retry_deadline, u64::MAX);
    assert!(retry_deadline > analytics_unix_ms());
}
