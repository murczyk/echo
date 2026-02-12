use crate::config::*;
use crate::types::*;
use crate::utils::worker_watch::spawn_named_worker;
use crate::{mk_conn_string, new_redis, new_redisb, storage};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::cookie::Key;
use actix_web::{web, App, HttpServer};

use crate::types::Mode::Live;
use milgeo_rs::MilGeo;
use tokio::runtime::Handle;
use tokio::signal::unix::{signal, SignalKind};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

mod admin;
pub mod discord;
mod healthcheck;
pub mod middleware;
pub mod monitoring;
pub use admin::RestartEchoRequest;

pub async fn new_env(mode: Mode) -> Result<Arc<Env>, AppError> {
    let config = read_config(mode).c(h!())?;
    let redis = new_redis(&config).await.c(h!())?;
    let redisb = new_redisb(&config).await.c(h!())?;
    let s3_config = mk_s3_config(&config).c(h!())?;
    let s3 = if let Some(s3_config) = &s3_config {
        let s3 = storage::build_s3_operator(s3_config).c(h!())?;
        if mode == Live
            && config.s3_config.clone().c(h!())?.strongbox_key.is_empty()
        {
            error!("strongbox_key is missing! please run oneoff-generate-strongbox-key, then copy strongbox_key from output and put to config.toml");
            None
        } else {
            Some(s3)
        }
    } else {
        error!("missing S3 config!");
        None
    };
    let mil_geo = MilGeo::new(&mk_conn_string(&config)[..]);
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let mut replicas = vec![];
    if let Some(replica_configs) = config.replicas.clone() {
        for replica in replica_configs {
            let host = replica
                .pg_host
                .clone()
                .or_else(|| config.pg_host.clone())
                .unwrap_or_else(|| DEFAULT_PG_HOST.to_string());
            let port = replica
                .pg_port
                .or(config.pg_port)
                .unwrap_or(DEFAULT_PG_PORT);
            match crate::new_pg_pool_from_replica(&config, &replica).await {
                Ok(pool) => {
                    let label = format!("{host}:{port}");
                    info!("replica pool ready {label}");
                    replicas.push(ReplicaPool { conn: pool, label });
                }
                Err(err) => {
                    warn!("failed to connect replica {host}:{port}: {err:?}");
                }
            }
        }
    }
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(RQ_TIMEOUT))
        .build()
        .c(h!())?;
    let m_greptimedb = if config.greptime_host.is_some()
        && config.greptime_host != Some("".to_string())
    {
        let e_greptimedb = crate::new_greptimedb_from_config(&config).await;
        match e_greptimedb {
            Ok(greptimedb) => Some(greptimedb),
            Err(e) => {
                warn!("failed to establish GreptimeDB connection: {e:?}");
                None
            }
        }
    } else {
        None
    };
    let settlement_paths = config.settlement_paths().c(h!())?;
    let settlements_data =
        crate::location::load_from_file(settlement_paths, mode)
            .unwrap_or_default();
    let settlements = Arc::new(RwLock::new(settlements_data));
    let callsigns_whitelist =
        crate::sigint::callsign::load_whitelist_from_file(mode)
            .await
            .c(h!())?;

    let version_file = match mode {
        Mode::Debug | Mode::Test => {
            std::env::current_dir().c(h!())?.to_path_buf()
        }
        Live => PathBuf::from("usr/share/echo"),
    }
    .join("version.txt");
    info!("version file: {}", version_file.display());
    let version = match tokio::fs::read_to_string(version_file).await {
        Ok(v) => v,
        Err(e) => {
            warn!("failed to read version file: {e:?}");
            "unknown".to_string()
        }
    };

    let env = Env {
        mode,
        redis: redis.clone(),
        redisb: redisb.clone(),
        s3,
        s3_config,
        mil_geo: mil_geo.clone(),
        dbx: dbx.clone(),
        rq,
        config: config.clone(),
        greptimedb: Arc::new(RwLock::new(m_greptimedb.clone())),
        settlements: settlements.clone(),
        callsigns_whitelist: callsigns_whitelist.clone(),
        version: version.clone(),
        replicas,
        tag_keyword_regex_cache: Arc::new(RwLock::new(Default::default())),
    };
    Ok(Arc::new(env))
}

