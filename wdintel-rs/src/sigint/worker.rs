use super::*;
use log::*;

#[tokio::main]
pub async fn sigint_worker(mode: Mode) -> Result<(), AppError> {
    crate::migration::run_migration_1(mode).await?;

    let config = crate::config::read_config(mode.clone())?;

    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(config.settlement_paths().unwrap())
            .unwrap(),
    ));

    let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
    let datasources = datasource::Entity::find()
        .filter(datasource::Column::Enabled.eq(true))
        .order_by_asc(datasource::Column::Id)
        .all(&dbx)
        .await?;
    let jset = tokio::task::LocalSet::new();
    info!("found enabled datasources: {}", datasources.len());
    for datasource in datasources {
        if datasource.kind == "signal" {
            let dbx2 = dbx.clone();
            let config5 = config.clone();
            let settlements2 = settlements.clone();
            jset.spawn_local(async move {
                receive_thread_signal_restapi_nofail(
                    settlements2,
                    &config5,
                    &dbx2,
                    datasource.id,
                )
                .await
            });
        } else if datasource.kind == "api" {
            log::warn!("> buran api disabled datasource id={}", datasource.id);
        } else if datasource.kind == "whatsapp" {
            let dbx2 = dbx.clone();
            let config5 = config.clone();
            let settlements2 = settlements.clone();
            jset.spawn_local(async move {
                crate::whatsapp::receive_thread_nofail(
                    settlements2,
                    &config5,
                    &dbx2,
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
    datasource_id: i64,
) {
    loop {
        if let Err(e) = receive_thread_signal_restapi(
            settlements.clone(),
            config,
            dbx,
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
            crate::sigint::restapi::receive_messages(config, &rq, &dbx).await?;
        if messages.len() > 0 {
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
                    &dbx,
                    &rq,
                    datasource_id,
                    &message,
                    &mut sync_state,
                )
                .await?;
            }
        }

        if messages_len > 0 {
            println!("> received {} messages done", messages_len);
        }

        if std::time::SystemTime::now().duration_since(last_sync_t.clone())?
            > std::time::Duration::from_secs(SYNC_SECS)
        {
            println!("> syncing accumulated group names and profiles");
            let groups =
                crate::sigint::restapi::receive_groups(config, &rq).await?;
            for group in groups {
                sync_state.groups.insert(SyncStateGroup {
                    master_key: group.internal_id.clone(),
                    name: group.name.clone(),
                });
            }
            do_sync_state_nofail(&dbx, datasource_id, &mut sync_state).await;
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
            .await?;
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
                    existing.update(dbx).await?;
                }
            }
            None => {
                signal_group::ActiveModel {
                    master_key: Set(group.master_key.clone()),
                    name: Set(Some(group.name.clone())),
                    datasource_id: Set(Some(datasource_id)),
                    created_at: NotSet,
                    ignore_operativny: Default::default(),
                }
                .insert(dbx)
                .await?;
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
                .await?;
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
                        existing.update(dbx).await?;
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
                    .await?;
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
    rq: &reqwest::Client,
    datasource_id: i64,
    message: &crate::sigint::restapi::Message,
    sync_state: &mut SyncState,
) -> Result<(), AppError> {
    info!("received: {}", display_message(message)?);

    if let Some(ref exception) = message.exception {
        let exc_message = exception.message.clone();
        warn!("Exception: {}", exc_message);

        if exc_message.starts_with("Untrusted identity: ") {
            if let Some(ref source_number) = message.envelope.source_number {
                info!("Trusting identity phone number: {}", source_number);
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
                info!("Trusting identity uuid: {}", source_uuid);
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
            warn!("Warning! Signal message.envelope.timestamp is too early: {}; See https://github.com/k-bx/echo/issues/35 , think of an action", timestamp2);
        }
        let now = Utc::now().naive_utc();
        if now < timestamp2 {
            warn!("Warning! Signal message.envelope.timestamp is in the future. now={}, timestamp={}, envelope.timestamp={}", now, timestamp2, message.envelope.timestamp);
            timestamp = Some(now);
        }
    }
    // Normalize body
    let body = body.replace("\r\n", "\n");
    let m_duplicate = find_duplicate(dbx, &body).await?;
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

    let message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body.clone())),
        created_at: NotSet,
        group_master_key: Set(Some(group_info.group_id.clone())),
        timestamp: Set(timestamp),
        sender: Set(Some(format!("{}", source_uuid.clone()))),
        duplicate_of: Set(m_duplicate_id),
        format: Set(Some(2)),
        datasource_id: Set(Some(datasource_id)),
        deleted: NotSet,
    };
    let db_message_id: i64 = SignalMessage::insert(message)
        .exec(dbx)
        .await?
        .last_insert_id;

    if let Some(ref attachments) = data_message.attachments {
        for attachment in attachments.iter() {
            save_attachment_restapi(
                config,
                &dbx,
                attachment,
                Some(db_message_id),
            )
            .await?;
        }
    }
    if let Some(ref quote) = data_message.quote {
        for attachment in quote.attachments.iter() {
            save_attachment_restapi(
                config,
                &dbx,
                attachment,
                Some(db_message_id),
            )
            .await?;
        }
    }

    // println!("> before inbox_item_oneoff_nofail");

    crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
        settlements.clone(),
        dbx,
        &rq,
        &config,
        db_message_id,
    )
    .await;

    // println!("> before incoming_message_after_insert");

    incoming_message_after_insert(dbx, db_message_id).await?;

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
