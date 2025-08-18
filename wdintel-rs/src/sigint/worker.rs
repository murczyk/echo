use super::*;
use log::*;

pub async fn sigint_worker(mode: Mode) -> Result<(), AppError> {
    let config = crate::config::read_config(mode)?;

    crate::migration::run_migration_1(mode)
        .await
        .context(h!())?;

    let redis = crate::new_redis(&config).await.context(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(
            config.settlement_paths().unwrap(),
            mode,
        )
        .unwrap(),
    ));

    let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
    let all_datasources = datasource::Entity::find()
        .filter(datasource::Column::Enabled.eq(true))
        .order_by_asc(datasource::Column::Id)
        .all(&dbx)
        .await
        .context(h!())?;
    let mut datasources = vec![];
    for datasource in all_datasources {
        if datasource.echo_client_lock_id.is_some() {
            info!(
                "datasource {} is being handled by echo-im worker, skipping...",
                datasource.display_name
            );
        } else {
            datasources.push(datasource);
        }
    }
    let jset = tokio::task::LocalSet::new();
    info!("found enabled datasources: {}", datasources.len());
    for datasource in datasources {
        if datasource.kind == "signal" {
            let dbx2 = dbx.clone();
            let config5 = config.clone();
            let settlements2 = settlements.clone();
            let mut redis = redis.clone();
            jset.spawn_local(async move {
                receive_thread_signal_restapi_nofail(
                    settlements2,
                    &config5,
                    &dbx2,
                    &mut redis,
                    datasource.id,
                )
                .await
            });
        } else if datasource.kind == "api" {
            warn!("> buran api disabled datasource id={}", datasource.id);
        } else if datasource.kind == "whatsapp" {
            let dbx2 = dbx.clone();
            let config5 = config.clone();
            let settlements2 = settlements.clone();
            let mut redis = redis.clone();
            jset.spawn_local(async move {
                crate::whatsapp::receive_thread_nofail(
                    settlements2,
                    &config5,
                    &dbx2,
                    &mut redis,
                    &datasource,
                )
                .await
            });
        } else {
            println!("> unknown datasource kind: {}", datasource.kind);
        }
    }
    jset.await;
    Ok(())
}