pub async fn main_server(
    mode: Mode,
    ps: crate::ServerPs,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) -> Result<(), AppError> {
    let mut background_tasks: JoinSet<()> = JoinSet::new();
    let bg_set = &mut background_tasks;

    crate::migration::run_migration_1(mode).await.c(h!())?;

    let env = new_env(mode).await.c(h!())?;

    let config = env.config.clone();
    let config1 = config.clone();
    let dbx4 = env.dbx.clone();
    let dbx6 = env.dbx.clone();
    let dbx7 = env.dbx.clone();
    let dbx8 = env.dbx.clone();
    let dbx9 = env.dbx.clone();
    let dbx10 = env.dbx.clone();
    let dbx11 = env.dbx.clone();
    let mil_geo2 = env.mil_geo.clone();
    if let Err(e) = crate::rer_importer::import_csv::ensure_import_group_exists(
        &env.dbx, &config,
    )
    .await
    {
        warn!("Failed to ensure import group exists: {e:?}");
    };

    let redis_session_store =
        RedisSessionStore::new(crate::redis_conn_string(&config).c(h!())?)
            .await
            .c(h!())?;

    // Create JoinSet for background tasks

    if !ps.no_bgworker {
        if let Some(secret_config) = config.vault_config.clone() {
            spawn_named_worker("secret_worker", bg_set, async move {
                crate::secret::secret_worker(secret_config).await
            });
        }
        spawn_named_worker("healthcheck_worker", bg_set, async move {
            healthcheck::healthcheck_worker(&dbx9, config1).await;
        });
        // Activity details worker
        if let Some(greptimedb) = env.greptime() {
            let redis = env.redis.clone();
            spawn_named_worker("activity_details_worker", bg_set, async move {
                middleware::activity_details_worker(redis, greptimedb).await;
            });
        }

        if !config.disable_cleanup_networks_worker.unwrap_or(false) {
            spawn_named_worker("cleanup_networks_worker", bg_set, async move {
                crate::sigint::network::cleanup_networks_worker(&dbx4).await;
            });
        }
        if config.fill_comp_freq_worker {
            spawn_named_worker("fill_comp_freq_worker", bg_set, async move {
                crate::rer_importer::reports::fill_comp_freq_worker(&dbx6)
                    .await;
            });
        }
        if !config.disable_inactive_users_worker.unwrap_or(false) {
            spawn_named_worker("inactive_users_worker", bg_set, async move {
                crate::users::inactive_users_worker(&dbx7).await;
            });
        }
        if !config.disable_unit_location_v2_worker.unwrap_or(false) {
            spawn_named_worker("location_v2_worker", bg_set, async move {
                crate::location::worker::process_location_v2_coords_worker(
                    &dbx8, mil_geo2,
                )
                .await;
            });
        }

        // AoR assignments consistency check worker (runs every 5 minutes)
        spawn_named_worker("aor_assignments_worker", bg_set, async move {
            crate::sigint::aor::worker::aor_assignments_check_worker(&dbx10)
                .await;
        });
        let token_1 = cancel_token.clone();
        let shutdown_handle_1 = shutdown_handle.clone();
        spawn_named_worker("messenger_receive_worker", bg_set, async move {
            crate::messenger::worker::receive_thread_nofail(
                mode,
                token_1,
                shutdown_handle_1,
            )
            .await;
        });
        let token_2 = cancel_token.clone();
        spawn_named_worker("process_queue_nofail", bg_set, async move {
            crate::messenger::worker::queue::process_queue_nofail(
                mode, token_2,
            )
            .await;
        });
        spawn_named_worker("operator_inbox_worker", bg_set, async move {
            crate::operator::worker::run_operator_inbox_worker_nofail(mode)
                .await;
        });
        spawn_named_worker("echo_im_cleanup", bg_set, async move {
            crate::messenger::worker::cleanup::run_cleanup_worker(mode).await;
        });
        spawn_named_worker("recent_inbox_network_worker", bg_set, async move {
            crate::sigint::network::etalon_calc::worker::run_recent_inbox_network_worker_nofail(mode).await;
        });
        spawn_named_worker("old_inbox_network_worker", bg_set, async move {
            crate::sigint::network::etalon_calc::worker::run_old_inbox_network_worker_nofail(
                mode,
            )
            .await;
        });
        spawn_named_worker(
            "inbox_network_daily_consistency_worker",
            bg_set,
            async move {
                crate::sigint::network::etalon_calc::worker::run_inbox_network_daily_consistency_worker_nofail(mode).await;
            },
        );
        spawn_named_worker(
            "worker_calculate_group_stats",
            bg_set,
            async move {
                crate::stats::worker::group_stats::worker_calculate_group_stats(mode).await;
            },
        );
        let rq2 = env.rq.clone();
        let tag_keyword_regex_cache = env.tag_keyword_regex_cache.clone();
        let token_2 = cancel_token.clone();
        let redis2 = env.redis.clone();
        if !config.disable_suggest_message_tags_worker.unwrap_or(false) {
            spawn_named_worker(
                "suggest_message_tags_worker",
                bg_set,
                async move {
                    let mut redis = redis2;
                    crate::tags::worker::suggest_message_tags_worker(
                        &rq2,
                        &dbx11,
                        &mut redis,
                        &tag_keyword_regex_cache,
                        token_2,
                    )
                    .await;
                },
            );
        }
    }

    spawn_named_worker("signal_cli_verbose_logger", bg_set, async move {
        info!("Starting enable_signal_cli_verbose_logging");
        if let Err(e) = echo_im::enable_signal_cli_verbose_logging(
            "echo",
            SIGNAL_CLIENT_PORT,
        )
        .await
        {
            if mode == Live {
                error!("failed to configure signal cli: {e:?}");
            }
        }
        info!("Done starting enable_signal_cli_verbose_logging");
    });

    if config.feature_tmp_in_memory.unwrap_or(false) {
        info!("Starting cleanup_tmp_worker_nofail");
        spawn_named_worker("cleanup_tmp_worker", bg_set, async move {
            echo_install_utils::tmpdir::cleanup_tmp_worker_nofail().await;
        });
    }

    let bind_ip = "0.0.0.0";
    let bind_port = if let Ok(port) = std::env::var("ECHO_SERVER_PORT") {
        info!("port overridden from env: {port}");
        port.parse::<u16>().c(h!())?
    } else {
        info!("starting echo server on default 8081 port. override it with ECHO_SERVER_PORT variable.");
        8081
    };
    info!("Starting server on {bind_ip}:{bind_port}");

    let env_for_server = env.clone();
    let server = HttpServer::new(move || {
        let env = env_for_server.clone();
        let cookie_secret = env.config.cookie_session_secret.clone();
        let redis_for_middleware = env.redis.clone();
        App::new()
            .wrap(actix_web::middleware::Compress::default())
            .app_data(actix_web::web::Data::from(env))
            // .wrap(
            //     actix_web::middleware::Logger::default()
            // )
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        IDENTITY_DURATION_HOURS * 60 * 60,
                    ))).build(),
            )
            .wrap(SessionMiddleware::new(
                redis_session_store.clone(),
                Key::from(cookie_secret.as_bytes()),
            ))
            .wrap(
                actix_web::middleware::from_fn(
                    middleware::mk_activity_middleware(Some(redis_for_middleware))
                )
            )
            .wrap(
                actix_web::middleware::from_fn(
                    middleware::access_log_middleware
                )
            )
            .service(self::monitoring::ping)
            .service(self::monitoring::public_ping)
            .service(self::monitoring::server_info)
            .service(self::monitoring::monitoring)
            // .service(api_logout)
            .service(crate::server::admin::restart_echo)
            .service(crate::server::admin::restart_datasource)
            .service(crate::kml::operatyvka)
            .service(crate::kml::operatyvka_download)
            .service(crate::kml::api_fix_kmz)
            .service(crate::atak::operatyvka_download)
            .service(crate::importer::download_kmz)
            .service(crate::terminal::parse_terminal_pdf)
            .service(crate::terminal::upload_screenshot)
            .service(crate::terminal::upload_pdf)
            .service(crate::delta::download_geojson)
            .service(crate::delta::bgtask_get_status_and_logs)
            .service(crate::delta::kmz_to_geojson)
            .service(crate::delta::csv::api_delta_csv_to_kmz)
            .service(crate::delta::radios_convert)
            .service(crate::delta::radios_download_result_per_date)
            .service(crate::delta::radios_download_result_per_radio)
            .service(crate::delta::radios_download_result_csv)
            .service(crate::delta::import_map)
            .service(crate::delta::get_geojson)
            .service(crate::delta::get_kml)
            .service(crate::delta::login::fetch_redirect_url)
            .service(crate::delta::login::handle_redirect)
            .service(crate::rer_importer::messenger_media)
            .service(crate::rer_importer::rer_importer_callsigns)
            .service(crate::rer_importer::callsigns_alchemy)
            .service(crate::rer_importer::unread_counters)
            .service(crate::rer_importer::signal_group_info)
            .service(crate::rer_importer::signal_group_info_batch)
            .service(crate::messenger::group::handlers::orphan_signal_groups)
            .service(crate::rer_importer::signal_profile_info)
            .service(crate::rer_importer::signal_profile_info_batch)
            .service(crate::rer_importer::signal_profile_save)
            .service(crate::rer_importer::latest_senders)
            .service(crate::rer_importer::list_messages)
            .service(crate::rer_importer::import_csv::rer_csv_import)
            .service(crate::rer_importer::import_csv::rer_delta_csv_import)
            .service(crate::rer_importer::import_kmz::rer_delta_kmz_import)
            .service(crate::rer_importer::inbox::inbox_messages)
            .service(crate::rer_importer::inbox::inbox_group_stats)
            .service(crate::rer_importer::inbox::get_inbox_map)
            .service(crate::rer_importer::inbox::inbox_messages_count)
            .service(crate::rer_importer::inbox::delete_message)
            .service(crate::rer_importer::inbox::comment_save)
            .service(crate::rer_importer::inbox::inbox_submit)
            .service(crate::rer_importer::inbox::inbox_cursor)
            .service(crate::rer_importer::inbox::update_inbox_cursor)
            .service(crate::rer_importer::inbox::messages_by_id)
            .service(crate::rer_importer::inbox::get_freq_pelengs_summary)
            .service(crate::rer_importer::analysis::stats_deprecated)
            .service(crate::rer_importer::analysis::aor_stats)
            .service(crate::rer_importer::analysis::aor_stats_count)
            .service(crate::rer_importer::analysis::network_stats)
            .service(crate::rer_importer::analysis::network_stats_count)
            .service(crate::rer_importer::analysis::count_stats)
            .service(crate::rer_importer::analysis::location_stats)
            .service(crate::rer_importer::analysis::unit_stats)
            .service(crate::rer_importer::analysis::tag_stats)
            .service(crate::rer_importer::analysis::callsign_stats)
            .service(crate::rer_importer::analysis::freq_stats)
            .service(crate::rer_importer::analysis::post_stats)
            .service(crate::rer_importer::analysis::sender_stats)
            .service(crate::rer_importer::analysis::group_stats)
            .service(crate::rer_importer::analysis::location_stats_count)
            .service(crate::rer_importer::analysis::unit_stats_count)
            .service(crate::rer_importer::analysis::tag_stats_count)
            .service(crate::rer_importer::analysis::callsign_stats_count)
            .service(crate::rer_importer::analysis::freq_stats_count)
            .service(crate::rer_importer::analysis::post_stats_count)
            .service(crate::rer_importer::analysis::sender_stats_count)
            .service(crate::rer_importer::analysis::group_stats_count)
            .service(crate::rer_importer::analysis::summary_table_freq)
            .service(crate::rer_importer::analysis::summary_table_xlsx)
            .service(crate::rer_importer::analysis::correlated_freqs)
            .service(crate::rer_importer::analysis::kmz::rer_analysis_download_kmz)
            .service(crate::rer_importer::analysis::geojson::rer_analysis_download_geojson)
            .service(crate::rer_importer::analysis::edit_freq_unit_name)
            .service(crate::rer_importer::analysis::saved_filters_list)
            .service(crate::rer_importer::analysis::saved_filters_duty_list)
            .service(crate::rer_importer::analysis::saved_filter_upsert)
            .service(crate::rer_importer::analysis::saved_filter_duty_upsert)
            .service(crate::rer_importer::analysis::saved_filter_rename)
            .service(crate::rer_importer::analysis::saved_filter_delete)
            .service(crate::rer_importer::analysis::new_callsigns)
            .service(crate::rer_importer::analysis::message_comments)
            .service(crate::rer_importer::analysis::batch_message_comments)
            .service(crate::rer_importer::analysis::message_draft_events)
            .service(crate::rer_importer::bookmark::bookmark_add)
            .service(crate::rer_importer::bookmark::bookmarks_list)
            .service(crate::rer_importer::bookmark::bookmark_rm)
            .service(crate::rer_importer::important::important_add)
            .service(crate::rer_importer::important::importants_list)
            .service(crate::rer_importer::important::important_rm)
            .service(crate::rer_importer::callsigns::callsigns_graph)
            .service(crate::rer_importer::gdoc::rer_callsign_info)
            .service(crate::rer_importer::gdoc::rer_callsign_info_batch)
            .service(crate::rer_importer::reports::report_docx)
            .service(crate::location::find_locations)
            .service(crate::location::fetch_regions)
            .service(crate::users::user_login)
            .service(crate::users::user_test_api_login)
            .service(crate::users::api_user)
            .service(crate::users::api_user_info)
            .service(crate::users::user_logout)
            .service(crate::users::settings_save)
            .service(crate::users::user_sigint_groups)
            .service(crate::users::user_sigint_groups_detailed)
            .service(crate::users::list_logins)
            .service(crate::users::create_login)
            .service(crate::users::create_delta_login)
            .service(crate::users::delete_login)
            .service(crate::users::update_login)
            .service(crate::users::keep_alive)
            .service(crate::organism::list_organisms)
            .service(crate::organism::create_organism)
            .service(crate::organism::update_organism)
            .service(crate::organism::delete_organism)
            .service(crate::organism::add_group_to_organism)
            .service(crate::organism::remove_group_from_organism)
            .service(crate::organism::group_list)
            .service(crate::organism::organism_group_list)
            .service(crate::organism::organism_available_groups)
            .service(crate::organism::organism_compute_available_groups)
            .service(crate::organism::organism_compute_available_groups_for_new)
            .service(crate::organism::organism_available_groups_batch)
            .service(crate::organism::organism_active_logins)
            .service(crate::organism::my_scope)
            .service(crate::datasource::list_datasources)
            .service(crate::datasource::datasource_group_list)
            .service(crate::sigint::zone::zones_list)
            .service(crate::sigint::zone::zones_datasources_list)
            .service(crate::sigint::zone::zones_datasources_groups_list)
            .service(crate::sigint::zone::zones_datasources_group_update)
            .service(crate::sigint::zone::zones_datasources_group_add)
            .service(crate::sigint::zone::zones_datasources_group_delete)
            .service(crate::sigint::unit::list_units)
            .service(crate::sigint::unit::list_units_by_id)
            .service(crate::sigint::unit::create_unit)
            .service(crate::sigint::unit::update_unit)
            .service(crate::sigint::unit::delete_unit)
            .service(crate::sigint::unit::delete_unit_duplicate)
            .service(crate::sigint::unit::units_search)
            .service(crate::sigint::callsign::list_callsigns)
            .service(crate::sigint::callsign::list_callsigns_csv)
            .service(crate::sigint::callsign::get_callsigns_with_units_from_inbox)
            .service(crate::sigint::callsign::create_callsign)
            .service(crate::sigint::callsign::update_callsign)
            .service(crate::sigint::callsign::delete_callsign)
            .service(crate::sigint::callsign::callsign_unit_stats)
            .service(crate::sigint::callsign::network_callsign::add_as_known_network_callsigns)
            .service(crate::sigint::callsign::network_callsign::create_network_callsign)
            .service(crate::sigint::callsign::network_callsign::delete_network_callsign)
            .service(crate::sigint::callsign::network_callsign::list_network_callsigns)
            .service(crate::sigint::callsign::network_callsign::network_callsigns_activity)
            .service(crate::sigint::callsign::network_callsign::update_network_callsign)
            .service(crate::sigint::key::list_keys)
            .service(crate::sigint::key::create_key)
            .service(crate::sigint::key::update_key)
            .service(crate::sigint::key::delete_key)
            .service(crate::sigint::key::admin::list_key_share_policies)
            .service(crate::sigint::key::admin::create_key_share_policy)
            .service(crate::sigint::key::admin::delete_key_share_policy)
            .service(crate::sigint::freq::freq_exists)
            .service(crate::sigint::freq::list_freqs)
            .service(crate::sigint::freq::list_freqs_v2)
            .service(crate::sigint::freq::list_freqs_for_period)
            .service(crate::sigint::freq::list_callsigns_by_freqs)
            .service(crate::sigint::freq::list_points_by_freq)
            .service(crate::sigint::freq::list_groups_by_freqs_per_day)
            .service(crate::sigint::freq::latest_frequencies)
            .service(crate::sigint::network::network_list)
            .service(crate::sigint::network::network_info_one)
            .service(crate::sigint::network::network_info_batch_id)
            .service(crate::sigint::network::network_info_batch_freq)
            .service(crate::sigint::network::update_freq_networks)
            .service(crate::sigint::network::create_network)
            .service(crate::sigint::network::delete_network)
            .service(crate::sigint::network::delete_network_freq)
            .service(crate::sigint::network::update_network_freq)
            .service(crate::sigint::network::add_network_freq)
            .service(crate::sigint::network::network_unit_stats)
            .service(crate::sigint::network::update_network)
            .service(crate::sigint::network::report_networks_goi)
            .service(crate::sigint::network::restore_network)
            .service(crate::sigint::network::network_callsigns)
            .service(crate::sigint::network::network_callsigns_list)
            .service(crate::sigint::network::network_freqs_activity_one)
            .service(crate::sigint::network::network_freqs_list)
            .service(crate::sigint::network::network_group_activity)
            .service(crate::sigint::network::network_group_activity_one)
            .service(crate::sigint::network::network_signals_list)
            .service(crate::sigint::network::list_network_points)
            .service(crate::sigint::network::merge_network)
            .service(crate::sigint::network::modulations_list)
            .service(crate::sigint::network::update_network_posts)
            .service(crate::sigint::network::update_network_units)
            .service(crate::sigint::post::post_list)
            .service(crate::sigint::post::create_post)
            .service(crate::sigint::post::update_post)
            .service(crate::sigint::post::delete_post)
            .service(crate::sigint::network::add_network_descriptions)
            .service(crate::sigint::network::update_network_description)
            .service(crate::sigint::network::delete_network_description)
            .service(crate::sigint::freq::freq_unit_stats)
            .service(crate::sigint::freq::freq_activity_daily)
            .service(crate::sigint::freq::list_alt_unit_by_freqs)
            .service(crate::sigint::freq::callsigns_for_filter)
            .service(crate::sigint::aor::aor_list)
            .service(crate::sigint::aor::create_aor)
            .service(crate::sigint::aor::update_aor)
            .service(crate::sigint::aor::delete_aor)
            .service(crate::sigint::etalonka::report_networks)
            .service(crate::sigint::etalonka::report_networks_batch_id)
            .service(crate::sigint::source::list_sources)
            .service(crate::sigint::signal::create_signal)
            .service(crate::sigint::signal::list_signals)
            .service(crate::sigint::signal::list_signals_csv)
            .service(crate::sigint::signal::delete_signal)
            .service(crate::sigint::signal::update_signal)
            .service(crate::sigint::signal::signal_unit_stats)
            .service(crate::tags::admin_list_tags)
            .service(crate::tags::create_tag)
            .service(crate::tags::update_tag)
            .service(crate::tags::tags_list)
            .service(crate::tags::add_tag_keywords)
            .service(crate::tags::update_tag_keyword)
            .service(crate::tags::delete_tag_keyword)
            .service(crate::tags::inbox_message_tags_add)
            .service(crate::tags::inbox_message_tags_rm)
            .service(crate::tags::inbox_message_tags_model_error)
            .service(crate::tags::get_inbox_message_model_errors)
            .service(crate::log_api::log_error)
            .service(crate::event_stream::long_poll)
            .service(crate::messenger::list_messengers)
            .service(crate::messenger::get_qr)
            .service(crate::messenger::is_linked)
            .service(crate::messenger::edit)
            .service(crate::messenger::unlink)
            .service(crate::messenger::link)
            .service(crate::messenger::link_operator)
            .service(crate::messenger::group_update)
            .service(crate::operator::message_submit)
            .service(crate::palitra::list_all_palitras)
            .service(crate::palitra::list_all_palitras_detailed)
            .service(crate::palitra::list_palitra_points)
            .service(crate::palitra::suggest_palitra_point_labels)
            .service(crate::palitra::search_palitra_points)
            .service(crate::palitra::create_palitra)
            .service(crate::palitra::create_palitra_with_kmz)
            .service(crate::palitra::update_palitra)
            .service(crate::palitra::delete_palitra)
            .service(crate::palitra::upload_palitra_points)
            .service(crate::palitra::analyze_kmz)
            .service(crate::alpine::convert_alpinequest_file)
            .service(crate::alpine::download_alpine_result)
            .service(
                web::scope(get_assets_url())
                    .route("/{filename:.*}", web::get().to(crate::storage::serve_assets)))
    })
        .bind((bind_ip, bind_port))?
        .run();

    let task_completion_future = async move {
        while background_tasks.join_next().await.is_some() {
            // do nothing
        }
        info!("[Background] All tasks in JoinSet completed on their own.");
    };

    let server_handle = server.handle();
    let mut sigint = signal(SignalKind::interrupt())
        .expect("Failed to register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate())
        .expect("Failed to register SIGTERM handler");

    shutdown_handle.spawn(async move {
        tokio::select! {
            _ = sigint.recv() => {
                println!("\n[SIGINT / CTRL+C] detected. Signaling shutdown.");
                cancel_token.cancel();
            },
            _ = sigterm.recv() => {
                println!("\n[SIGTERM / KILL] detected. Signaling shutdown.");
                cancel_token.cancel();
            },
            _ = tokio::signal::ctrl_c() => {
                info!("\n[CTRL+C] detected. Starting graceful shutdown...");
                cancel_token.cancel();
                server_handle.stop(true).await;
            },
            _ = task_completion_future => {
                info!("[Main] All background tasks finished. Stopping actix server.");
                server_handle.stop(true).await;
            }
            _ = server => {
                info!("[Main] Actix server finished normally. Signaling task cancellation.");
                cancel_token.cancel();
            }
        }
    }).await.c(h!())?;
    Ok(())
}
