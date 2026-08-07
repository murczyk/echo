use crate::config::*;
use crate::types::*;
use crate::utils::worker_watch::spawn_named_worker;
use crate::{mk_conn_string, new_redis, new_redis_for_db, new_redisb, storage};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::cookie::Key;
use actix_web::{web, App, HttpServer};

use crate::types::Mode::Live;
use milgeo_rs::MilGeo;
use std::net::TcpListener;
use std::os::unix::io::FromRawFd;
use tokio::runtime::Handle;
use tokio::signal::unix::{signal, SignalKind};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

mod admin;
mod analytics_health;
pub mod discord;
mod healthcheck;
pub mod middleware;
pub mod monitoring;
pub use admin::RestartEchoRequest;

fn systemd_listener() -> Result<Option<TcpListener>, AppError> {
    let listen_fds: i32 = match std::env::var("LISTEN_FDS") {
        Ok(value) => value.parse().unwrap_or(0),
        Err(_) => 0,
    };
    if listen_fds == 0 {
        return Ok(None);
    }
    let listen_pid: u32 = match std::env::var("LISTEN_PID") {
        Ok(value) => value.parse().unwrap_or(0),
        Err(_) => 0,
    };
    if listen_pid != std::process::id() {
        return Ok(None);
    }
    if listen_fds != 1 {
        warn!("LISTEN_FDS={listen_fds}, using first socket only");
    }
    let listener = unsafe { TcpListener::from_raw_fd(3) };
    listener.set_nonblocking(true).c(h!())?;
    std::env::remove_var("LISTEN_FDS");
    std::env::remove_var("LISTEN_PID");
    Ok(Some(listener))
}

pub async fn new_env(mode: Mode) -> Result<Arc<Env>, AppError> {
    let config = read_config(mode).c(h!())?;
    let metrics = crate::telemetry::Metrics::from_config(&config);
    let redis = new_redis(&config).await.c(h!())?;
    let stats_redis = new_redis_for_db(&config, config.group_stats_redis_db())
        .await
        .c(h!())?;
    let redisb = new_redisb(&config).await.c(h!())?;
    let s3_config = mk_s3_config(&config).c(h!())?;
    let s3 = if let Some(s3_config) = &s3_config {
        let s3 = storage::build_s3_operator(s3_config).c(h!())?;
        if mode == Live
            && config.s3_config.clone().c(h!())?.strongbox_key.is_empty()
        {
            error!(
                "strongbox_key is missing! please run oneoff-generate-strongbox-key, then copy strongbox_key from output and put to config.toml"
            );
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
    crate::ai_agent::dispatcher::import_legacy_config(
        &dbx,
        config.ai_agent_dispatcher.as_ref(),
    )
    .await
    .c(h!())?;
    let echo_gpu_client = Arc::new(
        echo_gpu_client::EchoGpuClient::new(
            dbx.clone(),
            echo_gpu_client::EchoGpuClientOptions::default(),
        )
        .await
        .c(h!())?,
    );
    let file_registry_db = crate::file_registry::connect_runtime(&config, mode)
        .await
        .c(h!())?;
    if file_registry_db.is_none() {
        log_missing_file_registry_configuration(&dbx, mode).await;
    }
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
                    warn!("failed to connect replica {host}:{port}: {:?}", err);
                }
            }
        }
    }
    let analytics = connect_analytics(&config).await;
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(RQ_TIMEOUT))
        .build()
        .c(h!())?;
    let rq_goi_associations: reqwest::Client =
        reqwest::Client::builder().build().c(h!())?;
    let m_greptimedb = if config.greptime_host.is_some()
        && config.greptime_host != Some("".to_string())
    {
        let e_greptimedb = crate::new_greptimedb_from_config(&config).await;
        match e_greptimedb {
            Ok(greptimedb) => Some(greptimedb),
            Err(e) => {
                warn!("failed to establish GreptimeDB connection: {:?}", e);
                None
            }
        }
    } else {
        None
    };
    let session_activity_queue_capacity = config
        .session_activity_queue_capacity
        .unwrap_or(SESSION_ACTIVITY_QUEUE_CAPACITY_DEFAULT);
    let (session_activity_tx, session_activity_rx) =
        if m_greptimedb.is_some() && session_activity_queue_capacity > 0 {
            let (tx, rx) =
                tokio::sync::mpsc::channel(session_activity_queue_capacity);
            (Some(tx), Some(rx))
        } else {
            if m_greptimedb.is_some() && session_activity_queue_capacity == 0 {
                warn!("session activity queue disabled: capacity is 0");
            }
            (None, None)
        };
    let settlement_paths = config.settlement_paths().c(h!())?;
    let settlements_data =
        crate::location::load_settlements_data_config(settlement_paths, mode)
            .c(h!())?;
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
            warn!("failed to read version file: {:?}", e);
            "unknown".to_string()
        }
    };

    let env = Env {
        mode,
        redis: redis.clone(),
        stats_redis,
        redisb: redisb.clone(),
        s3,
        s3_config,
        mil_geo: mil_geo.clone(),
        dbx: dbx.clone(),
        echo_gpu_client,
        file_registry_db,
        rq,
        rq_goi_associations,
        config: config.clone(),
        metrics,
        greptimedb: Arc::new(RwLock::new(m_greptimedb.clone())),
        settlements: settlements.clone(),
        callsigns_whitelist: callsigns_whitelist.clone(),
        version: version.clone(),
        replicas,
        analytics,
        tag_keyword_regex_cache: Arc::new(RwLock::new(Default::default())),
        session_activity_tx,
        session_activity_rx: Arc::new(tokio::sync::Mutex::new(
            session_activity_rx,
        )),
        session_activity_dropped: Arc::new(std::sync::atomic::AtomicU64::new(
            0,
        )),
        session_activity_enqueued: Arc::new(std::sync::atomic::AtomicU64::new(
            0,
        )),
        palitra_worker_context: Arc::new(Default::default()),
    };
    crate::location::aor_config::init_aor_location_config(
        &dbx,
        settlements.clone(),
    )
    .await
    .c(h!())?;
    Ok(Arc::new(env))
}