async fn receive_thread_signal_restapi_nofail(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
) {
    loop {
        if let Err(e) = receive_thread_signal_restapi(
            settlements.clone(),
            config,
            dbx,
            redis,
            datasource_id,
        )
        .await
        {
            error!("error in receive_thread_signal_restapi_nofail: {e:?}");
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

async fn receive_thread_signal_restapi(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
) -> Result<(), AppError> {
    let rq: reqwest::Client = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(
            crate::config::RQ_TIMEOUT_SIGNAL_API,
        ))
        .build()?;

    let mut sync_state = SyncState {
        groups: BTreeSet::new(),
        senders: BTreeSet::new(),
    };
    let mut last_sync_t = std::time::SystemTime::now();

    loop {
        // println!("> receiving messages...");
        let mut messages =
            crate::sigint::restapi::receive_messages(config, &rq, dbx)
                .await
                .context(h!())?;
        if !messages.is_empty() {
            println!("> received {} messages", messages.len());
        }
        // todo: check if this is needed
        messages.sort_by(|a, b| {
            a.envelope
                .timestamp
                .partial_cmp(&b.envelope.timestamp)
                .unwrap()
        });
        let messages_len = messages.len();
        for message in messages {
            for message in message_to_many(message)? {
                process_incoming_message_restapi(
                    settlements.clone(),
                    config,
                    dbx,
                    redis,
                    &rq,
                    datasource_id,
                    &message,
                    &mut sync_state,
                )
                .await
                .context(h!())?;
            }
        }

        if messages_len > 0 {
            println!("> received {messages_len} messages done");
        }

        if std::time::SystemTime::now().duration_since(last_sync_t)?
            > std::time::Duration::from_secs(SYNC_SECS)
        {
            println!("> syncing accumulated group names and profiles");
            let groups = crate::sigint::restapi::receive_groups(config, &rq)
                .await
                .context(h!())?;
            for group in groups {
                sync_state.groups.insert(SyncStateGroup {
                    master_key: group.internal_id.clone(),
                    name: group.name.clone(),
                });
            }
            do_sync_state_nofail(dbx, datasource_id, &mut sync_state).await;
            last_sync_t = std::time::SystemTime::now();
            println!("> syncing accumulated group names and profiles done");
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}

pub async fn do_sync_state_nofail(
    dbx: &sea_orm::DatabaseConnection,
    datasource_id: i64,
    sync_state: &mut SyncState,
) {
    if let Err(e) = do_sync_state(dbx, datasource_id, sync_state).await {
        println!("> Error during sync: {e:?}");
    }
}

pub async fn do_sync_state(
    dbx: &sea_orm::DatabaseConnection,
    datasource_id: i64,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    // sync sync_state.groups
    for group in sync_state.groups.iter() {
        let m_exising_signal_group = SignalGroup::find()
            .filter(signal_group::Column::MasterKey.eq(&group.master_key))
            .one(dbx)
            .await
            .context(h!())?;
        match m_exising_signal_group {
            Some(existing) => {
                if existing.name.as_ref() != Some(&group.name)
                    && !&group.name.is_empty()
                {
                    info!(
                        "> worker::do_sync_state: updated signal_group {} - changed name from {} to {} ",
                        existing.master_key,
                        existing.name.clone().unwrap_or(String::from("<null>")),
                        group.name.clone()
                    );
                    let mut existing: signal_group::ActiveModel =
                        existing.into();
                    existing.name = Set(Some(group.name.clone()));
                    existing.update(dbx).await.context(h!())?;
                }
            }
            None => {
                let group = signal_group::ActiveModel {
                    master_key: Set(group.master_key.clone()),
                    name: Set(Some(group.name.clone())),
                    datasource_id: Set(Some(datasource_id)),
                    is_secret: Set(false),
                    created_at: NotSet,
                    ignore_operativny: Default::default(),
                };
                crate::messenger::group::add_group(group, dbx)
                    .await
                    .context(h!())?;
            }
        }
    }

    for sender in sync_state.senders.iter() {
        if let Some(ref name) = sender.name {
            let m_existing_profile = SignalProfile::find()
                .filter(
                    signal_profile::Column::Uuid.eq(format!("{}", sender.uuid)),
                )
                .one(dbx)
                .await
                .context(h!())?;
            match m_existing_profile {
                Some(existing) => {
                    let prof_name = Some((Some(name.clone()), None));
                    if Some((
                        existing.given_name.clone(),
                        existing.family_name.clone(),
                    )) != prof_name
                    {
                        let mut existing: signal_profile::ActiveModel =
                            existing.into();
                        existing.given_name = Set(Some(name.clone()));
                        existing.family_name = Set(None);
                        existing.update(dbx).await.context(h!())?;
                    }
                }
                None => {
                    signal_profile::ActiveModel {
                        uuid: Set(format!("{}", sender.uuid)),
                        given_name: Set(Some(name.clone())),
                        family_name: Set(None),
                        created_at: NotSet,
                    }
                    .insert(dbx)
                    .await
                    .context(h!())?;
                }
            }
        }
    }
    *sync_state = SyncState {
        groups: BTreeSet::new(),
        senders: BTreeSet::new(),
    };
    Ok(())
}

pub async fn process_incoming_message_restapi(
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
    config: &crate::config::Config,
    dbx: &sea_orm::DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    rq: &reqwest::Client,
    datasource_id: i64,
    message: &crate::sigint::restapi::Message,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    info!("received: {}", display_message(message)?);

    if let Some(ref exception) = message.exception {
        let exc_message = exception.message.clone();
        warn!("Exception: {exc_message}");

        if exc_message.starts_with("Untrusted identity: ") {
            if let Some(ref source_number) = message.envelope.source_number {
                info!("Trusting identity phone number: {source_number}");
                if let Err(e) = crate::sigint::restapi::trust_identity(
                    config,
                    rq,
                    source_number,
                )
                .await
                {
                    warn!("Error trusting identity: {e:?}");
                }
            }
            if let Some(ref source_uuid) = message.envelope.source_uuid {
                info!("Trusting identity uuid: {source_uuid}");
                if let Err(e) = crate::sigint::restapi::trust_identity(
                    config,
                    rq,
                    source_uuid,
                )
                .await
                {
                    warn!("Error trusting identity uuid: {e:?}");
                }
            }
        }
    }

    let Some(ref data_message) = message.envelope.data_message else {
        return Ok(());
    };
    let Some(ref body) = data_message.message else {
        return Ok(());
    };
    let Some(ref group_info) = data_message.group_info else {
        return Ok(());
    };
    let mut timestamp: Option<NaiveDateTime> =
        chrono::DateTime::from_timestamp_millis(message.envelope.timestamp)
            .map(|x| x.naive_utc());
    if let Some(timestamp2) = timestamp {
        if timestamp2.year() < 2022 {
            warn!("Warning! Signal message.envelope.timestamp is too early: {timestamp2}; See https://github.com/k-bx/echo/issues/35 , think of an action");
        }
        let now = Utc::now().naive_utc();
        if now < timestamp2 {
            warn!("Warning! Signal message.envelope.timestamp is in the future. now={}, timestamp={}, envelope.timestamp={}", now, timestamp2, message.envelope.timestamp);
            timestamp = Some(now);
        }
    }
    // Normalize body
    let body = body.replace("\r\n", "\n");
    let m_duplicate = find_duplicate(dbx, &body).await.context(h!())?;
    let m_duplicate_id = m_duplicate.as_ref().map(|x| x.id);
    // skip if this is same-group duplicate
    if let Some(ref duplicate) = m_duplicate {
        if let Some(ref dup_group_master_key) = duplicate.group_master_key {
            if dup_group_master_key == &group_info.group_id {
                info!("> skipping same-group duplicate");
                return Ok(());
            }
        }
    }
    let Some(source_uuid) = message.envelope.source_uuid.clone() else {
        return Ok(());
    };
    let Some(source_name) = message.envelope.source_name.clone() else {
        return Ok(());
    };

    if config.read_from_legacy_data_sources.unwrap_or(true) {
        let message = signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(body.clone())),
            created_at: NotSet,
            group_master_key: Set(Some(group_info.group_id.clone())),
            timestamp: Set(timestamp),
            sender: Set(Some(source_uuid.clone().to_string())),
            duplicate_of: Set(m_duplicate_id),
            format: Set(Some(2)),
            datasource_id: Set(Some(datasource_id)),
            deleted: NotSet,
            external_id: NotSet,
        };
        let db_message_id: i64 = SignalMessage::insert(message)
            .exec(dbx)
            .await
            .context(h!())?
            .last_insert_id;

        if let Some(ref attachments) = data_message.attachments {
            for attachment in attachments.iter() {
                save_attachment_restapi(
                    config,
                    dbx,
                    attachment,
                    Some(db_message_id),
                )
                .await
                .context(h!())?;
            }
        }
        if let Some(ref quote) = data_message.quote {
            for attachment in quote.attachments.iter() {
                save_attachment_restapi(
                    config,
                    dbx,
                    attachment,
                    Some(db_message_id),
                )
                .await
                .context(h!())?;
            }
        }

        // println!("> before inbox_item_oneoff_nofail");

        crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
            settlements.clone(),
            dbx,
            rq,
            config,
            redis,
            db_message_id,
            None,
        )
        .await;

        // println!("> before incoming_message_after_insert");

        incoming_message_after_insert(dbx, db_message_id)
            .await
            .context(h!())?;
    }
    sync_state.senders.insert(SyncStateSender {
        uuid: Uuid::parse_str(&source_uuid)?,
        name: Some(source_name.clone()),
    });

    Ok(())
}

/// Shared logic between signal and buran api integration
pub async fn incoming_message_after_insert<'a, 'async_trait, C>(
    txn: &'a C,
    db_message_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"insert into sigint_search (id, search_tsv)
                select sii.id, to_tsvector('russian', sii.body_noheader->>'body')
                from sigint_inbox_item sii
                where sii.id = $1"#,
        [db_message_id.into()],
    );
    txn.execute(statement).await.context(h!())?;
    Ok(())
}
