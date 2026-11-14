use crate::config::{IDENTITY_DURATION_HOURS, ROLE_ADMIN, SYSTEM_LOGIN_NAME};
use crate::devices::ROLE_CYBER;
use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
use crate::entities::{login, system_settings};
use crate::functest::tests::*;
use crate::h;
use crate::rer_importer::analysis::*;
use crate::rer_importer::*;
use crate::{new_pg_runtime_pool_from_config, PgRuntimePoolRole};
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::storage::RedisSessionStore;
use actix_session::SessionMiddleware;
use actix_web::cookie::{Cookie, Key};
use actix_web::web::{Data, Json};
use actix_web::{
    http::StatusCode, test as actix_test, web, App, HttpMessage, HttpRequest,
    HttpResponse,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DbBackend, EntityTrait, FromQueryResult, IntoActiveModel, QueryFilter,
    Statement,
};
use serial_test::serial;

struct GroupFixture {
    signal_group: signal_group::Model,
    datasource_group: datasource_group::Model,
}

#[actix_web::test]
#[serial]
async fn issue_3940_bulk_unit_rename_preserves_rer_scope() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = &env.dbx;
    let login = find_test_login(db).await.unwrap().id;
    let group = GroupFixture {
        signal_group: find_test_signal_group(db).await.unwrap(),
        datasource_group: find_test_datasource_group(db).await.unwrap(),
    };
    let configured = mk_sigint_unit(db, Default::default()).await.unwrap();
    let excluded = mk_sigint_unit(db, Default::default()).await.unwrap();
    sigint_unit_rer_report_metadata::ActiveModel {
        sigint_unit_id: Set(configured.id),
        report_name: Set(Some("Bulk rename".into())),
        labels: Set(serde_json::json!(["Bulk rename"])),
        locations: Set(serde_json::json!([])),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let now = Utc::now().naive_utc();
    let mut items = Vec::new();
    for (unit_id, label) in [
        (configured.id, "rename-inside-3940"),
        (excluded.id, "rename-outside-3940"),
    ] {
        let message = mk_analysis_message(
            db,
            label,
            "3940.1",
            now,
            &[&group],
            &[],
            false,
        )
        .await
        .unwrap();
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(message.id),
            unit_id: Set(unit_id),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        items.push(message.id);
    }
    let session_store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = actix_test::init_service(
        App::new()
            .app_data(Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session_store, Key::generate()))
            .route(
                "/test/rer-rename-login/{login}",
                web::post().to(activity_daily_test_login),
            )
            .service(edit_freq_unit_name),
    )
    .await;
    let login_response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("/test/rer-rename-login/{login}"))
            .to_request(),
    )
    .await;
    let session_cookie = login_response
        .response()
        .cookies()
        .next()
        .unwrap()
        .into_owned();
    for enabled in [Some(true), Some(false), None] {
        for id in &items {
            sigint_inbox_item::ActiveModel {
                id: Set(*id),
                datetime: Set(Some(now)),
                unit: Set(Some("Original unit".into())),
                unit_v2: Set(Some("Original unit".into())),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .update(db)
            .await
            .unwrap();
        }
        let mut req = mk_analysis_stats_req(
            (now - chrono::Duration::hours(1))
                .and_utc()
                .timestamp_millis(),
            (now + chrono::Duration::hours(1))
                .and_utc()
                .timestamp_millis(),
        );
        req.only_for_rer_report = enabled;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/rer/analysis/freq-edit-unit-name")
                .cookie(session_cookie.clone())
                .set_json(EditFreqUnitNameReq {
                    analysis_stats_req: req,
                    freq: "3940.1".into(),
                    unit: "Original unit".into(),
                    unit_new: "Renamed unit".into(),
                    search: None,
                    filter_tags_option: None,
                    report_tags_only_this_unit: None,
                })
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        for (index, id) in items.iter().enumerate() {
            let item = sigint_inbox_item::Entity::find_by_id(*id)
                .one(db)
                .await
                .unwrap()
                .unwrap();
            let changed = index == 0 || enabled != Some(true);
            let expected = if changed {
                "Renamed unit"
            } else {
                "Original unit"
            };
            assert_eq!(item.unit.as_deref(), Some(expected));
            assert_eq!(item.unit_v2.as_deref(), Some(expected));
            assert_eq!(item.parsed_unit_v2, changed);
        }
    }
}

#[tokio::test]
#[serial]
async fn issue_3940_map_exports_preserve_rer_scope() {
    use std::io::Read;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = &env.dbx;
    let login = find_test_login(db).await.unwrap().id;
    let group = GroupFixture {
        signal_group: find_test_signal_group(db).await.unwrap(),
        datasource_group: find_test_datasource_group(db).await.unwrap(),
    };
    let configured = mk_sigint_unit(db, Default::default()).await.unwrap();
    let excluded = mk_sigint_unit(db, Default::default()).await.unwrap();
    sigint_unit_rer_report_metadata::ActiveModel {
        sigint_unit_id: Set(configured.id),
        report_name: Set(Some("Map export".into())),
        labels: Set(serde_json::json!(["Map export"])),
        locations: Set(serde_json::json!([])),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let now = Utc::now().naive_utc();
    for (unit_id, label, latitude) in [
        (configured.id, "INSIDE3940", 48.0),
        (excluded.id, "OUTSIDE3940", 49.0),
    ] {
        seed_rer_map_export_message(
            db, &group, unit_id, &login, label, latitude, now,
        )
        .await;
    }
    let mut req = mk_analysis_stats_req(
        (now - chrono::Duration::hours(1))
            .and_utc()
            .timestamp_millis(),
        (now + chrono::Duration::hours(1))
            .and_utc()
            .timestamp_millis(),
    );
    req.without_network = Some(true);
    for (scope, expected_count) in [(Some(true), 1), (None, 2)] {
        req.only_for_rer_report = scope;
        let geojson =
            geojson::rer_analysis_geojson_bytes(&login, &env, req.clone())
                .await
                .unwrap();
        let geojson = String::from_utf8(geojson).unwrap();
        let features: serde_json::Value =
            serde_json::from_str(&geojson).unwrap();
        assert_eq!(
            features["features"].as_array().unwrap().len(),
            expected_count
        );
        let kmz = kmz::rer_analysis_kmz_bytes(&login, &env, req.clone())
            .await
            .unwrap();
        let mut archive =
            ::zip::ZipArchive::new(std::io::Cursor::new(kmz)).unwrap();
        let mut kml = String::new();
        archive
            .by_name("doc.kml")
            .unwrap()
            .read_to_string(&mut kml)
            .unwrap();
        for output in [&geojson, &kml] {
            assert!(output.contains("INSIDE3940"));
            assert_eq!(output.contains("OUTSIDE3940"), scope.is_none());
        }
    }
}

async fn seed_rer_map_export_message(
    db: &DatabaseConnection,
    group: &GroupFixture,
    unit_id: i64,
    login: &uuid::Uuid,
    label: &str,
    latitude: f64,
    datetime: NaiveDateTime,
) {
    let message =
        mk_analysis_message(db, label, "111.1", datetime, &[group], &[], false)
            .await
            .unwrap();
    let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.datetime = Set(Some(datetime));
    inbox_item.lat = Set(Some(latitude));
    inbox_item.lng = Set(Some(37.0));
    let inbox_item = inbox_item.update(db).await.unwrap();
    sigint_inbox_item_unit::ActiveModel {
        item_id: Set(message.id),
        item_uuid: Set(inbox_item.id_uuid),
        unit_id: Set(unit_id),
        kind: Set(SigintInboxItemUnitKind::Parsed),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    crate::inbox::callsigns::sync(
        db,
        message.id,
        inbox_item.id_uuid,
        crate::inbox::callsigns::InboxItemCallsigns {
            primary: vec![label.into()],
            alg2: vec![],
        },
        *login,
    )
    .await
    .unwrap();
}

#[serial]
#[tokio::test]
async fn issue_3780_message_group_lookup_preserves_access_and_scope() {
    let env = cleanup().await.unwrap();
    let allowed = mk_signal_group(&env.dbx, Default::default())
        .await
        .unwrap()
        .master_key;
    let denied = mk_signal_group(&env.dbx, Default::default())
        .await
        .unwrap()
        .master_key;
    let mut ids = Vec::new();
    for groups in [
        vec![
            Some(allowed.clone()),
            Some(allowed.clone()),
            Some(denied.clone()),
        ],
        vec![Some(denied.clone())],
        vec![None],
    ] {
        let message = mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
        for group in groups {
            mk_signal_message_group(
                &env.dbx,
                signal_message_group::ActiveModel {
                    signal_message_id: Set(message.id),
                    group_master_key: Set(group),
                    datasource_group_id: Set(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        ids.push(message.id);
    }

    for lookup_by_message in [false, true] {
        for (keys, scope, expected) in [
            (vec![allowed.clone()], None, vec![ids[0]]),
            (vec![denied.clone()], None, vec![ids[0], ids[1]]),
            (
                vec![allowed.clone(), denied.clone()],
                None,
                vec![ids[0], ids[1]],
            ),
            (vec![], None, vec![]),
            (
                vec![allowed.clone()],
                Some(AnalyticsMessageIdScope::From(ids[1])),
                vec![],
            ),
            (
                vec![allowed.clone()],
                Some(AnalyticsMessageIdScope::Inclusive {
                    min_id: ids[0],
                    max_id: ids[0],
                }),
                vec![ids[0]],
            ),
            (
                vec![allowed.clone()],
                Some(AnalyticsMessageIdScope::Empty),
                vec![],
            ),
            (
                vec![allowed.clone(), denied.clone()],
                Some(AnalyticsMessageIdScope::From(ids[1])),
                vec![ids[1]],
            ),
            (
                vec![allowed.clone(), denied.clone()],
                Some(AnalyticsMessageIdScope::Inclusive {
                    min_id: ids[0],
                    max_id: ids[0],
                }),
                vec![ids[0]],
            ),
            (
                vec![allowed.clone(), denied.clone()],
                Some(AnalyticsMessageIdScope::Empty),
                vec![],
            ),
        ] {
            let actual = signal_message::Entity::find()
                .select_only()
                .column(signal_message::Column::Id)
                .filter(signal_message::Column::Id.is_in(ids.clone()))
                .filter(message_in_groups_exists_with_correlation(
                    keys,
                    scope.as_ref(),
                    lookup_by_message,
                ))
                .order_by_asc(signal_message::Column::Id)
                .into_tuple::<i64>()
                .all(&env.dbx)
                .await
                .unwrap();
            assert_eq!(actual, expected);
        }
    }
}

#[tokio::test]
#[ignore = "requires the isolated callsign benchmark database"]
async fn capture_callsign_page_production_builder_plans() {
    let output = std::path::PathBuf::from(
        std::env::var("CALLSIGN_PLAN_OUTPUT").unwrap(),
    );
    std::fs::create_dir_all(&output).unwrap();
    let env = crate::server::new_env(crate::types::Mode::Test)
        .await
        .unwrap();
    let state = env
        .dbx
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT master_key, creator FROM callsign_benchmark_state",
        ))
        .await
        .unwrap()
        .unwrap();
    let master_key: String = state.try_get_by("master_key").unwrap();
    let login: uuid::Uuid = state.try_get_by("creator").unwrap();
    let network_id: i64 = env
        .dbx
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT id FROM sigint_network WHERE name = 'BENCH-NET-000'",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get_by("id")
        .unwrap();
    let req = mk_analysis_stats_req(1_786_060_800_000, 1_791_320_400_000);

    let broad = AnalysisCallsignPageReq {
        req: req.clone(),
        query: String::new(),
        page_size: Some(50),
        cursor: None,
        order: AnalysisCallsignPageOrder::CountDesc,
    };
    let broad_first = stats::fetch_callsigns_page_for_login(
        &broad,
        &login,
        &env.dbx,
        vec![master_key.clone()],
    )
    .await
    .unwrap();
    let broad_second = AnalysisCallsignPageReq {
        cursor: broad_first.next_cursor,
        ..broad.clone()
    };
    let partial = AnalysisCallsignPageReq {
        req: req.clone(),
        query: "CS-099".to_string(),
        page_size: Some(50),
        cursor: None,
        order: AnalysisCallsignPageOrder::MatchThenName,
    };
    let partial_first = stats::fetch_callsigns_page_for_login(
        &partial,
        &login,
        &env.dbx,
        vec![master_key.clone()],
    )
    .await
    .unwrap();
    let partial_second = AnalysisCallsignPageReq {
        cursor: partial_first.next_cursor,
        ..partial.clone()
    };
    let mut partial_deep = partial.clone();
    for _ in 0..10 {
        let page = stats::fetch_callsigns_page_for_login(
            &partial_deep,
            &login,
            &env.dbx,
            vec![master_key.clone()],
        )
        .await
        .unwrap();
        partial_deep.cursor = page.next_cursor;
    }
    let exact = AnalysisCallsignPageReq {
        query: "CS-099000".to_string(),
        ..partial.clone()
    };
    let case_variant = AnalysisCallsignPageReq {
        query: "cs-099".to_string(),
        ..partial.clone()
    };
    let no_match = AnalysisCallsignPageReq {
        query: "NO-SUCH-CALLSIGN".to_string(),
        ..partial.clone()
    };
    let mut narrow_req = req;
    narrow_req.selected_freqs = Some(vec!["100.000".to_string()]);
    narrow_req.selected_networks = Some(vec![network_id]);
    let narrow = AnalysisCallsignPageReq {
        req: narrow_req,
        ..broad.clone()
    };

    for (name, page_req) in [
        ("broad-first", broad),
        ("broad-second", broad_second),
        ("partial-first", partial),
        ("partial-second", partial_second),
        ("partial-deep", partial_deep),
        ("exact-first", exact),
        ("case-variant-first", case_variant),
        ("no-match", no_match),
        ("narrow-first", narrow),
    ] {
        let statement = stats::callsign_page_statement_for_test(
            &page_req,
            &login,
            vec![master_key.clone()],
        )
        .unwrap();
        std::fs::write(output.join(format!("{name}.sql")), &statement.sql)
            .unwrap();
        for run in 1..=3 {
            let mut explain = statement.clone();
            explain.sql = format!(
                "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) {}",
                explain.sql,
            );
            let plan = env.dbx.query_all_raw(explain).await.unwrap();
            let plan = plan
                .iter()
                .map(|row| row.try_get_by_index::<String>(0).unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(output.join(format!("{name}-{run}.plan")), plan)
                .unwrap();
        }
    }
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

async fn activity_daily_test_login(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

async fn set_login_roles(
    db: &DatabaseConnection,
    login_id: uuid::Uuid,
    roles: serde_json::Value,
) {
    let login = login::Entity::find_by_id(login_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let mut login = login.into_active_model();
    login.roles = Set(roles);
    login.update(db).await.unwrap();
}

async fn set_devices_section_enabled(db: &DatabaseConnection, enabled: bool) {
    match system_settings::Entity::find().one(db).await.unwrap() {
        Some(settings) => {
            let mut settings = settings.into_active_model();
            settings.devices_section_enabled = Set(enabled);
            settings.update(db).await.unwrap();
        }
        None => {
            system_settings::ActiveModel {
                devices_section_enabled: Set(enabled),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
    }
}

async fn test_identity_login_id(
    env: &Env,
    test_identity: &TestIdentity,
) -> uuid::Uuid {
    crate::users::login_id_by_name(&env.dbx, &test_identity.login)
        .await
        .unwrap()
}

async fn fetch_correlated_inbox_count(
    env: &Env,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
) -> i64 {
    let query =
        crate::rer_importer::inbox::query::build_correlated_inbox_digest_query(
            login, env, req,
        )
        .await
        .unwrap();
    env.dbx
        .query_one_raw(Statement::from_string(DbBackend::Postgres, query))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap()
}

async fn assign_message_device_name(
    db: &DatabaseConnection,
    message_id: i64,
    device_name_id: Option<i64>,
    datetime: NaiveDateTime,
) {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(message_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.device_name_id = Set(device_name_id);
    inbox_item.datetime = Set(Some(datetime));
    inbox_item.update(db).await.unwrap();
}

async fn inbox_map_item_ids(
    env: &Env,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
) -> Vec<i64> {
    let query =
        crate::rer_importer::inbox::query::build_inbox_query(login, env, req)
            .await
            .unwrap();
    env.dbx
        .query_all_raw(Statement::from_string(DbBackend::Postgres, query))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "id").unwrap())
        .collect()
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
        search: None,
        search_mode: None,
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
        units_include_children: None,
        selected_unit_ids: None,
        denied_unit_ids: None,
        selected_device_names: None,
        denied_device_names: None,
        units_exact_match_only: None,
        locations_selected: None,
        locations_denied: None,
        include_peleng_locations: None,
        last_viewed_message_id: None,
        highlight_keywords_enabled: None,
        highlight_keyword_set_id: None,
    }
}

fn short_state(groups_selected: Option<Vec<String>>) -> RerDutyQueryState {
    RerDutyQueryState {
        group_scopes: None,
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
        selected_unit_ids: None,
        selected_units: None,
        selected_locations: None,
        selected_device_names: None,
        selected_aors: None,
        or_with_extended_form: None,
        or_bookmarked: None,
        or_important: None,
        or_with_coords: None,
        or_without_coords: None,
        search: None,
        search_mode: None,
        selected_tags: None,
        denied_tags: None,
        tag_presence: None,
        selected_networks: None,
        without_network: None,
        only_with_network: None,
        only_for_rer_report: None,
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
        message_time_basis: None,
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
    let inbox_item = mk_sigint_inbox_item(
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
    crate::battle_line::settlement_queue::reconcile_item_locations(
        db,
        inbox_item.id,
        inbox_item.id_uuid,
        location_v2,
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

    env.dbx
        .execute_unprepared(
            r#"
CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived;
CREATE OR REPLACE VIEW echo_clickhouse_derived.message_aor_link AS
SELECT
  message_group.signal_message_id AS sigint_inbox_item_id,
  group_aor.aor_id,
  aor.left_bound,
  aor.right_bound
FROM signal_message_group AS message_group
INNER JOIN signal_group_aor AS group_aor
  ON group_aor.master_key = message_group.group_master_key
INNER JOIN area_of_responsibility AS aor
  ON aor.id = group_aor.aor_id
WHERE message_group.group_master_key IN (
  SELECT DISTINCT group_master_key
  FROM sigint_zone_datasource
)
UNION ALL
SELECT
  inbox_network.sigint_inbox_item_id,
  network_aor.aor_id,
  aor.left_bound,
  aor.right_bound
FROM sigint_inbox_item_network AS inbox_network
INNER JOIN sigint_network AS network
  ON network.id = inbox_network.sigint_network_id
INNER JOIN sigint_network_aor AS network_aor
  ON network_aor.network_id = network.id
INNER JOIN area_of_responsibility AS aor
  ON aor.id = network_aor.aor_id
WHERE NOT network.deleted
"#,
        )
        .await
        .context(h!())?;
    let (login, master_keys) =
        analysis_login_and_master_keys(env).await.context(h!())?;
    let statement = stats::build_aors_analytics_query(
        req,
        &login,
        crate::utils::dt_from_millis(req.since_date_inclusive_ms)
            .context(h!())?,
        crate::utils::dt_from_millis(req.till_date_noninclusive_ms)
            .context(h!())?,
        master_keys,
    )
    .context(h!())?;
    let aors = AorQueryResult::find_by_statement(statement)
        .all(&env.dbx)
        .await
        .context(h!())?;
    let aors: BTreeMap<i64, i64> = aors
        .into_iter()
        .map(|aor| (aor.aor_id, aor.count))
        .collect();
    for scope in [
        None,
        Some(AnalyticsMessageIdScope::From(0)),
        Some(AnalyticsMessageIdScope::Inclusive {
            min_id: 0,
            max_id: i64::MAX,
        }),
        Some(AnalyticsMessageIdScope::Empty),
    ] {
        let count = fetch_analytics_aor_count_for_req(env, req, scope.as_ref())
            .await
            .context(h!())?;
        let expected = if scope.is_some_and(|scope| scope.is_empty()) {
            0
        } else {
            aors.len() as i64
        };
        assert_eq!(count, expected);
    }
    Ok(aors)
}

async fn fetch_analytics_aor_count_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
    scope: Option<&AnalyticsMessageIdScope>,
) -> Result<i64, AppError> {
    let (login, _) = analysis_login_and_master_keys(env).await.context(h!())?;
    let store = RedisSessionStore::new(
        crate::redis_conn_string(&env.config).context(h!())?,
    )
    .await
    .c(h!())?;
    let app = actix_test::init_service(
        App::new()
            .app_data(Data::from(env.clone()))
            .app_data(Data::new(scope.cloned()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route(
                "/test/aor-login/{login}",
                web::post().to(activity_daily_test_login),
            )
            .route(
                "/test/aor-count",
                web::post().to(analytics_aor_count_for_test),
            ),
    )
    .await;
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("/test/aor-login/{login}"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/test/aor-count")
            .cookie(cookie)
            .set_json(req)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(actix_test::read_body_json(response).await)
}

async fn analytics_aor_count_for_test(
    req: Json<AnalysisStatsReq>,
    user: Identity,
    env: Data<Env>,
    scope: Data<Option<AnalyticsMessageIdScope>>,
) -> Result<Json<i64>, AppError> {
    let login = login_id_from_identity(&user).context(h!())?;
    let master_keys = get_identity_sigint_groups(&env.dbx, &login)
        .await
        .context(h!())?;
    let count = stats::count_aors_raw_with_db(
        &req,
        &user,
        &env.dbx,
        &env.dbx,
        master_keys,
        scope.get_ref().as_ref(),
        None,
    )
    .await
    .context(h!())?;
    Ok(Json(count))
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
    assert!(statement.sql.find("UNION ALL").is_some());
    assert!(statement.sql.find("COUNT(DISTINCT network_id)").is_some());
    assert!(statement.sql.find("SELECT DISTINCT").is_none());
    assert!(statement.sql.find("WITH ").is_none());
    assert!(statement.sql.find("FROM \"login\"").is_none());
    assert!(statement.sql.find("JOIN \"login\"").is_none());
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
        master_keys.clone(),
    )?;
    let statement = query.build(DbBackend::Postgres);
    assert!(statement.sql.find("COUNT(DISTINCT").is_some());
    assert!(statement.sql.find("owner_organism_id").is_none());
    assert!(statement.sql.find("FROM \"login\"").is_none());
    assert!(statement.sql.find("JOIN \"login\"").is_none());
    let expected = query
        .into_model::<AnalyticsCountQueryResult>()
        .one(&env.dbx)
        .await
        .context(h!())?
        .map(|result| result.count)
        .unwrap_or(0);
    let actual = stats::count_tags_analytics_with_db(
        &Json(req.clone()),
        &login_id,
        &env.dbx,
        &env.dbx,
        master_keys,
        &tag_access,
        Some(&AnalyticsMessageIdScope::From(0)),
        None,
    )
    .await
    .context(h!())?;
    assert_eq!(actual, expected);
    Ok(actual)
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

async fn fetch_callsign_page_for_req(
    env: &Arc<Env>,
    req: AnalysisCallsignPageReq,
) -> Result<AnalysisCallsignPageRsp, AppError> {
    let (login, master_keys) =
        analysis_login_and_master_keys(env).await.context(h!())?;
    Ok(stats::fetch_callsigns_page_for_login(
        &req,
        &login,
        &env.dbx,
        master_keys,
    )
    .await
    .context(h!())?)
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

async fn fetch_bounded_metadata_stats_for_req(
    env: &Arc<Env>,
    req: &AnalysisStatsReq,
) -> Result<MetadataStatsRsp, AppError> {
    let (login, master_keys) = analysis_login_and_master_keys(env).await?;
    stats::fetch_metadata_stats_with_db(
        req,
        &login,
        &env.dbx,
        master_keys,
        Some(&AnalyticsMessageIdScope::From(0)),
    )
    .await
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
    let callsigns =
        serde_json::from_value::<Vec<String>>(callsigns).context(h!())?;
    let actor_id = crate::users::system_login_id(db).await.context(h!())?;
    crate::inbox::callsigns::sync(
        db,
        inbox_item.id,
        inbox_item.id_uuid,
        crate::inbox::callsigns::InboxItemCallsigns {
            primary: callsigns,
            alg2: Vec::new(),
        },
        actor_id,
    )
    .await
    .context(h!())?;
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

async fn set_message_population_times(
    db: &DatabaseConnection,
    signal_message_id: i64,
    created_at: NaiveDateTime,
    interception_datetime: NaiveDateTime,
) -> Result<(), AppError> {
    let signal_message = signal_message::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut signal_message = signal_message.into_active_model();
    signal_message.created_at = Set(created_at);
    signal_message.update(db).await.context(h!())?;

    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(db)
        .await
        .context(h!())?
        .context(h!())?;
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.datetime = Set(Some(interception_datetime));
    inbox_item.date = Set(Some(interception_datetime.date().to_string()));
    inbox_item.time = Set(Some(
        interception_datetime.time().format("%H:%M:%S").to_string(),
    ));
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

    assert!(str::contains(&sql, "NOT EXISTS"));
    assert!(!str::contains(&sql, "sender_id"));
    assert!(!str::contains(&sql, "sender_name"));
}

#[test]
fn postgres_tags_query_filters_inbox_ids_before_joining_result_tags() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["unit".to_string()]);
    req.without_model_tags = Some(true);
    let login_id = uuid::Uuid::nil();
    let query = stats::build_tags_query(
        &req,
        &login_id,
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = DbBackend::Postgres.build(&query).sql;
    assert!(
        sql.starts_with("WITH \"matching_unit_network_ids\""),
        "{sql}"
    );
    assert!(
        str::contains(&sql, ", \"matching_unit_inbox_item_ids\" AS"),
        "{sql}"
    );
    assert_eq!(str::matches(&sql, "MATERIALIZED").count(), 3, "{sql}");
    assert!(str::contains(&sql, " UNION ALL "), "{sql}");
    assert!(
        str::contains(&sql, ", \"filtered_inbox_items\" AS"),
        "{sql}"
    );
    assert!(str::contains(&sql, "MATERIALIZED ("));
    let filtered_ids_start = sql
        .find("IN (SELECT \"filtered_inbox_items\".\"id\"")
        .expect("missing materialized inbox-ID reference");
    let filtered_ids_sql = &sql[filtered_ids_start..];

    assert!(str::contains(
        &sql,
        "FROM \"sigint_inbox_item_tag\" INNER JOIN \"tag\""
    ));
    assert!(!str::contains(
        filtered_ids_sql,
        "JOIN \"sigint_inbox_item_tag\""
    ));
    assert!(
        !str::contains(filtered_ids_sql, "\"selected_unit_inbox_network\""),
        "{filtered_ids_sql}"
    );
    assert_eq!(
        str::matches(&sql, "\"sigint_inbox_item_tag\".\"model\" IS NULL")
            .count(),
        0
    );
}

#[test]
fn analytics_tags_query_keeps_flat_result_tag_join() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["unit".to_string()]);
    let login_id = uuid::Uuid::nil();
    let query = stats::build_tags_analytics_filtered_query(
        &req,
        &login_id,
        &[1],
        &[],
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "INNER JOIN \"sigint_inbox_item_tag\""));
    assert!(!str::contains(&sql, "WITH \"filtered_inbox_items\""));
    assert!(!str::contains(&sql, "WITH \"matching_unit_network_ids\""));
    assert!(!str::contains(
        &sql,
        "WITH \"matching_unit_inbox_item_ids\""
    ));
    assert!(
        str::contains(&sql, "\"selected_unit_inbox_network\""),
        "{sql}"
    );
}

#[test]
fn analytics_tags_selected_networks_use_flat_joins() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let query = stats::build_tags_analytics_filtered_query(
        &req,
        &uuid::Uuid::nil(),
        &[1],
        &[],
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(
        str::contains(
            &sql,
            "INNER JOIN \"sigint_inbox_item_network\" AS \
             \"analytics_network_filter_link\""
        ),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "INNER JOIN \"sigint_network\" AS \"analytics_network_filter\""
        ),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "\"analytics_network_filter_link\".\"sigint_network_id\" IN (1, 2)"
        ),
        "{sql}"
    );
    assert!(!str::contains(&sql, "\"iin_network_filter\""), "{sql}");
}

#[test]
fn postgres_tags_selected_networks_keep_correlated_filter() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let query = stats::build_tags_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = query.to_string(PostgresQueryBuilder);

    assert!(str::contains(&sql, "\"iin_network_filter\""), "{sql}");
    assert!(
        !str::contains(&sql, "\"analytics_network_filter_link\""),
        "{sql}"
    );
}

#[test]
fn analytics_freqs_selected_networks_use_scoped_flat_joins() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let query = stats::build_freqs_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        Some(&scope),
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(
        str::contains(
            &sql,
            "INNER JOIN \"sigint_inbox_item_network\" AS \
             \"analytics_network_filter_link\""
        ),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "\"analytics_network_filter_link\".\"sigint_network_id\" IN (1, 2)"
        ),
        "{sql}"
    );
    assert!(str::contains(
        &sql,
        "\"sigint_inbox_item\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"signal_message\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"analytics_message_access\".\"signal_message_id\" BETWEEN 10 AND 20"
    ));
    assert!(!str::contains(&sql, "\"iin_network_filter\""), "{sql}");
}

#[test]
fn postgres_freqs_selected_networks_keep_correlated_filter() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let query = stats::build_freqs_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "\"iin_network_filter\""), "{sql}");
    assert!(
        !str::contains(&sql, "\"analytics_network_filter_link\""),
        "{sql}"
    );
}

#[test]
fn analytics_groups_selected_networks_use_scoped_flat_joins() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let query = stats::build_groups_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        Some(&scope),
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(
        &sql,
        "INNER JOIN \"sigint_inbox_item_network\" AS \
         \"analytics_network_filter_link\""
    ));
    assert!(str::contains(
        &sql,
        "\"analytics_network_filter_link\".\"sigint_network_id\" IN (1, 2)"
    ));
    assert!(str::contains(
        &sql,
        "\"sigint_inbox_item\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"signal_message\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"signal_message_group\".\"signal_message_id\" BETWEEN 10 AND 20"
    ));
    assert!(!str::contains(&sql, "\"iin_network_filter\""), "{sql}");
}

#[test]
fn analytics_groups_selected_units_use_network_link_join() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["5 ЗВА".to_string()]);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let resolved = crate::rer_importer::analysis::analytics_unit::ResolvedAnalyticsUnitFilters {
        selected: crate::rer_importer::analysis::analytics_unit::ResolvedAnalyticsUnitFilter {
            ordinary_names: vec!["5 ЗВА".to_string()],
            includes_undefined: false,
            linked_network_ids: vec![7, 8],
            present: true,
        },
        ..Default::default()
    };
    let query = stats::build_groups_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        Some(&scope),
        Some(&resolved),
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "message_network_link"), "{sql}");
    assert!(str::contains(&sql, "analytics_selected_unit_link"), "{sql}");
    assert!(!str::contains(&sql, "matching_unit_network_ids"), "{sql}");
    assert!(!str::contains(&sql, "ANY($1::text[])"), "{sql}");
}

#[test]
fn postgres_groups_selected_networks_keep_correlated_filter() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let query = stats::build_groups_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        None,
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "\"iin_network_filter\""), "{sql}");
    assert!(
        !str::contains(&sql, "\"analytics_network_filter_link\""),
        "{sql}"
    );
}