#[derive(Debug, PartialEq)]
enum MissingFileRegistryConfigurationLog {
    Warning(String),
    Error(String),
}

fn missing_file_registry_configuration_log(
    devices_enabled: bool,
    mode: Mode,
) -> MissingFileRegistryConfigurationLog {
    if devices_enabled {
        MissingFileRegistryConfigurationLog::Error(format!(
            "Devices functionality is enabled, but the [file_registry] configuration section is missing. Add pg_host, pg_port, pg_user, pg_password, and pg_dbname under [file_registry], run `wdintel-rs --mode={mode} oneoff-create-file-registry-database`, then restart the backend. Device file operations are unavailable."
        ))
    } else {
        MissingFileRegistryConfigurationLog::Warning(
            "The optional [file_registry] configuration section is missing. Startup will continue without the file registry database; device file operations are unavailable. Add and provision [file_registry] before enabling Devices.".to_string(),
        )
    }
}

async fn log_missing_file_registry_configuration(
    dbx: &sea_orm::DatabaseConnection,
    mode: Mode,
) {
    match crate::system_settings::devices_section_enabled(dbx).await {
        Ok(devices_enabled) => {
            match missing_file_registry_configuration_log(devices_enabled, mode)
            {
                MissingFileRegistryConfigurationLog::Warning(message) => {
                    warn!("{message}");
                }
                MissingFileRegistryConfigurationLog::Error(message) => {
                    error!("{message}");
                }
            }
        }
        Err(error) => {
            error!(
                "The [file_registry] configuration section is missing, and checking whether Devices functionality is enabled failed: {error:?}. Startup will continue without the file registry database; add and provision [file_registry] before using Devices."
            );
        }
    }
}

async fn connect_analytics(config: &Config) -> Option<AnalyticsPool> {
    let analytics = config.analytics.as_ref()?;
    let host = &analytics.pg_host;
    let port = analytics.pg_port.unwrap_or(DEFAULT_PG_PORT);
    match crate::new_pg_pool_from_analytics(analytics).await {
        Ok(pool) => {
            info!("analytics pool configured {host}:{port}");
            Some(AnalyticsPool {
                conn: pool,
                retry_after_unix_ms: Arc::new(
                    std::sync::atomic::AtomicU64::new(0),
                ),
            })
        }
        Err(err) => {
            warn!(
                "failed to connect optional analytics database {host}:{port}: {:?}",
                err
            );
            None
        }
    }
}

async fn init_runtime_env(
    mode: Mode,
    role: crate::PgRuntimePoolRole,
) -> Result<Arc<Env>, AppError> {
    crate::migration::run_migration_1(mode).await.c(h!())?;
    crate::use_pg_runtime_pool(role);
    let env = new_env(mode).await.c(h!())?;
    let config = env.config.clone();
    if let Err(err) =
        crate::rer_importer::import_csv::ensure_import_group_exists(
            &env.dbx, &config,
        )
        .await
    {
        warn!("Failed to ensure import group exists: {:?}", err);
    };
    if let Err(err) =
        crate::organism::goi::integrations::ensure_goi_integration_maintainers(
            &env.dbx,
        )
        .await
    {
        error!("Failed to ensure GOI integration maintainers: {:?}", err);
    }
    Ok(env)
}

fn should_start_bgworkers_in_server(_mode: Mode, no_bgworker: bool) -> bool {
    !no_bgworker
}

fn spawn_group_stats_worker(bg_set: &mut JoinSet<()>, mode: Mode) {
    spawn_named_worker("worker_calculate_group_stats", bg_set, async move {
        crate::stats::worker::group_stats::worker_calculate_group_stats(mode)
            .await;
    });
}

fn spawn_goi_sync_worker_pool(bg_set: &mut JoinSet<()>, env: Arc<Env>) {
    let coordinator = Arc::new(
        crate::organism::goi::worker::GoiSyncWorkerCoordinator::default(),
    );
    for worker_index in 0..ORGANISM_GOI_SYNC_WORKER_COUNT {
        let env = env.clone();
        let coordinator = coordinator.clone();
        spawn_named_worker(
            format!("goi_sync_worker_{worker_index}"),
            bg_set,
            async move {
                crate::organism::goi::worker::goi_sync_worker_nofail(
                    env,
                    coordinator,
                )
                .await;
            },
        );
    }
}

fn spawn_palitra_conversion_worker(bg_set: &mut JoinSet<()>, env: Arc<Env>) {
    spawn_named_worker("palitra_conversion_worker", bg_set, async move {
        crate::palitra::conversion_worker::palitra_conversion_worker_nofail(
            env,
        )
        .await;
    });
}

