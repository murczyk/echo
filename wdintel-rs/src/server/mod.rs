use crate::config::*;
use crate::types::*;
use crate::{mk_conn_string, new_redis};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::CookieSessionStore, SessionMiddleware};
use actix_web::cookie::Key;
use actix_web::{App, HttpServer};

use milgeo_rs::MilGeo;

pub mod discord;
mod healthcheck;
pub mod middleware;
pub mod monitoring;

#[actix_web::main]
pub async fn main_server(
    mode: Mode,
    ps: crate::ServerPs,
) -> Result<(), std::io::Error> {
    crate::migration::run_migration_1(mode).await.unwrap();

    let config = crate::config::read_config(mode).unwrap();

    let config1 = config.clone();
    let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
    let dbx4 = dbx.clone();
    let dbx6 = dbx.clone();
    let dbx7 = dbx.clone();
    let dbx8 = dbx.clone();
    let dbx9 = dbx.clone();
    let e_greptimedb = crate::new_greptimedb_from_config(&config).await;
    let m_greptimedb = match e_greptimedb {
        Ok(greptimedb) => Some(greptimedb),
        Err(e) => {
            warn!("failed to establish GreptimeDB connection: {:?}", e);
            None
        }
    };
    let mil_geo = MilGeo::new(&mk_conn_string(&config)[..]);
    let mil_geo2 = mil_geo.clone();
    if let Err(e) = crate::rer_importer::import_csv::ensure_import_group_exists(
        &dbx, &config,
    )
    .await
    {
        warn!("Failed to ensure import group exists: {:?}", e);
    };

    let redis = match new_redis(&config).await {
        Ok(redis) => Some(redis),
        Err(e) => {
            error!("failed to establish Redis connection: {:?}", e);
            None
        }
    };

    if !ps.no_bgworker {
        if let Some(secret_config) = config.vault_config.clone() {
            tokio::spawn(async move {
                crate::secret::secret_worker(secret_config).await
            });
        }
        tokio::spawn(async move {
            healthcheck::healthcheck_worker(&dbx9, config1).await;
        });
        // Activity details worker
        if let Some(redis_conn) = redis.clone() {
            if let Some(greptimedb) = m_greptimedb.clone() {
                tokio::spawn(async move {
                    middleware::activity_details_worker(redis_conn, greptimedb)
                        .await;
                });
            }
        }
        if !config.disable_cleanup_networks_worker.unwrap_or(false) {
            tokio::spawn(async move {
                crate::sigint::network::cleanup_networks_worker(&dbx4).await;
            });
        }
        if config.fill_comp_freq_worker {
            tokio::spawn(async move {
                crate::rer_importer::reports::fill_comp_freq_worker(&dbx6)
                    .await;
            });
        }
        if !config.disable_inactive_users_worker.unwrap_or(false) {
            tokio::spawn(async move {
                crate::users::inactive_users_worker(&dbx7).await;
            });
        }
        if !config.disable_unit_location_v2_worker.unwrap_or(false) {
            tokio::spawn(async move {
                crate::location::worker::process_location_v2_coords_worker(
                    &dbx8, mil_geo2,
                )
                .await;
            });
        }
    }

    if let Err(e) =
        echo_im::enable_signal_cli_verbose_logging("echo", SIGNAL_CLIENT_PORT)
            .await
    {
        error!("failed to configure signal cli: {:?}", e);
    }

    if config.feature_tmp_in_memory.unwrap_or(false) {
        tokio::spawn(async move {
            echo_install_utils::tmpdir::cleanup_tmp_worker_nofail().await;
        });
    }

    HttpServer::new(move || {
        let b2_creds = aws_sdk_s3::config::Credentials::new(
            config.b2_aws_access_key_id.clone(),
            config.b2_aws_secret_access_key.clone(),
            None,
            None,
            crate::config::B2_AWS_PROFILE_NAME,
        );
        let b2_s3 = config.b2_s3.clone();
        // let b2_endpoint =
        //     aws_sdk_s3::Endpoint::immutable(b2_s3.parse().unwrap());
        let b2_config = aws_sdk_s3::Config::builder()
            .region(aws_sdk_s3::config::Region::new(
                config.b2_s3_region.clone(),
            ))
            // .endpoint_resolver(b2_endpoint)
            .endpoint_url(b2_s3)
            .credentials_provider(b2_creds)
            .build();
        let b2_cli = aws_sdk_s3::Client::from_conf(b2_config);
        let rq: reqwest::Client = reqwest::Client::builder()
            .timeout(core::time::Duration::from_secs(crate::config::RQ_TIMEOUT))
            .build()
            .unwrap();
        let settlement_paths = config.settlement_paths().unwrap();
        let settlements = Arc::new(RwLock::new(crate::location::load_from_file(settlement_paths).unwrap()));

        let env = Env {
            mode,
            redis: redis.clone(),
            b2_cli,
            mil_geo: mil_geo.clone(),
            dbx: dbx.clone(),
            rq,
            config: config.clone(),
            greptimedb: Arc::new(RwLock::new(m_greptimedb.clone())),
            settlements: settlements.clone(),
        };
        App::new()
            .wrap(actix_web::middleware::Compress::default())
            .app_data(actix_web::web::Data::new(env))
            // .wrap(
            //     actix_web::middleware::Logger::default()
            // )
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        crate::config::IDENTITY_DURATION_HOURS * 60 * 60,
                    ))).build(),
            )
            .wrap(SessionMiddleware::new(
                CookieSessionStore::default(),
                Key::from(config.cookie_session_secret.clone().as_bytes()),
            ))
            .wrap(
                actix_web::middleware::from_fn(middleware::mk_activity_middleware(redis.clone()))
            )
            .service(self::monitoring::ping)
            .service(self::monitoring::public_ping)
            .service(self::monitoring::server_info)
            .service(self::monitoring::monitoring)
            // .service(api_logout)
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
            .service(crate::rer_importer::attachment)
            .service(crate::rer_importer::rer_importer_callsigns)
            .service(crate::rer_importer::callsigns_alchemy)
            .service(crate::rer_importer::unread_counters)
            .service(crate::rer_importer::signal_group_info)
            .service(crate::rer_importer::signal_group_info_batch)
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
            .service(crate::rer_importer::inbox::inbox_submit)
            .service(crate::rer_importer::inbox::inbox_cursor)
            .service(crate::rer_importer::inbox::update_inbox_cursor)
            .service(crate::rer_importer::inbox::messages_by_id)
            .service(crate::rer_importer::inbox::get_freq_pelengs_summary)
            .service(crate::rer_importer::analysis::stats_deprecated)
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
            .service(crate::rer_importer::bookmark::bookmark_add)
            .service(crate::rer_importer::bookmark::bookmarks_list)
            .service(crate::rer_importer::bookmark::bookmark_rm)
            .service(crate::rer_importer::important::important_add)
            .service(crate::rer_importer::important::importants_list)
            .service(crate::rer_importer::important::important_rm)
            .service(crate::rer_importer::callsigns::callsigns_graph)
            .service(crate::rer_importer::gdoc::rer_callsign_info)
            .service(crate::rer_importer::gdoc::rer_callsign_info_batch)
            .service(crate::location::find_locations)
            .service(crate::location::fetch_regions)
            .service(crate::users::user_login)
            .service(crate::users::api_user)
            .service(crate::users::api_user_info)
            .service(crate::users::user_logout)
            .service(crate::users::settings_save)
            .service(crate::users::user_sigint_groups)
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
            .service(crate::organism::organism_group_list)
            .service(crate::datasource::list_datasources)
            .service(crate::datasource::datasource_group_list)
            .service(crate::sigint::zone::zones_list)
            .service(crate::sigint::zone::zones_datasources_list)
            .service(crate::sigint::zone::zones_datasources_groups_list)
            .service(crate::sigint::zone::zones_datasources_groups_list_save)
            .service(crate::sigint::unit::list_units)
            .service(crate::sigint::unit::list_units_by_id)
            .service(crate::sigint::unit::create_unit)
            .service(crate::sigint::unit::update_unit)
            .service(crate::sigint::unit::delete_unit)
            .service(crate::sigint::unit::delete_unit_duplicate)
            .service(crate::sigint::callsign::list_callsigns)
            .service(crate::sigint::callsign::get_callsigns_with_units_from_inbox)
            .service(crate::sigint::callsign::create_callsign)
            .service(crate::sigint::callsign::update_callsign)
            .service(crate::sigint::callsign::delete_callsign)
            .service(crate::sigint::callsign::callsign_unit_stats)
            .service(crate::sigint::callsign::callsign_binds)
            .service(crate::sigint::callsign::create_callsign_bind)
            .service(crate::sigint::callsign::update_callsign_bind)
            .service(crate::sigint::callsign::delete_callsign_bind)
            .service(crate::sigint::callsign::update_callsign_reporting)
            .service(crate::sigint::callsign::update_callsign_reporting_batch)
            .service(crate::sigint::freq::list_freqs)
            .service(crate::sigint::freq::list_freqs_v2)
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
            .service(crate::sigint::network::delete_network_freq)
            .service(crate::sigint::network::update_network_freq)
            .service(crate::sigint::network::add_network_freq)
            .service(crate::sigint::network::network_unit_stats)
            .service(crate::sigint::network::update_network)
            .service(crate::sigint::network::restore_network)
            .service(crate::sigint::network::network_callsigns)
            .service(crate::sigint::network::network_callsigns_list)
            .service(crate::sigint::network::network_freqs_list)
            .service(crate::sigint::network::network_group_activity)
            .service(crate::sigint::network::network_group_activity_one)
            .service(crate::sigint::network::network_signals_list)
            .service(crate::sigint::network::list_network_points)
            .service(crate::sigint::network::merge_network)
            .service(crate::sigint::network::modulations_list)
            .service(crate::sigint::network::update_network_posts)
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
            .service(crate::sigint::etalonka::report_freqs)
            .service(crate::sigint::etalonka::report_networks)
            .service(crate::sigint::source::list_sources)
            .service(crate::sigint::signal::create_signal)
            .service(crate::sigint::signal::list_signals)
            .service(crate::sigint::signal::delete_signal)
            .service(crate::sigint::signal::update_signal)
            .service(crate::sigint::signal::signal_unit_stats)
            .service(crate::tags::tags_list)
            .service(crate::tags::inbox_message_tags_add)
            .service(crate::tags::inbox_message_tags_rm)
            .service(crate::rer_importer::reports::report_docx)
            .service(crate::delta::login::fetch_redirect_url)
            .service(crate::delta::login::handle_redirect)
            .service(crate::log_api::log_error)
            .service(actix_files::Files::new(crate::config::get_assets_url(), crate::config::get_assets_folder(&config)).show_files_listing())
    })
    .bind(("0.0.0.0", 8081))?
    .run()
    .await
}