#[test]
fn analytics_networks_query_scopes_both_union_arms() {
    let req = mk_analysis_stats_req(0, 1);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let statement = stats::build_networks_analytics_query_with_scope(
        &req,
        &uuid::Uuid::nil(),
        &[],
        &[],
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        false,
        Some(&scope),
        None,
    )
    .unwrap();
    let sql = statement.sql;

    assert!(str::contains(&sql, "UNION ALL"), "{sql}");
    assert!(
        str::matches(&sql, "\"sigint_inbox_item\".\"id\" BETWEEN 10 AND 20")
            .count()
            >= 2,
        "{sql}"
    );
    assert!(
        str::matches(&sql, "\"signal_message\".\"id\" BETWEEN 10 AND 20")
            .count()
            >= 2,
        "{sql}"
    );
    assert!(
        str::matches(
            &sql,
            "\"signal_message_group\".\"signal_message_id\" BETWEEN 10 AND 20"
        )
        .count()
            >= 2,
        "{sql}"
    );
    assert!(str::contains(
        &sql,
        "\"analytics_linked_network_link\".\"sigint_inbox_item_id\" \
         BETWEEN 10 AND 20"
    ));
    assert!(
        str::contains(
            &sql,
            "\"echo_clickhouse_derived\".\"message_network_link\" \
             AS \"analytics_linked_network_link\""
        ),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "JOIN \"signal_group\" AS \"analytics_frequency_group\""
        ),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "JOIN \"sigint_network_freq\" AS \
             \"analytics_frequency_network_freq\" ON"
        ),
        "{sql}"
    );
    assert!(
        !str::contains(&sql, "JOIN (SELECT \"sigint_network_freq\""),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "JOIN \"signal_group\" AS \"analytics_linked_group\""
        ),
        "{sql}"
    );
    assert!(
        !str::contains(&sql, "JOIN (SELECT \"signal_group\""),
        "{sql}"
    );
}

#[test]
fn analytics_group_activity_query_is_bounded_and_aggregated() {
    let scope = AnalyticsMessageIdScope::From(10);
    let query = stats::build_group_activity_stats_query(
        vec!["group".to_string()],
        test_dt(2026, 1, 7, 0, 0),
        test_dt(2026, 1, 1, 0, 0),
        &scope,
    );
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "COUNT(*) FILTER (WHERE"), "{sql}");
    assert!(
        str::contains(&sql, "\"sigint_inbox_item\".\"id\" >= 10"),
        "{sql}"
    );
    assert!(
        str::contains(&sql, "\"signal_message\".\"id\" >= 10"),
        "{sql}"
    );
    assert!(
        str::contains(
            &sql,
            "\"signal_message_group\".\"signal_message_id\" >= 10"
        ),
        "{sql}"
    );
}

#[test]
fn analytics_senders_selected_networks_use_scoped_flat_joins() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let query = stats::build_sender_breakdown_query(
        &Json(req),
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        Some(&scope),
        None,
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(
        &sql,
        "INNER JOIN \"sigint_inbox_item_network\" AS \
         \"analytics_network_filter_link\""
    ));
    assert!(str::contains(
        &sql,
        "\"analytics_network_filter_link\".\"sigint_network_id\" IN (1, 2)"
    ));
    assert!(str::contains(
        &sql,
        "\"sigint_inbox_item\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"signal_message\".\"id\" BETWEEN 10 AND 20"
    ));
    assert!(str::contains(
        &sql,
        "\"signal_message_group\".\"signal_message_id\" BETWEEN 10 AND 20"
    ));
    assert!(!str::contains(&sql, "\"iin_network_filter\""), "{sql}");
    assert!(
        !str::contains(&sql, "FROM \"signal_message_group\""),
        "{sql}"
    );
}

#[test]
fn postgres_senders_selected_networks_keep_correlated_filter() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_networks = Some(vec![1, 2]);
    let query = stats::build_sender_breakdown_query(
        &Json(req),
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
        None,
        None,
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(str::contains(&sql, "\"iin_network_filter\""), "{sql}");
    assert!(
        !str::contains(&sql, "\"analytics_network_filter_link\""),
        "{sql}"
    );
    assert!(
        !str::contains(&sql, "FROM \"signal_message_group\""),
        "{sql}"
    );
}

#[test]
fn postgres_senders_creation_breakdown_qualifies_created_at() {
    let mut req = mk_analysis_stats_req(0, 86_400_000);
    req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    let query = stats::build_sender_breakdown_query(
        &Json(req),
        &uuid::Uuid::nil(),
        test_dt(1970, 1, 1, 0, 0),
        test_dt(1970, 1, 2, 0, 0),
        vec!["group".to_string()],
        None,
        None,
        None,
    )
    .unwrap();
    let sql = query.build(DbBackend::Postgres).to_string();

    assert!(
        sql.contains(r#""signal_message"."created_at" AT TIME ZONE"#),
        "{sql}"
    );
    assert!(!sql.contains("(created_at AT TIME ZONE"), "{sql}");
}

#[test]
fn postgres_tags_exact_unit_query_only_uses_linked_candidates() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["unit".to_string()]);
    req.units_exact_match_only = Some(true);
    let query = stats::build_tags_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(2026, 1, 1, 0, 0),
        test_dt(2026, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = DbBackend::Postgres.build(&query).sql;
    let matching_ids_start = sql
        .find("\"matching_unit_inbox_item_ids\" AS")
        .expect("missing matching inbox-ID CTE");
    let filtered_ids_start = sql
        .find(", \"filtered_inbox_items\" AS")
        .expect("missing filtered inbox-ID CTE");
    let matching_ids_sql = &sql[matching_ids_start..filtered_ids_start];

    assert!(
        str::contains(matching_ids_sql, "\"selected_linked_unit_inbox_item\""),
        "{matching_ids_sql}"
    );
    assert!(
        !str::contains(matching_ids_sql, "\"selected_header_unit_inbox_item\""),
        "{matching_ids_sql}"
    );
    assert!(
        !str::contains(matching_ids_sql, "UNION ALL"),
        "{matching_ids_sql}"
    );
}

#[test]
fn postgres_tags_creation_unit_query_uses_creation_bounds() {
    let mut req = mk_analysis_stats_req(0, 86_400_000);
    req.selected_units = Some(vec!["unit".to_string()]);
    req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    let query = stats::build_tags_query(
        &req,
        &uuid::Uuid::nil(),
        test_dt(1970, 1, 1, 0, 0),
        test_dt(1970, 1, 2, 0, 0),
        vec!["group".to_string()],
    )
    .unwrap();
    let sql = DbBackend::Postgres.build(&query).sql;

    assert!(sql.contains("selected_header_unit_signal_message"), "{sql}");
    assert!(sql.contains("selected_linked_unit_signal_message"), "{sql}");
    assert!(sql.contains("created_at"), "{sql}");
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
async fn analysis_search_modes_match_case_insensitively_in_counts_and_inbox_3780(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let login = find_test_login(&fixture.env.dbx).await.unwrap();
    let mut ids = Vec::new();
    for (index, text) in
        ["нора", "НОРА!", "панорама", "норма", "нормальний", "норою"]
            .into_iter()
            .enumerate()
    {
        ids.push(
            mk_analysis_message(
                &fixture.env.dbx,
                text,
                "155.2750",
                test_dt(2026, 3, 1, 10, index as u32),
                &[&fixture.alpha],
                &[],
                false,
            )
            .await
            .unwrap()
            .id,
        );
    }
    for (mode, expected_indexes) in [
        (None, vec![0, 1, 3, 4, 5]),
        (Some(AnalysisSearchMode::Fuzzy), vec![0, 1, 3, 4, 5]),
        (Some(AnalysisSearchMode::Exact), vec![0, 1]),
        (Some(AnalysisSearchMode::Substring), vec![0, 1, 2]),
    ] {
        let mut req = analysis_stats_req0(&fixture);
        req.search = Some("НоРа".into());
        req.search_mode = mode;
        assert_eq!(
            fetch_selected_count_for_req(&fixture.env, &req)
                .await
                .unwrap(),
            expected_indexes.len() as i64,
            "{mode:?}"
        );
        let inbox_req = InboxMessagesReq {
            since_date_inclusive_ms: Some(req.since_date_inclusive_ms),
            till_date_inclusive_ms: Some(req.till_date_noninclusive_ms - 1),
            search: req.search.clone(),
            search_mode: mode,
            selected_groups: Some(vec![fixture
                .alpha
                .signal_group
                .master_key
                .clone()]),
            ..Default::default()
        };
        let actual = inbox_map_item_ids(&fixture.env, &login.id, &inbox_req)
            .await
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        let expected = expected_indexes
            .iter()
            .map(|index| ids[*index])
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(actual, expected, "{mode:?}");
    }
    let mut req = analysis_stats_req0(&fixture);
    req.search_mode = Some(AnalysisSearchMode::Exact);
    for (query, expected) in
        [("нора -панорама", 2), ("нора or норма", 3), ("\"нора\"", 2)]
    {
        req.search = Some(query.into());
        assert_eq!(
            fetch_selected_count_for_req(&fixture.env, &req)
                .await
                .unwrap(),
            expected,
            "{query}"
        );
    }
}

#[tokio::test]
#[serial]
async fn analysis_search_highlights_follow_selected_mode_3780() {
    use crate::rer_importer::highlight::ContentNode;

    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let login = find_test_login(&fixture.env.dbx).await.unwrap();
    let text =
        "🙂 НоРа,НОРА! норою панорама норма БА123З foo_bar fooXbar 100% 1000";
    let mut ids = Vec::new();
    for body in [text, "панорама"] {
        ids.push(
            mk_analysis_message(
                &fixture.env.dbx,
                body,
                "155.2750",
                test_dt(2026, 3, 1, 10, 0),
                &[&fixture.alpha],
                &[],
                false,
            )
            .await
            .unwrap()
            .id,
        );
    }
    for (mode, query, expected) in [
        (None, "НоРа", vec!["НоРа", "НОРА", "норою"]),
        (
            Some(AnalysisSearchMode::Exact),
            "НоРа",
            vec!["НоРа", "НОРА"],
        ),
        (
            Some(AnalysisSearchMode::Exact),
            "\"НоРа\"",
            vec!["НоРа", "НОРА"],
        ),
        (
            Some(AnalysisSearchMode::Exact),
            "НоРа or absent -норою",
            vec!["НоРа", "НОРА"],
        ),
        (
            Some(AnalysisSearchMode::Substring),
            "НоРа",
            vec!["НоРа", "НОРА", "нора"],
        ),
        (
            Some(AnalysisSearchMode::Substring),
            "\"НоРа\"",
            vec!["НоРа", "НОРА", "нора"],
        ),
        (
            Some(AnalysisSearchMode::Substring),
            "НоРа or absent -норма",
            vec!["НоРа", "НОРА", "нора"],
        ),
        (Some(AnalysisSearchMode::Exact), "\"БА%З\"", vec!["БА123З"]),
        (
            Some(AnalysisSearchMode::Substring),
            "\"БА%З\"",
            vec!["БА123З"],
        ),
        (
            Some(AnalysisSearchMode::Substring),
            "foo_bar",
            vec!["foo_bar"],
        ),
        (Some(AnalysisSearchMode::Substring), "100%", vec!["100%"]),
    ] {
        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
            till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms - 1),
            selected_groups: Some(vec![fixture
                .alpha
                .signal_group
                .master_key
                .clone()]),
            search: Some(query.into()),
            search_mode: mode,
            highlight_searchres: Some(true),
            ..Default::default()
        };
        let messages = crate::rer_importer::inbox::get_inbox_messages(
            &login.id,
            &vec![login.id],
            &fixture.env,
            &req,
        )
        .await
        .unwrap();
        assert!(
            messages.iter().any(|(id, _)| *id == ids[0]),
            "{mode:?}: {query}"
        );
        if mode == Some(AnalysisSearchMode::Substring) && expected.len() == 3 {
            assert!(messages.iter().any(|(id, _)| *id == ids[1]), "{query}");
        }
        for (id, message) in messages {
            let highlights = message
                .text_marked
                .unwrap()
                .into_iter()
                .filter_map(|node| match node {
                    ContentNode::CNHighlightC(highlight) => Some(highlight),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let actual = highlights
                .iter()
                .map(|highlight| highlight.text.as_str())
                .collect::<Vec<_>>();
            if id == ids[0] {
                assert_eq!(actual, expected, "{mode:?}: {query}");
            } else if id == ids[1] {
                assert_eq!(mode, Some(AnalysisSearchMode::Substring));
                assert_eq!(actual, vec!["нора"]);
                assert_eq!((highlights[0].begin, highlights[0].end), (2, 6));
            }
            for highlight in highlights {
                assert_eq!(
                    message
                        .text
                        .chars()
                        .skip(highlight.begin)
                        .take(highlight.end - highlight.begin)
                        .collect::<String>(),
                    highlight.text,
                );
            }
        }
    }
}

async fn seed_search_pagination_messages(
    fixture: &RerAnalysisFixture,
    login: &uuid::Uuid,
    tag_id: i64,
) {
    let db = &fixture.env.dbx;
    for index in 0..27 {
        let datetime = test_dt(2026, 3, 1, 10, index % 3);
        let message = mk_analysis_message(
            db,
            &format!("Береза pagination {index}"),
            "155.2750",
            datetime,
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            tag_id: Set(tag_id),
            confidence: Set(1.0),
            login_id: Set(Some(*login)),
            model: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        mk_sigint_inbox_item_metadata(
            db,
            sigint_inbox_item_metadata::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                color_code: Set(Some("7".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if index == 26 {
            signal_message::Entity::update_many()
                .col_expr(signal_message::Column::Deleted, Expr::value(true))
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(db)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
#[serial]
async fn postgres_search_pages_preserve_filters_details_and_cursors_3780() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let tag = mk_tag(
        db,
        tag::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    seed_search_pagination_messages(&fixture, &login.id, tag.id).await;
    for sort_by in [
        InboxMessagesSortBy::IMSDatetime,
        InboxMessagesSortBy::IMSTimestamp,
        InboxMessagesSortBy::IMSCreatedAt,
    ] {
        for newest_first in [false, true] {
            let mut req = InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(2026, 3, 1, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
                ),
                search: Some("Берез".into()),
                search_mode: None,
                selected_groups: Some(vec![fixture
                    .alpha
                    .signal_group
                    .master_key
                    .clone()]),
                selected_freqs: Some(vec!["155.2750".into()]),
                selected_tags: Some(vec![tag.id]),
                metadata_cc: Some(vec!["7".into()]),
                without_model_tags: Some(true),
                sort_by: Some(sort_by),
                newest_first: Some(newest_first),
                ..Default::default()
            };
            let mut first_ids = Vec::new();
            for page_index in 0..2 {
                let expected =
                    inbox_map_item_ids(&fixture.env, &login.id, &req).await;
                let messages = crate::rer_importer::inbox::get_inbox_messages(
                    &login.id,
                    &vec![login.id],
                    &fixture.env,
                    &req,
                )
                .await
                .unwrap();
                let ids =
                    messages.iter().map(|(id, _)| *id).collect::<Vec<_>>();
                assert_eq!(ids, expected);
                let tail = crate::rer_importer::inbox::query::load_postgres_fresh_tail_inbox_candidates(
                    db,
                    &login.id,
                    &fixture.env,
                    &req,
                    test_dt(2026, 3, 1, 9, 0),
                )
                .await
                .unwrap();
                assert_eq!(tail, expected);
                let tail_query = crate::rer_importer::inbox::query::build_postgres_fresh_tail_inbox_digest_query(
                    &login.id,
                    &fixture.env,
                    &req,
                    test_dt(2026, 3, 1, 9, 0),
                )
                .await
                .unwrap();
                let tail = db
                    .query_one_raw(Statement::from_string(
                        DbBackend::Postgres,
                        tail_query,
                    ))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    tail.try_get::<i64>("", "count").unwrap(),
                    if page_index == 0 { 26 } else { 6 }
                );
                assert_eq!(
                    messages.len(),
                    if page_index == 0 {
                        INBOX_MESSAGES_PAGE_LIMIT
                    } else {
                        6
                    }
                );
                assert!(messages
                    .iter()
                    .all(|(_, message)| message.tags == Some(vec![tag.id])
                        && message.metadata.len() == 1));
                if page_index == 0 {
                    first_ids = ids.clone();
                    if newest_first {
                        req.before_id_noninclusive = ids.last().copied();
                    } else {
                        req.since_id_noninclusive = ids.last().copied();
                    }
                } else {
                    assert!(ids.iter().all(|id| !first_ids.contains(id)));
                }
            }
        }
    }
}

#[tokio::test]
#[serial]
async fn fresh_tail_candidates_read_the_tail_by_id_4153() {
    use crate::rer_importer::inbox::query::{
        build_postgres_fresh_tail_inbox_candidate_query,
        load_postgres_fresh_tail_inbox_candidates,
    };
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    // Later than anything in the test dump, so the tail holds only these messages.
    let tail_start = test_dt(2030, 3, 1, 10, 0);
    let mut fresh = Vec::new();
    for (minutes, label) in
        [(-60, "Береза"), (1, "Береза"), (2, "Береза"), (3, "Дуб")]
    {
        let message = mk_analysis_message(
            db,
            label,
            "155.2750",
            tail_start + chrono::Duration::minutes(minutes),
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        if minutes > 0 && label == "Береза" {
            fresh.push(message.id);
        }
    }
    let mut req = InboxMessagesReq {
        since_date_inclusive_ms: Some(
            test_dt(2030, 2, 1, 0, 0).and_utc().timestamp_millis(),
        ),
        till_date_inclusive_ms: Some(
            test_dt(2030, 3, 2, 0, 0).and_utc().timestamp_millis(),
        ),
        search: Some("Берез".into()),
        selected_groups: Some(vec![fixture
            .alpha
            .signal_group
            .master_key
            .clone()]),
        sort_by: Some(InboxMessagesSortBy::IMSDatetime),
        newest_first: Some(true),
        ..Default::default()
    };
    let query = build_postgres_fresh_tail_inbox_candidate_query(
        db,
        &login.id,
        &fixture.env,
        &req,
        tail_start,
    )
    .await
    .unwrap()
    .unwrap();
    // The month-long scan only narrows when the inbox item itself is limited.
    let sql = query.build(DbBackend::Postgres).to_string();
    assert!(sql.contains(r#""sigint_inbox_item"."id" IN ("#), "{sql}");
    let mut ids = load_postgres_fresh_tail_inbox_candidates(
        db,
        &login.id,
        &fixture.env,
        &req,
        tail_start,
    )
    .await
    .unwrap();
    ids.sort();
    assert_eq!(ids, fresh);
    // Nothing created since the bound: no query at all.
    assert!(build_postgres_fresh_tail_inbox_candidate_query(
        db,
        &login.id,
        &fixture.env,
        &req,
        tail_start + chrono::Duration::days(1),
    )
    .await
    .unwrap()
    .is_none());
    // Without a date range the query starts from signal_message, where the
    // created_at bound is already indexed, so it is left as it was.
    req.since_date_inclusive_ms = None;
    req.till_date_inclusive_ms = None;
    let sql = build_postgres_fresh_tail_inbox_candidate_query(
        db,
        &login.id,
        &fixture.env,
        &req,
        tail_start,
    )
    .await
    .unwrap()
    .unwrap()
    .build(DbBackend::Postgres)
    .to_string();
    assert!(!sql.contains(r#""sigint_inbox_item"."id" IN ("#), "{sql}");
}

#[tokio::test]
#[serial]
async fn indexed_fuzzy_inbox_pages_preserve_full_period_matches_3780() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let tag = mk_tag(db, Default::default()).await.unwrap();
    seed_search_pagination_messages(&fixture, &login.id, tag.id).await;
    let unit = mk_sigint_unit(db, Default::default()).await.unwrap();
    let date = test_dt(2026, 3, 1, 10, 0);
    let attachments = seed_fresh_tail_search_messages_3780(
        &fixture,
        [unit.id, unit.id],
        date,
    )
    .await;
    let audio = seed_full_period_audio_search_3780(&fixture, date).await;
    for (group, datetime) in [
        (&fixture.secret_hidden, date),
        (&fixture.alpha, date - chrono::Duration::days(16)),
    ] {
        mk_analysis_message(
            db,
            "Береза",
            "155.2750",
            datetime,
            &[group],
            &[],
            false,
        )
        .await
        .unwrap();
    }
    for newest in [false, true] {
        for (search, count) in [
            ("Берез", 31),
            ("\"Береза\"", 31),
            ("коридор", 1),
            ("absent3780", 0),
        ] {
            let mut req = InboxMessagesReq {
                since_date_inclusive_ms: Some(
                    test_dt(2026, 3, 1, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(2026, 3, 16, 0, 0).and_utc().timestamp_millis(),
                ),
                search: Some(search.into()),
                newest_first: Some(newest),
                ..Default::default()
            };
            let reference = inbox_map_item_ids(
                &fixture.env,
                &login.id,
                &InboxMessagesReq {
                    nolimit: Some(true),
                    ..req.clone()
                },
            )
            .await;
            assert_eq!(reference.len(), count, "{search}");
            if search == "Берез" {
                assert!(reference.contains(&attachments[1]));
                assert!(reference.contains(&attachments[3]));
                assert!(!reference.contains(&attachments[4]));
                assert!(reference.contains(&audio));
            }
            for page in 0..2 {
                let transaction = crate::read_query::begin(db).await.unwrap();
                let ids = crate::rer_importer::inbox::query::load_postgres_inbox_page_ids(
                    &transaction,
                    &login.id,
                    &fixture.env,
                    &req,
                    None,
                )
                .await
                .unwrap();
                transaction.commit().await.unwrap();
                let expected = reference
                    .iter()
                    .copied()
                    .skip(page * INBOX_MESSAGES_PAGE_LIMIT)
                    .take(INBOX_MESSAGES_PAGE_LIMIT)
                    .collect::<Vec<_>>();
                assert_eq!(
                    ids, expected,
                    "{search}, newest={newest}, page={page}"
                );
                let Some(cursor) = ids.last().copied() else {
                    break;
                };
                if newest {
                    req.before_id_noninclusive = Some(cursor);
                } else {
                    req.since_id_noninclusive = Some(cursor);
                }
            }
        }
    }
}

async fn seed_fresh_tail_search_messages_3780(
    fixture: &RerAnalysisFixture,
    unit_ids: [i64; 2],
    date: NaiveDateTime,
) -> Vec<i64> {
    let db = &fixture.env.dbx;
    let mut ids = Vec::new();
    for (index, text) in [
        "Береза коридор",
        "Вільха",
        "Береза стара",
        "Вільха вкладення",
        "Вільха застаріла ревізія",
    ]
    .into_iter()
    .enumerate()
    {
        let message = mk_analysis_message(
            db,
            text,
            "155.2750",
            if index == 2 {
                date - chrono::Duration::hours(1)
            } else {
                date
            },
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        ids.push(message.id);
        sigint_inbox_item::Entity::update_many()
            .col_expr(
                sigint_inbox_item::Column::UnitV2,
                Expr::value(if index == 3 {
                    "3780 attachment tail"
                } else {
                    "3780 fresh tail"
                }),
            )
            .filter(sigint_inbox_item::Column::Id.eq(message.id))
            .exec(db)
            .await
            .unwrap();
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(message.id),
            unit_id: Set(unit_ids[usize::from(index == 3)]),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        if matches!(index, 1 | 3 | 4) {
            seed_fresh_tail_search_attachment_3780(db, message.id, index).await;
        }
    }
    ids
}

async fn seed_fresh_tail_search_attachment_3780(
    db: &DatabaseConnection,
    message_id: i64,
    index: usize,
) {
    let media = signal_message_media::ActiveModel {
        id: Set(uuid::Uuid::new_v4()),
        signal_message_id: Set(message_id),
        file_name: Set(Some(
            if index == 1 {
                "Береза.txt"
            } else {
                "content.txt"
            }
            .into(),
        )),
        content_type: Set("text/plain".into()),
        size_bytes: Set(1),
        is_encrypted: Set(true),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    if index == 1 {
        return;
    }
    let revision = uuid::Uuid::new_v4();
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
        WITH document AS (
            UPDATE attachment_document SET revision = $2
            WHERE media_id = $1 RETURNING media_id
        )
        INSERT INTO attachment_chunk
            (media_id, revision, ordinal, member, locator, text, markdown, html)
        SELECT media_id, $3, 0, 'content.txt', '1',
            'Береза зміна позиції', '', '' FROM document
        "#,
        [
            media.id.into(),
            revision.into(),
            if index == 4 {
                uuid::Uuid::new_v4()
            } else {
                revision
            }
            .into(),
        ],
    ))
    .await
    .unwrap();
}

fn fresh_tail_unit_filters_3780(
    unit_ids: [i64; 2],
) -> Vec<(InboxMessagesReq, Vec<usize>)> {
    vec![
        (InboxMessagesReq::default(), vec![0, 1, 3, 4]),
        (
            InboxMessagesReq {
                selected_units: Some(vec!["3780 fresh tail".into()]),
                ..Default::default()
            },
            vec![0, 1, 4],
        ),
        (
            InboxMessagesReq {
                selected_unit_ids: Some(vec![unit_ids[0]]),
                ..Default::default()
            },
            vec![0, 1, 4],
        ),
        (
            InboxMessagesReq {
                selected_units: Some(vec!["3780 fresh tail".into()]),
                selected_unit_ids: Some(vec![unit_ids[1]]),
                ..Default::default()
            },
            vec![0, 1, 3, 4],
        ),
        (
            InboxMessagesReq {
                denied_units: Some(vec!["3780 fresh tail".into()]),
                ..Default::default()
            },
            vec![3],
        ),
        (
            InboxMessagesReq {
                denied_unit_ids: Some(vec![unit_ids[0]]),
                ..Default::default()
            },
            vec![3],
        ),
    ]
}

async fn assert_fresh_tail_search_3780(
    env: &Env,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    date: NaiveDateTime,
    expected: &[i64],
) {
    use crate::rer_importer::inbox::query::{
        build_postgres_fresh_tail_inbox_digest_query,
        load_postgres_fresh_tail_inbox_candidates,
    };

    let db = &env.dbx;
    let cutoff = date - chrono::Duration::minutes(1);
    let actual =
        load_postgres_fresh_tail_inbox_candidates(db, login, env, req, cutoff)
            .await
            .unwrap();
    assert_eq!(actual, expected, "{req:?}");
    let query =
        build_postgres_fresh_tail_inbox_digest_query(login, env, req, cutoff)
            .await
            .unwrap();
    let row = db
        .query_one_raw(Statement::from_string(DbBackend::Postgres, query))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<i64>("", "count").unwrap(),
        expected.len() as i64
    );
    assert_eq!(
        row.try_get::<Option<NaiveDateTime>>("", "first_element_ts")
            .unwrap(),
        (!expected.is_empty()).then_some(date)
    );
}

async fn assert_full_period_search_results_3780(
    fixture: &RerAnalysisFixture,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    mut expected: Vec<i64>,
) {
    let mut actual = inbox_map_item_ids(&fixture.env, login, req).await;
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected, "{req:?}");
    let sql = crate::rer_importer::inbox::query::build_inbox_digest_query(
        login,
        &fixture.env,
        req,
    )
    .await
    .unwrap();
    let row = fixture
        .env
        .dbx
        .query_one_raw(Statement::from_string(DbBackend::Postgres, sql))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<i64>("", "count").unwrap(),
        expected.len() as i64
    );
    let mut stats_req = mk_analysis_stats_req(
        req.since_date_inclusive_ms.unwrap(),
        req.till_date_inclusive_ms.unwrap(),
    );
    stats_req.selected_groups = req.selected_groups.clone();
    stats_req.selected_freqs = req.selected_freqs.clone();
    stats_req.search = req.search.clone();
    stats_req.search_mode = req.search_mode;
    let groups = fetch_group_counts_for_req(&fixture.env, &stats_req)
        .await
        .unwrap();
    assert_eq!(
        groups
            .get(&fixture.alpha.signal_group.master_key)
            .copied()
            .unwrap_or(0),
        expected.len() as i64,
        "{req:?}"
    );
    let sender_counts = fetch_sender_counts_for_req(&fixture.env, &stats_req)
        .await
        .unwrap();
    assert_eq!(
        sender_counts.values().sum::<i64>(),
        expected.len() as i64,
        "{req:?}"
    );
    let freqs = fetch_freq_counts_for_req(&fixture.env, &stats_req)
        .await
        .unwrap();
    assert!(!freqs.is_empty());
    stats_req.selected_freqs = Some(vec!["999.9999".into()]);
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &stats_req)
            .await
            .unwrap(),
        freqs,
        "frequency facet must ignore its own selection: {req:?}"
    );
}

async fn seed_full_period_audio_search_3780(
    fixture: &RerAnalysisFixture,
    date: NaiveDateTime,
) -> i64 {
    let db = &fixture.env.dbx;
    let message = mk_analysis_message(
        db,
        "Аудіозапис",
        "155.2750",
        date,
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
        with source as (
            insert into transcription_source(id, source_key)
            values ($1, '3780-audio/' || $1::text) returning id
        ), audio as (
            insert into signal_message_audio_ref
                (id, signal_message_id, audio_id, transcription_source_id)
            select $1, $2, $1, id from source returning id
        )
        insert into signal_message_audio_search(id, signal_message_id, file_name)
        select id, $2, 'Береза.wav' from audio
        "#,
        [uuid::Uuid::new_v4().into(), message.id.into()],
    ))
    .await
    .unwrap();
    message.id
}

async fn assert_attachment_search_without_inbox_3780(
    fixture: &RerAnalysisFixture,
    login: &uuid::Uuid,
    message: i64,
    date: NaiveDateTime,
) {
    let db = &fixture.env.dbx;
    for body in [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!({"body": null})),
        Some(serde_json::json!({"body": ""})),
    ] {
        sigint_inbox_item::Entity::delete_by_id(message)
            .exec(db)
            .await
            .unwrap();
        if let Some(body) = body {
            crate::functest::tests::mk_sigint_inbox_item(
                db,
                sigint_inbox_item::ActiveModel {
                    id: Set(message),
                    body_noheader: Set(Some(body)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        for sort_by in [
            InboxMessagesSortBy::IMSCreatedAt,
            InboxMessagesSortBy::IMSDatetime,
        ] {
            for search_mode in
                [AnalysisSearchMode::Exact, AnalysisSearchMode::Substring]
            {
                for (search, matches) in [
                    ("\"Береза.txt\"", true),
                    ("-Невідомий", true),
                    ("-Береза", false),
                    ("\"%\"", true),
                    ("-\"%\"", false),
                ] {
                    let req = InboxMessagesReq {
                        since_date_inclusive_ms: (sort_by
                            == InboxMessagesSortBy::IMSCreatedAt)
                            .then_some(date.and_utc().timestamp_millis()),
                        selected_groups: Some(vec![fixture
                            .alpha
                            .signal_group
                            .master_key
                            .clone()]),
                        search: Some(search.into()),
                        search_mode: Some(search_mode),
                        sort_by: Some(sort_by),
                        nolimit: Some(true),
                        load_latest: Some(true),
                        ..Default::default()
                    };
                    assert_optional_inbox_search_result_3780(
                        fixture, login, &req, message, matches,
                    )
                    .await;
                }
            }
        }
    }
}

async fn assert_optional_inbox_search_result_3780(
    fixture: &RerAnalysisFixture,
    login: &uuid::Uuid,
    req: &InboxMessagesReq,
    message: i64,
    matches: bool,
) {
    let actual = inbox_map_item_ids(&fixture.env, login, req).await;
    assert_eq!(actual.contains(&message), matches, "{req:?}");
    let sql = crate::rer_importer::inbox::query::build_inbox_digest_query(
        login,
        &fixture.env,
        req,
    )
    .await
    .unwrap();
    let row = fixture
        .env
        .dbx
        .query_one_raw(Statement::from_string(DbBackend::Postgres, sql))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<i64>("", "count").unwrap(),
        actual.len() as i64,
        "{req:?}"
    );
}

#[tokio::test]
#[serial]
async fn postgres_full_period_search_preserves_pages_counts_and_facets_3780() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let unit = mk_sigint_unit(db, Default::default()).await.unwrap();
    let date = test_dt(2026, 10, 25, 10, 0);
    let ids = seed_fresh_tail_search_messages_3780(
        &fixture,
        [unit.id, unit.id],
        date,
    )
    .await;
    let audio = seed_full_period_audio_search_3780(&fixture, date).await;
    let mut other_frequency = 0;
    for (index, group, datetime, deleted) in [
        (0, &fixture.alpha, date, false),
        (1, &fixture.secret_live, date, false),
        (2, &fixture.alpha, date - chrono::Duration::days(32), false),
        (3, &fixture.alpha, date, true),
    ] {
        let message = mk_analysis_message(
            db,
            "Береза",
            if index == 0 { "155.3000" } else { "155.2750" },
            datetime,
            &[group],
            &[],
            false,
        )
        .await
        .unwrap();
        if deleted {
            signal_message::Entity::update_many()
                .col_expr(signal_message::Column::Deleted, Expr::value(true))
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(db)
                .await
                .unwrap();
        }
        if index == 0 {
            other_frequency = message.id;
        }
    }
    for days in [1, 7, 8, 16, 31] {
        for selected_freqs in [None, Some(vec!["155.2750".into()])] {
            for search_mode in [
                AnalysisSearchMode::Fuzzy,
                AnalysisSearchMode::Exact,
                AnalysisSearchMode::Substring,
            ] {
                for (search, indexes) in [
                    ("Береза", vec![0, 1, 2, 3]),
                    ("Береза or Вільха or Сосна or Клен or Ясен or Дуб or Граб or Тис or Бук or Кедр or Липа or Осика -\"невідоме місце\" -\"відсутня фраза\" -\"немає тексту\" -\"неіснуючий запис\"", vec![0, 1, 2, 3, 4]),
                    ("Береза or Вільха -\"зміна позиції\" -\"відсутня фраза\"", vec![0, 1, 2, 4]),
                    ("-Береза", vec![4]),
                    ("\"зміна позиції\"", vec![3]),
                ] {
                    let req = InboxMessagesReq {
                        since_date_inclusive_ms: Some(
                            (date - chrono::Duration::days(days))
                                .and_utc()
                                .timestamp_millis(),
                        ),
                        till_date_inclusive_ms: Some(
                            (date + chrono::Duration::hours(1))
                                .and_utc()
                                .timestamp_millis(),
                        ),
                        selected_groups: Some(vec![fixture
                            .alpha
                            .signal_group
                            .master_key
                            .clone()]),
                        selected_freqs: selected_freqs.clone(),
                        search: Some(search.into()),
                        search_mode: Some(search_mode),
                        nolimit: Some(true),
                        ..Default::default()
                    };
                    let mut expected = indexes
                        .iter()
                        .map(|index| ids[*index])
                        .collect::<Vec<_>>();
                    if search == "Береза" || search.starts_with("Береза or ") {
                        expected.push(audio);
                    }
                    if selected_freqs.is_none() && (search == "Береза" || search.starts_with("Береза or ")) {
                        expected.push(other_frequency);
                    }
                    assert_full_period_search_results_3780(
                        &fixture, &login.id, &req, expected,
                    )
                    .await;
                }
            }
        }
    }
    assert_attachment_search_without_inbox_3780(
        &fixture, &login.id, ids[1], date,
    )
    .await;
}

#[tokio::test]
#[serial]
async fn postgres_fresh_tail_search_preserves_matches_and_unit_filters_3780() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let unit = mk_sigint_unit(db, Default::default()).await.unwrap();
    let attachment_unit = mk_sigint_unit(db, Default::default()).await.unwrap();
    let date = test_dt(2026, 3, 2, 10, 0);
    let ids = seed_fresh_tail_search_messages_3780(
        &fixture,
        [unit.id, attachment_unit.id],
        date,
    )
    .await;
    for (filters, eligible) in
        fresh_tail_unit_filters_3780([unit.id, attachment_unit.id])
    {
        for search_mode in [
            AnalysisSearchMode::Fuzzy,
            AnalysisSearchMode::Exact,
            AnalysisSearchMode::Substring,
        ] {
            for (search, matches) in [
                ("Береза", vec![0, 1, 3]),
                ("-Береза", vec![4]),
                ("Береза or Вільха", vec![0, 1, 3, 4]),
                ("155.275 Береза", vec![0, 1, 3]),
                ("\"Береза\" -відсутній", vec![0, 1, 3]),
                ("\"зміна позиції\"", vec![3]),
            ] {
                let req = InboxMessagesReq {
                    since_date_inclusive_ms: Some(
                        (date - chrono::Duration::hours(2))
                            .and_utc()
                            .timestamp_millis(),
                    ),
                    till_date_inclusive_ms: Some(
                        (date + chrono::Duration::days(1))
                            .and_utc()
                            .timestamp_millis(),
                    ),
                    search: Some(search.into()),
                    search_mode: Some(search_mode),
                    nolimit: Some(true),
                    ..filters.clone()
                };
                let expected = matches
                    .into_iter()
                    .filter(|index| eligible.contains(index))
                    .map(|index| ids[index])
                    .collect::<Vec<_>>();
                let mut full_period =
                    inbox_map_item_ids(&fixture.env, &login.id, &req).await;
                full_period.retain(|id| *id != ids[2]);
                assert_eq!(full_period, expected, "{search_mode:?}: {search}");
                for sort_by in [
                    InboxMessagesSortBy::IMSDatetime,
                    InboxMessagesSortBy::IMSCreatedAt,
                ] {
                    let req = InboxMessagesReq {
                        sort_by: Some(sort_by),
                        ..req.clone()
                    };
                    assert_fresh_tail_search_3780(
                        &fixture.env,
                        &login.id,
                        &req,
                        date,
                        &expected,
                    )
                    .await;
                }
            }
        }
    }
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
async fn rer_analysis_facets_ignore_their_own_selected_values() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let req = analysis_stats_req0(&fixture);

    let groups = fetch_group_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let mut selected_req = req.clone();
    selected_req.selected_groups =
        groups.keys().next().cloned().map(|group| vec![group]);
    assert_eq!(
        fetch_group_counts_for_req(&fixture.env, &selected_req)
            .await
            .unwrap(),
        groups
    );

    let sender_values = fetch_sender_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let mut selected_req = req.clone();
    selected_req.selected_senders = sender_values
        .keys()
        .next()
        .cloned()
        .map(|sender| vec![sender]);
    assert_eq!(
        fetch_sender_counts_for_req(&fixture.env, &selected_req)
            .await
            .unwrap(),
        sender_values
    );

    let freqs = fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap();
    let mut selected_req = req;
    selected_req.selected_freqs =
        freqs.keys().next().cloned().map(|freq| vec![freq]);
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &selected_req)
            .await
            .unwrap(),
        freqs
    );
}

#[tokio::test]
#[serial]
async fn collect_group_names_prefers_signal_group_over_whatsapp_name() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let alpha_key = fixture.alpha.signal_group.master_key.clone();
    let beta_key = fixture.beta.signal_group.master_key.clone();
    let unresolved_key = "whatsapp-only-group-master-key".to_string();
    let alpha_signal_name = fixture.alpha.signal_group.name.clone().unwrap();
    let whatsapp_only_name = "Whatsapp Only Group".to_string();

    whatsapp_group::Entity::delete_many()
        .filter(whatsapp_group::Column::Jid.eq_any(vec![
            alpha_key.clone(),
            beta_key.clone(),
            unresolved_key.clone(),
        ]))
        .exec(&fixture.env.dbx)
        .await
        .unwrap();

    whatsapp_group::ActiveModel {
        jid: Set(alpha_key.clone()),
        owner_jid: Set(None),
        name: Set("Stale Whatsapp Group".to_string()),
        created_at: Set(test_dt(2026, 3, 1, 7, 0)),
        deleted: Set(false),
    }
    .insert(&fixture.env.dbx)
    .await
    .unwrap();
    whatsapp_group::ActiveModel {
        jid: Set(unresolved_key.clone()),
        owner_jid: Set(None),
        name: Set(whatsapp_only_name.clone()),
        created_at: Set(test_dt(2026, 3, 1, 7, 0)),
        deleted: Set(false),
    }
    .insert(&fixture.env.dbx)
    .await
    .unwrap();

    let groups = vec![
        AnalysisStatsGroup {
            master_key: alpha_key.clone(),
            count: 3,
        },
        AnalysisStatsGroup {
            master_key: beta_key,
            count: 4,
        },
        AnalysisStatsGroup {
            master_key: unresolved_key.clone(),
            count: 1,
        },
    ];
    let group_names = collect_group_names(&groups, &fixture.env, false, None)
        .await
        .unwrap();

    let alpha_names = group_names
        .iter()
        .filter(|group| group.master_key == alpha_key)
        .map(|group| group.name.clone())
        .collect::<Vec<_>>();
    let unresolved_names = group_names
        .iter()
        .filter(|group| group.master_key == unresolved_key)
        .map(|group| group.name.clone())
        .collect::<Vec<_>>();

    assert_eq!(alpha_names, vec![alpha_signal_name]);
    assert_eq!(unresolved_names, vec![whatsapp_only_name]);
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
async fn analytics_aor_membership_preserves_union_counts_and_cursors_3780() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    for (index, (groups, networks)) in [
        (vec![&fixture.group_x], vec![]),
        (vec![&fixture.group_y], vec![fixture.network_k.network.id]),
        (
            vec![&fixture.group_x, &fixture.group_y],
            vec![fixture.network_k.network.id, fixture.network_l.network.id],
        ),
        (vec![&fixture.group_y], vec![fixture.network_l.network.id]),
        (vec![&fixture.group_y], vec![]),
    ]
    .into_iter()
    .enumerate()
    {
        mk_analysis_message(
            db,
            &format!("membership-{index}"),
            "901.3",
            test_dt(2026, 3, 2, 10, index as u32),
            &groups,
            &networks,
            false,
        )
        .await
        .unwrap();
    }
    let login = crate::users::login_id_by_name(db, "Tester").await.unwrap();
    let mut req = InboxMessagesReq {
        since_date_inclusive_ms: Some(
            test_dt(2026, 3, 1, 0, 0).and_utc().timestamp_millis(),
        ),
        till_date_inclusive_ms: Some(
            test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
        ),
        selected_aors: Some(vec![fixture.aor_a.id]),
        nolimit: Some(true),
        ..Default::default()
    };
    for selected_group in
        [None, Some(fixture.group_y.signal_group.master_key.clone())]
    {
        req.selected_groups = selected_group.map(|group| vec![group]);
        let mut expected =
            crate::rer_importer::inbox::query::build_filtered_inbox_query(
                db,
                &login,
                &fixture.env,
                &req,
            )
            .await
            .unwrap()
            .select_only()
            .column(signal_message::Column::Id)
            .into_tuple::<i64>()
            .all(db)
            .await
            .unwrap();
        expected.sort_unstable();
        expected.dedup();
        assert_eq!(
            expected.len(),
            if req.selected_groups.is_some() { 2 } else { 3 }
        );
        let candidates =
            crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login,
                &fixture.env,
                &req,
                db,
                90_000,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidates, expected);
        let digest = crate::rer_importer::inbox::query::build_analytics_inbox_digest_query(&login, &fixture.env, &req, db, 90_000).await.unwrap().unwrap();
        let quantity: i64 = db
            .query_one_raw(Statement::from_string(DbBackend::Postgres, digest))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "count")
            .unwrap();
        assert_eq!(quantity, expected.len() as i64);
        let cursor_req = InboxMessagesReq {
            nolimit: Some(false),
            since_id_noninclusive: Some(expected[0]),
            ..req.clone()
        };
        let candidates =
            crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login,
                &fixture.env,
                &cursor_req,
                db,
                90_000,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidates, expected[1..]);
    }
}