fn spawn_background_workers(
    mode: Mode,
    env: Arc<Env>,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
    should_spawn_group_stats_worker: bool,
    should_spawn_goi_workers: bool,
    bg_set: &mut JoinSet<()>,
) {
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

    if let Some(secret_config) = config.vault_config.clone() {
        spawn_named_worker("secret_worker", bg_set, async move {
            crate::secret::secret_worker(secret_config).await
        });
    }
    spawn_named_worker("healthcheck_worker", bg_set, async move {
        healthcheck::healthcheck_worker(&dbx9, config1).await;
    });
    if let (Some(analytics), Some(analytics_config)) =
        (env.analytics.clone(), config.analytics.as_ref())
    {
        let freshness_max_age_ms = analytics_config.freshness_max_age_ms();
        spawn_named_worker("analytics_health_log_worker", bg_set, async move {
            analytics_health::analytics_health_log_worker(
                analytics,
                freshness_max_age_ms,
            )
            .await;
        });
    }
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
            crate::rer_importer::reports::fill_comp_freq_worker(&dbx6).await;
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

    let env2 = env.clone();
    spawn_named_worker("iggy_integration_worker", bg_set, async move {
        crate::iggy::worker::run_nofail(env2).await;
    });
    spawn_named_worker("aor_assignments_worker", bg_set, async move {
        crate::sigint::aor::worker::aor_assignments_check_worker(&dbx10).await;
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
        crate::messenger::worker::queue::process_queue_nofail(mode, token_2)
            .await;
    });
    spawn_named_worker("operator_inbox_worker", bg_set, async move {
        crate::operator::worker::run_operator_inbox_worker_nofail(mode).await;
    });
    spawn_named_worker(
        "rer_duty_historical_interceptions_worker",
        bg_set,
        async move {
            crate::system_settings::worker::run_rer_duty_historical_interceptions_worker_nofail(mode).await;
        },
    );
    spawn_named_worker("echo_im_cleanup", bg_set, async move {
        crate::messenger::worker::cleanup::run_cleanup_worker(mode).await;
    });
    spawn_named_worker("recent_inbox_network_worker", bg_set, async move {
        crate::sigint::network::etalon_calc::worker::run_recent_inbox_network_worker_nofail(mode).await;
    });
    spawn_named_worker("old_inbox_network_worker", bg_set, async move {
        crate::sigint::network::etalon_calc::worker::run_old_inbox_network_worker_nofail(mode).await;
    });
    spawn_named_worker("unit_tag_queue_worker", bg_set, async move {
        crate::sigint::unit_tag::run_unit_tag_queue_worker_nofail(mode).await;
    });
    spawn_named_worker(
        "inbox_network_daily_consistency_worker",
        bg_set,
        async move {
            crate::sigint::network::etalon_calc::worker::run_inbox_network_daily_consistency_worker_nofail(mode).await;
        },
    );
    if should_spawn_group_stats_worker {
        spawn_group_stats_worker(bg_set, mode);
    }
    let rq2 = env.rq.clone();
    let tag_keyword_regex_cache = env.tag_keyword_regex_cache.clone();
    let token_3 = cancel_token.clone();
    let redis2 = env.redis.clone();
    if !config.disable_suggest_message_tags_worker.unwrap_or(false) {
        spawn_named_worker("suggest_message_tags_worker", bg_set, async move {
            let mut redis = redis2;
            crate::tags::worker::suggest_message_tags_worker(
                &rq2,
                &dbx11,
                &mut redis,
                &tag_keyword_regex_cache,
                token_3,
            )
            .await;
        });
    }

    if let Some(model_config) = env.config.ai_models_config.clone() {
        if model_config.worker.unwrap_or_default() {
            let token = cancel_token.clone();
            spawn_named_worker("refresh_models_worker", bg_set, async move {
                crate::tags::worker::refresh_models_worker_nofail(
                    model_config,
                    token,
                )
                .await;
            });
        }
    }

    let rq3 = env.rq.clone();
    let redis3 = env.redis.clone();
    let dbx11 = env.dbx.clone();
    let palitra_worker_context = env.palitra_worker_context.clone();
    spawn_named_worker("palitra_highlight_worker", bg_set, async move {
        let mut redis = redis3;
        crate::palitra::worker::palitra_highlight_worker_nofail(
            &rq3,
            &dbx11,
            &mut redis,
            &palitra_worker_context,
        )
        .await;
    });

    let ai_callsign_env = env.clone();
    let ai_callsign_cancellation_token = cancel_token.clone();
    spawn_named_worker("ai_callsign_worker", bg_set, async move {
        crate::ai_callsign::worker::run_nofail(
            ai_callsign_env,
            ai_callsign_cancellation_token,
        )
        .await;
    });

    let ai_agent_env = env.clone();
    let ai_agent_cancellation = cancel_token.clone();
    spawn_named_worker("ai_agent_worker", bg_set, async move {
        crate::ai_agent::worker::run_nofail(
            ai_agent_env,
            ai_agent_cancellation,
        )
        .await;
    });

    spawn_named_worker("signal_cli_verbose_logger", bg_set, async move {
        info!("Starting enable_signal_cli_verbose_logging");
        if let Err(err) = echo_im::enable_signal_cli_verbose_logging(
            "echo",
            SIGNAL_CLIENT_PORT,
        )
        .await
        {
            if mode == Live {
                error!("failed to configure signal cli: {:?}", err);
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

    if should_spawn_goi_workers {
        spawn_goi_sync_worker_pool(bg_set, env.clone());
        let message_uid_env = env.clone();
        spawn_named_worker(
            "goi_association_message_uid_worker",
            bg_set,
            async move {
                crate::organism::goi::message_uid::goi_association_message_uid_worker_nofail(
                    message_uid_env,
                )
                .await;
            },
        );
    }
    spawn_palitra_conversion_worker(bg_set, env);
}

fn spawn_vault_background_workers(env: Arc<Env>, bg_set: &mut JoinSet<()>) {
    if let Some(secret_config) = env.config.vault_config.clone() {
        spawn_named_worker("secret_worker", bg_set, async move {
            crate::secret::secret_worker(secret_config).await
        });
    }
}

fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(self::monitoring::ping)
            .service(self::monitoring::public_ping)
            .service(self::monitoring::server_info)
            .service(self::monitoring::monitoring)
            // .service(api_logout)
            .service(crate::server::admin::restart_echo)
            .service(crate::server::admin::restart_datasource)
            .service(
                crate::stats::cache_backfill::start_group_stats_cache_backfill,
            )
            .service(crate::kml::operatyvka)
            .service(crate::kml::operatyvka_download)
            .service(crate::kml::api_fix_kmz)
            .service(crate::atak::operatyvka_download)
            .service(crate::importer::download_kmz)
            .service(crate::delta::download_geojson)
            .service(crate::terminal::parse_terminal_pdf)
            .service(crate::terminal::upload_screenshot)
            .service(crate::terminal::upload_pdf)
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
            .service(crate::rer_importer::rer_message_attachments_zip)
            .service(
                crate::messenger::media_thumbnail::messenger_media_thumbnail,
            )
            .service(crate::messenger::media_wave::messenger_media_wave)
            .service(crate::messenger::media_wave::messenger_media_spectrogram)
            .service(crate::rer_importer::rer_importer_callsigns)
            .service(crate::rer_importer::callsigns_alchemy)
            .service(crate::rer_importer::unread_counters)
            .service(crate::rer_importer::signal_group_info)
            .service(crate::rer_importer::signal_group_info_batch)
            .service(crate::rer_importer::signal_groups)
            .service(crate::messenger::group::handlers::orphan_signal_groups)
            .service(crate::messenger::group::handlers::archived_signal_groups)
            .service(crate::messenger::group::handlers::signal_group_archive)
            .service(crate::messenger::group::handlers::signal_group_unarchive)
            .service(crate::messenger::group::handlers::group_stats_timeline)
            .service(crate::rer_importer::signal_profile_info)
            .service(crate::rer_importer::signal_profile_info_batch)
            .service(crate::rer_importer::signal_profile_save)
            .service(crate::rer_importer::latest_senders)
            .service(crate::rer_importer::senders)
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
            .service(crate::rer_importer::inbox::inbox_submit_v11)
            .service(crate::rer_importer::inbox::inbox_cursor)
            .service(crate::rer_importer::inbox::update_inbox_cursor)
            .service(crate::rer_importer::inbox::inbox_item_context)
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
            .service(crate::rer_importer::analysis::metadata_stats)
            .service(crate::rer_importer::analysis::freq_stats)
            .service(crate::rer_importer::analysis::post_stats)
            .service(crate::rer_importer::analysis::sender_stats)
            .service(crate::rer_importer::analysis::group_stats)
            .service(crate::rer_importer::analysis::activity_daily)
            .service(crate::rer_importer::analysis::callsign_relations)
            .service(
                crate::rer_importer::analysis::callsign_frequency_matches,
            )
            .service(crate::rer_importer::analysis::location_stats_count)
            .service(crate::rer_importer::analysis::unit_stats_count)
            .service(crate::rer_importer::analysis::tag_stats_count)
            .service(crate::rer_importer::analysis::callsign_stats_count)
            .service(crate::rer_importer::analysis::freq_stats_count)
            .service(crate::rer_importer::analysis::post_stats_count)
            .service(crate::rer_importer::analysis::sender_stats_count)
            .service(crate::rer_importer::analysis::group_stats_count)
            .service(crate::rer_importer::analysis::summary_table_freq)
            .service(crate::rer_importer::analysis::summary_table_task_launch)
            .service(crate::rer_importer::analysis::correlated_freqs)
            .service(crate::rer_importer::analysis::kmz_task_launch)
            .service(crate::rer_importer::analysis::geojson_task_launch)
            .service(crate::rer_importer::analysis::edit_freq_unit_name)
            .service(crate::rer_importer::analysis::saved_filters_list)
            .service(crate::rer_importer::analysis::saved_filters_duty_list)
            .service(crate::rer_importer::analysis::saved_filter_upsert)
            .service(crate::rer_importer::analysis::saved_filter_duty_upsert)
            .service(crate::rer_importer::analysis::rer_duty_filters_create)
            .service(crate::rer_importer::analysis::rer_duty_filters_get)
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
            .service(crate::rer_importer::reports::report_docx_task_launch)
            .service(crate::report_history::report_history_list)
            .service(crate::report_history::report_history_admin_list)
            .service(crate::report_history::report_history_status)
            .service(crate::report_history::report_history_download)
            .service(crate::report_history::report_history_retry)
            .service(crate::report_history::report_history_cancel)
            .service(crate::location::find_locations)
            .service(crate::location::find_locations_prefix)
            .service(crate::location::fetch_regions)
            .service(crate::location::aor_config::list_aor_location_configs)
            .service(crate::location::aor_config::save_aor_location_config)
            .service(crate::system_settings::current_system_settings)
            .service(crate::system_settings::list_system_settings)
            .service(crate::system_settings::create_system_settings)
            .service(crate::system_settings::activate_system_settings)
            .service(crate::system_settings::rer_duty_test_replay_status)
            .service(crate::ai_engine::list_ai_engines)
            .service(crate::ai_engine::get_ai_engine)
            .service(crate::ai_engine::create_ai_engine)
            .service(crate::ai_engine::update_ai_engine)
            .service(crate::ai_engine::delete_ai_engine)
            .service(crate::ai_engine::list_ai_chats)
            .service(crate::ai_engine::get_ai_chat)
            .service(crate::ai_engine::send_ai_chat_message)
            .service(crate::ai_agent::configuration)
            .service(crate::ai_agent::list_conversations)
            .service(crate::ai_agent::create_conversation)
            .service(crate::ai_agent::get_conversation)
            .service(crate::ai_agent::update_conversation)
            .service(crate::ai_agent::delete_conversation)
            .service(crate::ai_agent::create_request)
            .service(crate::ai_agent::cancel_request)
            .service(crate::ai_agent::request_events)
            .service(crate::ai_agent::auth::exchange_bootstrap)
            .service(
                crate::ai_agent::provider_gateway::chat_completions,
            )
            .service(crate::ai_agent::admin::get_settings)
            .service(crate::ai_agent::admin::update_settings)
            .service(crate::ai_agent::admin::get_dispatcher)
            .service(crate::ai_agent::admin::update_dispatcher)
            .service(crate::ai_agent::admin::test_dispatcher)
            .service(crate::ai_agent::admin::list_echo_proxies)
            .service(crate::ai_agent::admin::upsert_echo_proxy)
            .service(crate::ai_agent::admin::delete_echo_proxy)
            .service(crate::ai_agent::admin::test_echo_proxy)
            .service(crate::ai_agent::admin::list_containers)
            .service(crate::ai_agent::admin::list_requests)
            .service(crate::ai_agent::admin::get_request)
            .service(crate::ai_agent::admin::retry_review)
            .service(crate::ai_agent::admin::get_user_agent)
            .service(crate::ai_agent::admin::start_user_agent)
            .service(crate::ai_agent::admin::stop_user_agent)
            .service(crate::ai_agent::admin::test_user_agent)
            .service(crate::ai_callsign::get_ai_callsign_page)
            .service(crate::ai_callsign::create_ai_callsign_test_message)
            .service(crate::ai_callsign::update_ai_callsign_test_message)
            .service(crate::ai_callsign::delete_ai_callsign_test_message)
            .service(crate::ai_callsign::test_ai_callsign_parsing)
            .service(crate::ai_callsign::save_ai_callsign_parsing)
            .service(crate::ai_callsign::recalculate_ai_callsign_parsing)
            .service(crate::ai_callsign::save_ai_callsign_worker_settings)
            .service(crate::transcriber::list_instances)
            .service(crate::transcriber::create_instance)
            .service(crate::transcriber::update_instance)
            .service(crate::transcriber::delete_instance)
            .service(crate::transcriber::check_instance)
            .service(crate::transcriber::queue_status)
            .service(crate::transcriber::message_transcriptions)
            .service(crate::messenger::missing_message::echo_missing_message_list)
            .service(crate::messenger::missing_message::echo_missing_message_counts)
            .service(crate::messenger::missing_message::echo_missing_message_resolve)
            .service(crate::messenger::restapi_errors::signal_restapi_error_list)
            .service(crate::messenger::restapi_errors::signal_restapi_error_latest)
            .service(crate::messenger::restapi_errors::signal_restapi_error_counts)
            .service(crate::users::user_login)
            .service(crate::users::user_test_api_login)
            .service(crate::users::api_user)
            .service(crate::users::api_user_info)
            .service(crate::users::user_logout)
            .service(crate::users::settings_save)
            .service(crate::user_settings::user_settings_get)
            .service(crate::user_settings::user_settings_put)
            .service(crate::users::user_sigint_groups)
            .service(crate::users::user_sigint_groups_detailed)
            .service(crate::sigint::direct_submit::submit_direct)
            .service(crate::sigint::direct_submit::edit_message)
            .service(crate::sigint::direct_submit::parse_direct_submit)
            .service(crate::sigint::file_upload::tus_base)
            .service(crate::sigint::file_upload::tus_file)
            .service(crate::sigint::device_name::device_name_create)
            .service(crate::sigint::device_name::device_name_search)
            .service(crate::users::list_logins)
            .service(crate::users::create_login)
            .service(crate::users::create_delta_login)
            .service(crate::users::delete_login)
            .service(crate::users::update_login)
            .service(crate::users::keep_alive)
            .service(crate::users::mark_release_seen)
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
            .service(crate::organism::organism_logins)
            .service(crate::api_integrations::list_api_integrations)
            .service(crate::api_integrations::upsert_api_integration)
            .service(crate::api_integrations::delete_api_integration)
            .service(crate::api_integrations::test_iggy_connection)
            .service(crate::devices::devices::list)
            .service(crate::devices::devices::unit_stats)
            .service(crate::devices::devices::aors)
            .service(crate::devices::devices::units)
            .service(crate::devices::devices::detail)
            .service(crate::devices::devices::create)
            .service(crate::devices::devices::update)
            .service(crate::devices::files::roots)
            .service(crate::devices::files::subtree_counts)
            .service(crate::devices::files::browse)
            .service(crate::devices::files::search)
            .service(crate::devices::files::journal)
            .service(crate::devices::files::sync)
            .service(crate::organism::goi::integrations::list_admin_goi_integrations)
            .service(crate::organism::goi::integrations::get_admin_goi_integration)
            .service(crate::organism::goi::integrations::upsert_admin_goi_integration)
            .service(crate::organism::goi::integrations::delete_admin_goi_integration)
            .service(crate::organism::goi::integrations::check_goi_integration_connection)
            .service(crate::organism::goi::integrations::setup_goi_integration_worker)
            .service(crate::organism::goi::integrations::list_current_user_goi_integrations)
            .service(crate::organism::goi::integrations::update_current_user_goi_pause_worker)
            .service(crate::organism::goi::integrations::list_goi_report_tab_order)
            .service(crate::organism::goi::integrations::update_goi_report_tab_order)
            .service(crate::organism::goi::integrations::restart_current_user_goi_service)
            .service(crate::organism::goi::integrations::unlink_current_user_goi_whatsapp)
            .service(crate::organism::goi::integrations::download_current_user_goi_palettes)
            .service(crate::organism::goi::integrations::upload_current_user_goi_categories)
            .service(crate::organism::goi::integrations::list_current_user_goi_associations)
            .service(crate::organism::goi::integrations::list_current_user_goi_knowledge)
            .service(crate::organism::my_scope)
            .service(crate::organism::keyword_sets::list_keyword_sets)
            .service(crate::organism::keyword_sets::upsert_keyword_set)
            .service(crate::organism::keyword_sets::delete_keyword_set)
            .service(crate::organism::keyword_sets::inflect_keyword_set)
            .service(crate::datasource::list_datasources)
            .service(crate::datasource::datasource_group_list)
            .service(crate::sigint::zone::zones_list)
            .service(crate::sigint::zone::zones_datasources_list)
            .service(crate::sigint::zone::zones_datasources_groups_list)
            .service(crate::sigint::zone::zones_datasources_group_update)
            .service(crate::sigint::zone::zones_datasources_group_add)
            .service(crate::sigint::zone::zones_datasources_group_delete)
            .service(crate::sigint::zone::my_admin_groups)
            .service(crate::sigint::zone::my_admin_group_edit_reference)
            .service(crate::sigint::zone::my_admin_group_update)
            .service(crate::sigint::unit::list_units)
            .service(crate::sigint::unit::list_units_by_id)
            .service(crate::sigint::unit::create_unit)
            .service(crate::sigint::unit::create_unit_with_auto_network)
            .service(crate::sigint::unit::create_device_network)
            .service(crate::sigint::unit::update_unit)
            .service(crate::sigint::unit::delete_unit)
            .service(crate::sigint::unit::delete_unit_duplicate)
            .service(crate::sigint::unit::units_search)
            .service(crate::sigint::unit::attachment::unit_details)
            .service(crate::sigint::unit::orbit::unit_orbit_children)
            .service(crate::sigint::unit::orbit::orbit_link_candidates)
            .service(crate::sigint::unit::orbit::search_orbit_units)
            .service(crate::sigint::unit::orbit::import_orbit_unit)
            .service(crate::sigint::unit::orbit::link_orbit_unit)
            .service(crate::sigint::unit::orbit::unlink_orbit_unit)
            .service(
                crate::sigint::unit::attachment::unit_attachment_unit_ids,
            )
            .service(crate::sigint::unit::attachment::upload_unit_attachment)
            .service(crate::sigint::unit::attachment::update_unit_attachment)
            .service(crate::sigint::unit::attachment::delete_unit_attachment)
            .service(crate::sigint::unit::attachment::download_unit_attachment)
            .service(crate::sigint::callsign::list_callsigns)
            .service(crate::sigint::callsign::callsign_name_search)
            .service(crate::sigint::callsign::list_callsigns_csv)
            .service(crate::sigint::callsign::list_callsigns_xlsx)
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
            .service(crate::sigint::network::find_live_networks)
            .service(crate::sigint::network::network_info_one)
            .service(crate::sigint::network::network_info_batch_id)
            .service(crate::sigint::network::network_info_batch_freq)
            .service(crate::sigint::network::update_freq_networks)
            .service(crate::sigint::network::create_network)
            .service(crate::sigint::network::delete_network)
            .service(crate::sigint::network::delete_network_freq)
            .service(crate::sigint::network::update_network_freq)
            .service(crate::sigint::network::update_network_freq_v2)
            .service(crate::sigint::network::add_network_freq)
            .service(crate::sigint::network::add_network_freq_v2)
            .service(crate::sigint::network::reactivate_network_freq)
            .service(crate::sigint::network::network_unit_stats)
            .service(crate::sigint::network::update_network)
            .service(crate::sigint::network::report_networks_goi_task_launch)
            .service(crate::sigint::network::restore_network)
            .service(crate::sigint::network::network_search)
            .service(crate::sigint::network::network_callsigns)
            .service(crate::sigint::network::network_callsigns_list)
            .service(crate::sigint::network::relations::network_callsigns_relations)
            .service(crate::sigint::network::relations::network_callsigns_relation_messages)
            .service(crate::sigint::network::network_freqs_activity_one)
            .service(crate::sigint::network::network_freq_callsigns)
            .service(crate::sigint::network::network_freq_callsigns_batch)
            .service(crate::sigint::network::network_freqs_list)
            .service(crate::sigint::network::network_group_activity)
            .service(crate::sigint::network::network_group_activity_one)
            .service(crate::sigint::network::network_signals_list)
            .service(crate::sigint::network::list_network_points)
            .service(crate::sigint::network::merge_network)
            .service(crate::sigint::network::encryptions_list)
            .service(crate::sigint::network::update_network_posts)
            .service(crate::sigint::network::update_network_units)
            .service(crate::sigint::post::post_list)
            .service(crate::sigint::post::post_name_search)
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
            .service(crate::sigint::freq::freq_search)
            .service(crate::sigint::aor::aor_list)
            .service(crate::sigint::aor::create_aor)
            .service(crate::sigint::aor::update_aor)
            .service(crate::sigint::aor::update_aor_report_order)
            .service(crate::sigint::aor::delete_aor)
            .service(crate::sigint::etalonka::task::report_networks_task_launch)
            .service(crate::sigint::etalonka::task::report_networks_batch_id_task_launch)
            .service(crate::sigint::source::list_sources)
            .service(crate::sigint::signal::create_signal)
            .service(crate::sigint::signal::signal_name_search)
            .service(crate::sigint::signal::list_signals)
            .service(crate::sigint::signal::list_signals_csv)
            .service(crate::sigint::signal::delete_signal)
            .service(crate::sigint::signal::update_signal)
            .service(crate::sigint::signal::signal_unit_stats)
            .service(crate::tags::admin_list_tags)
            .service(crate::tags::create_tag)
            .service(crate::tags::update_tag)
            .service(crate::tags::tags_list)
            .service(crate::tags::organism_list_tags)
            .service(crate::tags::admin_organism_list_tags)
            .service(crate::tags::create_organism_tag)
            .service(crate::tags::update_organism_tag)
            .service(crate::tags::delete_organism_tag)
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
            .service(crate::messenger::accounts_stats_timeline)
            .service(crate::messenger::get_qr)
            .service(crate::messenger::is_linked)
            .service(crate::messenger::edit)
            .service(crate::messenger::unlink)
            .service(crate::messenger::link)
            .service(crate::messenger::system_service_name_availability)
            .service(crate::messenger::link_operator)
            .service(crate::messenger::group_update)
            .service(crate::operator::message_submit)
            .service(crate::palitra::list_all_palitras)
            .service(crate::palitra::list_all_palitras_v2)
            .service(crate::palitra::list_map_palitras_v2)
            .service(crate::palitra::list_all_palitras_detailed)
            .service(crate::palitra::read_palitra_goi_sync_history)
            .service(crate::palitra::read_palitra_v2)
            .service(crate::palitra::read_palitra_preview_v2)
            .service(crate::palitra::list_palitra_points)
            .service(crate::palitra::suggest_palitra_point_labels)
            .service(crate::palitra::search_palitra_points)
            .service(crate::palitra::create_palitra)
            .service(crate::palitra::create_palitra_basic)
            .service(crate::palitra::create_palitra_basic_v2)
            .service(crate::palitra::create_palitra_with_kmz)
            .service(crate::palitra::update_palitra)
            .service(crate::palitra::update_palitra_v2)
            .service(crate::palitra::archive_palitra)
            .service(crate::palitra::unarchive_palitra)
            .service(crate::palitra::delete_palitra)
            .service(crate::palitra::assign_palitra_folder)
            .service(crate::palitra::rename_palitra_folder)
            .service(crate::palitra::archive_palitra_folder)
            .service(crate::palitra::delete_palitra_folder)
            .service(crate::palitra::download_palitras)
            .service(crate::palitra::download_palitras_delta_split)
            .service(crate::palitra::upload_palitra_points)
            .service(crate::palitra::retry_palitra_conversion)
            .service(crate::palitra::retry_goi_source_conversion)
            .service(crate::palitra::analyze_kmz)
            .service(crate::alpine::convert_alpinequest_file)
            .service(crate::alpine::download_alpine_result)
            .service(
                web::scope(get_assets_url())
                    .route("/{filename:.*}", web::get().to(crate::storage::serve_assets)));
}

pub async fn main_server(
    mode: Mode,
    ps: crate::ServerPs,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) -> Result<(), AppError> {
    let env = init_runtime_env(mode, crate::PgRuntimePoolRole::Web)
        .await
        .c(h!())?;
    let config = env.config.clone();

    let redis_session_store =
        RedisSessionStore::new(crate::redis_conn_string(&config).c(h!())?)
            .await
            .c(h!())?;

    let mut background_tasks: JoinSet<()> = JoinSet::new();
    let session_env = env.clone();
    let token_session = cancel_token.clone();
    spawn_named_worker(
        "session_activity_worker",
        &mut background_tasks,
        async move {
            crate::session::run_activity_worker_nofail(
                session_env,
                token_session,
            )
            .await;
        },
    );
    let media_cache_dir =
        crate::messenger::media_cache::media_cache_dir(&config);
    spawn_named_worker(
        "messenger_media_cache_cleanup_worker",
        &mut background_tasks,
        async move {
            crate::messenger::media_cache::run_cache_cleanup_worker_nofail(
                media_cache_dir,
            )
            .await;
        },
    );
    let media_thumbnail_env = env.clone();
    spawn_named_worker(
        "messenger_media_thumbnail_worker",
        &mut background_tasks,
        async move {
            crate::messenger::media_thumbnail::run_thumbnail_worker_nofail(
                media_thumbnail_env,
            )
            .await;
        },
    );
    let should_start_bgworkers =
        should_start_bgworkers_in_server(mode, ps.no_bgworker);
    if should_start_bgworkers {
        match mode {
            Mode::Live => spawn_vault_background_workers(
                env.clone(),
                &mut background_tasks,
            ),
            Mode::Test | Mode::Debug => spawn_background_workers(
                mode,
                env.clone(),
                cancel_token.clone(),
                shutdown_handle.clone(),
                true,
                false,
                &mut background_tasks,
            ),
        }
    } else {
        info!("Background workers are disabled in server mode={mode}");
    }

    let bind_ip = "0.0.0.0";
    let bind_port = if let Ok(port) = std::env::var("ECHO_SERVER_PORT") {
        info!("port overridden from env: {port}");
        port.parse::<u16>().c(h!())?
    } else {
        info!(
            "starting echo server on default 8081 port. override it with ECHO_SERVER_PORT variable."
        );
        8081
    };

    let env_for_server = env.clone();
    let server_builder = HttpServer::new(move || {
        let env = env_for_server.clone();
        let cookie_secret = env.config.cookie_session_secret.clone();
        let redis_for_middleware = env.redis.clone();
        App::new()
            .wrap(actix_web::middleware::Compress::default())
            .app_data(actix_web::web::Data::from(env))
            .app_data(
                web::JsonConfig::default().limit(SERVER_JSON_PAYLOAD_MAX_BYTES),
            )
            // .wrap(
            //     actix_web::middleware::Logger::default()
            // )
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        IDENTITY_DURATION_HOURS * 60 * 60,
                    )))
                    .build(),
            )
            .wrap(actix_web::middleware::from_fn(
                middleware::purge_legacy_identity_middleware,
            ))
            .wrap(actix_web::middleware::from_fn(
                crate::ai_agent::middleware::enforce_agent_routes,
            ))
            .wrap(SessionMiddleware::new(
                redis_session_store.clone(),
                Key::from(cookie_secret.as_bytes()),
            ))
            .wrap(actix_web::middleware::from_fn(
                middleware::mk_activity_middleware(Some(redis_for_middleware)),
            ))
            .wrap(actix_web::middleware::from_fn(
                middleware::access_log_middleware,
            ))
            .configure(configure_routes)
    });

    let server = if let Some(listener) = systemd_listener()? {
        info!("Starting server with systemd socket activation");
        server_builder.listen(listener)?
    } else {
        info!("Starting server on {bind_ip}:{bind_port}");
        server_builder.bind((bind_ip, bind_port))?
    }
    .run();

    let task_completion_future = async move {
        if should_start_bgworkers && mode == Mode::Live {
            std::future::pending::<()>().await;
        } else if should_start_bgworkers {
            while background_tasks.join_next().await.is_some() {
                // do nothing
            }
            info!("[Background] All tasks in JoinSet completed on their own.");
        } else {
            std::future::pending::<()>().await;
        }
    };

    let server_handle = server.handle();
    let mut sigint = signal(SignalKind::interrupt())
        .expect("Failed to register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate())
        .expect("Failed to register SIGTERM handler");

    let server_result = shutdown_handle.spawn(async move {
        tokio::select! {
            _ = sigint.recv() => {
                println!("\n[SIGINT / CTRL+C] detected. Signaling shutdown.");
                cancel_token.cancel();
                server_handle.stop(true).await;
            },
            _ = sigterm.recv() => {
                println!("\n[SIGTERM / KILL] detected. Signaling shutdown.");
                cancel_token.cancel();
                server_handle.stop(true).await;
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
    }).await.c(h!());
    if let Some(metrics) = &env.metrics {
        metrics.shutdown();
    }
    server_result?;
    Ok(())
}

pub async fn main_bgworker(
    mode: Mode,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) -> Result<(), AppError> {
    let env = init_runtime_env(mode, crate::PgRuntimePoolRole::Bgworker)
        .await
        .c(h!())?;
    crate::migration::request_analytics_table_reconciliation().await;
    let mut background_tasks: JoinSet<()> = JoinSet::new();
    let mut transcriber_tasks: JoinSet<()> = JoinSet::new();
    spawn_background_workers(
        mode,
        env.clone(),
        cancel_token.clone(),
        shutdown_handle.clone(),
        true,
        true,
        &mut background_tasks,
    );
    let transcriber_worker_id = Uuid::now_v7();
    info!(
        "starting audio transcription process worker_id={transcriber_worker_id} tasks={ECHO_AUDIO_TRANSCRIPTION_CONCURRENCY}"
    );
    for index in 0..ECHO_AUDIO_TRANSCRIPTION_CONCURRENCY {
        let worker_env = env.clone();
        let worker_token = cancel_token.clone();
        spawn_named_worker(
            format!("audio_transcription_worker_{index}"),
            &mut transcriber_tasks,
            async move {
                crate::transcriber::worker::run_nofail(
                    worker_env,
                    transcriber_worker_id,
                    worker_token,
                )
                .await;
            },
        );
    }
    let task_completion_future = async move {
        while background_tasks.join_next().await.is_some() {}
        info!("[Background] All tasks in JoinSet completed on their own.");
    };

    let mut sigint = signal(SignalKind::interrupt())
        .expect("Failed to register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate())
        .expect("Failed to register SIGTERM handler");

    shutdown_handle
        .spawn(async move {
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
                },
                _ = task_completion_future => {
                    info!("[Bgworker] All background tasks finished.");
                }
            }

            cancel_token.cancel();
            let drain = async {
                while transcriber_tasks.join_next().await.is_some() {}
            };
            if tokio::time::timeout(
                core::time::Duration::from_secs(
                    ECHO_AUDIO_TRANSCRIPTION_SHUTDOWN_GRACE_SECS,
                ),
                drain,
            )
            .await
            .is_err()
            {
                warn!(
                    "audio transcription drain exceeded {} seconds",
                    ECHO_AUDIO_TRANSCRIPTION_SHUTDOWN_GRACE_SECS
                );
            }
        })
        .await
        .c(h!())?;
    Ok(())
}

pub async fn main_report_worker(
    mode: Mode,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) -> Result<(), AppError> {
    crate::use_pg_runtime_pool(crate::PgRuntimePoolRole::ReportWorker);
    let env = new_env(mode).await.c(h!())?;
    crate::report_history::reset_in_progress_nofail(env.as_ref()).await;

    let mut report_tasks = JoinSet::new();
    crate::report_history::spawn_report_history_workers(&mut report_tasks, env);
    let task_completion_future = async move {
        while report_tasks.join_next().await.is_some() {}
        info!("[Report worker] All report tasks finished.");
    };

    let mut sigint = signal(SignalKind::interrupt())
        .expect("Failed to register SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate())
        .expect("Failed to register SIGTERM handler");

    shutdown_handle
        .spawn(async move {
            tokio::select! {
                _ = sigint.recv() => {
                    info!("[Report worker] SIGINT detected.");
                },
                _ = sigterm.recv() => {
                    info!("[Report worker] SIGTERM detected.");
                },
                _ = tokio::signal::ctrl_c() => {
                    info!("[Report worker] CTRL+C detected.");
                },
                _ = task_completion_future => {
                    info!("[Report worker] All background tasks finished.");
                }
            }
            cancel_token.cancel();
        })
        .await
        .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{http::StatusCode, test, App};
    #[actix_web::test]
    async fn missing_file_registry_log_escalates_when_devices_are_enabled() {
        let MissingFileRegistryConfigurationLog::Warning(warning) =
            missing_file_registry_configuration_log(false, Mode::Live)
        else {
            panic!("disabled Devices should produce a warning");
        };
        assert!(warning.contains("Startup will continue"));

        let MissingFileRegistryConfigurationLog::Error(error) =
            missing_file_registry_configuration_log(true, Mode::Live)
        else {
            panic!("enabled Devices should produce an error");
        };
        assert!(error.contains("[file_registry]"));
        assert!(error.contains(
            "wdintel-rs --mode=live oneoff-create-file-registry-database"
        ));
    }

    #[actix_web::test]
    async fn test_api_sigint_units_route_is_registered() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let redis_session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = test::init_service(
            App::new()
                .wrap(
                    IdentityMiddleware::builder()
                        .visit_deadline(Some(std::time::Duration::from_secs(
                            IDENTITY_DURATION_HOURS * 60 * 60,
                        )))
                        .build(),
                )
                .wrap(SessionMiddleware::new(
                    redis_session_store,
                    Key::generate(),
                ))
                .app_data(
                    web::JsonConfig::default()
                        .limit(SERVER_JSON_PAYLOAD_MAX_BYTES),
                )
                .configure(configure_routes),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/api/sigint/units")
            .set_json(crate::sigint::unit::types::ListUnitsReq {
                sort_by: None,
                after_unit_id: None,
                before_unit_id: None,
            })
            .to_request();
        let res = test::call_service(&app, req).await;

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn test_report_history_cancel_route_is_registered() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let redis_session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = test::init_service(
            App::new()
                .wrap(
                    IdentityMiddleware::builder()
                        .visit_deadline(Some(std::time::Duration::from_secs(
                            IDENTITY_DURATION_HOURS * 60 * 60,
                        )))
                        .build(),
                )
                .wrap(SessionMiddleware::new(
                    redis_session_store,
                    Key::generate(),
                ))
                .app_data(
                    web::JsonConfig::default()
                        .limit(SERVER_JSON_PAYLOAD_MAX_BYTES),
                )
                .configure(configure_routes),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/api/report-history/cancel")
            .set_json(crate::report_history::ReportHistoryIdReq { id: 1 })
            .to_request();
        let res = test::call_service(&app, req).await;

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn test_rer_message_attachments_zip_requires_authentication() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let redis_session_store =
            RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
                .await
                .unwrap();
        let app = test::init_service(
            App::new()
                .wrap(
                    IdentityMiddleware::builder()
                        .visit_deadline(Some(std::time::Duration::from_secs(
                            IDENTITY_DURATION_HOURS * 60 * 60,
                        )))
                        .build(),
                )
                .wrap(SessionMiddleware::new(
                    redis_session_store,
                    Key::generate(),
                ))
                .configure(configure_routes),
        )
        .await;
        let req = test::TestRequest::get()
            .uri("/api/rer-importer/messages/1/attachments.zip")
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
