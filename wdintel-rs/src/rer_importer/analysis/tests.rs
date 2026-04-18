use crate::functest::tests::*;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::rer_importer::*;
use actix_web::web::{Data, Json};
use sea_orm::ActiveValue::Set;
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
            ..Default::default()
        },
    )
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
                login: Set(login.login.clone()),
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

fn sender_counts(senders: Vec<AnalysisStatsSender>) -> BTreeMap<String, i64> {
    senders
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
) -> Result<(String, Vec<String>), AppError> {
    let test_identity = mk_test_identity().await?;
    let master_keys =
        get_identity_sigint_groups(&env.dbx, &test_identity.login)
            .await
            .context(h!())?;
    Ok((test_identity.login, master_keys))
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
    let senders =
        stats::fetch_senders_for_login(req, &login, &env, master_keys)
            .await
            .context(h!())?;
    Ok(sender_counts(senders))
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
    let env = Data::from(fixture.env.clone());
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.south_aor.id]);
    let req = Json(req);
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = group_counts(
        stats::fetch_groups_for_login(
            &req.0,
            &test_identity.login,
            &env,
            master_keys,
        )
        .await
        .unwrap(),
    );

    assert_eq!(counts.len(), 2);
    assert_eq!(counts.get(&fixture.alpha.signal_group.master_key), Some(&2));
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
async fn rer_analysis_group_dropdown_keeps_network_matched_groups() {
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
        BTreeMap::from([
            (fixture.group_x.signal_group.master_key.clone(), 3),
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
        BTreeMap::from([
            (fixture.group_x.signal_group.master_key.clone(), 3),
            (fixture.group_y.signal_group.master_key.clone(), 1),
        ])
    );

    let network_counts = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(network_counts.get(&fixture.network_k.network.id), Some(&1));
    assert!(!network_counts.contains_key(&fixture.network_l.network.id));
}

#[tokio::test]
#[serial]
async fn rer_analysis_shared_messages_keep_related_groups_visible() {
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
        BTreeMap::from([
            (fixture.group_x.signal_group.master_key.clone(), 1),
            (fixture.group_y.signal_group.master_key.clone(), 1),
        ])
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
        BTreeMap::from([
            (fixture.group_x.signal_group.master_key.clone(), 1),
            (fixture.group_y.signal_group.master_key.clone(), 1),
        ])
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
async fn rer_analysis_network_aor_overlap_keeps_messages_groups_and_networks() {
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
        BTreeMap::from([(fixture.alpha.signal_group.master_key.clone(), 1,)])
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
async fn rer_analysis_network_aor_match_can_show_group_without_network() {
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
        BTreeMap::from([(fixture.group_y.signal_group.master_key.clone(), 1,)])
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
            user_id: Set("Tester".to_string()),
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
            login: Set(Some("Tester".to_string())),
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
            login: Set(Some("Tester".to_string())),
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
            login: Set("Tester".to_string()),
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
            login: Set(Some("Tester".to_string())),
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
        1
    );
    assert_eq!(
        fetch_callsign_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        BTreeMap::from([("CS-COM".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(tag_comment.id, 1)])
    );
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
            user_id: Set("Tester".to_string()),
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
            login: Set(Some("Tester".to_string())),
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
            login: Set(Some("Tester".to_string())),
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
            login: Set(Some("Tester".to_string())),
            model: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            login: Set("Tester".to_string()),
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
            login: Set(Some(same_org_login.login.clone())),
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
            login: Set(Some(other_org_login.login.clone())),
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
            login: Set(Some("Tester".to_string())),
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
            login: Set(Some("Tester".to_string())),
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
async fn rer_analysis_metadata_stats_use_ids_not_display_names() {
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

    let req = analysis_stats_req0(&fixture);
    let metadata = fetch_metadata_stats_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let sender_values = metadata_value_counts(metadata.senders);
    let receiver_values = metadata_value_counts(metadata.receivers);

    assert_eq!(sender_values, BTreeMap::from([("SID-01".to_string(), 1)]));
    assert!(!sender_values.contains_key("Sender Name"));
    assert_eq!(receiver_values, BTreeMap::from([("RID-01".to_string(), 1)]));
    assert!(!receiver_values.contains_key("Receiver Name"));
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
            created_by: Set("Tester".to_string()),
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
async fn rer_analysis_freq_stats_follow_group_and_network_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = Data::from(fixture.env.clone());

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = freq_counts(
        stats::fetch_freqs_for_login(
            &req,
            &test_identity.login,
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
async fn rer_analysis_count_stats_follow_aor_frequency_and_peleng_filters() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = Data::from(fixture.env.clone());

    let test_identity = mk_test_identity().await.unwrap();
    let req = Json(analysis_stats_req0(&fixture));
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let master_keys_noimport = master_keys.clone();
    let groups = stats::fetch_groups_for_login(
        &req.0,
        &test_identity.login,
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
        &test_identity.login,
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
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity.login,
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
    req.or_with_coords = Some(true);
    let req = Json(req);
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    assert_eq!(
        stats::fetch_counts_for_login(
            &req,
            &test_identity.login,
            &fixture.env,
            master_keys,
        )
        .await
        .unwrap()
        .1,
        1
    );
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = aor_counts(
        stats::fetch_aors_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = aor_counts(
        stats::fetch_aors_for_login(
            &req,
            &test_identity.login,
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
    let master_keys =
        get_identity_sigint_groups(&fixture.env.dbx, &test_identity.login)
            .await
            .unwrap();
    let counts = network_counts(
        stats::fetch_networks_for_login(
            &req,
            &test_identity.login,
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