#[tokio::test]
#[serial]
async fn rer_analysis_aor_filter_ignores_orphan_duplicate_group_links() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;

    sigint_zone_datasource::Entity::delete_many()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey.eq(fixture
                .group_x
                .signal_group
                .master_key
                .clone()),
        )
        .exec(db)
        .await
        .unwrap();
    let message = mk_analysis_message(
        db,
        "orphan-duplicate-group-aor",
        "901.3",
        test_dt(2026, 3, 2, 10, 0),
        &[&fixture.group_y, &fixture.group_x],
        &[],
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
        0
    );
    let aor_counts =
        fetch_aor_counts_for_req(&fixture.env, &req).await.unwrap();
    assert_eq!(
        fetch_analytics_aor_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        aor_counts
    );
    assert!(!aor_counts.contains_key(&fixture.aor_a.id));

    let identity = mk_test_identity().await.unwrap();
    let login = test_identity_login_id(&fixture.env, &identity).await;
    let inbox_req = InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_aors: req.selected_aors,
        nolimit: Some(true),
        ..Default::default()
    };
    let message_ids =
        crate::rer_importer::inbox::query::build_filtered_inbox_query(
            db,
            &login,
            &fixture.env,
            &inbox_req,
        )
        .await
        .unwrap()
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .unwrap();
    assert!(!message_ids.contains(&message.id));

    let analytics_message_ids =
        crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
            &login,
            &fixture.env,
            &inbox_req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!analytics_message_ids.contains(&message.id));
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
async fn rer_analysis_without_network_filters_messages_but_not_network_facet() {
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
    let network_counts = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert_eq!(
        network_counts,
        BTreeMap::from([(fixture.network_k.network.id, 1)])
    );

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
    assert_eq!(
        fetch_network_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        network_counts
    );

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
    assert_eq!(
        fetch_network_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        network_counts
    );
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
async fn rer_analysis_peleng_location_filter_does_not_narrow_location_facet() {
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
    let location_counts = fetch_location_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    assert!(location_counts.contains_key("Unrelated Town"));

    req.selected_locations = Some(vec!["Peleng Town".to_string()]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        fetch_location_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        location_counts
    );

    req.include_peleng_locations = Some(true);

    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_location_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        location_counts
    );
}

#[tokio::test]
#[serial]
async fn rer_analysis_location_filter_does_not_narrow_location_facet() {
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
    let location_counts = fetch_location_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();

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
        location_counts
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

async fn seed_note_filter_comments(
    fixture: &RerAnalysisFixture,
) -> (BTreeSet<i64>, BTreeSet<i64>) {
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let system_login_id = crate::users::system_login_id(db).await.unwrap();
    let datetime = test_dt(2026, 3, 1, 10, 5);
    let mut all_note_ids = BTreeSet::new();
    let mut user_note_ids = BTreeSet::new();
    for legacy in [true, false] {
        for authors in [
            vec![system_login_id],
            vec![login.id],
            vec![system_login_id, login.id],
        ] {
            let message = mk_analysis_message(
                db,
                "note-filter-message",
                "940.9",
                datetime,
                &[&fixture.alpha],
                &[],
                false,
            )
            .await
            .unwrap();
            all_note_ids.insert(message.id);
            if authors.contains(&login.id) {
                user_note_ids.insert(message.id);
            }
            for author in authors {
                if legacy {
                    mk_sigint_comment(
                        db,
                        sigint_comment::ActiveModel {
                            signal_message_id: Set(message.id),
                            login_id: Set(author),
                            comment: Set("note".to_string()),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                } else {
                    crate::sigint::comments::create_linked_message_comment_from_ingestion(
                        db,
                        &fixture.env.config,
                        message.id,
                        &author,
                        "note",
                        datetime,
                        None,
                    )
                    .await
                    .unwrap();
                }
            }
        }
    }
    (all_note_ids, user_note_ids)
}

async fn mk_note_filter_parent(
    fixture: &RerAnalysisFixture,
) -> signal_message::Model {
    mk_analysis_message(
        &fixture.env.dbx,
        "note-filter-parent",
        "940.9",
        test_dt(2026, 3, 1, 10, 5),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap()
}

async fn seed_note_filter_sender_authors(
    fixture: &RerAnalysisFixture,
    all_note_ids: &mut BTreeSet<i64>,
    user_note_ids: &mut BTreeSet<i64>,
) {
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let system_login_id = crate::users::system_login_id(db).await.unwrap();
    for (author, sender, system_only) in [
        (None, Some(system_login_id.to_string()), true),
        (None, Some(system_login_id.to_string().to_uppercase()), true),
        (None, Some(system_login_id.simple().to_string()), true),
        (None, Some(system_login_id.braced().to_string()), true),
        (None, Some(system_login_id.urn().to_string()), true),
        (None, Some(login.id.to_string()), false),
        (Some(login.id), Some(system_login_id.to_string()), false),
        (Some(system_login_id), Some(login.id.to_string()), true),
        (None, None, false),
        (None, Some("non-UUID sender".to_string()), false),
    ] {
        let parent = mk_note_filter_parent(fixture).await;
        let child = crate::sigint::comments::create_linked_message_comment_from_ingestion(
            db,
            &fixture.env.config,
            parent.id,
            &login.id,
            "note",
            test_dt(2026, 3, 1, 10, 5),
            None,
        )
        .await
        .unwrap();
        signal_message::ActiveModel {
            id: Set(child),
            login_id: Set(author),
            sender: Set(sender),
            ..Default::default()
        }
        .update(db)
        .await
        .unwrap();
        all_note_ids.insert(parent.id);
        if !system_only {
            user_note_ids.insert(parent.id);
        }
    }
}

async fn seed_note_filter_non_notes(
    fixture: &RerAnalysisFixture,
) -> BTreeSet<i64> {
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let parent = mk_note_filter_parent(fixture).await;
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            signal_message_id: Set(parent.id),
            login_id: Set(login.id),
            comment: Set(String::new()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut ids = BTreeSet::from([parent.id]);
    for (body, deleted, relation_kind) in [
        (Some(""), false, intel_product_filter::RELATION_KIND_COMMENT),
        (None, false, intel_product_filter::RELATION_KIND_COMMENT),
        (
            Some("note"),
            true,
            intel_product_filter::RELATION_KIND_COMMENT,
        ),
        (
            Some("report"),
            false,
            intel_product_filter::RELATION_KIND_REPORT,
        ),
    ] {
        let parent = mk_note_filter_parent(fixture).await;
        ids.insert(parent.id);
        let child = mk_signal_message(
            db,
            signal_message::ActiveModel {
                login_id: Set(Some(login.id)),
                body: Set(body.map(str::to_string)),
                deleted: Set(deleted),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        intel_product::ActiveModel {
            intel_message_id: Set(child.id),
            source_message_id: Set(parent.id),
            relation_kind: Set(relation_kind),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        mk_sigint_comment(
            db,
            sigint_comment::ActiveModel {
                signal_message_id: Set(parent.id),
                login_id: Set(login.id),
                comment: Set("stale migrated note".to_string()),
                migrated_signal_message_id: Set(Some(child.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    ids
}

async fn assert_note_filter_matches(
    fixture: &RerAnalysisFixture,
    request: &InboxMessagesReq,
    candidates: &[i64],
    expected: &BTreeSet<i64>,
) {
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let logins = crate::users::get_organism_login_ids_by_id(db, &login.id)
        .await
        .unwrap();
    for nolimit in [true, false] {
        let request = InboxMessagesReq {
            nolimit: Some(nolimit),
            ..request.clone()
        };
        let messages = crate::rer_importer::inbox::get_inbox_messages(
            &login.id,
            &logins,
            &fixture.env,
            &request,
        )
        .await
        .unwrap();
        assert_eq!(
            messages.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>(),
            *expected,
        );
    }
    let mut stats_request = analysis_stats_req0(fixture);
    stats_request.or_with_extended_form = Some(true);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &stats_request)
            .await
            .unwrap(),
        expected.len() as i64,
    );
    let query =
        crate::rer_importer::inbox::query::build_inbox_query_for_candidate_ids(
            db,
            &login.id,
            &fixture.env,
            request,
            candidates,
            false,
        )
        .await
        .unwrap();
    let matching_ids = db
        .query_all_raw(Statement::from_string(DbBackend::Postgres, query))
        .await
        .unwrap()
        .iter()
        .map(|row| row.try_get_by::<i64, _>("id").unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(matching_ids, *expected);
}

#[tokio::test]
#[serial]
async fn rer_analysis_note_filter_respects_comment_parsing_setting() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let (mut all_note_ids, mut user_note_ids) =
        seed_note_filter_comments(&fixture).await;
    seed_note_filter_sender_authors(
        &fixture,
        &mut all_note_ids,
        &mut user_note_ids,
    )
    .await;
    let mut candidates = seed_note_filter_non_notes(&fixture).await;
    candidates.extend(&all_note_ids);
    let candidates = candidates.into_iter().collect::<Vec<_>>();
    let request = InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        or_with_extended_form: Some(true),
        nolimit: Some(true),
        ..Default::default()
    };
    for (index, (enabled, expected)) in [
        (None, &all_note_ids),
        (Some(true), &user_note_ids),
        (Some(false), &all_note_ids),
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(enabled) = enabled {
            system_settings::ActiveModel {
                sigint_comment_parsing_enabled: Set(enabled),
                updated_at: Set(test_dt(2026, 3, 1, 12, index as u32)),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
        system_settings::ActiveModel {
            sigint_comment_parsing_enabled: Set(enabled != Some(true)),
            deleted: Set(true),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        assert_note_filter_matches(&fixture, &request, &candidates, expected)
            .await;
    }
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
async fn rer_analysis_callsign_page_paginates_full_order_and_escapes_literal_search(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    for (index, callsign) in [
        "PAGER-ALPHA",
        "PAGER-BRAVO",
        "PAGER-CHARLIE",
        "A-PAGER",
        "PAGER",
    ]
    .into_iter()
    .enumerate()
    {
        let message = mk_analysis_message(
            db,
            &format!("callsign-page-{index}"),
            "943.1",
            test_dt(2026, 3, 1, 10, index as u32),
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        set_message_callsigns(db, message.id, serde_json::json!([callsign]))
            .await
            .unwrap();
    }
    let variant = mk_analysis_message(
        db,
        "callsign-page-variant",
        "943.1",
        test_dt(2026, 3, 1, 10, 3),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, variant.id, serde_json::json!(["pager-alpha"]))
        .await
        .unwrap();
    let literal = mk_analysis_message(
        db,
        "callsign-page-literal",
        "943.2",
        test_dt(2026, 3, 1, 10, 9),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_callsigns(db, literal.id, serde_json::json!(["PCT%_\\'"]))
        .await
        .unwrap();

    let mut req = analysis_stats_req0(&fixture);
    req.selected_callsigns = Some(vec!["DOES-NOT-EXIST".to_string()]);
    let page = AnalysisCallsignPageReq {
        req,
        query: "PAGER".to_string(),
        page_size: Some(1),
        cursor: None,
        order: AnalysisCallsignPageOrder::MatchThenName,
    };
    let mut cursor = None;
    let mut first_cursor = None;
    let mut labels = Vec::new();
    let mut alpha = None;
    for _ in 0..5 {
        let current = fetch_callsign_page_for_req(
            &fixture.env,
            AnalysisCallsignPageReq {
                cursor: cursor.clone(),
                ..page.clone()
            },
        )
        .await
        .unwrap();
        let entry = current.entries.into_iter().next().unwrap();
        if entry.label == "PAGER-ALPHA" {
            alpha = Some(entry.clone());
        }
        if labels.is_empty() {
            first_cursor = current.next_cursor.clone();
        }
        labels.push(entry.label);
        cursor = current.next_cursor;
    }
    assert_eq!(
        labels,
        vec![
            "PAGER",
            "A-PAGER",
            "PAGER-ALPHA",
            "PAGER-BRAVO",
            "PAGER-CHARLIE"
        ]
    );
    assert!(cursor.is_none());
    let alpha = alpha.unwrap();
    assert_eq!(alpha.count, 2);
    assert_eq!(
        alpha.values.iter().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from(["PAGER-ALPHA".to_string(), "pager-alpha".to_string()])
    );
    let literal_page = fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            query: "PCT%_\\'".to_string(),
            page_size: Some(50),
            cursor: None,
            ..page.clone()
        },
    )
    .await
    .unwrap();
    assert_eq!(literal_page.entries.len(), 1);
    assert_eq!(literal_page.entries[0].label, "PCT%_\\'");

    for index in 0..101 {
        let message = mk_analysis_message(
            db,
            &format!("callsign-page-size-{index}"),
            "943.3",
            test_dt(2026, 3, 1, 10, 0),
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        set_message_callsigns(
            db,
            message.id,
            serde_json::json!([format!("SIZE-{index:03}")]),
        )
        .await
        .unwrap();
    }
    let size_page = AnalysisCallsignPageReq {
        req: analysis_stats_req0(&fixture),
        query: "SIZE-".to_string(),
        page_size: None,
        cursor: None,
        order: AnalysisCallsignPageOrder::MatchThenName,
    };
    let default_size =
        fetch_callsign_page_for_req(&fixture.env, size_page.clone())
            .await
            .unwrap();
    assert_eq!(default_size.entries.len(), 50);
    assert!(default_size.has_more);
    let max_size = fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            page_size: Some(200),
            ..size_page
        },
    )
    .await
    .unwrap();
    assert_eq!(max_size.entries.len(), 100);
    assert!(max_size.has_more);

    assert!(fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            page_size: Some(2),
            cursor: first_cursor.clone(),
            ..page.clone()
        },
    )
    .await
    .is_err());
    assert!(fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            order: AnalysisCallsignPageOrder::CountDesc,
            cursor: first_cursor.clone(),
            ..page.clone()
        },
    )
    .await
    .is_err());
    assert!(fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            query: "PAGER-BRAVO".to_string(),
            cursor: first_cursor,
            ..page.clone()
        },
    )
    .await
    .is_err());
    for cursor in ["!", "e30"] {
        let error = fetch_callsign_page_for_req(
            &fixture.env,
            AnalysisCallsignPageReq {
                cursor: Some(cursor.to_owned()),
                ..page.clone()
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            crate::error::AppError::Form(errors) if errors.contains_key("cursor")
        ));
    }

    let count_page = AnalysisCallsignPageReq {
        order: AnalysisCallsignPageOrder::CountDesc,
        ..page
    };
    let count_first =
        fetch_callsign_page_for_req(&fixture.env, count_page.clone())
            .await
            .unwrap();
    assert_eq!(count_first.entries[0].label, "PAGER-ALPHA");
    assert_eq!(count_first.entries[0].count, 2);
    assert_eq!(
        count_first.entries[0]
            .values
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["PAGER-ALPHA".to_string(), "pager-alpha".to_string()])
    );
    let count_second = fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            cursor: count_first.next_cursor.clone(),
            ..count_page.clone()
        },
    )
    .await
    .unwrap();
    assert_eq!(count_second.entries[0].label, "A-PAGER");
    assert_eq!(count_second.entries[0].count, 1);
    assert_eq!(count_second.entries[0].values, vec!["A-PAGER"]);

    let mut callsign_facet_changed = count_page;
    callsign_facet_changed.req.selected_callsigns =
        Some(vec!["DOES-NOT-EXIST".to_string()]);
    let count_second_with_callsign_facet_changed = fetch_callsign_page_for_req(
        &fixture.env,
        AnalysisCallsignPageReq {
            cursor: count_first.next_cursor,
            ..callsign_facet_changed
        },
    )
    .await
    .unwrap();
    assert_eq!(
        count_second_with_callsign_facet_changed.entries[0].label,
        "A-PAGER"
    );
    assert_eq!(
        count_second_with_callsign_facet_changed.entries,
        count_second.entries
    );
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
    let bounded_metadata =
        fetch_bounded_metadata_stats_for_req(&fixture.env, &req)
            .await
            .unwrap();
    let sender_values = metadata_value_counts(metadata.senders);
    let receiver_values = metadata_value_counts(metadata.receivers);
    let bounded_sender_values = metadata_value_counts(bounded_metadata.senders);
    let bounded_receiver_values =
        metadata_value_counts(bounded_metadata.receivers);

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
    assert_eq!(bounded_sender_values, sender_values);
    assert_eq!(bounded_receiver_values, receiver_values);
}

#[tokio::test]
#[serial]
async fn rer_analysis_units_exact_and_undefined_filters_work() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    db.execute_unprepared(
        "CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived; \
         CREATE OR REPLACE VIEW echo_clickhouse_derived.message_network_link AS \
         SELECT sigint_inbox_item_id, sigint_network_id FROM sigint_inbox_item_network",
    ).await.unwrap();
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
        true,
    )
    .await
    .unwrap();
    set_message_unit(db, msg_header_only.id, Some("Header Unit"))
        .await
        .unwrap();

    let msg_unknown = mk_analysis_message(
        db,
        "msg-unit-unknown",
        "944.3",
        test_dt(2026, 3, 2, 10, 8),
        &[&fixture.group_x],
        &[],
        true,
    )
    .await
    .unwrap();
    let unit_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Unit filter tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for message_id in [msg_etalon.id, msg_header_only.id, msg_unknown.id] {
        mk_sigint_inbox_item_tag(
            db,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message_id),
                tag_id: Set(unit_tag.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

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
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
    );

    assert_eq!(
        fetch_analytics_tag_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
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
    assert!(fetch_tag_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());

    assert_eq!(
        fetch_analytics_tag_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
    );
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
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
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
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
    );

    sigint_inbox_item_unit::ActiveModel {
        item_id: Set(msg_etalon.id),
        unit_id: Set(etalon_unit.id),
        kind: Set(SigintInboxItemUnitKind::Network),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    req.selected_unit_ids = Some(vec![etalon_unit.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.1".to_string(), 1), ("944.3".to_string(), 1),])
    );

    assert_eq!(
        fetch_analytics_tag_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        1
    );
    let identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &identity).await;
    let inbox_req = InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_units: req.selected_units,
        selected_unit_ids: req.selected_unit_ids,
        nolimit: Some(true),
        ..Default::default()
    };
    let item_ids =
        crate::rer_importer::inbox::query::build_filtered_inbox_query(
            db,
            &login_id,
            &fixture.env,
            &inbox_req,
        )
        .await
        .unwrap()
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .collect::<BTreeSet<_>>();
    assert!(item_ids.contains(&msg_etalon.id));
    assert!(item_ids.contains(&msg_unknown.id));
    assert!(!item_ids.contains(&msg_header_only.id));

    for (selected, denied, ids, exact) in [
        (Some("Header Unit"), None, None, false),
        (Some("Header Unit"), None, None, true),
        (Some("Etalon Unit"), None, None, true),
        (Some("Не визначено"), None, None, false),
        (
            Some("Не визначено"),
            None,
            Some(vec![etalon_unit.id]),
            false,
        ),
        (None, Some("Etalon Unit"), None, false),
        (None, Some("Не визначено"), None, false),
    ] {
        let req = InboxMessagesReq {
            selected_units: selected.map(|value| vec![value.to_string()]),
            denied_units: denied.map(|value| vec![value.to_string()]),
            selected_unit_ids: ids,
            units_exact_match_only: Some(exact),
            ..inbox_req.clone()
        };
        let expected =
            crate::rer_importer::inbox::query::build_filtered_inbox_query(
                db,
                &login_id,
                &fixture.env,
                &req,
            )
            .await
            .unwrap()
            .select_only()
            .column(signal_message::Column::Id)
            .into_tuple::<i64>()
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let actual =
            crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login_id,
                &fixture.env,
                &req,
                db,
                90_000,
            )
            .await
            .unwrap()
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual, expected,
            "selected={selected:?} denied={denied:?} exact={exact}"
        );
    }
}

#[tokio::test]
#[serial]
async fn rer_analysis_legacy_unit_filters_follow_message_time_basis() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    db.execute_unprepared(
        "CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived; \
         CREATE OR REPLACE VIEW echo_clickhouse_derived.message_network_link AS \
         SELECT sigint_inbox_item_id, sigint_network_id FROM sigint_inbox_item_network",
    )
    .await
    .unwrap();
    let login_id = crate::users::login_id_by_name(db, "Tester").await.unwrap();
    let linked_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Creation linked unit".to_string()),
            created_by_login_id: Set(login_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let linked_network = mk_network_fixture(
        db,
        "Creation linked network",
        "945.1",
        fixture.aor_a.id,
        fixture.created_at,
    )
    .await
    .unwrap();
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(linked_network.network.id),
            unit_id: Set(linked_unit.id),
            created_at: Set(fixture.created_at),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let inside = test_dt(2026, 3, 2, 8, 5);
    let outside = test_dt(2026, 3, 2, 9, 5);
    let header_creation = mk_analysis_message(
        db,
        "creation-header-inside",
        "945.2",
        inside,
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, header_creation.id, Some("Creation header unit"))
        .await
        .unwrap();
    set_message_population_times(db, header_creation.id, inside, outside)
        .await
        .unwrap();
    let header_interception = mk_analysis_message(
        db,
        "interception-header-inside",
        "945.3",
        inside,
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, header_interception.id, Some("Creation header unit"))
        .await
        .unwrap();
    set_message_population_times(db, header_interception.id, outside, inside)
        .await
        .unwrap();

    let linked_creation = mk_analysis_message(
        db,
        "creation-linked-inside",
        "945.1",
        inside,
        &[&fixture.group_x],
        &[linked_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, linked_creation.id, Some("Header noise"))
        .await
        .unwrap();
    set_message_population_times(db, linked_creation.id, inside, outside)
        .await
        .unwrap();
    let linked_interception = mk_analysis_message(
        db,
        "interception-linked-inside",
        "945.1",
        inside,
        &[&fixture.group_x],
        &[linked_network.network.id],
        false,
    )
    .await
    .unwrap();
    set_message_unit(db, linked_interception.id, Some("Header noise"))
        .await
        .unwrap();
    set_message_population_times(db, linked_interception.id, outside, inside)
        .await
        .unwrap();

    let unit_tag = mk_tag(
        db,
        tag::ActiveModel {
            label: Set("Creation unit boundary tag".to_string()),
            enabled: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for message_id in [
        header_creation.id,
        header_interception.id,
        linked_creation.id,
        linked_interception.id,
    ] {
        mk_sigint_inbox_item_tag(
            db,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message_id),
                tag_id: Set(unit_tag.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    let mut header_req = analysis_stats_req_for_aor_fixture(&fixture);
    header_req.selected_units = Some(vec!["Creation header unit".to_string()]);
    header_req.units_exact_match_only = Some(false);
    header_req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        BTreeMap::from([("945.2".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
    );

    header_req.message_time_basis = None;
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        BTreeMap::from([("945.3".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &header_req)
            .await
            .unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
    );

    let mut linked_req = analysis_stats_req_for_aor_fixture(&fixture);
    linked_req.selected_units = Some(vec!["Creation linked unit".to_string()]);
    linked_req.units_exact_match_only = Some(true);
    linked_req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        BTreeMap::from([("945.1".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
    );

    linked_req.message_time_basis = None;
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        BTreeMap::from([("945.1".to_string(), 1)])
    );
    assert_eq!(
        fetch_tag_counts_for_req(&fixture.env, &linked_req)
            .await
            .unwrap(),
        BTreeMap::from([(unit_tag.id, 1)])
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
async fn rer_analysis_unit_id_filter_keeps_same_name_units_distinct() {
    let fixture = mk_aor_filter_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let created_by_login_id =
        crate::users::login_id_by_name(db, "Tester").await.unwrap();
    let first_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Duplicate unit name".to_string()),
            created_by_login_id: Set(created_by_login_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Duplicate unit name".to_string()),
            created_by_login_id: Set(created_by_login_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let first_message = mk_analysis_message(
        db,
        "msg-unit-id-first",
        "944.51",
        test_dt(2026, 3, 2, 10, 7),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    let second_message = mk_analysis_message(
        db,
        "msg-unit-id-second",
        "944.52",
        test_dt(2026, 3, 2, 10, 8),
        &[&fixture.group_x],
        &[],
        false,
    )
    .await
    .unwrap();
    for (item_id, unit_id) in [
        (first_message.id, first_unit.id),
        (second_message.id, second_unit.id),
    ] {
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(item_id),
            unit_id: Set(unit_id),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    let mut req = analysis_stats_req_for_aor_fixture(&fixture);
    req.selected_unit_ids = Some(vec![first_unit.id]);
    assert_eq!(
        fetch_freq_counts_for_req(&fixture.env, &req).await.unwrap(),
        BTreeMap::from([("944.51".to_string(), 1)])
    );

    req.selected_unit_ids = Some(vec![first_unit.id, second_unit.id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        2
    );

    let test_identity = mk_test_identity().await.unwrap();
    let inbox_req = InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        selected_unit_ids: Some(vec![first_unit.id, second_unit.id]),
        denied_unit_ids: Some(vec![first_unit.id]),
        nolimit: Some(true),
        ..Default::default()
    };
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let item_ids =
        crate::rer_importer::inbox::query::build_filtered_inbox_query(
            &fixture.env.dbx,
            &login_id,
            &fixture.env,
            &inbox_req,
        )
        .await
        .unwrap()
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .unwrap();
    assert_eq!(item_ids, vec![second_message.id]);

    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::UnitV2,
            Expr::value("Header branch"),
        )
        .filter(sigint_inbox_item::Column::Id.eq(second_message.id))
        .exec(db)
        .await
        .unwrap();
    for (selected_units, selected_unit_ids, denied_unit_ids, expected) in [
        (
            None,
            vec![first_unit.id, second_unit.id],
            Some(vec![first_unit.id]),
            vec![second_message.id],
        ),
        (
            Some(vec!["Header branch".to_string()]),
            vec![first_unit.id],
            None,
            vec![first_message.id, second_message.id],
        ),
        (
            Some(vec![]),
            vec![first_unit.id],
            None,
            vec![first_message.id],
        ),
        (None, vec![-1], None, vec![]),
    ] {
        let inbox_req = InboxMessagesReq {
            selected_units,
            selected_unit_ids: Some(selected_unit_ids),
            denied_unit_ids,
            ..inbox_req.clone()
        };
        let candidates =
            crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login_id,
                &fixture.env,
                &inbox_req,
                db,
                90_000,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidates, expected);
    }

    let first_unit_id = first_unit.id;
    let mut first_unit = first_unit.into_active_model();
    first_unit.deleted = Set(true);
    first_unit.update(db).await.unwrap();
    req.selected_unit_ids = Some(vec![first_unit_id]);
    assert_eq!(
        fetch_selected_count_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        0
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
        true,
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
        true,
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

    let cursor = mk_analysis_message(
        db,
        "msg-unit-filter-cursor",
        "944.5",
        test_dt(2026, 3, 2, 10, 4),
        &[&fixture.group_x],
        &[],
        true,
    )
    .await
    .unwrap();
    let mut cursor: signal_message::ActiveModel = cursor.into();
    cursor.deleted = Set(true);
    let cursor = cursor.update(db).await.unwrap();
    let msg_child = mk_analysis_message(
        db,
        "msg-child-unit",
        "944.6",
        test_dt(2026, 3, 2, 10, 5),
        &[&fixture.group_x],
        &[child_network.network.id],
        true,
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
        true,
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

    let login = test_identity_login_id(&fixture.env, &test_identity).await;
    let digest_req = InboxMessagesReq {
        page_id: Some(RER_DUTY_PAGE_ID.to_string()),
        since_id_noninclusive: Some(cursor.id),
        sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
        selected_units: Some(vec!["2 бат 1 полк".to_string()]),
        units_exact_match_only: Some(false),
        ..Default::default()
    };
    assert_eq!(
        fetch_correlated_inbox_count(&fixture.env, &login, &digest_req).await,
        1
    );
    assert_eq!(
        fetch_correlated_inbox_count(
            &fixture.env,
            &login,
            &InboxMessagesReq {
                units_exact_match_only: Some(true),
                ..digest_req.clone()
            },
        )
        .await,
        0
    );
    assert_eq!(
        fetch_correlated_inbox_count(
            &fixture.env,
            &login,
            &InboxMessagesReq {
                selected_units: None,
                denied_units: Some(vec!["2 бат".to_string()]),
                ..digest_req.clone()
            },
        )
        .await,
        1
    );
    assert_eq!(
        fetch_correlated_inbox_count(
            &fixture.env,
            &login,
            &InboxMessagesReq {
                selected_units: Some(vec!["Не визначено".to_string()]),
                ..digest_req
            },
        )
        .await,
        0
    );
    sigint_inbox_item_unit::ActiveModel {
        item_id: Set(msg_other.id),
        unit_id: Set(other_unit.id),
        kind: Set(SigintInboxItemUnitKind::Parsed),
        created_at: Set(fixture.created_at),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    assert_materialized_unit_counts_3780(
        &fixture.env,
        &login,
        cursor.id,
        other_unit.id,
    )
    .await;
}

async fn assert_materialized_unit_counts_3780(
    env: &Env,
    login: &uuid::Uuid,
    cursor: i64,
    linked_unit: i64,
) {
    for exact in [false, true] {
        for (selected, denied) in [
            (Some(vec!["2 бат 1 полк".into()]), None),
            (None, Some(vec!["2 бат".into()])),
            (Some(vec!["Не визначено".into()]), None),
            (None, Some(vec!["Не визначено".into()])),
            (Some(vec!["2 бат".into(), "Не визначено".into()]), None),
        ] {
            for sort_by in [
                InboxMessagesSortBy::IMSCreatedAt,
                InboxMessagesSortBy::IMSTimestamp,
            ] {
                let req = InboxMessagesReq {
                    page_id: Some(RER_DUTY_PAGE_ID.to_string()),
                    since_id_noninclusive: Some(cursor),
                    sort_by: Some(sort_by),
                    selected_units: selected.clone(),
                    denied_units: denied.clone(),
                    selected_unit_ids: Some(vec![linked_unit]),
                    units_exact_match_only: Some(exact),
                    nolimit: Some(true),
                    ..Default::default()
                };
                let expected =
                    crate::rer_importer::inbox::bl::get_inbox_map_items(
                        login, env, &req,
                    )
                    .await
                    .unwrap()
                    .len() as i64;
                assert_eq!(
                    fetch_correlated_inbox_count(env, login, &req).await,
                    expected
                );
                let sql = crate::rer_importer::inbox::query::build_inbox_digest_query(
                    login, env, &req,
                )
                .await
                .unwrap();
                let count: i64 = env
                    .dbx
                    .query_one_raw(Statement::from_string(
                        DbBackend::Postgres,
                        sql,
                    ))
                    .await
                    .unwrap()
                    .unwrap()
                    .try_get("", "count")
                    .unwrap();
                assert_eq!(count, expected);
            }
        }
    }
}

#[tokio::test]
#[serial]
async fn rer_analysis_unit_filter_does_not_match_child_unit_name_suffix() {
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
        true,
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
        true,
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
    assert!(items.is_empty());

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
    assert_eq!(items.len(), 2);
    assert!(items.iter().any(|item| item.id == msg_child.id));
    assert!(items.iter().any(|item| item.id == msg_other.id));
}

#[tokio::test]
#[serial]
async fn issue_3598_rer_analysis_freq_stats_follow_group_and_network_filters() {
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

    let test_identity = mk_test_identity().await.unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.only_with_network = Some(true);
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
        BTreeMap::from([("333.3".to_string(), 1), ("444.4".to_string(), 1),])
    );
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
fn summary_table_analytics_rows_build_expected_response() {
    let summary = build_summary_table_freq_from_analytics_rows(
        vec![SummaryTableFreqCountRow {
            freq: Some("111.1".to_string()),
            count: 3,
        }],
        vec![SummaryTableFreqValueRow {
            freq: Some("111.1".to_string()),
            value: Some("unit".to_string()),
        }],
        vec![SummaryTableFreqValueRow {
            freq: Some("111.1".to_string()),
            value: Some("|one|two|".to_string()),
        }],
        vec![SummaryTableFreqValueRow {
            freq: Some("111.1".to_string()),
            value: Some("callsign".to_string()),
        }],
        BTreeMap::new(),
    );

    assert_eq!(summary.rows.len(), 1);
    assert_eq!(summary.rows[0].freq, "111.1");
    assert_eq!(summary.rows[0].count, 3);
    assert_eq!(summary.rows[0].units, vec!["unit"]);
    assert_eq!(summary.rows[0].locations, vec!["one", "two"]);
    assert_eq!(summary.rows[0].callsigns, vec!["callsign"]);
}

#[test]
fn summary_table_postgres_unit_filter_is_period_bounded() {
    let mut req = mk_analysis_stats_req(0, 86_400_000);
    req.selected_units = Some(vec!["100 pbr".to_string()]);

    let sql = build_summary_table_filtered_messages_query(
        &uuid::Uuid::nil(),
        &req,
        &["group".to_string()],
    )
    .unwrap()
    .build(DbBackend::Postgres)
    .to_string();

    assert_eq!(sql.matches("MATERIALIZED").count(), 2, "{sql}");
    assert!(sql.contains("matching_unit_network_ids"), "{sql}");
    assert!(sql.contains("matching_unit_inbox_item_ids"), "{sql}");
    assert!(sql.contains("1970-01-01 00:00:00"), "{sql}");
    assert!(sql.contains("1970-01-02 00:00:00"), "{sql}");
}

#[test]
fn summary_table_analytics_unit_filter_uses_bounded_flat_joins() {
    let mut req = mk_analysis_stats_req(0, 86_400_000);
    req.selected_callsigns = Some(vec!["CALLSIGN".to_string()]);
    req.selected_tags = Some(vec![3]);
    req.selected_aors = Some(vec![5]);
    req.selected_networks = Some(vec![7]);
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: 10,
        max_id: 20,
    };
    let tag_access = stats::AnalyticsTagAccess {
        accessible_tag_ids: vec![3],
        unit_login_ids: Vec::new(),
    };
    let filtered_messages =
        build_summary_table_filtered_messages_query_with_access(
            &uuid::Uuid::nil(),
            &req,
            &["group".to_string()],
            Some(&tag_access),
            Some(&scope),
        )
        .unwrap();
    let mut selected =
        analytics_unit::split_analytics_unit_filter(&Some(vec![
            "58 А".to_string(),
            "Не визначено".to_string(),
        ]));
    selected.linked_network_ids = vec![11];
    let filtered_messages =
        analytics_unit::apply_resolved_analytics_unit_filters(
            filtered_messages,
            &analytics_unit::ResolvedAnalyticsUnitFilters {
                selected,
                all_unit_network_ids: vec![11, 12],
                ..Default::default()
            },
            &scope,
            false,
        );
    let sql =
        summary_table_freq_callsigns_query(filtered_messages, Some(&scope))
            .build(DbBackend::Postgres)
            .to_string();

    for bounded_column in [
        r#""sigint_inbox_item"."id" BETWEEN 10 AND 20"#,
        r#""signal_message"."id" BETWEEN 10 AND 20"#,
        r#""analytics_message_access"."signal_message_id" BETWEEN 10 AND 20"#,
        r#""sigint_inbox_item_tag"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""analytics_message_aor_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""analytics_network_filter_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""analytics_selected_unit_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""analytics_any_unit_link"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""new_callsign_filter"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
        r#""summary_table_callsign"."sigint_inbox_item_id" BETWEEN 10 AND 20"#,
    ] {
        assert!(sql.contains(bounded_column), "{bounded_column}: {sql}");
    }
    assert!(sql.contains(r#""unit_v2" IN"#), "{sql}");
    for alias in ["58 А", "58 а", "58 ЗА", "58 за", "58 ЗВА", "58 зва"]
    {
        assert!(sql.contains(&format!("'{alias}'")), "{sql}");
    }
    assert!(sql.contains(r#""unit_v2" IS NULL"#), "{sql}");
    assert!(sql.contains(r#""active_from" <= "datetime""#), "{sql}");
    assert!(sql.contains(r#""active_to" >= "datetime""#), "{sql}");
    assert!(!sql.contains(r#"JOIN "sigint_unit""#), "{sql}");
    assert!(!sql.contains(r#"JOIN "sigint_network_unit""#), "{sql}");
}

#[test]
fn summary_table_analytics_exact_unit_filter_ignores_header_units() {
    let scope = AnalyticsMessageIdScope::From(10);
    let mut selected =
        analytics_unit::split_analytics_unit_filter(&Some(vec![
            "58 А".to_string()
        ]));
    selected.linked_network_ids = vec![11];
    let sql = analytics_unit::apply_resolved_analytics_unit_filters(
        signal_message::Entity::find().join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        ),
        &analytics_unit::ResolvedAnalyticsUnitFilters {
            selected,
            ..Default::default()
        },
        &scope,
        true,
    )
    .build(DbBackend::Postgres)
    .to_string();

    assert!(sql.contains("analytics_selected_unit_link"), "{sql}");
    assert!(!sql.contains(r#""unit_v2" IN"#), "{sql}");
    assert!(!sql.contains(r#"JOIN "sigint_unit""#), "{sql}");
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
            callsign_message_counts: BTreeMap::from([("Zulu".to_string(), 2)]),
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
            callsign_message_counts: BTreeMap::from([
                ("Alpha".to_string(), 1),
                ("Zulu".to_string(), 3),
            ]),
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
    assert_eq!(
        merged.callsign_message_counts,
        BTreeMap::from([("Alpha".to_string(), 1), ("Zulu".to_string(), 5)])
    );
}

#[test]
fn summary_table_callsigns_require_minimum_mentions() {
    let summary_table = SummaryTableFreq {
        rows: vec![SummaryTableFreqRow {
            freq: "111.1".to_string(),
            count: 5,
            callsigns: vec!["Alpha".to_string(), "Zulu".to_string()],
            units: Vec::new(),
            locations: Vec::new(),
            coords: Vec::new(),
            locality_coords: Vec::new(),
        }],
    };
    let callsign_message_counts =
        BTreeMap::from([("Alpha".to_string(), 2), ("Zulu".to_string(), 3)]);

    assert_eq!(
        summary_table_freqs_per_callsign(
            &summary_table,
            &callsign_message_counts,
            Some(RER_SUMMARY_TABLE_CALLSIGN_MIN_MENTIONS),
        ),
        BTreeMap::from([("Zulu".to_string(), vec!["111.1".to_string()])])
    );

    assert_eq!(
        summary_table_freqs_per_callsign(
            &summary_table,
            &callsign_message_counts,
            None,
        ),
        BTreeMap::from([
            ("Alpha".to_string(), vec!["111.1".to_string()]),
            ("Zulu".to_string(), vec!["111.1".to_string()]),
        ])
    );
}

#[test]
fn summary_table_callsign_threshold_is_ignored_for_periods_under_three_days() {
    let short_req = mk_analysis_stats_req(
        0,
        RER_SUMMARY_TABLE_CALLSIGN_THRESHOLD_MIN_PERIOD_MS - 1,
    );
    let three_day_req = mk_analysis_stats_req(
        0,
        RER_SUMMARY_TABLE_CALLSIGN_THRESHOLD_MIN_PERIOD_MS,
    );

    assert_eq!(summary_table_callsign_threshold(&short_req, 5), None);
    assert_eq!(summary_table_callsign_threshold(&three_day_req, 5), Some(5));
}

#[test]
fn summary_table_xlsx_list_cells_summarize_omitted_values() {
    let first = "і".repeat(RER_SUMMARY_TABLE_XLSX_LIST_CHARACTER_LIMIT - 20);
    let values = [&first, "1234567890", "abcdefghij"];

    let text = xlsx_list_cell_text(values);

    assert_eq!(
        text,
        format!("{first}{RER_SUMMARY_TABLE_XLSX_LIST_SEPARATOR}та ще 2 ін.")
    );
    assert!(
        text.chars().count() <= RER_SUMMARY_TABLE_XLSX_LIST_CHARACTER_LIMIT
    );
    assert_eq!(
        xlsx_list_cell_text([
            "x".repeat(RER_SUMMARY_TABLE_XLSX_LIST_CHARACTER_LIMIT + 1)
        ]),
        "та ще 1 ін."
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
        .filter(sigint_inbox_item::Column::Id.eq(geocoded_message.id))
        .exec(db)
        .await
        .unwrap();
    let actor_id = crate::users::system_login_id(db).await.unwrap();
    crate::inbox::callsigns::sync(
        db,
        geocoded_message.id,
        geocoded_message.id_uuid,
        crate::inbox::callsigns::InboxItemCallsigns {
            primary: vec!["Geo".to_string()],
            alg2: Vec::new(),
        },
        actor_id,
    )
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
        chunked.callsign_message_counts,
        single.callsign_message_counts
    );
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
    let date = crate::stats::get_local_date(test_dt(2026, 3, 1, 10, 0));
    req.since_date_inclusive_ms = crate::stats::start_of_day(date)
        .unwrap()
        .and_utc()
        .timestamp_millis();
    req.till_date_noninclusive_ms =
        crate::stats::start_of_day(date + chrono::Duration::days(2))
            .unwrap()
            .and_utc()
            .timestamp_millis();
    let dt_since = dt_from_millis(req.since_date_inclusive_ms).unwrap();
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms).unwrap();
    let stats_redis = crate::stats::redis::GroupStatsRedis::new(
        fixture.env.stats_redis.clone(),
    );
    crate::stats::recalculate_group_stats(
        &fixture.env.dbx,
        &stats_redis,
        dt_since,
        dt_till,
        true,
        true,
    )
    .await
    .unwrap();
    assert!(crate::stats::should_read_stats_aggregated_for_config(
        &req,
        &fixture.env.config,
        dt_since,
        dt_till,
    ));
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

    let matches = stats::count_unit_exact_match_breakdown_for_login(
        &req,
        &test_identity_login_id(&fixture.env, &test_identity).await,
        &fixture.env,
        master_keys.clone(),
    )
    .await
    .unwrap();
    assert_eq!(matches, (7, 0));

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

    let req = analysis_stats_req0(&fixture);
    let expected = fetch_aor_counts_for_req(&fixture.env, &req).await.unwrap();
    let mut selected_req = req;
    selected_req.selected_aors = Some(vec![fixture.south_aor.id]);
    assert_eq!(
        fetch_aor_counts_for_req(&fixture.env, &selected_req)
            .await
            .unwrap(),
        expected
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

    let req = analysis_stats_req0(&fixture);
    let expected = fetch_network_counts_for_req(&fixture.env, &req)
        .await
        .unwrap();
    let mut selected_req = req;
    selected_req.selected_networks =
        Some(vec![fixture.network_south.network.id]);
    assert_eq!(
        fetch_network_counts_for_req(&fixture.env, &selected_req)
            .await
            .unwrap(),
        expected
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

    req.selected_aors = Some(vec![fixture.north_aor.id]);
    assert_eq!(
        fetch_analytics_aor_counts_for_req(&fixture.env, &req)
            .await
            .unwrap(),
        expected
    );
    req.selected_freqs = Some(vec!["888.8".to_string()]);
    req.selected_groups =
        Some(vec![fixture.secret_hidden.signal_group.master_key.clone()]);
    assert!(fetch_analytics_aor_counts_for_req(&fixture.env, &req)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_aor_count_preserves_overlap_posts_and_scope() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let message = mk_analysis_message(
        &fixture.env.dbx,
        "msg-overlapping-aors",
        "999.9",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha, &fixture.beta],
        &[fixture.network_south.network.id],
        false,
    )
    .await
    .unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["999.9".to_string()]);
    let expected =
        BTreeMap::from([(fixture.north_aor.id, 1), (fixture.south_aor.id, 1)]);
    for (posts, expected) in [
        (None, expected.clone()),
        (Some(vec![]), BTreeMap::new()),
        (Some(vec!["".to_string()]), expected),
    ] {
        req.selected_posts = posts;
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
    let post = sigint_post::ActiveModel {
        name: Set("post-3780".to_string()),
        deleted: Set(false),
        created_at: Set(test_dt(2026, 3, 1, 10, 0)),
        ..Default::default()
    }
    .insert(&fixture.env.dbx)
    .await
    .unwrap();
    sigint_inbox_item::ActiveModel {
        id: Set(message.id),
        post_id: Set(Some(post.id)),
        ..Default::default()
    }
    .update(&fixture.env.dbx)
    .await
    .unwrap();
    req.selected_posts = Some(vec![post.name]);
    for (scope, expected) in [
        (AnalyticsMessageIdScope::From(message.id), 2),
        (
            AnalyticsMessageIdScope::Inclusive {
                min_id: message.id,
                max_id: message.id,
            },
            2,
        ),
        (AnalyticsMessageIdScope::From(message.id + 1), 0),
    ] {
        assert_eq!(
            fetch_analytics_aor_count_for_req(&fixture.env, &req, Some(&scope))
                .await
                .unwrap(),
            expected
        );
    }
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_aor_count_preserves_time_and_live_aors() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let created_at = test_dt(2026, 3, 1, 10, 8);
    let intercepted_at = test_dt(2026, 3, 1, 11, 8);
    let message = mk_analysis_message(
        db,
        "msg-aor-time-boundaries",
        "3780.1",
        created_at,
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    sigint_inbox_item::ActiveModel {
        id: Set(message.id),
        datetime: Set(Some(intercepted_at)),
        ..Default::default()
    }
    .update(db)
    .await
    .unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["3780.1".to_string()]);
    let created = created_at.and_utc().timestamp_millis();
    let intercepted = intercepted_at.and_utc().timestamp_millis();
    let creation =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    for (basis, since, till, present) in [
        (None, created, created + 60_000, false),
        (creation, created, created + 60_000, true),
        (None, intercepted, intercepted + 60_000, true),
        (None, intercepted - 60_000, intercepted, false),
        (creation, created - 60_000, created, false),
        (creation, created + 1, created + 60_000, false),
    ] {
        req.message_time_basis = basis;
        req.since_date_inclusive_ms = since;
        req.till_date_noninclusive_ms = till;
        let expected = if present {
            BTreeMap::from([(fixture.north_aor.id, 1)])
        } else {
            BTreeMap::new()
        };
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
}

#[tokio::test]
#[serial]
async fn rer_analysis_analytics_aor_count_excludes_deleted_messages_and_aors() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let message = mk_analysis_message(
        db,
        "msg-aor-deletion",
        "3780.1",
        test_dt(2026, 3, 1, 10, 8),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let mut req = analysis_stats_req0(&fixture);
    req.selected_freqs = Some(vec!["3780.1".to_string()]);
    for (message_deleted, aor_deleted, top_level, present) in [
        (false, true, true, false),
        (false, false, false, false),
        (false, false, true, true),
        (true, false, true, false),
    ] {
        signal_message::ActiveModel {
            id: Set(message.id),
            deleted: Set(message_deleted),
            ..Default::default()
        }
        .update(db)
        .await
        .unwrap();
        area_of_responsibility::ActiveModel {
            id: Set(fixture.north_aor.id),
            deleted: Set(aor_deleted),
            is_top_level: Set(top_level),
            ..Default::default()
        }
        .update(db)
        .await
        .unwrap();
        let expected = if present {
            BTreeMap::from([(fixture.north_aor.id, 1)])
        } else {
            BTreeMap::new()
        };
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
    let cached = crate::stats::read_group_stats_timeline_cached(
        &Data::from(fixture.env.clone()),
        vec![fixture.beta.signal_group.master_key.clone()],
        dt_since,
        dt_till,
    )
    .await
    .unwrap();
    assert_eq!(
        cached[0]
            .points
            .iter()
            .map(|point| point.count)
            .collect::<Vec<_>>(),
        vec![2, 2]
    );
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

    let post = sigint_post::ActiveModel {
        name: Set("Tagged posts 3780".to_string()),
        deleted: Set(false),
        created_at: Set(test_dt(2026, 3, 1, 10, 0)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    sigint_inbox_item::ActiveModel {
        id: Set(message.id),
        post_id: Set(Some(post.id)),
        ..Default::default()
    }
    .update(db)
    .await
    .unwrap();

    // #3780: sender pushdown must preserve ownership and duplicate-row counts.
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            tag_id: Set(public_tag.id),
            login_id: Set(Some(login.id)),
            model: Set(Some("duplicate-association".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (login_id, groups) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();
    let access = stats::resolve_analytics_tag_access(db, &login_id, true)
        .await
        .unwrap();
    let scope = AnalyticsMessageIdScope::From(1);
    for selected in [
        vec![public_tag.id, owner_tag.id],
        vec![public_tag.id, inaccessible_tag.id],
    ] {
        for without_model in [false, true] {
            let mut req = analysis_stats_req0(&fixture);
            req.selected_tags = Some(selected.clone());
            req.filter_tags_option = Some(TagFilterOption::AllTags);
            req.without_model_tags = Some(without_model);
            req.report_tags_only_this_unit = Some(true);
            for scope in [None, Some(&scope)] {
                let mut results = Vec::new();
                for access in [None, Some(&access)] {
                    let query = stats::build_sender_breakdown_query(
                        &Json(req.clone()),
                        &login_id,
                        dt_from_millis(req.since_date_inclusive_ms).unwrap(),
                        dt_from_millis(req.till_date_noninclusive_ms).unwrap(),
                        groups.clone(),
                        scope,
                        None,
                        access,
                    )
                    .unwrap();
                    let count: i64 = db
                        .query_all_raw(query.build(DbBackend::Postgres))
                        .await
                        .unwrap()
                        .iter()
                        .map(|row| row.try_get::<i64>("", "count").unwrap())
                        .sum();
                    results.push(count);
                }
                let mut post_results = Vec::new();
                for access in [None, Some(&access)] {
                    let query = stats::build_posts_query(
                        &&Json(req.clone()),
                        &login_id,
                        groups.clone(),
                        dt_from_millis(req.since_date_inclusive_ms).unwrap(),
                        dt_from_millis(req.till_date_noninclusive_ms).unwrap(),
                        scope,
                        None,
                        access,
                    )
                    .unwrap();
                    let count: i64 = db
                        .query_all_raw(query.build(DbBackend::Postgres))
                        .await
                        .unwrap()
                        .iter()
                        .map(|row| row.try_get::<i64>("", "count").unwrap())
                        .sum();
                    post_results.push(count);
                }
                assert_eq!(post_results, results);
                assert_eq!(results[0], results[1]);
                assert_eq!(
                    results[1],
                    i64::from(selected[1] == owner_tag.id && without_model)
                );
            }
        }
    }
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
    assert!(access
        .accessible_tag_ids
        .as_slice()
        .contains(&public_tag.id));
    assert!(access.accessible_tag_ids.as_slice().contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&other_tag.id));
    assert!(access.unit_login_ids.as_slice().contains(&login.id));
    assert!(access
        .unit_login_ids
        .as_slice()
        .contains(&same_organism_login.id));
    assert!(access.unit_login_ids.as_slice().contains(&deleted_login.id));
    assert!(!access
        .unit_login_ids
        .as_slice()
        .contains(&other_organism_login.id));
    assert!(!access
        .unit_login_ids
        .as_slice()
        .contains(&no_organism_login.id));

    let access =
        stats::resolve_analytics_tag_access(db, &other_organism_login.id, true)
            .await
            .unwrap();
    assert!(access
        .accessible_tag_ids
        .as_slice()
        .contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&owner_tag.id));
    assert!(access.accessible_tag_ids.as_slice().contains(&other_tag.id));
    assert!(access
        .unit_login_ids
        .as_slice()
        .contains(&other_organism_login.id));
    assert!(!access.unit_login_ids.as_slice().contains(&login.id));

    let access =
        stats::resolve_analytics_tag_access(db, &no_organism_login.id, true)
            .await
            .unwrap();
    assert!(access
        .accessible_tag_ids
        .as_slice()
        .contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&other_tag.id));
    assert!(access.unit_login_ids.is_empty());

    let access =
        stats::resolve_analytics_tag_access(db, &deleted_login.id, true)
            .await
            .unwrap();
    assert!(access
        .accessible_tag_ids
        .as_slice()
        .contains(&public_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&owner_tag.id));
    assert!(!access.accessible_tag_ids.as_slice().contains(&other_tag.id));
    assert!(access.unit_login_ids.as_slice().contains(&login.id));

    let mut owner_tag = owner_tag.into_active_model();
    owner_tag.owner_organism_id = Set(Some(other_organism.id));
    let owner_tag = owner_tag.update(db).await.unwrap();
    let access = stats::resolve_analytics_tag_access(db, &login.id, false)
        .await
        .unwrap();
    assert!(!access.accessible_tag_ids.as_slice().contains(&owner_tag.id));
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
    let mut state = short_state(Some(vec!["group-1".to_string()]));
    state.waterfalls.as_mut().unwrap()[0]
        .1
        .units_include_children = Some(true);
    let (id, _reused) = rer_duty_short_state_create_or_reuse(&mut redis, state)
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
    assert_eq!(
        rsp.state.waterfalls.as_ref().unwrap()[0]
            .1
            .units_include_children,
        Some(true)
    );
}

#[tokio::test]
#[serial]
async fn saved_analysis_filter_preserves_descendant_selection_3527() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let env = &fixture.env;
    let login = find_test_login(&env.dbx).await.unwrap();
    let req = analysis_stats_req0(&fixture);
    let unit_filter = AnalysisUnitFilter {
        values: vec!["unit-parent:group:2:6 А".to_string()],
        include_children: true,
    };
    let mut saved_req = serde_json::to_value(req).unwrap();
    saved_req["unit_filter"] = serde_json::to_value(&unit_filter).unwrap();
    let filters: Vec<SavedFilter> = saved_filter_upsert_1(
        sea_orm_active_enums::SigintSavedFilterTypeEnum::Analysis,
        login.id,
        &env.dbx,
        "Descendant filter #3527".to_string(),
        saved_req,
    )
    .await
    .unwrap();
    for filter in &filters {
        sigint_saved_filter::Entity::delete_by_id(filter.id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }
    assert_eq!(filters.len(), 1);
    assert_eq!(filters[0].unit_filter.as_ref(), Some(&unit_filter));
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
        None,
        core::time::Duration::from_secs(1),
        postgres_query,
        "circuit_open",
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
async fn count_stats_analytics_resource_limits_preserve_circuit_3780() {
    for (message, opens_circuit) in [
        ("Code: 241. Query memory limit exceeded (MEMORY_LIMIT_EXCEEDED)", false),
        ("Code: 241. Memory limit (for user) exceeded (MEMORY_LIMIT_EXCEEDED)", false),
        ("Code: 202. Too many simultaneous queries (TOO_MANY_SIMULTANEOUS_QUERIES)", false),
        ("Code: 241. (total) memory limit exceeded (MEMORY_LIMIT_EXCEEDED)", true),
        ("pg_clickhouse: DB::Exception: Query memory limit exceeded: maximum 2 GiB", false),
        ("pg_clickhouse: DB::Exception: Memory limit (for user) exceeded", false),
        ("pg_clickhouse: DB::Exception: Too many simultaneous queries for user echo_gateway", false),
        ("pg_clickhouse: DB::Exception: (total) memory limit exceeded", true),
    ] {
        let retry_state = AtomicU64::new(0);
        let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
        let analytics_query = async {
            Err::<&str, AppError>(anyhow::anyhow!(message).context(h!()).into())
        };
        let response = with_count_stats_analytics_fallback(
            Some(analytics_query),
            None,
            core::time::Duration::from_secs(1),
            async { Ok::<_, AppError>("postgres") },
            "circuit_open",
            Some(retry_attempt),
            core::time::Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(response, "postgres");
        assert_eq!(analytics_retry_attempt(&retry_state).is_none(), opens_circuit);
    }
    assert!(analytics_fallback_needs_capacity(
        "analytics_resource_limit"
    ));
}

fn local_source_rejection_3978() -> AppError {
    anyhow::Error::new(DbErr::Custom(
        crate::config::ANALYSIS_SOURCE_READ_QUEUE_ERROR.into(),
    ))
    .context(h!())
    .into()
}

#[test]
fn analytics_failure_reason_separates_local_source_saturation_3978() {
    assert_eq!(
        analytics_failure_reason(&local_source_rejection_3978(), None),
        "source_saturated"
    );
    let source_timeout = AppError::ServiceUnavailable {
        msg: "source statement timeout".into(),
        retry_after_secs: 1,
    };
    assert_eq!(
        analytics_failure_reason(&source_timeout, None),
        "source_saturated"
    );
    let analytics: AppError = anyhow::anyhow!("analytics unavailable").into();
    assert_eq!(
        analytics_failure_reason(&analytics, None),
        "analytics_error"
    );
}

fn attachment_coverage_error() -> AppError {
    use crate::types::ShortContext;
    let coverage: anyhow::Result<()> =
        Err(crate::attachments::analytics::AttachmentSearchCoverageError)
            .c(h!());
    coverage.c(h!()).unwrap_err().into()
}

#[tokio::test]
async fn count_stats_attachment_coverage_miss_retries_postgres() {
    // 0 is a closed circuit; 1 is an expired cooldown, i.e. a half-open probe.
    for initial_state in [0, 1] {
        let retry_state = AtomicU64::new(initial_state);
        let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
        let postgres_attempts = std::sync::atomic::AtomicUsize::new(0);
        let response = with_count_stats_analytics_fallback(
            Some(async { Err::<&str, AppError>(attachment_coverage_error()) }),
            None,
            core::time::Duration::from_secs(1),
            async {
                postgres_attempts
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok::<_, AppError>("postgres")
            },
            "circuit_open",
            Some(retry_attempt),
            core::time::Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(response, "postgres");
        assert_eq!(
            postgres_attempts.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
    }
}

#[tokio::test]
async fn count_stats_local_source_rejection_keeps_circuit_closed_3978() {
    // 0 is a closed circuit; 1 is an expired cooldown, i.e. a half-open probe.
    for initial_state in [0, 1] {
        let retry_state = AtomicU64::new(initial_state);
        let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
        let postgres_attempts = std::sync::atomic::AtomicUsize::new(0);
        let error = with_count_stats_analytics_fallback(
            Some(async {
                Err::<&str, AppError>(local_source_rejection_3978())
            }),
            None,
            core::time::Duration::from_secs(1),
            async {
                postgres_attempts
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok::<_, AppError>("postgres")
            },
            "circuit_open",
            Some(retry_attempt),
            core::time::Duration::from_secs(30),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            AppError::ServiceUnavailable {
                retry_after_secs: 1,
                ..
            }
        ));
        assert_eq!(
            postgres_attempts.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
    }
}

#[tokio::test]
#[serial]
async fn analytics_read_local_source_rejection_keeps_circuit_closed_3978() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    // One connection holds an uncommitted health view, so the analytics
    // freshness check passes without changing the shared test schema.
    let analytics = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_conn_string(&fixture.env.config),
        1,
    )
    .await
    .unwrap();
    analytics
        .execute_unprepared(
            "BEGIN; CREATE VIEW public.echo_analytics_health AS \
             SELECT true AS singleton, true AS healthy, \
             CURRENT_TIMESTAMP AS checked_at;",
        )
        .await
        .unwrap();
    let mut env = (*fixture.env).clone();
    env.config.analytics = Some(
        serde_json::from_value(serde_json::json!({
            "pg_host":"unused", "pg_user":"unused",
            "pg_password":"unused", "pg_dbname":"unused"
        }))
        .unwrap(),
    );
    env.analytics = Some(crate::types::AnalyticsPool {
        conn: analytics.clone(),
        retry_after_unix_ms_by_operation: Default::default(),
    });
    let operation = "source saturation test 3978";
    let postgres_attempts = std::sync::atomic::AtomicUsize::new(0);

    let error = with_analytics_read_fallback(
        &env,
        operation,
        true,
        |_db| async { Err::<i64, AppError>(local_source_rejection_3978()) },
        |_db| async {
            postgres_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, AppError>(0)
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(error, AppError::ServiceUnavailable { .. }));
    assert_eq!(
        postgres_attempts.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let analytics_value = || {
        with_analytics_read_fallback(
            &env,
            operation,
            true,
            |_db| async { Ok::<_, AppError>(1i64) },
            |_db| async { Ok::<_, AppError>(0i64) },
        )
    };
    assert_eq!(analytics_value().await.unwrap(), 1);

    // A failure of analytics itself still opens the circuit.
    with_analytics_read_fallback(
        &env,
        operation,
        true,
        |_db| async {
            Err::<i64, AppError>(
                anyhow::anyhow!("analytics unavailable").into(),
            )
        },
        |_db| async { Ok::<_, AppError>(0i64) },
    )
    .await
    .unwrap();
    assert_eq!(analytics_value().await.unwrap(), 0);
    analytics.close().await.unwrap();
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
        None,
        core::time::Duration::from_secs(1),
        postgres_query,
        "circuit_open",
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
        None,
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        "unconfigured",
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
    assert!(!analytics_count_request_supported(&req));
    assert!(!analytics_summary_table_request_supported(&req));
    assert!(!analytics_inbox_request_supported(&InboxMessagesReq {
        since_date_inclusive_ms: Some(0),
        or_with_extended_form: Some(true),
        ..Default::default()
    }));

    req.or_with_extended_form = None;
    req.report_tags_only_this_unit = Some(true);
    assert!(analytics_count_request_supported(&req));
}

#[test]
fn creation_time_requests_bypass_interception_scoped_analytics() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);

    assert!(!analytics_count_request_supported(&req));
}

#[test]
fn count_stats_analytics_supports_callsigns_and_text_search() {
    let mut req = mk_analysis_stats_req(0, 1);

    req.search = Some("callsign".to_string());
    assert!(analytics_count_request_supported(&req));

    req.search = None;
    req.selected_callsigns = Some(vec!["ALPHA".to_string()]);
    assert!(analytics_count_request_supported(&req));
}

#[test]
fn count_stats_analytics_supports_unit_filters() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["unit".to_string()]);
    assert!(analytics_count_request_supported(&req));
}

#[test]
fn summary_table_analytics_supports_units_and_text_search() {
    let mut req = mk_analysis_stats_req(0, 1);
    req.selected_units = Some(vec!["unit".to_string()]);
    assert!(analytics_summary_table_request_supported(&req));
    assert!(analytics_count_request_supported(&req));

    req.selected_units = None;
    req.search = Some("message".to_string());
    assert!(analytics_summary_table_request_supported(&req));
}

#[test]
fn analytical_inbox_reads_support_callsigns_and_text_search() {
    let mut req = InboxMessagesReq::default();
    assert!(!analytics_inbox_request_supported(&req));

    req.since_date_inclusive_ms = Some(1);
    assert!(analytics_inbox_request_supported(&req));

    req.since_date_inclusive_ms = None;
    req.since_id_noninclusive = Some(1);
    assert!(analytics_inbox_request_supported(&req));

    req.search = Some("callsign".to_string());
    assert!(analytics_inbox_request_supported(&req));

    req.search = None;
    req.selected_callsigns = Some(vec!["ALPHA".to_string()]);
    assert!(analytics_inbox_request_supported(&req));

    req.only_with_media = Some(true);
    assert!(analytics_inbox_request_supported(&req));
}

#[test]
fn analytical_inbox_reads_support_unit_filters() {
    let mut req = InboxMessagesReq {
        since_date_inclusive_ms: Some(1),
        ..Default::default()
    };
    req.selected_units = Some(vec!["unit".to_string()]);
    assert!(analytics_inbox_request_supported(&req));

    req.selected_units = None;
    req.denied_units = Some(vec!["unit".to_string()]);
    assert!(analytics_inbox_request_supported(&req));
}

#[test]
fn analytical_inbox_candidates_reject_unbounded_and_support_bounded_media_and_nolimit(
) {
    let mut req = InboxMessagesReq::default();
    assert!(!analytics_inbox_candidates_supported(&req));

    req.since_date_inclusive_ms = Some(1);
    assert!(analytics_inbox_candidates_supported(&req));

    req.only_with_media = Some(true);
    assert!(analytics_inbox_candidates_supported(&req));

    req.only_with_media = None;
    req.search = Some("message".to_string());
    assert!(analytics_inbox_candidates_supported(&req));

    req.search = None;
    req.nolimit = Some(true);
    assert!(analytics_inbox_candidates_supported(&req));
    req.since_date_inclusive_ms = None;
    req.load_latest = Some(true);
    assert!(!analytics_inbox_candidates_supported(&req));
}

#[test]
fn analytical_inbox_candidates_support_latest_initial_duty_unit_filters() {
    let req = InboxMessagesReq {
        page_id: Some("rer-duty-neo".to_string()),
        load_latest: Some(true),
        selected_units: Some(vec!["unit".to_string()]),
        ..Default::default()
    };
    assert!(analytics_inbox_candidates_supported(&req));
}

#[tokio::test]
#[serial]
async fn analytics_read_outcome_distinguishes_unconfigured_and_unavailable() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    assert!(fixture.env.analytics.is_none());
    assert_eq!(
        postgres_pool_identity(&fixture.env.dbx),
        postgres_pool_identity(&fixture.env.dbx.clone())
    );

    let result = with_analytics_read_fallback_outcome(
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

    assert_eq!(result.value, "postgres");
    assert_eq!(result.postgres_reason, Some("unconfigured"));
    assert!(result.postgres_fallback_permit.is_none());

    let mut env = (*fixture.env).clone();
    env.config.analytics = Some(AnalyticsConfig {
        pg_host: "unavailable".to_string(),
        pg_port: None,
        pg_user: "unavailable".to_string(),
        pg_password: "unavailable".to_string(),
        pg_dbname: "unavailable".to_string(),
        connect_timeout_ms: None,
        max_connections: None,
        query_timeout_ms: None,
        freshness_max_age_ms: None,
        retry_cooldown_ms: None,
    });
    let result = with_analytics_read_fallback_outcome(
        &env,
        "analytics unavailable fallback test",
        true,
        |_db| async { Ok::<_, AppError>("analytics") },
        |_db| async { Ok::<_, AppError>("postgres") },
    )
    .await
    .unwrap();

    assert_eq!(result.value, "postgres");
    assert_eq!(result.postgres_reason, Some("analytics_unavailable"));
    assert!(result.postgres_fallback_permit.is_some());
}

async fn seed_window_count_messages_3780(fixture: &RerAnalysisFixture) {
    let db = &fixture.env.dbx;
    let tag = mk_tag(db, Default::default()).await.unwrap();
    let july = test_dt(2026, 7, 1, 0, 0);
    let dates = [
        test_dt(2026, 2, 2, 10, 0),
        test_dt(2026, 5, 2, 10, 0),
        july - chrono::Duration::microseconds(1),
        july,
        test_dt(2026, 8, 2, 10, 0),
    ];
    for date in dates {
        let message = mk_analysis_message(
            db,
            "window3780",
            "3780.1",
            date,
            &[&fixture.alpha],
            &[fixture.network_wide.network.id],
            false,
        )
        .await
        .unwrap();
        set_message_population_times(db, message.id, date, date)
            .await
            .unwrap();
        set_message_post(db, message.id, "WindowPost")
            .await
            .unwrap();
        set_message_callsigns(
            db,
            message.id,
            serde_json::json!(["WindowCallsign"]),
        )
        .await
        .unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(message.id),
            tag_id: Set(tag.id),
            confidence: Set(1.0),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
    for (date, group, deleted) in [
        (test_dt(2026, 5, 2, 10, 0), &fixture.secret_live, false),
        (test_dt(2026, 5, 2, 10, 0), &fixture.alpha, true),
        (test_dt(2026, 10, 1, 0, 0), &fixture.alpha, false),
    ] {
        let message = mk_analysis_message(
            db,
            "window3780",
            "3780.1",
            date,
            &[group],
            &[],
            false,
        )
        .await
        .unwrap();
        set_message_population_times(db, message.id, date, date)
            .await
            .unwrap();
        if deleted {
            signal_message::Entity::update_many()
                .col_expr(signal_message::Column::Deleted, Expr::value(true))
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(db)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
#[serial]
async fn analysis_split_count_endpoints_preserve_totals_and_device_authorization(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let (login, _) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();
    set_login_roles(&fixture.env.dbx, login, serde_json::json!(["Rer"])).await;
    let store = RedisSessionStore::new(
        crate::redis_conn_string(&fixture.env.config).unwrap(),
    )
    .await
    .unwrap();
    let app = actix_test::init_service(
        App::new()
            .app_data(Data::from(fixture.env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route(
                "/test/count-login/{login}",
                web::post().to(activity_daily_test_login),
            )
            .service(count_stats)
            .service(message_stats_count)
            .service(unit_match_stats_count)
            .service(group_stats_count)
            .service(sender_stats_count)
            .service(post_stats_count)
            .service(freq_stats_count)
            .service(callsign_stats_count)
            .service(tag_stats_count)
            .service(unit_stats_count)
            .service(location_stats_count)
            .service(aor_stats_count)
            .service(network_stats_count),
    )
    .await;
    let endpoints = [
        "messages",
        "units/matches",
        "groups",
        "senders",
        "posts",
        "freqs",
        "callsigns",
        "tags",
        "units",
        "locations",
        "aors",
        "networks",
    ];
    let mut req = analysis_stats_req0(&fixture);
    req.selected_aors = Some(vec![fixture.north_aor.id]);
    for endpoint in endpoints {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/api/rer/analysis/stats/{endpoint}/count"))
                .set_json(&req)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{endpoint}");
    }
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("/test/count-login/{login}"))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let combined: serde_json::Value = actix_test::call_and_read_body_json(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/rer/analysis/stats/count")
            .cookie(cookie.clone())
            .set_json(&req)
            .to_request(),
    )
    .await;
    for endpoint in endpoints {
        let result: serde_json::Value = actix_test::call_and_read_body_json(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/api/rer/analysis/stats/{endpoint}/count"))
                .cookie(cookie.clone())
                .set_json(&req)
                .to_request(),
        )
        .await;
        let expected = match endpoint {
            "messages" => {
                serde_json::json!({ "count_overall": combined["count_overall"], "count_selected": combined["count_selected"] })
            }
            "units/matches" => {
                serde_json::json!({ "exact_matches_count": combined["units_exact_matches_count"], "non_exact_matches_count": combined["units_non_exact_matches_count"] })
            }
            dimension => combined[format!("{dimension}_count")].clone(),
        };
        assert_eq!(result, expected, "{endpoint}");
    }
    seed_window_count_messages_3780(&fixture).await;
    for mode in [
        AnalysisSearchMode::Fuzzy,
        AnalysisSearchMode::Exact,
        AnalysisSearchMode::Substring,
    ] {
        for basis in [
            None,
            Some(crate::user_settings::MessageTimeBasis::MessageCreation),
        ] {
            let mut baseline = analysis_stats_req0(&fixture);
            baseline.search = Some("window3780".into());
            baseline.search_mode = Some(mode);
            baseline.message_time_basis = basis;
            baseline.selected_groups =
                Some(vec![fixture.alpha.signal_group.master_key.clone()]);
            baseline.since_date_inclusive_ms =
                test_dt(2026, 8, 2, 0, 0).and_utc().timestamp_millis();
            baseline.till_date_noninclusive_ms =
                test_dt(2026, 8, 3, 0, 0).and_utc().timestamp_millis();
            let mut historical = baseline.clone();
            historical.since_date_inclusive_ms =
                test_dt(2026, 1, 1, 0, 0).and_utc().timestamp_millis();
            historical.till_date_noninclusive_ms =
                test_dt(2026, 10, 1, 0, 0).and_utc().timestamp_millis();
            for endpoint in endpoints {
                let uri = format!("/api/rer/analysis/stats/{endpoint}/count");
                let baseline: serde_json::Value =
                    actix_test::call_and_read_body_json(
                        &app,
                        actix_test::TestRequest::post()
                            .uri(&uri)
                            .cookie(cookie.clone())
                            .set_json(&baseline)
                            .to_request(),
                    )
                    .await;
                let result: serde_json::Value =
                    actix_test::call_and_read_body_json(
                        &app,
                        actix_test::TestRequest::post()
                            .uri(&uri)
                            .cookie(cookie.clone())
                            .set_json(&historical)
                            .to_request(),
                    )
                    .await;
                match endpoint {
                    "messages" => assert_eq!(
                        result["count_selected"], 5,
                        "{mode:?}/{basis:?}"
                    ),
                    "units/matches" => {
                        for field in
                            ["exact_matches_count", "non_exact_matches_count"]
                        {
                            assert_eq!(
                                result[field].as_i64().unwrap(),
                                baseline[field].as_i64().unwrap() * 5
                            );
                        }
                    }
                    _ => assert_eq!(
                        result, baseline,
                        "{endpoint}/{mode:?}/{basis:?}"
                    ),
                }
            }
        }
    }
    set_devices_section_enabled(&fixture.env.dbx, true).await;
    req.selected_device_names = Some(vec!["restricted-device".to_string()]);
    for endpoint in endpoints {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/api/rer/analysis/stats/{endpoint}/count"))
                .cookie(cookie.clone())
                .set_json(&req)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{endpoint}");
    }
}

#[tokio::test]
#[serial]
async fn analysis_split_count_fallbacks_share_capacity_and_release_it_between_waves(
) {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let mut env = (*fixture.env).clone();
    env.config.analytics = Some(
        serde_json::from_value(serde_json::json!({
            "pg_host": "unavailable",
            "pg_user": "unavailable",
            "pg_password": "unavailable",
            "pg_dbname": "unavailable"
        }))
        .unwrap(),
    );
    let req = analysis_stats_req0(&fixture);
    let login = uuid::Uuid::new_v4();
    let active = std::sync::atomic::AtomicUsize::new(0);
    let maximum = std::sync::atomic::AtomicUsize::new(0);
    let active = &active;
    let maximum = &maximum;
    let available = ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE.available_permits();
    let load = |request, operation| {
        counts::read_with_fallback(
            &env,
            login,
            request,
            operation,
            |_db| async { panic!("unavailable analytics must not be queried") },
            |db| async move {
                let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(concurrent, Ordering::SeqCst);
                db.execute_unprepared("select pg_sleep(0.02)")
                    .await
                    .c(h!())?;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, AppError>(())
            },
        )
    };
    let (first, second, third) = tokio::join!(
        load(&req, "analysis stats groups count"),
        load(&req, "analysis stats senders count"),
        load(&req, "analysis stats units count"),
    );
    first.unwrap();
    second.unwrap();
    third.unwrap();
    assert_eq!(maximum.load(Ordering::SeqCst), 3);
    assert_eq!(
        ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE.available_permits(),
        available
    );
    maximum.store(0, Ordering::SeqCst);
    let (first, second) = tokio::join!(
        load(&req, "analysis stats groups count"),
        load(&req, "analysis stats groups count"),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    load(&req, "analysis stats networks count").await.unwrap();
    maximum.store(0, Ordering::SeqCst);
    let mut other_req = req.clone();
    other_req.selected_groups = Some(vec!["other-filter".to_string()]);
    let (first, second) = tokio::join!(
        load(&req, "analysis stats groups count"),
        load(&other_req, "analysis stats groups count"),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    maximum.store(0, Ordering::SeqCst);
    let mut postgres_req = other_req.clone();
    postgres_req.search = Some("postgres-only filter".to_string());
    let (first, second, third) = tokio::join!(
        load(&postgres_req, "analysis stats groups count"),
        load(&postgres_req, "analysis stats senders count"),
        load(&postgres_req, "analysis stats units count"),
    );
    first.unwrap();
    second.unwrap();
    third.unwrap();
    assert_eq!(maximum.load(Ordering::SeqCst), 3);
    assert_eq!(
        ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE.available_permits(),
        available
    );
}

#[tokio::test]
#[serial]
async fn analysis_split_postgres_only_count_facets_do_not_block_each_other() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    assert!(fixture.env.analytics.is_none());
    assert!(fixture.env.config.analytics.is_none());
    let req = analysis_stats_req0(&fixture);
    let mut search_req = req.clone();
    search_req.search = Some("postgres-only filter".to_string());
    let mut creation_req = req.clone();
    creation_req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    let login = uuid::Uuid::new_v4();
    let available = ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE.available_permits();

    for (req, needs_capacity) in
        [(req, false), (search_req, false), (creation_req, true)]
    {
        let active = std::sync::atomic::AtomicUsize::new(0);
        let maximum = std::sync::atomic::AtomicUsize::new(0);
        let active = &active;
        let maximum = &maximum;
        let load = |operation| {
            counts::read_with_fallback(
                &fixture.env,
                login,
                &req,
                operation,
                |_db| async {
                    panic!("PostgreSQL-only request used analytics")
                },
                |db| async move {
                    let permits = ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE
                        .available_permits();
                    if needs_capacity {
                        assert!(permits < available);
                    } else {
                        assert_eq!(permits, available);
                    }
                    let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(concurrent, Ordering::SeqCst);
                    db.execute_unprepared("select pg_sleep(0.02)")
                        .await
                        .c(h!())?;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, AppError>(())
                },
            )
        };
        let (first, second, third, fourth) = tokio::join!(
            load("analysis stats groups count"),
            load("analysis stats senders count"),
            load("analysis stats units count"),
            load("analysis stats networks count"),
        );
        first.unwrap();
        second.unwrap();
        third.unwrap();
        fourth.unwrap();
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
        assert_eq!(
            ANALYTICS_POSTGRES_FALLBACK_SEMAPHORE.available_permits(),
            available
        );
    }
}

#[tokio::test]
#[serial]
async fn network_activity_windows_leave_fallback_capacity_for_pages_3780() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let mut env = (*fixture.env).clone();
    env.config.analytics = Some(
        serde_json::from_value(serde_json::json!({
            "pg_host":"unavailable", "pg_user":"unavailable",
            "pg_password":"unavailable", "pg_dbname":"unavailable"
        }))
        .unwrap(),
    );
    let ready = tokio::sync::Barrier::new(3);
    let release = tokio::sync::Notify::new();
    crate::read_query::scope(
        "network-window-capacity-3780".into(),
        vec![crate::read_query::pool_identity(&env.dbx)],
        async {
            crate::read_query::set_login(uuid::Uuid::new_v4());
            let ready = &ready;
            let release = &release;
            let window = || {
                with_analytics_read_fallback(
                    &env,
                    ANALYTICS_NETWORK_ACTIVITY_OPERATION,
                    true,
                    |_db| async { panic!("unavailable analytics was queried") },
                    |db| async move {
                        crate::read_query::connection(&db)
                            .query_one_raw(Statement::from_string(
                                DbBackend::Postgres,
                                "SELECT 42::bigint AS value",
                            ))
                            .await
                            .c(h!())?;
                        let released = release.notified();
                        ready.wait().await;
                        released.await;
                        Ok::<_, AppError>(42i64)
                    },
                )
            };
            let page = async {
                ready.wait().await;
                let result = tokio::time::timeout(
                    core::time::Duration::from_secs(1),
                    with_analytics_read_fallback(
                        &env,
                        "network window concurrent page",
                        true,
                        |_db| async {
                            panic!("unavailable analytics was queried")
                        },
                        |db| async move {
                            let row = crate::read_query::connection(&db)
                                .query_one_raw(Statement::from_string(
                                    DbBackend::Postgres,
                                    "SELECT 42::bigint AS value",
                                ))
                                .await
                                .c(h!())?
                                .c(h!())?;
                            Ok::<_, AppError>(
                                row.try_get::<i64>("", "value").c(h!())?,
                            )
                        },
                    ),
                )
                .await;
                release.notify_waiters();
                result.unwrap().unwrap()
            };
            let (first, second, page) = tokio::join!(window(), window(), page);
            assert_eq!(first.unwrap(), 42);
            assert_eq!(second.unwrap(), 42);
            assert_eq!(page, 42);
        },
    )
    .await;
}

#[test]
fn analysis_split_count_failure_opens_the_circuit_for_later_dimensions() {
    let states = RwLock::new(HashMap::new());
    let groups = analytics_retry_state_for_operation(
        &states,
        "analysis stats groups count",
    );
    analytics_retry_attempt(&groups)
        .unwrap()
        .record_failure(core::time::Duration::from_secs(30));
    let units = analytics_retry_state_for_operation(
        &states,
        "analysis stats units matches count",
    );
    assert!(analytics_retry_attempt(&units).is_none());
    let inbox = analytics_retry_state_for_operation(&states, "analysis inbox");
    assert!(analytics_retry_attempt(&inbox).is_some());
}

#[tokio::test]
async fn count_stats_analytics_timeout_retries_postgres() {
    let analytics_query = std::future::pending::<Result<&str, AppError>>();
    let result = with_count_stats_analytics_fallback(
        Some(analytics_query),
        None,
        core::time::Duration::ZERO,
        async { Ok::<_, AppError>("postgres") },
        "circuit_open",
        None,
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap();

    assert_eq!(result, "postgres");
}

#[tokio::test]
#[serial]
async fn analytics_fallback_maps_capped_postgres_query_to_one_timeout_error() {
    let mut config =
        crate::config::read_config(crate::types::Mode::Test).unwrap();
    config.postgres_runtime = Some(crate::config::PostgresRuntimeConfig {
        search_statement_timeout_ms:
            crate::config::ANALYSIS_SEARCH_STATEMENT_TIMEOUT_MS_DEFAULT,
        search_http_timeout_ms:
            crate::config::ANALYSIS_SEARCH_HTTP_TIMEOUT_MS_DEFAULT,
        statement_timeout_ms: 25,
        report_worker_statement_timeout_ms: 25,
        lock_timeout_ms: 15,
        idle_in_transaction_session_timeout_ms: 50,
    });
    let db = new_pg_runtime_pool_from_config(&config, PgRuntimePoolRole::Web)
        .await
        .unwrap();
    let postgres_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let postgres_attempts_query = postgres_attempts.clone();

    let error = with_count_stats_analytics_fallback(
        Some(async {
            Err::<&str, AppError>(
                anyhow::anyhow!("analytics unavailable").into(),
            )
        }),
        None,
        core::time::Duration::from_secs(1),
        async move {
            postgres_attempts_query
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            db.execute_unprepared("select pg_sleep(2)").await.c(h!())?;
            Ok::<_, AppError>("postgres")
        },
        "circuit_open",
        None,
        core::time::Duration::from_secs(30),
    )
    .await
    .unwrap_err();

    assert_eq!(
        postgres_attempts.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let AppError::ServiceUnavailable {
        msg,
        retry_after_secs,
    } = error
    else {
        panic!("expected PostgreSQL timeout error");
    };
    assert_eq!(retry_after_secs, 1);
    assert!(msg.contains("перевищив допустимий час"));
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
fn analytics_retry_cooldowns_are_scoped_to_operation() {
    let retry_states = RwLock::new(HashMap::new());
    let report_retry_state =
        analytics_retry_state_for_operation(&retry_states, "report");
    let inbox_retry_state =
        analytics_retry_state_for_operation(&retry_states, "inbox");

    analytics_retry_attempt(&report_retry_state)
        .unwrap()
        .record_failure(core::time::Duration::from_secs(30));

    assert!(analytics_retry_attempt(&report_retry_state).is_none());
    assert!(analytics_retry_attempt(&inbox_retry_state).is_some());
    assert!(Arc::ptr_eq(
        &report_retry_state,
        &analytics_retry_state_for_operation(&retry_states, "report")
    ));
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
        None,
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        "circuit_open",
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
        None,
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        "circuit_open",
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

#[tokio::test]
async fn replication_health_failure_releases_half_open_circuit() {
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
    let (postgres_started_tx, postgres_started_rx) =
        tokio::sync::oneshot::channel();
    let (release_postgres_tx, release_postgres_rx) =
        tokio::sync::oneshot::channel();

    let fallback = with_count_stats_analytics_fallback(
        Some(async {
            Err::<&str, AppError>(
                anyhow::Error::new(AnalyticsReplicationHealthError).into(),
            )
        }),
        None,
        core::time::Duration::from_secs(1),
        async {
            let _ = postgres_started_tx.send(());
            let _ = release_postgres_rx.await;
            Ok::<_, AppError>("postgres")
        },
        "circuit_open",
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    );
    let observe_retry_state = async {
        postgres_started_rx.await.unwrap();
        assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
        release_postgres_tx.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(fallback, observe_retry_state);
    let result = result.unwrap();

    assert_eq!(result, "postgres");
    assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
    assert!(analytics_retry_attempt(&retry_state).is_some());
}

#[tokio::test]
async fn analytics_connection_timeout_reopens_half_open_circuit() {
    let config = crate::config::read_config(crate::types::Mode::Test).unwrap();
    let analytics_conn =
        crate::new_pg_pool_from_conn_string_with_max_connections(
            crate::mk_conn_string(&config),
            2,
        )
        .await
        .unwrap();
    assert!(!analytics_pool_is_at_capacity(&analytics_conn));
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();

    let result = with_count_stats_analytics_fallback(
        Some(async {
            Err::<&str, AppError>(
                anyhow::Error::new(DbErr::ConnectionAcquire(
                    ConnAcquireErr::Timeout,
                ))
                .into(),
            )
        }),
        Some(&analytics_conn),
        core::time::Duration::from_secs(1),
        async { Ok::<_, AppError>("postgres") },
        "circuit_open",
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

#[tokio::test]
async fn analytics_pool_saturation_releases_half_open_circuit() {
    let config = crate::config::read_config(crate::types::Mode::Test).unwrap();
    let analytics_conn =
        crate::new_pg_pool_from_conn_string_with_max_connections(
            crate::mk_conn_string(&config),
            1,
        )
        .await
        .unwrap();
    let _connection = analytics_conn
        .get_postgres_connection_pool()
        .acquire()
        .await
        .unwrap();
    assert!(analytics_pool_is_at_capacity(&analytics_conn));
    let retry_state = std::sync::atomic::AtomicU64::new(1);
    let retry_attempt = analytics_retry_attempt(&retry_state).unwrap();
    let (postgres_started_tx, postgres_started_rx) =
        tokio::sync::oneshot::channel();
    let (release_postgres_tx, release_postgres_rx) =
        tokio::sync::oneshot::channel();

    let fallback = with_count_stats_analytics_fallback(
        Some(async {
            Err::<&str, AppError>(
                anyhow::Error::new(DbErr::ConnectionAcquire(
                    ConnAcquireErr::Timeout,
                ))
                .into(),
            )
        }),
        Some(&analytics_conn),
        core::time::Duration::from_secs(1),
        async {
            let _ = postgres_started_tx.send(());
            let _ = release_postgres_rx.await;
            Ok::<_, AppError>("postgres")
        },
        "circuit_open",
        Some(retry_attempt),
        core::time::Duration::from_secs(30),
    );
    let observe_retry_state = async {
        postgres_started_rx.await.unwrap();
        assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
        release_postgres_tx.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(fallback, observe_retry_state);
    let result = result.unwrap();

    assert_eq!(result, "postgres");
    assert_eq!(retry_state.load(std::sync::atomic::Ordering::Acquire), 0);
    assert!(analytics_retry_attempt(&retry_state).is_some());
}

fn callsign_aggregate_test_query(
    selected_freqs: &[String],
) -> Select<signal_message::Entity> {
    signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(sigint_inbox_item::Column::Freq, "freq")
        .column_as(sigint_inbox_item::Column::Datetime, "timestamp")
        .expr_as(
            correlated_freq_is_selected_expr(selected_freqs),
            "selected_freq",
        )
}

#[test]
fn correlated_frequency_query_is_aggregated_for_both_databases() {
    let statement = correlated_freq_callsign_pairs_statement(
        callsign_aggregate_test_query(&["100".to_string()]),
        &["ALPHA".to_string(), "BRAVO".to_string()],
    );
    assert!(statement.sql.contains("SELECT DISTINCT"));
    assert!(statement
        .sql
        .contains("all_callsigns.callsign IN ('ALPHA', 'BRAVO')"));
    assert!(!statement.sql.contains("jsonb_agg"));

    let (analytics_query, callsign_alias) = join_analytics_message_callsign(
        callsign_aggregate_test_query(&["100".to_string()]),
        "test_correlated_callsign",
        None,
    );
    let sql = analytics_query
        .select_only()
        .expr(Expr::col((callsign_alias, Alias::new("callsign"))))
        .distinct()
        .build(DbBackend::Postgres)
        .to_string();
    assert!(
        sql.contains(r#""echo_clickhouse_derived"."message_callsign""#),
        "{sql}"
    );
    assert!(sql.starts_with("SELECT DISTINCT"), "{sql}");
}

#[test]
fn new_callsign_queries_return_only_aggregates() {
    let query = callsign_aggregate_test_query(&["100".to_string()]);
    let current = effective_callsign_values_statement(query.clone());
    let lookback = new_callsign_last_seen_statement(query.clone());

    assert!(current
        .sql
        .contains("SELECT DISTINCT all_callsigns.callsign"));
    assert!(lookback
        .sql
        .contains("MAX(filtered_items.timestamp) AS last_seen"));
    assert!(!current.sql.contains("jsonb_agg(all_callsigns.callsign"));

    let (analytics_query, callsign_alias) =
        join_analytics_message_callsign(query, "test_new_callsign", None);
    let sql = analytics_query
        .select_only()
        .expr(Expr::col((callsign_alias.clone(), Alias::new("callsign"))))
        .expr_as(Expr::cust("MAX(sigint_inbox_item.datetime)"), "last_seen")
        .group_by(Expr::col((callsign_alias, Alias::new("callsign"))))
        .build(DbBackend::Postgres)
        .to_string();
    assert!(
        sql.contains(r#""echo_clickhouse_derived"."message_callsign""#),
        "{sql}"
    );
    assert!(sql.contains("MAX(sigint_inbox_item.datetime)"), "{sql}");

    let selected_callsign_query = filter_selected_callsigns_for_source(
        callsign_aggregate_test_query(&["100".to_string()]),
        &Some(vec!["ALPHA".to_string()]),
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Analytics,
        None,
    )
    .unwrap();
    let (selected_callsign_query, _) = join_analytics_message_callsign(
        selected_callsign_query,
        "test_new_callsign_output",
        None,
    );
    let sql = selected_callsign_query
        .build(DbBackend::Postgres)
        .to_string();
    assert_eq!(
        sql.matches(r#""echo_clickhouse_derived"."message_callsign""#)
            .count(),
        2,
        "{sql}"
    );
    assert!(!sql.contains("EXISTS"), "{sql}");
}

#[test]
fn correlated_and_new_callsign_queries_filter_by_creation_time() {
    let mut req = mk_analysis_stats_req(1_000, 2_000);
    req.message_time_basis =
        Some(crate::user_settings::MessageTimeBasis::MessageCreation);
    let correlated = build_correlated_freq_messages_query(
        &req,
        vec!["group-1".to_string()],
        dt_from_millis(req.since_date_inclusive_ms).unwrap(),
        dt_from_millis(req.till_date_noninclusive_ms).unwrap(),
        None,
    )
    .unwrap()
    .build(DbBackend::Postgres)
    .to_string();
    assert!(
        correlated.contains(r#""signal_message"."created_at""#),
        "{correlated}"
    );
    assert!(
        !correlated.contains(r#""sigint_inbox_item"."datetime" >="#),
        "{correlated}"
    );

    let new_callsigns_sql = build_new_callsign_filtered_items_query(
        &uuid::Uuid::nil(),
        &req,
        req.since_date_inclusive_ms,
        req.till_date_noninclusive_ms,
        ReportPeriodEnd::NonInclusive,
        &["group-1".to_string()],
        &None,
        false,
        crate::inbox::callsigns::EffectiveCallsignSqlSource::Postgres,
        None,
        None,
    )
    .unwrap()
    .build(DbBackend::Postgres)
    .to_string();
    assert!(
        new_callsigns_sql.contains(r#""signal_message"."created_at""#),
        "{new_callsigns_sql}"
    );
    assert!(
        new_callsigns_sql.contains(r#""timestamp""#),
        "{new_callsigns_sql}"
    );
    assert!(
        !new_callsigns_sql.contains(r#""sigint_inbox_item"."datetime" >="#),
        "{new_callsigns_sql}"
    );
}

#[test]
fn new_callsign_thresholds_keep_existing_boundary_semantics() {
    let report_since = test_dt(2026, 2, 1, 0, 0);
    let callsigns = ["exact-24h", "exact-30d", "exact-7d", "never", "recent"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let last_seen = BTreeMap::from([
        (
            "exact-24h".to_string(),
            report_since - chrono::Duration::hours(24),
        ),
        (
            "exact-7d".to_string(),
            report_since - chrono::Duration::days(7),
        ),
        (
            "exact-30d".to_string(),
            report_since - chrono::Duration::days(30),
        ),
        (
            "recent".to_string(),
            report_since - chrono::Duration::hours(1),
        ),
    ]);

    let result = classify_new_callsigns(callsigns, &last_seen, report_since);

    assert_eq!(
        result.not_seen_24h,
        vec!["exact-24h", "exact-30d", "exact-7d", "never"]
    );
    assert_eq!(
        result.not_seen_7days,
        vec!["exact-30d", "exact-7d", "never"]
    );
    assert_eq!(result.not_seen_30days, vec!["exact-30d", "never"]);
}

#[tokio::test]
#[serial]
async fn analytics_chunked_frequency_candidates_3780_preserve_order_and_access()
{
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    seed_chunked_messages_3780(&fixture).await;
    let login = crate::users::login_id_by_name(&fixture.env.dbx, "Tester")
        .await
        .unwrap();
    for sort_by in [
        InboxMessagesSortBy::IMSDatetime,
        InboxMessagesSortBy::IMSTimestamp,
        InboxMessagesSortBy::IMSCreatedAt,
    ] {
        for (newest_first, nolimit) in
            [(true, false), (false, false), (true, true), (false, true)]
        {
            for (selected_freqs, denied_freqs) in [
                (Some(vec!["3780.1".to_string()]), None),
                (None, Some(vec!["3780.2".to_string()])),
                (
                    Some(vec!["3780.1".to_string(), "".to_string()]),
                    Some(vec!["".to_string()]),
                ),
                (None, None),
            ] {
                let mut req = InboxMessagesReq {
                    selected_freqs,
                    denied_freqs,
                    sort_by: Some(sort_by),
                    since_date_inclusive_ms: Some(
                        test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
                    ),
                    till_date_inclusive_ms: Some(
                        test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
                    ),
                    newest_first: Some(newest_first),
                    nolimit: Some(nolimit),
                    ..Default::default()
                };
                for _page in 0..2 {
                    let expected =
                        inbox_map_item_ids(&fixture.env, &login, &req).await;
                    let actual = crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                        &login,
                        &fixture.env,
                        &req,
                        &fixture.env.dbx,
                        90_000,
                    )
                    .await
                    .unwrap()
                    .unwrap();
                    assert_eq!(actual, expected, "{sort_by:?}");
                    if newest_first {
                        req.before_id_noninclusive = expected.last().copied();
                    } else {
                        req.since_id_noninclusive = expected.last().copied();
                    }
                }
            }
        }
    }
}

#[tokio::test]
#[serial]
async fn analytics_chunked_latest_candidates_3780_preserve_limits_and_units() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let messages = seed_chunked_messages_3780(&fixture).await;
    let login = crate::users::login_id_by_name(&fixture.env.dbx, "Tester")
        .await
        .unwrap();
    for req in [
        InboxMessagesReq {
            selected_freqs: Some(vec!["3780.1".to_string()]),
            load_latest: Some(true),
            ..Default::default()
        },
        InboxMessagesReq {
            selected_freqs: Some(vec!["3780.1".to_string()]),
            load_latest: Some(true),
            nolimit: Some(true),
            ..Default::default()
        },
        InboxMessagesReq {
            selected_units: Some(vec!["3780 header".to_string()]),
            load_latest: Some(true),
            ..Default::default()
        },
    ] {
        let expected = inbox_map_item_ids(&fixture.env, &login, &req).await;
        assert!(!expected.is_empty());
        let actual =
            crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login,
                &fixture.env,
                &req,
                &fixture.env.dbx,
                90_000,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual, expected);
    }
    let recent = chrono::Utc::now().naive_utc() - chrono::Duration::hours(1);
    let old = recent - chrono::Duration::days(10);
    let candidate_queries = Arc::new(AtomicUsize::new(0));
    let callback_queries = candidate_queries.clone();
    let mut analytics_db = fixture.env.dbx.clone();
    analytics_db.set_metric_callback(move |metric| {
        if metric.statement.sql.contains("\"ordering_value\"") {
            callback_queries.fetch_add(1, Ordering::SeqCst);
        }
    });
    for recent_count in [messages.len(), 3, 0] {
        for (index, message) in messages.iter().enumerate() {
            signal_message::Entity::update_many()
                .col_expr(
                    signal_message::Column::CreatedAt,
                    Expr::value(if index < recent_count {
                        recent
                    } else {
                        old
                    }),
                )
                .filter(signal_message::Column::Id.eq(message.id))
                .exec(&fixture.env.dbx)
                .await
                .unwrap();
        }
        for sort_by in [
            InboxMessagesSortBy::IMSDatetime,
            InboxMessagesSortBy::IMSTimestamp,
            InboxMessagesSortBy::IMSCreatedAt,
        ] {
            let req = InboxMessagesReq {
                selected_units: Some(vec!["3780 header".to_string()]),
                sort_by: Some(sort_by),
                load_latest: Some(true),
                ..Default::default()
            };
            let expected = inbox_map_item_ids(&fixture.env, &login, &req).await;
            assert_eq!(expected.len(), INBOX_MESSAGES_PAGE_LIMIT);
            candidate_queries.store(0, Ordering::SeqCst);
            let actual = crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login, &fixture.env, &req, &analytics_db, 90_000,
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(actual, expected, "{sort_by:?}, recent={recent_count}");
            if recent_count == messages.len() {
                assert_eq!(candidate_queries.load(Ordering::SeqCst), 2);
            }
        }
    }
}

#[tokio::test]
#[serial]
async fn analytics_chunked_unit_id_candidates_3780_preserve_limits_and_access()
{
    use std::sync::atomic::{AtomicUsize, Ordering};

    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let messages = seed_chunked_messages_3780(&fixture).await;
    let login = crate::users::login_id_by_name(&fixture.env.dbx, "Tester")
        .await
        .unwrap();
    let units = seed_chunked_unit_links_3780(&fixture, &messages, login).await;
    let candidate_queries = Arc::new(AtomicUsize::new(0));
    let callback_queries = candidate_queries.clone();
    let mut analytics_db = fixture.env.dbx.clone();
    analytics_db.set_metric_callback(move |metric| {
        if metric.statement.sql.contains("\"ordering_value\"") {
            callback_queries.fetch_add(1, Ordering::SeqCst);
        }
    });
    for (selected_unit_ids, denied_unit_ids, total) in [
        (Some(vec![units[0]]), None, 28),
        (Some(vec![units[1]]), None, 3),
        (None, Some(vec![units[0]]), 4),
        (Some(vec![units[0], units[1]]), Some(vec![units[1]]), 28),
        (Some(vec![units[2]]), None, 0),
        (None, Some(vec![units[2]]), 32),
        (Some(vec![]), Some(vec![]), 32),
    ] {
        for nolimit in [false, true] {
            let req = InboxMessagesReq {
                selected_unit_ids: selected_unit_ids.clone(),
                denied_unit_ids: denied_unit_ids.clone(),
                since_date_inclusive_ms: Some(
                    test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(
                    test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
                ),
                sort_by: Some(InboxMessagesSortBy::IMSCreatedAt),
                newest_first: Some(true),
                nolimit: Some(nolimit),
                ..Default::default()
            };
            let expected = inbox_map_item_ids(&fixture.env, &login, &req).await;
            assert_eq!(
                expected.len(),
                if nolimit {
                    total
                } else {
                    std::cmp::min(total, INBOX_MESSAGES_PAGE_LIMIT)
                }
            );
            candidate_queries.store(0, Ordering::SeqCst);
            let actual = crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
                &login, &fixture.env, &req, &analytics_db, 90_000,
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(actual, expected);
            if !nolimit {
                assert_unit_id_digest_3780(&fixture, login, &req, total).await;
            }
            assert_eq!(
                candidate_queries.load(Ordering::SeqCst),
                2,
                "selected={selected_unit_ids:?}, denied={denied_unit_ids:?}"
            );
        }
    }
}

async fn assert_unit_id_digest_3780(
    fixture: &RerAnalysisFixture,
    login: uuid::Uuid,
    req: &InboxMessagesReq,
    expected_count: usize,
) {
    let split = test_dt(2026, 3, 2, 10, 0) + chrono::Duration::seconds(18);
    for upper_bound in [None, Some(split)] {
        let actual =
            crate::rer_importer::inbox::query::load_analytics_inbox_digest(
                &login,
                &fixture.env,
                req,
                &fixture.env.dbx,
                90_000,
                upper_bound,
            )
            .await
            .unwrap()
            .unwrap();
        let mut reference_req = req.clone();
        if let Some(upper_bound) = upper_bound {
            reference_req.till_date_inclusive_ms =
                Some(upper_bound.and_utc().timestamp_millis() - 1);
        }
        let source =
            crate::rer_importer::inbox::query::build_inbox_digest_query(
                &login,
                &fixture.env,
                &reference_req,
            )
            .await
            .unwrap();
        let expected = fixture
            .env
            .dbx
            .query_one_raw(Statement::from_string(DbBackend::Postgres, source))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual.0, expected.try_get::<i64>("", "count").unwrap());
        assert_eq!(
            actual.1,
            expected
                .try_get::<Option<NaiveDateTime>>("", "first_element_ts")
                .unwrap()
        );
        if upper_bound.is_none() {
            assert_eq!(actual.0, expected_count as i64);
        }
    }
}

async fn seed_chunked_unit_links_3780(
    fixture: &RerAnalysisFixture,
    messages: &[signal_message::Model],
    login: uuid::Uuid,
) -> Vec<i64> {
    let db = &fixture.env.dbx;
    let mut units = Vec::new();
    for deleted in [false, false, true] {
        units.push(
            mk_sigint_unit(
                db,
                sigint_unit::ActiveModel {
                    name: Set("3780 shared unit name".to_string()),
                    created_by_login_id: Set(login),
                    deleted: Set(deleted),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .id,
        );
    }
    let base = messages.iter().map(|message| message.id).min().unwrap();
    let mut links = Vec::new();
    for message in messages {
        let index = (message.id - base)
            % crate::config::ANALYTICS_INBOX_MESSAGE_ID_CHUNK_SIZE;
        let unit_index = match index {
            28..=30 => 1,
            31 => 2,
            _ => 0,
        };
        links.push(sigint_inbox_item_unit::ActiveModel {
            item_id: Set(message.id),
            unit_id: Set(units[unit_index]),
            kind: Set(SigintInboxItemUnitKind::Parsed),
            ..Default::default()
        });
        if message.id == base {
            links.push(sigint_inbox_item_unit::ActiveModel {
                item_id: Set(message.id),
                unit_id: Set(units[unit_index]),
                kind: Set(SigintInboxItemUnitKind::Network),
                ..Default::default()
            });
        }
    }
    sigint_inbox_item_unit::Entity::insert_many(links)
        .exec(db)
        .await
        .unwrap();
    units
}

async fn seed_chunked_messages_3780(
    fixture: &RerAnalysisFixture,
) -> Vec<signal_message::Model> {
    let db = &fixture.env.dbx;
    let base: i64 = signal_message::Entity::find()
        .select_only()
        .column_as(signal_message::Column::Id.max(), "max_id")
        .into_tuple::<i64>()
        .one(db)
        .await
        .unwrap()
        .unwrap()
        + 1;
    let date = test_dt(2026, 3, 2, 10, 0);
    let width = crate::config::ANALYTICS_INBOX_MESSAGE_ID_CHUNK_SIZE;
    let messages = signal_message::Entity::insert_many((0..34).map(|index| {
        let created_at = date + chrono::Duration::seconds((index * 17) % 37);
        signal_message::ActiveModel {
            id: Set(base + index + (index % 2) * width),
            body: Set(Some(format!("3780 chunk {index}"))),
            created_at: Set(created_at),
            timestamp: Set(Some(created_at)),
            deleted: Set(index == 32),
            datasource_group_id: Set(Some(fixture.alpha.datasource_group.id)),
            ..Default::default()
        }
    }))
    .exec_with_returning(db)
    .await
    .unwrap();
    sigint_inbox_item::Entity::insert_many(messages.iter().map(|message| {
        let index = (message.id - base) % width;
        let freq = match index {
            29 => Some("3780.2"),
            30 => Some(""),
            31 => None,
            _ => Some("3780.1"),
        };
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            datetime: Set(message.timestamp),
            freq: Set(freq.map(str::to_string)),
            unit_v2: Set(Some("3780 header".to_string())),
            ..Default::default()
        }
    }))
    .exec(db)
    .await
    .unwrap();
    let mut memberships = Vec::new();
    for message in &messages {
        let index = (message.id - base) % width;
        let groups = match index {
            0 => vec![&fixture.alpha, &fixture.beta],
            33 => vec![&fixture.secret_hidden],
            _ => vec![&fixture.alpha],
        };
        for group in groups {
            memberships.push(signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(
                    group.signal_group.master_key.clone(),
                )),
                datasource_group_id: Set(Some(group.datasource_group.id)),
                created_at: Set(date),
                ..Default::default()
            });
        }
    }
    signal_message_group::Entity::insert_many(memberships)
        .exec(db)
        .await
        .unwrap();
    messages
}

#[tokio::test]
#[serial]
async fn analytics_chunked_inbox_counts_3780_keep_access_and_fresh_tail_split()
{
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    seed_chunked_messages_3780(&fixture).await;
    let login = crate::users::login_id_by_name(&fixture.env.dbx, "Tester")
        .await
        .unwrap();
    let req = InboxMessagesReq {
        sort_by: Some(InboxMessagesSortBy::IMSCreatedAt),
        since_date_inclusive_ms: Some(
            test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
        ),
        till_date_inclusive_ms: Some(
            test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
        ),
        ..Default::default()
    };
    let split = test_dt(2026, 3, 2, 10, 0) + chrono::Duration::seconds(18);
    let full = crate::rer_importer::inbox::query::load_analytics_inbox_digest(
        &login,
        &fixture.env,
        &req,
        &fixture.env.dbx,
        90_000,
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(full.0, 32);
    let historical =
        crate::rer_importer::inbox::query::load_analytics_inbox_digest(
            &login,
            &fixture.env,
            &req,
            &fixture.env.dbx,
            90_000,
            Some(split),
        )
        .await
        .unwrap()
        .unwrap();
    let source = crate::rer_importer::inbox::query::build_postgres_fresh_tail_inbox_digest_query(
        &login, &fixture.env, &req, split,
    ).await.unwrap();
    let tail = fixture
        .env
        .dbx
        .query_one_raw(Statement::from_string(DbBackend::Postgres, source))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        historical.0 + tail.try_get::<i64>("", "count").unwrap(),
        full.0
    );
    assert_eq!(historical.1, full.1);
}

#[tokio::test]
#[serial]
async fn analytics_chunked_tag_counts_3780_deduplicate_messages_per_tag() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let messages = seed_chunked_messages_3780(&fixture).await;
    let db = &fixture.env.dbx;
    let (login, master_keys) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();
    let tag = mk_tag(db, Default::default()).await.unwrap();
    let base = messages.iter().map(|message| message.id).min().unwrap();
    for message in &messages {
        mk_sigint_inbox_item_tag(
            db,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                tag_id: Set(tag.id),
                confidence: Set(1.0),
                model: Set(
                    (message.id - base == 28).then(|| "3780".to_string())
                ),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    mk_sigint_inbox_item_tag(
        db,
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(base),
            tag_id: Set(tag.id),
            confidence: Set(1.0),
            model: Set(Some("3780 duplicate actor".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let access = stats::resolve_analytics_tag_access(db, &login, false)
        .await
        .unwrap();
    let mut req = mk_analysis_stats_req(
        test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
        test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
    );
    req.selected_freqs = Some(vec!["3780.1".to_string()]);
    for without_model_tags in [false, true] {
        req.without_model_tags = Some(without_model_tags);
        req.denied_tags = Some(vec![tag.id]);
        let rows = stats::fetch_analytics_tags_for_login_with_scope(
            &req,
            &login,
            db,
            db,
            master_keys.clone(),
            &access,
            &AnalyticsMessageIdScope::From(base),
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tag_id, tag.id);
        assert_eq!(rows[0].count, 29);
    }
}

#[test]
fn analytics_message_id_chunks_3780_cover_boundaries_without_overlap() {
    let width = crate::config::ANALYTICS_STATS_MESSAGE_ID_CHUNK_SIZE;
    let chunks = AnalyticsMessageIdScope::Inclusive {
        min_id: i64::MAX - width,
        max_id: i64::MAX,
    }
    .chunks(width);
    assert_eq!(
        chunks,
        vec![
            AnalyticsMessageIdScope::Inclusive {
                min_id: i64::MAX - width,
                max_id: i64::MAX - 1,
            },
            AnalyticsMessageIdScope::Inclusive {
                min_id: i64::MAX,
                max_id: i64::MAX,
            },
        ]
    );
    assert!(AnalyticsMessageIdScope::Inclusive {
        min_id: 2,
        max_id: 1,
    }
    .chunks(width)
    .is_empty());
    assert!(AnalyticsMessageIdScope::Empty.chunks(width).is_empty());
}

#[tokio::test]
#[serial]
async fn analytics_chunked_recent_scope_3780_keeps_replication_tail_open() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let messages = seed_chunked_messages_3780(&fixture).await;
    let db = &fixture.env.dbx;
    let min_id = messages.iter().map(|message| message.id).min().unwrap();
    let max_id = messages.iter().map(|message| message.id).max().unwrap();
    let width = crate::config::ANALYTICS_INBOX_MESSAGE_ID_CHUNK_SIZE;
    let scopes = analytics_message_id_chunks(
        db,
        AnalyticsMessageIdScope::From(min_id),
        width,
    )
    .await
    .unwrap();
    let arriving = signal_message::ActiveModel {
        id: Set(max_id + width),
        body: Set(Some("3780 arriving during chunk planning".to_string())),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let mut ids = Vec::new();
    for scope in scopes {
        ids.extend(
            signal_message::Entity::find()
                .select_only()
                .column(signal_message::Column::Id)
                .filter(scope.condition(signal_message::Column::Id))
                .into_tuple::<i64>()
                .all(db)
                .await
                .unwrap(),
        );
    }
    assert_eq!(ids.len(), messages.len() + 1);
    assert!(ids.contains(&arriving.id));
    let scopes = analytics_message_id_chunks(
        db,
        AnalyticsMessageIdScope::From(arriving.id + 1),
        width,
    )
    .await
    .unwrap();
    assert_eq!(scopes, vec![AnalyticsMessageIdScope::From(arriving.id + 1)]);
}

#[tokio::test]
#[serial]
async fn analytics_chunked_facets_3780_preserve_distinct_counts_and_metadata() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let messages = seed_chunked_messages_3780(&fixture).await;
    seed_chunked_metadata_and_networks_3780(&fixture, &messages).await;
    let db = &fixture.env.dbx;
    let (login, master_keys) =
        analysis_login_and_master_keys(&fixture.env).await.unwrap();
    let access = stats::resolve_analytics_tag_access(db, &login, false)
        .await
        .unwrap();
    let base = messages.iter().map(|message| message.id).min().unwrap();
    let scope = AnalyticsMessageIdScope::From(base);
    let mut req = mk_analysis_stats_req(
        test_dt(2026, 3, 2, 0, 0).and_utc().timestamp_millis(),
        test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
    );
    req.selected_freqs = Some(vec!["3780.1".to_string()]);
    for basis in [
        None,
        Some(crate::user_settings::MessageTimeBasis::MessageCreation),
    ] {
        req.message_time_basis = basis;
        let expected_metadata = stats::fetch_metadata_stats_with_db(
            &req,
            &login,
            db,
            master_keys.clone(),
            None,
        )
        .await
        .unwrap();
        let metadata = stats::fetch_analytics_metadata_for_login_with_scope(
            &req,
            &login,
            db,
            db,
            master_keys.clone(),
            &scope,
        )
        .await
        .unwrap();
        assert_eq!(metadata, expected_metadata);
        assert_eq!(metadata.ccs.iter().map(|row| row.count).sum::<i64>(), 29);
        assert_eq!(metadata.senders.len(), 1);
        assert_eq!(metadata.senders[0].count, 29);
        for (selected_units, expected) in [
            (None, (29, 0)),
            (Some(vec!["3780 header".to_string()]), (0, 29)),
            (Some(vec!["3780 absent".to_string()]), (0, 0)),
        ] {
            let mut req = req.clone();
            req.selected_units = selected_units;
            let counts = stats::count_unit_exact_match_breakdown_for_login(
                &Json(req),
                &login,
                fixture.env.as_ref(),
                master_keys.clone(),
            )
            .await
            .unwrap();
            assert_eq!(counts, expected);
        }
        let networks = stats::fetch_analytics_networks_for_login_with_scope(
            &req,
            &login,
            db,
            db,
            master_keys.clone(),
            &access,
            &scope,
        )
        .await
        .unwrap();
        assert_eq!(
            networks,
            vec![AnalysisStatsNetwork {
                network_id: fixture.network_wide.network.id,
                count: 29,
            }]
        );
        let expected_daily =
            stats::fetch_daily_group_activity_for_login_with_db(
                &req,
                &login,
                db,
                db,
                master_keys.clone(),
                None,
            )
            .await
            .unwrap();
        let daily = stats::fetch_daily_group_activity_for_login_with_db(
            &req,
            &login,
            db,
            db,
            master_keys.clone(),
            Some(&scope),
        )
        .await
        .unwrap();
        let counts = |rows: Vec<stats::AnalysisDailyGroupActivity>| {
            rows.into_iter()
                .map(|row| ((row.msg_date, row.group), row.value))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(counts(daily), counts(expected_daily));
    }
}

async fn seed_chunked_metadata_and_networks_3780(
    fixture: &RerAnalysisFixture,
    messages: &[signal_message::Model],
) {
    let db = &fixture.env.dbx;
    db.execute_unprepared(
        r#"
        CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived;
        CREATE OR REPLACE VIEW echo_clickhouse_derived.message_network_link AS
        SELECT sigint_inbox_item_id, sigint_network_id
        FROM sigint_inbox_item_network
    "#,
    )
    .await
    .unwrap();
    let base = messages.iter().map(|message| message.id).min().unwrap();
    for message in messages {
        mk_sigint_inbox_item_metadata(
            db,
            sigint_inbox_item_metadata::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                color_code: Set(Some(
                    if message.id == base { " 3780 " } else { "3780" }
                        .to_string(),
                )),
                hash_id: Set(Some("3780-hash".to_string())),
                sender_id: Set(Some(" 3780-sender ".to_string())),
                sender_name: Set(Some("3780-sender".to_string())),
                call_group_id: Set(Some("3780-receiver".to_string())),
                call_group_name: Set(Some("3780-receiver".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            db,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(fixture.network_wide.network.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
#[serial]
async fn analytics_candidates_preserve_unit_media_permissions_and_paging() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = crate::users::login_id_by_name(db, "Tester").await.unwrap();
    let mut units = Vec::new();
    for deleted in [false, true] {
        units.push(
            mk_sigint_unit(
                db,
                sigint_unit::ActiveModel {
                    name: Set("Analytics candidate unit".to_string()),
                    created_by_login_id: Set(login),
                    deleted: Set(deleted),
                    ..Default::default()
                },
            )
            .await
            .unwrap(),
        );
    }
    let date = test_dt(2026, 3, 2, 10, 0);
    let count = ANALYTICS_INBOX_CANDIDATE_PAGE_SIZE + 3;
    let messages =
        signal_message::Entity::insert_many((0..count).map(|index| {
            signal_message::ActiveModel {
                body: Set(Some(format!("analytics candidate {index}"))),
                created_at: Set(date),
                timestamp: Set(Some(date)),
                datasource_group_id: Set(Some(
                    fixture.alpha.datasource_group.id,
                )),
                message_uid: Set(Some(format!("analytics-candidate-{index}"))),
                ..Default::default()
            }
        }))
        .exec_with_returning(db)
        .await
        .unwrap();
    sigint_inbox_item::Entity::insert_many(messages.iter().map(|message| {
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            date: Set(Some("2026-03-02".to_string())),
            time: Set(Some("10:00:00".to_string())),
            datetime: Set(Some(date)),
            freq: Set(Some("944.99".to_string())),
            ..Default::default()
        }
    }))
    .exec(db)
    .await
    .unwrap();
    signal_message_group::Entity::insert_many(messages.iter().enumerate().map(
        |(index, message)| {
            let group = if index == count - 1 {
                &fixture.secret_hidden
            } else {
                &fixture.alpha
            };
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(
                    group.signal_group.master_key.clone(),
                )),
                datasource_group_id: Set(Some(group.datasource_group.id)),
                created_at: Set(date),
                ..Default::default()
            }
        },
    ))
    .exec(db)
    .await
    .unwrap();
    sigint_inbox_item_unit::Entity::insert_many(
        messages.iter().enumerate().map(|(index, message)| {
            sigint_inbox_item_unit::ActiveModel {
                item_id: Set(message.id),
                unit_id: Set(units[usize::from(index == count - 2)].id),
                kind: Set(SigintInboxItemUnitKind::Parsed),
                ..Default::default()
            }
        }),
    )
    .exec(db)
    .await
    .unwrap();
    signal_message_media::Entity::insert_many(messages.iter().flat_map(
        |message| {
            (0..2).map(move |_| signal_message_media::ActiveModel {
                id: Set(uuid::Uuid::new_v4()),
                signal_message_id: Set(message.id),
                content_type: Set("image/png".to_string()),
                size_bytes: Set(1),
                created_at: Set(date),
                is_encrypted: Set(false),
                ..Default::default()
            })
        },
    ))
    .exec(db)
    .await
    .unwrap();
    let mut req = InboxMessagesReq {
        since_date_inclusive_ms: Some(
            test_dt(2026, 3, 1, 0, 0).and_utc().timestamp_millis(),
        ),
        till_date_inclusive_ms: Some(
            test_dt(2026, 3, 3, 0, 0).and_utc().timestamp_millis(),
        ),
        selected_unit_ids: Some(units.iter().map(|unit| unit.id).collect()),
        only_with_media: Some(true),
        nolimit: Some(true),
        ..Default::default()
    };
    let expected = messages[..count - 2]
        .iter()
        .map(|message| message.id)
        .collect::<Vec<_>>();
    let candidates =
        crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
            &login,
            &fixture.env,
            &req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidates, expected);
    let digest =
        crate::rer_importer::inbox::query::build_analytics_inbox_digest_query(
            &login,
            &fixture.env,
            &req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap();
    let quantity: i64 = db
        .query_one_raw(Statement::from_string(DbBackend::Postgres, digest))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap();
    assert_eq!(quantity, expected.len() as i64);
    req.nolimit = Some(false);
    req.since_id_noninclusive = Some(expected[9]);
    let candidates =
        crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
            &login,
            &fixture.env,
            &req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidates, expected[10..10 + INBOX_MESSAGES_PAGE_LIMIT]);
    for sort_by in [
        InboxMessagesSortBy::IMSDatetime,
        InboxMessagesSortBy::IMSTimestamp,
    ] {
        for newer in [false, true] {
            let cursor_req = InboxMessagesReq {
                sort_by: Some(sort_by),
                since_id_noninclusive: newer.then_some(expected[9]),
                before_id_noninclusive: (!newer).then_some(expected[9]),
                ..req.clone()
            };
            let primary =
                crate::rer_importer::inbox::query::build_inbox_digest_query(
                    &login,
                    &fixture.env,
                    &cursor_req,
                )
                .await
                .unwrap();
            let analytics = crate::rer_importer::inbox::query::build_analytics_inbox_digest_query(
                &login,
                &fixture.env,
                &cursor_req,
                db,
                90_000,
            )
            .await
            .unwrap()
            .unwrap();
            for query in [primary, analytics] {
                let quantity: i64 = db
                    .query_one_raw(Statement::from_string(
                        DbBackend::Postgres,
                        query,
                    ))
                    .await
                    .unwrap()
                    .unwrap()
                    .try_get("", "count")
                    .unwrap();
                assert_eq!(
                    quantity,
                    if newer { expected.len() as i64 - 10 } else { 9 }
                );
            }
        }
    }
    req.since_id_noninclusive = None;
    req.since_date_inclusive_ms = None;
    req.till_date_inclusive_ms = None;
    req.load_latest = Some(true);
    let candidates =
        crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
            &login,
            &fixture.env,
            &req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        candidates,
        expected
            .iter()
            .rev()
            .take(INBOX_MESSAGES_PAGE_LIMIT)
            .copied()
            .collect::<Vec<_>>()
    );
    req.denied_unit_ids = Some(vec![units[0].id]);
    assert!(
        crate::rer_importer::inbox::query::load_analytics_inbox_candidates(
            &login,
            &fixture.env,
            &req,
            db,
            90_000,
        )
        .await
        .unwrap()
        .unwrap()
        .is_empty()
    );
}

#[tokio::test]
#[serial]
async fn echo_3461_inbox_device_filters_include_exclude_and_keep_nulls() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let alpha = device_name::ActiveModel {
        name: Set(Some("ECHO-3461 Alpha".to_string())),
        login_id: Set(login_id),
        created_at: Set(chrono::Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let beta = device_name::ActiveModel {
        name: Set(Some("ECHO-3461 Beta".to_string())),
        login_id: Set(login_id),
        created_at: Set(chrono::Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let alpha_message = mk_analysis_message(
        db,
        "echo-3461-alpha",
        "3461.1",
        test_dt(2026, 3, 1, 8, 1),
        &[&fixture.alpha],
        &[],
        true,
    )
    .await
    .unwrap();
    let beta_message = mk_analysis_message(
        db,
        "echo-3461-beta",
        "3461.2",
        test_dt(2026, 3, 1, 8, 2),
        &[&fixture.alpha],
        &[],
        true,
    )
    .await
    .unwrap();
    let null_message = mk_analysis_message(
        db,
        "echo-3461-null",
        "3461.3",
        test_dt(2026, 3, 1, 8, 3),
        &[&fixture.alpha],
        &[],
        true,
    )
    .await
    .unwrap();
    assign_message_device_name(
        db,
        alpha_message.id,
        Some(alpha.id),
        test_dt(2026, 3, 1, 8, 1),
    )
    .await;
    assign_message_device_name(
        db,
        beta_message.id,
        Some(beta.id),
        test_dt(2026, 3, 1, 8, 2),
    )
    .await;
    assign_message_device_name(
        db,
        null_message.id,
        None,
        test_dt(2026, 3, 1, 8, 3),
    )
    .await;

    let base_req = InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        nolimit: Some(true),
        ..Default::default()
    };
    let unfiltered =
        inbox_map_item_ids(&fixture.env, &login_id, &base_req).await;
    let empty_lists = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_device_names: Some(vec![]),
            denied_device_names: Some(vec![]),
            ..base_req.clone()
        },
    )
    .await;
    assert_eq!(empty_lists, unfiltered);

    let included = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_device_names: Some(vec![alpha.name.clone().unwrap()]),
            ..base_req.clone()
        },
    )
    .await;
    assert_eq!(included, vec![alpha_message.id]);

    let denied_alpha = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_device_names: Some(vec![alpha.name.clone().unwrap()]),
            ..base_req.clone()
        },
    )
    .await;
    assert!(!denied_alpha.contains(&alpha_message.id));
    assert!(denied_alpha.contains(&beta_message.id));
    assert!(denied_alpha.contains(&null_message.id));

    let denied_both = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_device_names: Some(vec![
                alpha.name.clone().unwrap(),
                beta.name.clone().unwrap(),
            ]),
            ..base_req.clone()
        },
    )
    .await;
    assert!(!denied_both.contains(&alpha_message.id));
    assert!(!denied_both.contains(&beta_message.id));
    assert!(denied_both.contains(&null_message.id));

    let include_and_exclude = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_device_names: Some(vec![alpha.name.unwrap()]),
            denied_device_names: Some(vec![beta.name.unwrap()]),
            ..base_req
        },
    )
    .await;
    assert_eq!(include_and_exclude, vec![alpha_message.id]);
}

struct LocationFilterMessages {
    location_a: i64,
    location_b: i64,
    null_location: i64,
    null_location_null_freq: i64,
    peleng_freq: i64,
}

async fn clear_message_freq(db: &DatabaseConnection, message_id: i64) {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(message_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.freq = Set(None);
    inbox_item.update(db).await.unwrap();
}

async fn mk_location_filter_message(
    fixture: &RerAnalysisFixture,
    label: &str,
    freq: &str,
    minute: u32,
    location_v2: Option<&str>,
) -> i64 {
    let db = &fixture.env.dbx;
    let datetime = test_dt(2026, 3, 1, 8, minute);
    let message = mk_analysis_message_with_location(
        db,
        label,
        freq,
        datetime,
        &[&fixture.alpha],
        &[],
        false,
        location_v2,
    )
    .await
    .unwrap();
    let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let mut inbox_item = inbox_item.into_active_model();
    inbox_item.datetime = Set(Some(datetime));
    inbox_item.update(db).await.unwrap();
    message.id
}

async fn mk_location_filter_messages(
    fixture: &RerAnalysisFixture,
) -> LocationFilterMessages {
    let db = &fixture.env.dbx;
    let location_a = crate::location::utils::format_location("Location A");
    let location_b = crate::location::utils::format_location("Location B");
    mk_freq_location(
        db,
        freq_location::ActiveModel {
            freq: Set("3308.4".to_string()),
            location: Set("Location A".to_string()),
            created_at: Set(test_dt(2026, 3, 1, 7, 0)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let null_location_null_freq = mk_location_filter_message(
        fixture,
        "echo-3308-null-freq",
        "3308.5",
        5,
        None,
    )
    .await;
    clear_message_freq(db, null_location_null_freq).await;
    LocationFilterMessages {
        location_a: mk_location_filter_message(
            fixture,
            "echo-3308-a",
            "3308.1",
            1,
            Some(&location_a),
        )
        .await,
        location_b: mk_location_filter_message(
            fixture,
            "echo-3308-b",
            "3308.2",
            2,
            Some(&location_b),
        )
        .await,
        null_location: mk_location_filter_message(
            fixture,
            "echo-3308-null",
            "3308.3",
            3,
            None,
        )
        .await,
        null_location_null_freq,
        peleng_freq: mk_location_filter_message(
            fixture,
            "echo-3308-peleng",
            "3308.4",
            4,
            None,
        )
        .await,
    }
}

fn location_filter_base_req(fixture: &RerAnalysisFixture) -> InboxMessagesReq {
    InboxMessagesReq {
        since_date_inclusive_ms: Some(fixture.since_date_inclusive_ms),
        till_date_inclusive_ms: Some(fixture.till_date_noninclusive_ms),
        nolimit: Some(true),
        ..Default::default()
    }
}

fn strings(values: &[&str]) -> Option<Vec<String>> {
    Some(values.iter().map(|value| (*value).to_owned()).collect())
}

#[tokio::test]
#[serial]
async fn echo_3308_inbox_denied_location_keeps_null_locations() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let messages = mk_location_filter_messages(&fixture).await;
    let base_req = location_filter_base_req(&fixture);

    let unfiltered =
        inbox_map_item_ids(&fixture.env, &login_id, &base_req).await;
    let empty_list = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_locations: Some(vec![]),
            ..base_req.clone()
        },
    )
    .await;
    assert_eq!(empty_list, unfiltered);

    let denied_a = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_locations: strings(&["Location A"]),
            ..base_req
        },
    )
    .await;
    assert!(!denied_a.contains(&messages.location_a));
    assert!(denied_a.contains(&messages.location_b));
    assert!(denied_a.contains(&messages.null_location));
    assert!(denied_a.contains(&messages.null_location_null_freq));
    assert!(denied_a.contains(&messages.peleng_freq));
}

#[tokio::test]
#[serial]
async fn echo_3308_inbox_denied_empty_location_excludes_null_locations() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let messages = mk_location_filter_messages(&fixture).await;

    let denied_empty = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_locations: strings(&[""]),
            ..location_filter_base_req(&fixture)
        },
    )
    .await;
    let mut expected = vec![messages.location_a, messages.location_b];
    expected.sort();
    let mut denied_empty = denied_empty;
    denied_empty.sort();
    assert_eq!(denied_empty, expected);
}

#[tokio::test]
#[serial]
async fn echo_3308_inbox_denied_peleng_location_keeps_null_freqs() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let messages = mk_location_filter_messages(&fixture).await;

    let denied_a = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_locations: strings(&["Location A"]),
            include_peleng_locations: Some(true),
            ..location_filter_base_req(&fixture)
        },
    )
    .await;
    assert!(!denied_a.contains(&messages.location_a));
    assert!(!denied_a.contains(&messages.peleng_freq));
    assert!(denied_a.contains(&messages.location_b));
    assert!(denied_a.contains(&messages.null_location));
    assert!(denied_a.contains(&messages.null_location_null_freq));
}

#[tokio::test]
#[serial]
async fn echo_3308_inbox_selected_and_denied_locations_combine() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let messages = mk_location_filter_messages(&fixture).await;
    let base_req = location_filter_base_req(&fixture);

    let selected_and_denied = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_locations: strings(&["Location A", "Location B"]),
            denied_locations: strings(&["Location B"]),
            ..base_req.clone()
        },
    )
    .await;
    assert_eq!(selected_and_denied, vec![messages.location_a]);

    let selected_empty_denied_peleng = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_locations: strings(&[""]),
            denied_locations: strings(&["Location A"]),
            include_peleng_locations: Some(true),
            ..base_req
        },
    )
    .await;
    assert!(selected_empty_denied_peleng.contains(&messages.null_location));
    assert!(selected_empty_denied_peleng
        .contains(&messages.null_location_null_freq));
    assert!(!selected_empty_denied_peleng.contains(&messages.peleng_freq));
    assert!(!selected_empty_denied_peleng.contains(&messages.location_a));
    assert!(!selected_empty_denied_peleng.contains(&messages.location_b));
}

#[tokio::test]
#[serial]
async fn echo_3308_location_wildcards_match_literally() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let messages = mk_location_filter_messages(&fixture).await;
    let base_req = location_filter_base_req(&fixture);

    let denied_wildcards = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            denied_locations: strings(&["%", "_"]),
            ..base_req.clone()
        },
    )
    .await;
    assert!(denied_wildcards.contains(&messages.location_a));
    assert!(denied_wildcards.contains(&messages.location_b));

    let selected_wildcards = inbox_map_item_ids(
        &fixture.env,
        &login_id,
        &InboxMessagesReq {
            selected_locations: strings(&["%", "_"]),
            ..base_req
        },
    )
    .await;
    assert!(!selected_wildcards.contains(&messages.location_a));
    assert!(!selected_wildcards.contains(&messages.location_b));
}

#[tokio::test]
#[serial]
async fn issue_3783_device_facet_counts_accessible_messages_with_other_filters()
{
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &identity).await;
    let mut devices = Vec::new();
    for name in ["3783 Alpha", "3783 Alpha", "3783 Beta"] {
        devices.push(
            device_name::ActiveModel {
                name: Set(Some(name.to_string())),
                login_id: Set(login_id),
                created_at: Set(test_dt(2026, 3, 1, 7, 0)),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap(),
        );
    }
    let mut ids = Vec::new();
    for (index, device) in devices.iter().enumerate() {
        let datetime = test_dt(2026, 3, 1, 8, index as u32);
        let message = mk_analysis_message(
            db,
            &format!("3783-device-{index}"),
            if index == 2 { "3783.2" } else { "3783.1" },
            datetime,
            &[&fixture.alpha, &fixture.beta],
            &[],
            true,
        )
        .await
        .unwrap();
        assign_message_device_name(db, message.id, Some(device.id), datetime)
            .await;
        ids.push(message.id);
    }
    for (suffix, group, datetime, deleted) in [
        (
            "hidden",
            &fixture.secret_hidden,
            test_dt(2026, 3, 1, 8, 4),
            false,
        ),
        ("old", &fixture.alpha, test_dt(2026, 2, 1, 8, 4), false),
        ("deleted", &fixture.alpha, test_dt(2026, 3, 1, 8, 4), true),
    ] {
        let message = mk_analysis_message(
            db,
            &format!("3783-{suffix}"),
            "3783.1",
            datetime,
            &[group],
            &[],
            true,
        )
        .await
        .unwrap();
        assign_message_device_name(
            db,
            message.id,
            Some(devices[0].id),
            datetime,
        )
        .await;
        if deleted {
            let mut message = message.into_active_model();
            message.deleted = Set(true);
            message.update(db).await.unwrap();
        }
    }
    let mut req = analysis_stats_req0(&fixture);
    req.selected_device_names = Some(vec!["3783 Alpha".to_string()]);
    let groups = vec![
        fixture.alpha.signal_group.master_key.clone(),
        fixture.beta.signal_group.master_key.clone(),
    ];
    for (scope, time_basis) in [
        (None, None),
        (
            None,
            Some(crate::user_settings::MessageTimeBasis::MessageCreation),
        ),
        (Some(AnalyticsMessageIdScope::From(0)), None),
    ] {
        req.message_time_basis = time_basis;
        let counts = stats::fetch_device_names_with_db(
            &req,
            &login_id,
            db,
            db,
            groups.clone(),
            scope.as_ref(),
        )
        .await
        .unwrap();
        assert_eq!(
            counts,
            vec![
                AnalysisStatsDeviceName {
                    name: "3783 Alpha".to_string(),
                    count: 2
                },
                AnalysisStatsDeviceName {
                    name: "3783 Beta".to_string(),
                    count: 1
                },
            ]
        );
        let mut filtered = req.clone();
        filtered.selected_freqs = Some(vec!["3783.2".to_string()]);
        assert_eq!(
            stats::fetch_device_names_with_db(
                &filtered,
                &login_id,
                db,
                db,
                groups.clone(),
                scope.as_ref()
            )
            .await
            .unwrap(),
            vec![AnalysisStatsDeviceName {
                name: "3783 Beta".to_string(),
                count: 1
            },]
        );
        filtered.selected_locations =
            Some(vec!["no-such-location".to_string()]);
        assert!(stats::fetch_device_names_with_db(
            &filtered,
            &login_id,
            db,
            db,
            groups.clone(),
            scope.as_ref()
        )
        .await
        .unwrap()
        .is_empty());
    }
    let scope = AnalyticsMessageIdScope::Inclusive {
        min_id: ids[2],
        max_id: ids[2],
    };
    assert_eq!(
        stats::fetch_device_names_with_db(
            &req,
            &login_id,
            db,
            db,
            groups,
            Some(&scope)
        )
        .await
        .unwrap(),
        vec![AnalysisStatsDeviceName {
            name: "3783 Beta".to_string(),
            count: 1
        },]
    );
}

#[actix_web::test]
#[serial]
async fn echo_3461_activity_daily_requires_device_filter_access() {
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let test_identity = mk_test_identity().await.unwrap();
    let login_id = test_identity_login_id(&fixture.env, &test_identity).await;
    let destructive_device_name = "ECHO-3461 destructive device".to_string();
    let destructive_device = device_name::ActiveModel {
        name: Set(Some(destructive_device_name.clone())),
        login_id: Set(login_id),
        created_at: Set(chrono::Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(&fixture.env.dbx)
    .await
    .unwrap();
    let destructive_datetime = dt_from_millis(fixture.since_date_inclusive_ms)
        .unwrap()
        + chrono::Duration::minutes(1);
    assert!(
        destructive_datetime
            >= dt_from_millis(fixture.since_date_inclusive_ms).unwrap()
    );
    assert!(
        destructive_datetime
            < dt_from_millis(fixture.till_date_noninclusive_ms).unwrap()
    );
    let destructive_message = mk_analysis_message(
        &fixture.env.dbx,
        "echo-3461-destructive-unit-edit",
        "3461.9",
        destructive_datetime,
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let destructive_inbox =
        sigint_inbox_item::Entity::find_by_id(destructive_message.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
    let mut destructive_inbox = destructive_inbox.into_active_model();
    destructive_inbox.device_name_id = Set(Some(destructive_device.id));
    destructive_inbox.datetime = Set(Some(destructive_datetime));
    destructive_inbox.unit = Set(Some("ECHO-3461 original unit".to_string()));
    destructive_inbox.unit_v2 =
        Set(Some("ECHO-3461 original unit".to_string()));
    destructive_inbox.parsed_unit_v2 = Set(false);
    let destructive_inbox =
        destructive_inbox.update(&fixture.env.dbx).await.unwrap();
    let redis_session_store = RedisSessionStore::new(
        crate::redis_conn_string(&fixture.env.config).unwrap(),
    )
    .await
    .unwrap();
    let app = actix_test::init_service(
        App::new()
            .app_data(Data::from(fixture.env.clone()))
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        IDENTITY_DURATION_HOURS * 60 * 60,
                    )))
                    .build(),
            )
            .wrap(SessionMiddleware::new(redis_session_store, Key::generate()))
            .route(
                "/test/activity-daily-login/{login}",
                web::post().to(activity_daily_test_login),
            )
            .service(activity_daily)
            .service(device_name_stats)
            .service(edit_freq_unit_name),
    )
    .await;
    let login_response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("/test/activity-daily-login/{login_id}"))
            .to_request(),
    )
    .await;
    let session_cookie: Cookie<'static> = login_response
        .response()
        .cookies()
        .next()
        .unwrap()
        .into_owned();

    let request = |selected_device_names: Option<Vec<String>>| {
        let mut req = analysis_stats_req0(&fixture);
        req.selected_device_names = selected_device_names;
        req
    };
    let call = |req: AnalysisStatsReq| {
        actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/rer/analysis/activity-daily")
                .cookie(session_cookie.clone())
                .set_json(req)
                .to_request(),
        )
    };
    let call_devices = || {
        actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/rer/analysis/stats/device-names")
                .cookie(session_cookie.clone())
                .set_json(request(None))
                .to_request(),
        )
    };
    let edit_request = || EditFreqUnitNameReq {
        analysis_stats_req: request(Some(
            vec![destructive_device_name.clone()],
        )),
        freq: "3461.9".to_string(),
        unit: "ECHO-3461 original unit".to_string(),
        unit_new: "ECHO-3461 updated unit".to_string(),
        search: None,
        filter_tags_option: None,
        report_tags_only_this_unit: None,
    };
    set_devices_section_enabled(&fixture.env.dbx, true).await;
    set_login_roles(&fixture.env.dbx, login_id, serde_json::json!(["Rer"]))
        .await;
    assert_eq!(
        call(request(Some(vec!["ECHO-3461 Alpha".to_string()])))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/rer/analysis/freq-edit-unit-name")
                .cookie(session_cookie.clone())
                .set_json(edit_request())
                .to_request(),
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sigint_inbox_item::Entity::find_by_id(destructive_message.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap(),
        destructive_inbox
    );
    assert_ne!(call(request(None)).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(call_devices().await.status(), StatusCode::FORBIDDEN);

    set_login_roles(
        &fixture.env.dbx,
        login_id,
        serde_json::json!(["Rer", ROLE_CYBER]),
    )
    .await;
    assert!(actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/rer/analysis/freq-edit-unit-name")
            .cookie(session_cookie.clone())
            .set_json(edit_request())
            .to_request(),
    )
    .await
    .status()
    .is_success());
    let destructive_inbox =
        sigint_inbox_item::Entity::find_by_id(destructive_message.id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        destructive_inbox.unit,
        Some("ECHO-3461 updated unit".to_string())
    );
    assert_eq!(
        destructive_inbox.unit_v2,
        Some("ECHO-3461 updated unit".to_string())
    );
    assert!(destructive_inbox.parsed_unit_v2);
    assert_eq!(
        destructive_inbox.device_name_id,
        Some(destructive_device.id)
    );

    set_login_roles(&fixture.env.dbx, login_id, serde_json::json!(["Rer"]))
        .await;
    assert_eq!(
        call(request(Some(vec!["ECHO-3461 Alpha".to_string()])))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    for roles in [
        serde_json::json!(["Rer", ROLE_CYBER]),
        serde_json::json!([ROLE_ADMIN]),
    ] {
        set_login_roles(&fixture.env.dbx, login_id, roles).await;
        assert_eq!(call_devices().await.status(), StatusCode::OK);
        assert_ne!(
            call(request(Some(vec!["ECHO-3461 Alpha".to_string()])))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }

    set_devices_section_enabled(&fixture.env.dbx, false).await;
    for roles in [
        serde_json::json!(["Rer", ROLE_CYBER]),
        serde_json::json!([ROLE_ADMIN]),
    ] {
        set_login_roles(&fixture.env.dbx, login_id, roles).await;
        assert_eq!(call_devices().await.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            call(request(Some(vec!["ECHO-3461 Alpha".to_string()])))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
}

#[test]
fn issue_4070_ai_frequency_summary_keeps_the_most_active_rows() {
    let row = |index: usize, count: i64, values: usize| SummaryTableFreqRow {
        freq: format!("{index:04}"),
        count,
        callsigns: vec!["позивний".to_string(); values],
        units: vec![],
        locations: vec![],
        coords: vec![],
        locality_coords: vec![],
    };
    let extra = 2;
    let mut rows = (0..AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS + extra)
        .map(|index| row(index, index as i64, 1))
        .collect::<Vec<_>>();
    rows.push(row(
        9998,
        1_000,
        AI_AGENT_FREQUENCY_SUMMARY_MAX_ROW_VALUES + 1,
    ));
    rows.push(row(9997, 1_000, 1));

    let summary = rank_ai_frequency_summary(SummaryTableFreq { rows }).unwrap();

    assert_eq!(
        summary.total_rows,
        AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS + extra + 2
    );
    assert_eq!(summary.rows.len(), AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS);
    assert_eq!(summary.rows[0].freq, "9997");
    assert_eq!(summary.rows[1].freq, "9998");
    assert_eq!(
        summary.rows[1].callsigns.len(),
        AI_AGENT_FREQUENCY_SUMMARY_MAX_ROW_VALUES
    );
    assert!(summary.row_values_truncated);
    assert!(summary
        .rows
        .windows(2)
        .all(|pair| pair[0].count >= pair[1].count));

    let long = "підрозділ ".repeat(40);
    let rows = (0..AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS)
        .map(|index| SummaryTableFreqRow {
            callsigns: vec![long.clone(); 32],
            units: vec![long.clone(); 32],
            locations: vec![long.clone(); 32],
            ..row(index, 1, 0)
        })
        .collect::<Vec<_>>();
    let summary = rank_ai_frequency_summary(SummaryTableFreq { rows }).unwrap();
    assert_eq!(summary.total_rows, AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS);
    assert!(!summary.rows.is_empty());
    assert!(summary.rows.len() < AI_AGENT_FREQUENCY_SUMMARY_MAX_ROWS);
    assert!(
        serde_json::to_vec(&summary).unwrap().len()
            <= AI_AGENT_FREQUENCY_SUMMARY_MAX_BYTES + 1024
    );

    let oversized = SummaryTableFreqRow {
        freq: "\u{1}".repeat(200_000),
        units: vec!["п".repeat(17_000); 32],
        ..row(1, 1, 0)
    };
    let summary = rank_ai_frequency_summary(SummaryTableFreq {
        rows: vec![oversized],
    })
    .unwrap();
    assert_eq!(summary.rows.len(), 1);
    assert_eq!(
        summary.rows[0].units[0].chars().count(),
        AI_AGENT_FREQUENCY_SUMMARY_MAX_VALUE_CHARS
    );
    assert_eq!(
        summary.rows[0].freq.chars().count(),
        AI_AGENT_FREQUENCY_SUMMARY_MAX_VALUE_CHARS
    );
    assert!(summary.row_values_truncated);
}

#[tokio::test]
#[serial]
async fn issue_3873_daily_statistics_preserve_access_identity_and_distinct_counts(
) {
    use super::daily_messages::{
        load, load_catalog, load_group_counts, load_options, load_sender_page,
        DailyMessageSenderKey, DailyMessageStatsCatalogReq,
        DailyMessageStatsGrouping, DailyMessageStatsOptionsReq,
        DailyMessageStatsReq, DailyMessageStatsSendersReq,
    };
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let allowed = get_identity_sigint_groups(db, &login.id).await.unwrap();
    assert!(!allowed.contains(&fixture.secret_hidden.signal_group.master_key));
    let first = mk_analysis_message(
        db,
        "3873-first",
        "3873",
        test_dt(2026, 10, 25, 0, 30),
        &[&fixture.alpha, &fixture.beta],
        &[],
        false,
    )
    .await
    .unwrap();
    let second = mk_analysis_message(
        db,
        "3873-second",
        "3873",
        test_dt(2026, 10, 25, 1, 30),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let unknown = mk_analysis_message(
        db,
        "3873-unknown",
        "3873",
        test_dt(2026, 10, 25, 2, 30),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "3873-hidden",
        "3873",
        test_dt(2026, 10, 25, 2, 30),
        &[&fixture.secret_hidden],
        &[],
        false,
    )
    .await
    .unwrap();
    for message in [&first, &second, &unknown] {
        signal_message_group::Entity::update_many()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .col_expr(
                signal_message_group::Column::Sender,
                Expr::value(if message.id == unknown.id {
                    None
                } else {
                    Some("3873-sender")
                }),
            )
            .col_expr(
                signal_message_group::Column::LoginId,
                Expr::value(Option::<uuid::Uuid>::None),
            )
            .exec(db)
            .await
            .unwrap();
    }
    signal_group::Entity::update_many()
        .filter(signal_group::Column::MasterKey.is_in([
            fixture.alpha.signal_group.master_key.clone(),
            fixture.beta.signal_group.master_key.clone(),
        ]))
        .col_expr(signal_group::Column::Name, Expr::value("Same name"))
        .exec(db)
        .await
        .unwrap();
    let mut req = DailyMessageStatsReq {
        user_label_id: None,
        from_date: "2026-10-24".into(),
        to_date: "2026-10-26".into(),
        grouping: DailyMessageStatsGrouping::DailyStatsGroups,
        selected_groups: None,
        selected_senders: None,
        selected_unit_ids: None,
        cursor: None,
    };
    let stats = load(db, &req, allowed.clone()).await.unwrap();
    let catalog_req = DailyMessageStatsCatalogReq {
        known_hierarchy_revision: None,
        selected_senders: vec![
            DailyMessageSenderKey {
                sender: Some("3873-sender".into()),
            },
            DailyMessageSenderKey {
                sender: Some("3873-no-accessible-sender".into()),
            },
            DailyMessageSenderKey { sender: None },
        ],
    };
    let catalog = load_catalog(
        &fixture.env,
        &catalog_req,
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert_eq!(catalog.sender_labels.len(), 2);
    assert!(catalog
        .groups
        .iter()
        .all(|group| allowed.contains(&group.key)));
    assert!(catalog
        .groups
        .iter()
        .any(|group| group.key == fixture.alpha.signal_group.master_key
            && group.label == "Same name"));
    let conditional = load_catalog(
        &fixture.env,
        &DailyMessageStatsCatalogReq {
            known_hierarchy_revision: Some(
                catalog.unit_hierarchy.unwrap().revision,
            ),
            ..catalog_req
        },
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert!(conditional.unit_hierarchy.is_none());
    assert_eq!(stats.days, ["2026-10-24", "2026-10-25", "2026-10-26"]);
    let alpha = stats
        .series
        .iter()
        .find(|series| {
            series.key.as_ref() == Some(&fixture.alpha.signal_group.master_key)
        })
        .unwrap();
    let beta = stats
        .series
        .iter()
        .find(|series| {
            series.key.as_ref() == Some(&fixture.beta.signal_group.master_key)
        })
        .unwrap();
    assert_eq!(alpha.label, beta.label);
    assert_eq!(
        (alpha.points[1].messages, alpha.points[1].counterparts),
        (3, 2)
    );
    assert_eq!(
        (beta.points[1].messages, beta.points[1].counterparts),
        (1, 1)
    );
    assert_eq!(alpha.points[0].messages, 0);
    assert_eq!(alpha.points[2].messages, 0);
    assert!(stats.series.iter().all(|series| series.key.as_ref()
        != Some(&fixture.secret_hidden.signal_group.master_key)));
    let counts = load_group_counts(db, &req, allowed.clone()).await.unwrap();
    assert_eq!(
        counts
            .iter()
            .find(|row| row.value == fixture.alpha.signal_group.master_key)
            .unwrap()
            .count,
        3
    );
    assert!(!counts
        .iter()
        .any(|row| row.value == fixture.secret_hidden.signal_group.master_key));
    let sender_req = DailyMessageStatsSendersReq {
        filter: req.clone(),
        search: None,
        cursor: None,
    };
    let sender_page = load_sender_page(
        db,
        &sender_req,
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert_eq!(sender_page.total, 2);
    assert_eq!(sender_page.options.len(), 2);
    assert!(sender_page.options.iter().any(|row| row.key.is_none()));
    let searched = load_sender_page(
        db,
        &DailyMessageStatsSendersReq {
            search: Some("3873-sender".into()),
            ..sender_req.clone()
        },
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert_eq!(searched.total, 2);
    assert_eq!(searched.options.len(), 1);
    let absent = load_sender_page(
        db,
        &DailyMessageStatsSendersReq {
            search: Some("no-such-sender".into()),
            ..sender_req.clone()
        },
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert_eq!(absent.total, 2);
    assert!(absent.options.is_empty());
    let mut empty_sender_req = sender_req;
    empty_sender_req.filter.selected_groups =
        Some(vec![fixture.secret_hidden.signal_group.master_key.clone()]);
    let empty = load_sender_page(
        db,
        &empty_sender_req,
        allowed.clone(),
        "test-access".into(),
    )
    .await
    .unwrap();
    assert_eq!(empty.total, 0);
    assert!(empty.options.is_empty());
    req.grouping = DailyMessageStatsGrouping::DailyStatsSenders;
    let stats = load(db, &req, allowed.clone()).await.unwrap();
    let sender = stats
        .series
        .iter()
        .find(|series| series.key.as_deref() == Some("3873-sender"))
        .unwrap();
    assert_eq!(
        (sender.points[1].messages, sender.points[1].counterparts),
        (2, 2)
    );
    let unknown = stats
        .series
        .iter()
        .find(|series| series.key.is_none())
        .unwrap();
    assert_eq!(
        (unknown.points[1].messages, unknown.points[1].counterparts),
        (1, 1)
    );
    req.selected_groups =
        Some(vec![fixture.beta.signal_group.master_key.clone()]);
    req.selected_senders = Some(vec![DailyMessageSenderKey { sender: None }]);
    assert!(load(db, &req, allowed.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    req.selected_senders = Some(vec![DailyMessageSenderKey {
        sender: Some("3873-sender".into()),
    }]);
    let stats = load(db, &req, allowed.clone()).await.unwrap();
    assert_eq!(stats.series[0].points[1].messages, 1);
    req.selected_groups =
        Some(vec![fixture.secret_hidden.signal_group.master_key.clone()]);
    assert!(load(db, &req, allowed.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    req.selected_groups = Some(vec![]);
    assert!(load(db, &req, allowed.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    req.selected_groups = None;
    req.selected_unit_ids = Some(vec![]);
    assert!(load(db, &req, allowed.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    let unit = mk_sigint_unit(db, Default::default()).await.unwrap();
    for kind in [
        SigintInboxItemUnitKind::Parsed,
        SigintInboxItemUnitKind::Network,
    ] {
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(first.id),
            unit_id: Set(unit.id),
            kind: Set(kind),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
    req.selected_unit_ids = Some(vec![unit.id]);
    let stats = load(db, &req, allowed.clone()).await.unwrap();
    assert_eq!(
        (
            stats.series[0].points[1].messages,
            stats.series[0].points[1].counterparts
        ),
        (1, 2)
    );
    req.selected_unit_ids = None;
    req.selected_groups =
        Some(vec![fixture.alpha.signal_group.master_key.clone()]);
    let options = load_options(
        db,
        &DailyMessageStatsOptionsReq {
            filter: req.clone(),
            search: None,
            include_children: None,
        },
        allowed.clone(),
    )
    .await
    .unwrap();
    assert_eq!(options.total, 2);
    assert_eq!(
        options
            .options
            .iter()
            .find(|entry| entry.key.is_none())
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        options
            .options
            .iter()
            .find(|entry| entry.key.as_deref() == Some("3873-sender"))
            .unwrap()
            .count,
        2
    );
    assert!(options.options.iter().any(|entry| entry.key.is_none()));
    assert!(options
        .options
        .iter()
        .any(|entry| entry.key.as_deref() == Some("3873-sender")));

    req.grouping = DailyMessageStatsGrouping::DailyStatsGroups;
    let options = load_options(
        db,
        &DailyMessageStatsOptionsReq {
            filter: req.clone(),
            search: Some("Same name".into()),
            include_children: None,
        },
        allowed.clone(),
    )
    .await
    .unwrap();
    assert_eq!(options.total, 2);
    assert_eq!(options.options.len(), 2);
    assert_ne!(options.options[0].key, options.options[1].key);
    assert_eq!(
        options
            .options
            .iter()
            .find(|entry| entry.key.as_ref()
                == Some(&fixture.alpha.signal_group.master_key))
            .unwrap()
            .count,
        2
    );
    assert_eq!(
        options
            .options
            .iter()
            .find(|entry| entry.key.as_ref()
                == Some(&fixture.beta.signal_group.master_key))
            .unwrap()
            .count,
        1
    );

    req.selected_senders = None;
    req.from_date = "2026-10-25".into();
    req.to_date = "2026-10-25".into();
    for (index, datetime) in [
        test_dt(2026, 10, 24, 20, 59),
        test_dt(2026, 10, 24, 21, 0),
        test_dt(2026, 10, 25, 21, 59),
        test_dt(2026, 10, 25, 22, 0),
    ]
    .into_iter()
    .enumerate()
    {
        mk_analysis_message(
            db,
            &format!("3873-midnight-{index}"),
            "3873",
            datetime,
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
    }
    signal_message::Entity::update_many()
        .filter(signal_message::Column::Id.eq(first.id))
        .col_expr(
            signal_message::Column::Timestamp,
            Expr::value(test_dt(2026, 1, 1, 0, 0)),
        )
        .exec(db)
        .await
        .unwrap();
    let stats = load(db, &req, allowed).await.unwrap();
    assert_eq!(stats.series[0].points[0].messages, 5);
}

#[tokio::test]
#[serial]
async fn issue_3873_daily_statistics_cursor_and_calendar_validation() {
    use super::daily_messages::{
        load, load_options, DailyMessageStatsGrouping,
        DailyMessageStatsOptionsReq, DailyMessageStatsReq,
    };
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut allowed = vec![];
    for index in 0..53 {
        let group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set(format!("3873-page-{index:02}")),
                name: Set(Some("Repeated label".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        allowed.push(group.master_key);
    }
    let mut req = DailyMessageStatsReq {
        user_label_id: None,
        from_date: "2026-10-25".into(),
        to_date: "2026-10-25".into(),
        grouping: DailyMessageStatsGrouping::DailyStatsGroups,
        selected_groups: None,
        selected_senders: None,
        selected_unit_ids: None,
        cursor: None,
    };
    let mut keys = vec![];
    loop {
        let page = load(&env.dbx, &req, allowed.clone()).await.unwrap();
        assert_eq!(page.total_series, 53);
        assert!(page.series.iter().all(|entry| entry.points[0].messages == 0
            && entry.points[0].counterparts == 0));
        keys.extend(page.series.into_iter().map(|series| series.key.unwrap()));
        req.cursor = page.next_cursor;
        if req.cursor.is_none() {
            break;
        }
    }
    assert_eq!(keys, allowed);
    let mut keys = vec![];
    loop {
        let page = load_options(
            &env.dbx,
            &DailyMessageStatsOptionsReq {
                filter: req.clone(),
                search: Some("Repeated".into()),
                include_children: None,
            },
            allowed.clone(),
        )
        .await
        .unwrap();
        assert_eq!(page.total, 53);
        keys.extend(page.options.into_iter().map(|entry| entry.key.unwrap()));
        req.cursor = page.next_cursor;
        if req.cursor.is_none() {
            break;
        }
    }
    assert_eq!(keys, allowed);
    for (from, to) in
        [("2026-01-01", "2026-03-31"), ("2026-10-25", "2026-10-25")]
    {
        req.from_date = from.into();
        req.to_date = to.into();
        assert!(load(&env.dbx, &req, vec![]).await.is_ok());
    }
    for (from, to) in [
        ("2026-01-01", "2026-04-01"),
        ("2026-02-30", "2026-03-01"),
        ("2026-10-26", "2026-10-25"),
        ("2099-01-01", "2099-01-01"),
    ] {
        req.from_date = from.into();
        req.to_date = to.into();
        assert!(load(&env.dbx, &req, vec![]).await.is_err());
    }
}

#[tokio::test]
#[serial]
async fn issue_3873_filter_counts_preserve_access_and_deduplicate_unit_subtrees(
) {
    use super::daily_messages::{
        load, load_unit_options, DailyMessageStatsGrouping,
        DailyMessageStatsReq,
    };
    use crate::sigint::unit::types::{
        UnitHierarchyGroup, UnitHierarchyRsp, UnitHierarchyUnit,
    };
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let login = find_test_login(db).await.unwrap();
    let allowed = get_identity_sigint_groups(db, &login.id).await.unwrap();
    let parent = mk_sigint_unit(db, Default::default()).await.unwrap();
    let child = mk_sigint_unit(db, Default::default()).await.unwrap();
    let first = mk_analysis_message(
        db,
        "3873-count-first",
        "3873",
        test_dt(2026, 10, 25, 10, 0),
        &[&fixture.alpha, &fixture.beta],
        &[],
        false,
    )
    .await
    .unwrap();
    let second = mk_analysis_message(
        db,
        "3873-count-second",
        "3873",
        test_dt(2026, 10, 25, 11, 0),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    let hidden = mk_analysis_message(
        db,
        "3873-count-hidden",
        "3873",
        test_dt(2026, 10, 25, 12, 0),
        &[&fixture.secret_hidden],
        &[],
        false,
    )
    .await
    .unwrap();
    mk_analysis_message(
        db,
        "3873-count-undefined",
        "3873",
        test_dt(2026, 10, 25, 13, 0),
        &[&fixture.alpha],
        &[],
        false,
    )
    .await
    .unwrap();
    for (item_id, unit_id, kind) in [
        (first.id, parent.id, SigintInboxItemUnitKind::Parsed),
        (first.id, child.id, SigintInboxItemUnitKind::Parsed),
        (first.id, child.id, SigintInboxItemUnitKind::Network),
        (second.id, child.id, SigintInboxItemUnitKind::Parsed),
        (hidden.id, child.id, SigintInboxItemUnitKind::Parsed),
    ] {
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(item_id),
            unit_id: Set(unit_id),
            kind: Set(kind),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }
    let hierarchy = UnitHierarchyRsp {
        revision: "3873".into(),
        selections: vec![],
        groups: vec![
            UnitHierarchyGroup {
                id: "group:2:army".into(),
                label: "Army".into(),
                level: 2,
                parent_index: None,
            },
            UnitHierarchyGroup {
                id: "group:2:army|3:virtual".into(),
                label: "Virtual".into(),
                level: 3,
                parent_index: Some(0),
            },
            UnitHierarchyGroup {
                id: "group:2:army|3:virtual|4:child".into(),
                label: "Child".into(),
                level: 4,
                parent_index: Some(1),
            },
        ],
        units: vec![
            UnitHierarchyUnit {
                id: parent.id,
                name: "Army".into(),
                group_index: Some(0),
            },
            UnitHierarchyUnit {
                id: child.id,
                name: "Child".into(),
                group_index: Some(2),
            },
        ],
    };
    let mut req = DailyMessageStatsReq {
        user_label_id: None,
        from_date: "2026-10-25".into(),
        to_date: "2026-10-25".into(),
        grouping: DailyMessageStatsGrouping::DailyStatsGroups,
        selected_groups: None,
        selected_senders: None,
        selected_unit_ids: Some(vec![]),
        cursor: None,
    };
    for (children, expected_parent, expected_virtual) in
        [(true, 2, 2), (false, 1, 0)]
    {
        let counts =
            load_unit_options(db, &req, allowed.clone(), &hierarchy, children)
                .await
                .unwrap();
        assert_eq!(
            counts
                .iter()
                .find(|option| option.value == format!("unit-id:{}", parent.id))
                .unwrap()
                .count,
            expected_parent
        );
        assert_eq!(
            counts
                .iter()
                .find(|option| option.value
                    == "unit-parent:group:2:army|3:virtual")
                .unwrap()
                .count,
            expected_virtual
        );
        assert_eq!(
            counts
                .iter()
                .find(|option| option.value == format!("unit-id:{}", child.id))
                .unwrap()
                .count,
            2
        );
        assert_eq!(
            counts
                .iter()
                .find(|option| option.value == "unit-id:0")
                .unwrap()
                .count,
            1
        );
    }
    req.selected_unit_ids =
        Some(vec![crate::config::ANALYSIS_STATS_UNDEFINED_UNIT_ID]);
    let undefined = load(db, &req, allowed.clone()).await.unwrap();
    assert_eq!(
        undefined
            .series
            .iter()
            .map(|series| series.points[0].messages)
            .sum::<i64>(),
        1
    );
    req.selected_groups =
        Some(vec![fixture.beta.signal_group.master_key.clone()]);
    let counts = load_unit_options(db, &req, allowed.clone(), &hierarchy, true)
        .await
        .unwrap();
    assert!(counts.iter().all(|option| option.count
        == if option.value == "unit-id:0" { 0 } else { 1 }));
    req.selected_groups =
        Some(vec![fixture.secret_hidden.signal_group.master_key.clone()]);
    assert!(load_unit_options(db, &req, allowed, &hierarchy, true)
        .await
        .unwrap()
        .iter()
        .all(|option| option.count == 0));
}

#[tokio::test]
#[serial]
async fn issue_3873_label_panels_and_filters_respect_sender_organisms() {
    use super::daily_messages::{
        load, load_catalog, load_group_counts, load_options, load_panels,
        load_sender_page, load_unit_options, DailyMessageStatsAccess,
        DailyMessageStatsCatalogReq, DailyMessageStatsGrouping,
        DailyMessageStatsOptionsReq, DailyMessageStatsReq,
        DailyMessageStatsSendersReq,
    };
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let own = mk_organism(db, Default::default()).await.unwrap();
    let other = mk_organism(db, Default::default()).await.unwrap();
    let author = mk_login(
        db,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let external = mk_login(
        db,
        login::ActiveModel {
            organism_id: Set(Some(other.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let profile_key = uuid::Uuid::new_v4().to_string();
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into signal_profile(uuid,given_name) values ($1,'Signal sender')", [profile_key.clone().into()])).await.unwrap();
    login::Entity::update_many()
        .filter(login::Column::Id.eq(external.id))
        .col_expr(
            login::Column::SignalProfileId,
            Expr::value(profile_key.clone()),
        )
        .exec(db)
        .await
        .unwrap();
    let mut labels = vec![];
    for (organism, user) in [(&own, &author), (&other, &external)] {
        let label = crate::organism::labels::OrganismUserLabel::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into organism_user_label (organism_id,name,color) values ($1,'Same name','#87d7f1') returning *", [organism.id.into()])).one(db).await.unwrap().unwrap();
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into organism_user_label_assignment (login_id,organism_id,label_id) values ($1,$2,$3)", [user.id.into(), organism.id.into(), label.id.into()])).await.unwrap();
        labels.push(label.id);
    }
    let api_sender_id = uuid::Uuid::new_v4();
    let api_sender_key = api_sender_id.to_string();
    api_sender::ActiveModel {
        sender_uuid: Set(api_sender_id),
        api_id: Set(author.id),
        login_id: Set(external.id),
        display_name: Set("API sender".into()),
    }
    .insert(db)
    .await
    .unwrap();
    for (index, sender) in [
        None,
        Some(profile_key.as_str()),
        Some(api_sender_key.as_str()),
        Some("unmapped-3873"),
    ]
    .into_iter()
    .enumerate()
    {
        let message = mk_analysis_message(
            db,
            &format!("label-panel-{index}"),
            "3873",
            test_dt(2026, 10, 25, 12, 0),
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        signal_message_group::Entity::update_many()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .col_expr(signal_message_group::Column::Sender, Expr::value(sender))
            .col_expr(
                signal_message_group::Column::LoginId,
                Expr::value(Some(if sender == Some(api_sender_key.as_str()) {
                    external.id
                } else {
                    author.id
                })),
            )
            .exec(db)
            .await
            .unwrap();
    }
    let allowed = vec![fixture.alpha.signal_group.master_key.clone()];
    let mut req = DailyMessageStatsReq {
        user_label_id: None,
        from_date: "2026-10-25".into(),
        to_date: "2026-10-25".into(),
        grouping: DailyMessageStatsGrouping::DailyStatsSenders,
        selected_groups: None,
        selected_senders: None,
        selected_unit_ids: None,
        cursor: None,
    };
    let own_access =
        DailyMessageStatsAccess::for_organism(allowed.clone(), Some(own.id));
    let other_access =
        DailyMessageStatsAccess::for_organism(allowed.clone(), Some(other.id));
    let panels = load_panels(db, &req, own_access.clone()).await.unwrap();
    assert_eq!(panels.len(), 2);
    assert!(panels.iter().any(|panel| panel.label_id == labels[0]
        && panel.organism_name.as_deref() == Some(own.name.as_str())));
    assert!(!panels.iter().any(|panel| panel.label_id == labels[1]));
    let other_panels =
        load_panels(db, &req, other_access.clone()).await.unwrap();
    assert!(other_panels.iter().any(|panel| panel.label_id == labels[1]));
    for label in [
        labels[0],
        labels[1],
        crate::config::USER_LABEL_UNASSIGNED_ID,
    ] {
        req.user_label_id = Some(label);
        let stats = load(db, &req, allowed.clone()).await.unwrap();
        let expected: Vec<String> = if label == labels[0] {
            vec![author.id.to_string()]
        } else if label == labels[1] {
            vec![profile_key.clone(), api_sender_key.clone()]
        } else {
            vec!["unmapped-3873".into()]
        };
        assert_eq!(stats.series.len(), expected.len());
        for series in stats.series {
            assert_eq!(series.points[0].messages, 1);
            assert!(expected
                .iter()
                .any(|key| Some(key) == series.key.as_ref()));
        }
    }
    let hidden = load_panels(
        db,
        &req,
        DailyMessageStatsAccess::for_organism(vec![], Some(own.id)),
    )
    .await
    .unwrap();
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].label_id, crate::config::USER_LABEL_UNASSIGNED_ID);
    let duplicate = mk_login(
        db,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            signal_profile_id: Set(Some(profile_key.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    req.user_label_id = Some(labels[1]);
    let remaining = load(db, &req, allowed.clone()).await.unwrap();
    assert_eq!(remaining.series.len(), 1);
    assert_eq!(
        remaining.series[0].key.as_deref(),
        Some(api_sender_key.as_str())
    );
    req.user_label_id = Some(crate::config::USER_LABEL_UNASSIGNED_ID);
    assert_eq!(
        load(db, &req, allowed.clone()).await.unwrap().series.len(),
        2
    );
    login::Entity::delete_by_id(duplicate.id)
        .exec(db)
        .await
        .unwrap();

    let child = mk_organism(
        db,
        organism::ActiveModel {
            parent_id: Set(Some(own.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut unlabelled = vec![];
    for organism_id in [own.id, other.id, child.id] {
        let user = mk_login(
            db,
            login::ActiveModel {
                organism_id: Set(Some(organism_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_analysis_message(
            db,
            &format!("label-unassigned-{organism_id}"),
            "3873",
            test_dt(2026, 10, 25, 12, 0),
            &[&fixture.alpha],
            &[],
            false,
        )
        .await
        .unwrap();
        signal_message_group::Entity::update_many()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .col_expr(
                signal_message_group::Column::Sender,
                Expr::value(Some(user.id.to_string())),
            )
            .col_expr(
                signal_message_group::Column::LoginId,
                Expr::value(Some(author.id)),
            )
            .exec(db)
            .await
            .unwrap();
        unlabelled.push(user);
    }
    let stats = load(db, &req, own_access.clone()).await.unwrap();
    assert_eq!(stats.series.len(), 1);
    assert_eq!(
        stats.series[0].key.as_deref(),
        Some(unlabelled[0].id.to_string().as_str())
    );
    assert_eq!(stats.series[0].points[0].messages, 1);
    req.user_label_id = Some(labels[1]);
    assert!(load(db, &req, own_access.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    req.user_label_id = None;
    let stats = load(db, &req, own_access.clone()).await.unwrap();
    assert_eq!(stats.series.len(), 2);
    assert!(stats
        .series
        .iter()
        .all(|series| series.points[0].messages == 1));
    let other_stats = load(db, &req, other_access.clone()).await.unwrap();
    assert_eq!(other_stats.series.len(), 3);
    let sender_page = load_sender_page(
        db,
        &DailyMessageStatsSendersReq {
            filter: req.clone(),
            search: None,
            cursor: None,
        },
        own_access.clone(),
        "own".into(),
    )
    .await
    .unwrap();
    assert_eq!(sender_page.total, 2);
    let counts = load_group_counts(db, &req, own_access.clone())
        .await
        .unwrap();
    assert_eq!(counts[0].count, 2);
    let hierarchy = crate::sigint::unit::hierarchy::load(&fixture.env)
        .await
        .unwrap();
    let counts =
        load_unit_options(db, &req, own_access.clone(), &hierarchy, true)
            .await
            .unwrap();
    assert_eq!(
        counts
            .iter()
            .find(|count| count.value == "unit-id:0")
            .unwrap()
            .count,
        2
    );
    let catalog = load_catalog(
        &fixture.env,
        &DailyMessageStatsCatalogReq {
            known_hierarchy_revision: None,
            selected_senders: [
                Some(author.id.to_string()),
                Some(unlabelled[0].id.to_string()),
                Some(profile_key.clone()),
                Some("unmapped-3873".into()),
                None,
            ]
            .into_iter()
            .map(|sender| super::daily_messages::DailyMessageSenderKey {
                sender,
            })
            .collect(),
        },
        own_access.clone(),
        "own".into(),
    )
    .await
    .unwrap();
    assert_eq!(catalog.sender_labels.len(), 2);
    req.grouping = DailyMessageStatsGrouping::DailyStatsGroups;
    let options = load_options(
        db,
        &DailyMessageStatsOptionsReq {
            filter: req.clone(),
            search: None,
            include_children: None,
        },
        own_access.clone(),
    )
    .await
    .unwrap();
    assert_eq!(options.options[0].count, 2);
    let no_organism = DailyMessageStatsAccess::for_organism(allowed, None);
    assert!(load_panels(db, &req, no_organism.clone())
        .await
        .unwrap()
        .is_empty());
    assert!(load(db, &req, no_organism).await.unwrap().series.is_empty());

    req.grouping = DailyMessageStatsGrouping::DailyStatsSenders;
    for id in [unlabelled[0].id, author.id] {
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
            [id.into(), own.id.into()])).await.unwrap();
    }
    assert!(load(db, &req, own_access.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    req.user_label_id = Some(crate::config::USER_LABEL_UNASSIGNED_ID);
    assert!(load(db, &req, own_access.clone())
        .await
        .unwrap()
        .series
        .is_empty());
    let panels = load_panels(db, &req, own_access).await.unwrap();
    assert_eq!(
        panels
            .iter()
            .map(|panel| panel.label_id)
            .collect::<Vec<_>>(),
        vec![crate::config::USER_LABEL_UNASSIGNED_ID]
    );
    req.user_label_id = None;
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
        [external.id.into(), other.id.into()])).await.unwrap();
    let remaining = load(db, &req, other_access.clone()).await.unwrap();
    assert_eq!(remaining.series.len(), 1);
    assert_eq!(
        remaining.series[0].key.as_deref(),
        Some(unlabelled[1].id.to_string().as_str())
    );
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"delete from organism_message_stats_exclusion where login_id=$1"#,
        [external.id.into()],
    ))
    .await
    .unwrap();
    let ambiguous = mk_login(
        db,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            signal_profile_id: Set(Some(profile_key.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
        [ambiguous.id.into(), own.id.into()])).await.unwrap();
    let remaining = load(db, &req, other_access.clone()).await.unwrap();
    assert_eq!(remaining.series.len(), 2);
    assert!(remaining
        .series
        .iter()
        .all(|series| series.key.as_deref() != Some(profile_key.as_str())));
    api_sender::ActiveModel {
        sender_uuid: Set(author.id),
        api_id: Set(external.id),
        login_id: Set(external.id),
        display_name: Set("Excluded direct UUID".into()),
    }
    .insert(db)
    .await
    .unwrap();
    let remaining = load(db, &req, other_access).await.unwrap();
    assert!(remaining
        .series
        .iter()
        .all(|series| series.key.as_deref()
            != Some(author.id.to_string().as_str())));
}

#[actix_web::test]
#[serial]
async fn issue_3873_statistics_revalidate_organism_for_cached_and_legacy_routes(
) {
    use super::daily_messages::*;
    let fixture = mk_rer_analysis_fixture().await.unwrap();
    let db = &fixture.env.dbx;
    let viewer = find_test_login(db).await.unwrap();
    let own = viewer.organism_id.unwrap();
    let other = mk_organism(db, Default::default()).await.unwrap();
    mk_organism_aor(
        db,
        organism_aor::ActiveModel {
            organism_id: Set(other.id),
            aor_id: Set(fixture.north_aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut authors = vec![];
    let mut labels = vec![];
    for (index, organism_id) in [own, other.id].into_iter().enumerate() {
        let author = mk_login(
            db,
            login::ActiveModel {
                organism_id: Set(Some(organism_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let label = crate::organism::labels::OrganismUserLabel::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"insert into organism_user_label(organism_id,name,color) values ($1,'Same name','#87d7f1') returning *"#, [organism_id.into()])).one(db).await.unwrap().unwrap();
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"insert into organism_user_label_assignment(login_id,organism_id,label_id) values ($1,$2,$3)"#, [author.id.into(), organism_id.into(), label.id.into()])).await.unwrap();
        for number in 0..=index {
            let message = mk_analysis_message(
                db,
                &format!("organism-scope-{index}-{number}"),
                "3873",
                test_dt(2026, 10, 25, 12, 0),
                &[&fixture.alpha],
                &[],
                false,
            )
            .await
            .unwrap();
            signal_message_group::Entity::update_many()
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .eq(message.id),
                )
                .col_expr(
                    signal_message_group::Column::Sender,
                    Expr::value(Some(author.id.to_string())),
                )
                .exec(db)
                .await
                .unwrap();
        }
        authors.push(author);
        labels.push(label.id);
    }
    let store = RedisSessionStore::new(
        crate::redis_conn_string(&fixture.env.config).unwrap(),
    )
    .await
    .unwrap();
    let app = actix_test::init_service(
        App::new()
            .app_data(Data::from(fixture.env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route(
                "/test/organism-stats-login/{login}",
                web::post().to(activity_daily_test_login),
            )
            .service(daily_messages)
            .service(daily_message_options)
            .service(daily_catalog)
            .service(daily_facet_counts)
            .service(daily_senders)
            .service(daily_panels)
            .service(crate::organism::message_statistics::set_exclusion),
    )
    .await;
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("/test/organism-stats-login/{}", viewer.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let filter = serde_json::json!({"from_date":"2026-10-25","to_date":"2026-10-25","grouping":"Senders","selected_groups":[fixture.alpha.signal_group.master_key],"selected_senders":null,"selected_unit_ids":null,"cursor":null});
    let mut revisions = vec![];
    for (organism_id, role, author_index) in [
        (Some(own), "Rer", Some(0)),
        (Some(other.id), "Rer", Some(1)),
        (None, "Rer", None),
        (Some(own), "Admin", Some(0)),
    ] {
        login::Entity::update_many()
            .filter(login::Column::Id.eq(viewer.id))
            .col_expr(login::Column::OrganismId, Expr::value(organism_id))
            .col_expr(
                login::Column::Roles,
                Expr::value(serde_json::json!([role])),
            )
            .exec(db)
            .await
            .unwrap();
        macro_rules! call {
            ($path:expr, $body:expr) => {{
                let response = actix_test::call_service(
                    &app,
                    actix_test::TestRequest::post()
                        .uri($path)
                        .cookie(cookie.clone())
                        .set_json($body)
                        .to_request(),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK, "{}", $path);
                let body: serde_json::Value =
                    actix_test::read_body_json(response).await;
                body
            }};
        }
        let stats = call!("/api/rer/analysis/stats/daily-messages", &filter);
        assert_eq!(
            stats["series"].as_array().unwrap().len(),
            usize::from(author_index.is_some())
        );
        if let Some(index) = author_index {
            assert_eq!(
                stats["series"][0]["key"],
                authors[index].id.to_string()
            );
            assert_eq!(stats["series"][0]["points"][0]["messages"], index + 1);
        }
        let options = call!(
            "/api/rer/analysis/stats/daily-messages/options",
            serde_json::json!({"filter":filter,"search":null,"include_children":true})
        );
        assert_eq!(options["total"], usize::from(author_index.is_some()));
        let panels =
            call!("/api/rer/analysis/stats/daily-messages/panels", &filter);
        let panel_ids: Vec<_> = panels["panels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|panel| panel["label_id"].as_i64().unwrap())
            .collect();
        assert_eq!(
            panel_ids,
            author_index.map_or(vec![], |index| vec![
                labels[index],
                crate::config::USER_LABEL_UNASSIGNED_ID
            ])
        );
        let catalog = call!(
            "/api/rer/analysis/stats/daily-messages/catalog",
            serde_json::json!({"known_hierarchy_revision":null,"selected_senders":authors.iter().map(|author| serde_json::json!({"sender":author.id})).collect::<Vec<_>>()})
        );
        assert_eq!(
            catalog["sender_labels"].as_array().unwrap().len(),
            usize::from(author_index.is_some())
        );
        let counts = call!(
            "/api/rer/analysis/stats/daily-messages/facet-counts",
            serde_json::json!({"filter":filter,"facet":"Groups","include_children":true})
        );
        let count = counts["counts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["value"] == fixture.alpha.signal_group.master_key)
            .map_or(0, |row| row["count"].as_u64().unwrap());
        assert_eq!(count, author_index.map_or(0, |index| index as u64 + 1));
        revisions.push(counts["access_revision"].clone());
        let sender_page = call!(
            "/api/rer/analysis/stats/daily-messages/senders",
            serde_json::json!({"filter":filter,"search":null,"cursor":null})
        );
        assert_eq!(sender_page["total"], usize::from(author_index.is_some()));
        let foreign = call!(
            "/api/rer/analysis/stats/daily-messages",
            serde_json::json!({"user_label_id":author_index.map(|index| labels[1-index]),"from_date":"2026-10-25","to_date":"2026-10-25","grouping":"Senders"})
        );
        assert!(foreign["series"].as_array().unwrap().is_empty());
        if role == "Admin" {
            let unit_filter = serde_json::json!({"filter":filter,"facet":"Units","include_children":true});
            let _ = call!(
                "/api/rer/analysis/stats/daily-messages/facet-counts",
                &unit_filter
            );
            let mut previous_revision = counts["access_revision"].clone();
            for excluded in [true, false] {
                call!(
                    "/api/organism/message-stats-exclusion",
                    serde_json::json!({"organism_id":own,"login_id":authors[0].id,"excluded":excluded})
                );
                let expected = usize::from(!excluded);
                let stats =
                    call!("/api/rer/analysis/stats/daily-messages", &filter);
                assert_eq!(stats["series"].as_array().unwrap().len(), expected);
                let counts = call!(
                    "/api/rer/analysis/stats/daily-messages/facet-counts",
                    serde_json::json!({"filter":filter,"facet":"Groups","include_children":true})
                );
                assert_ne!(counts["access_revision"], previous_revision);
                previous_revision = counts["access_revision"].clone();
                assert_eq!(
                    counts["counts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["value"]
                            == fixture.alpha.signal_group.master_key)
                        .unwrap()["count"],
                    expected
                );
                let unit_counts = call!(
                    "/api/rer/analysis/stats/daily-messages/facet-counts",
                    &unit_filter
                );
                assert_eq!(
                    unit_counts["counts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|row| row["value"] == "unit-id:0")
                        .unwrap()["count"],
                    expected
                );
                let sender_page = call!(
                    "/api/rer/analysis/stats/daily-messages/senders",
                    serde_json::json!({"filter":filter,"search":null,"cursor":null})
                );
                assert_eq!(sender_page["total"], expected);
                let options = call!(
                    "/api/rer/analysis/stats/daily-messages/options",
                    serde_json::json!({"filter":filter,"search":null,"include_children":true})
                );
                assert_eq!(options["total"], expected);
                let panels = call!(
                    "/api/rer/analysis/stats/daily-messages/panels",
                    &filter
                );
                assert_eq!(
                    panels["panels"].as_array().unwrap().len(),
                    expected + 1
                );
                let catalog = call!(
                    "/api/rer/analysis/stats/daily-messages/catalog",
                    serde_json::json!({"known_hierarchy_revision":null,"selected_senders":[{"sender":authors[0].id}]})
                );
                assert_eq!(
                    catalog["sender_labels"].as_array().unwrap().len(),
                    expected
                );
            }
        }
    }
    assert_ne!(revisions[0], revisions[1]);
    assert_ne!(revisions[1], revisions[2]);
}
