use super::*;
use crate::devices::audio::{
    self,
    acceptance_tests::{
        enabled_audio_device, native_audio_bytes, receive_command,
    },
};
use crate::entities::{
    device, login, signal_message, signal_message_media, system_settings,
};
use crate::file_registry::entities::device_audio;
use crate::functest::tests::{cleanup_locked, mk_sigint_zone};
use crate::h;
use crate::messenger::group::native::{
    self, NativeGroupCreateReq, NativeGroupSettings,
};
use crate::sigint::types::InterseptionKind;
use crate::types::{Env, ShortContext};
use sea_orm::*;
use uuid::Uuid;

async fn fixture(env: &Env) -> (login::Model, Uuid, Vec<String>) {
    let (actor, device) = enabled_audio_device(env).await;
    system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::SupportNonRerInterceptions,
            sea_query::Expr::value(true),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    let zone = mk_sigint_zone(&env.dbx, Default::default()).await.unwrap();
    let mut actor = login::Entity::find_by_id(actor)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    actor.roles = Set(serde_json::json!(["Admin", "Cyber"]));
    actor.sigint_zone_id = Set(Some(zone.id));
    let actor = actor.update(&env.dbx).await.unwrap();
    let aor = crate::functest::tests::mk_aor(&env.dbx, Default::default())
        .await
        .unwrap();
    crate::functest::tests::mk_organism_aor(
        &env.dbx,
        crate::entities::organism_aor::ActiveModel {
            organism_id: Set(actor.organism_id.unwrap()),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut groups = vec![];
    for category in [
        InterseptionKind::InterseptionRer,
        InterseptionKind::InterseptionOther,
    ] {
        let tx = env.dbx.begin().await.unwrap();
        let group = native::create_group(
            &tx,
            actor.id,
            NativeGroupCreateReq {
                request_id: Uuid::new_v4().to_string(),
                settings: NativeGroupSettings {
                    name: format!("Forwarding {}", Uuid::new_v4()),
                    color_key: None,
                    short_note: None,
                    long_note: None,
                    is_secret: true,
                    user_logins: vec![actor.id.to_string()],
                    organism_ids: vec![],
                    admin_logins: vec![actor.id.to_string()],
                    area_of_responsibility_ids: vec![aor.id],
                    zone_ids: vec![zone.id],
                    interseption_kind: category,
                    disable_network_assignment: false,
                    is_aviation_group: false,
                },
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        groups.push(group.master_key);
    }
    (actor, device, groups)
}

async fn configure(
    env: &Env,
    actor: &login::Model,
    device: Uuid,
    enabled: bool,
    add_groups: Vec<String>,
    remove_groups: Vec<String>,
) -> Result<(), crate::error::AppError> {
    let current = settings::read(&env.dbx, actor, device).await.unwrap();
    let tx = env.dbx.begin().await.unwrap();
    device::Entity::find_by_id(device)
        .lock_exclusive()
        .one(&tx)
        .await
        .unwrap();
    settings::apply(
        &tx,
        actor,
        device,
        &types::DeviceAudioForwardingChange {
            version: current.version,
            enabled,
            add_groups,
            remove_groups,
        },
    )
    .await
    .c(h!())?;
    tx.commit().await.unwrap();
    Ok(())
}

#[actix_web::test]
#[serial_test::serial]
async fn forwarding_catalog_removal_checks_versions_and_disables_last_binding()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    configure(&env, &actor, device, true, groups.clone(), vec![])
        .await
        .unwrap();
    let page = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.total_count, 2);
    let first = &page.items[0];
    let second = &page.items[1];
    let request = types::RemoveDeviceAudioForwardingReq {
        device_id: device.to_string(),
        group_master_key: first.group_master_key.clone(),
        version: first.version.clone(),
    };
    catalog::remove(&env.dbx, &actor, &request).await.unwrap();
    assert!(settings::configured(&env.dbx, device).await.unwrap());
    let mut request = types::RemoveDeviceAudioForwardingReq {
        group_master_key: second.group_master_key.clone(),
        ..request
    };
    assert!(matches!(
        catalog::remove(&env.dbx, &actor, &request).await,
        Err(crate::error::AppError::ConflictJson { .. })
    ));
    let page = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.total_count, 1);
    request.version = page.items[0].version.clone();
    let viewer =
        crate::devices::access::login_with_roles(&actor, &["CyberViewer"]);
    assert!(catalog::remove(&env.dbx, &viewer, &request).await.is_err());
    device::Entity::update_many()
        .col_expr(device::Column::Archived, sea_query::Expr::value(true))
        .col_expr(
            device::Column::ArchivedAt,
            sea_query::Expr::value(chrono::Utc::now().naive_utc()),
        )
        .filter(device::Column::Id.eq(device))
        .exec(&env.dbx)
        .await
        .unwrap();
    let page = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert!(page.items[0].device_archived);
    catalog::remove(&env.dbx, &actor, &request).await.unwrap();
    assert!(
        !settings::read(&env.dbx, &actor, device)
            .await
            .unwrap()
            .enabled
    );
    let empty_page = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert!(empty_page.items.is_empty());
    assert_eq!(empty_page.total_count, 0);
}

#[actix_web::test]
#[serial_test::serial]
async fn forwarding_catalog_pagination_keeps_every_binding() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    configure(&env, &actor, device, false, groups.clone(), vec![])
        .await
        .unwrap();
    let source = device::Entity::find_by_id(device)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    for index in 0..crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE {
        let mut copy = source.clone().into_active_model();
        let id = Uuid::new_v4();
        copy.id = Set(id);
        copy.name = Set(Some(format!("Forwarding page device {index}")));
        copy.insert(&env.dbx).await.unwrap();
        env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres, r#"
            insert into device_audio_forwarding_settings(device_id,enabled,version,updated_at,updated_by)
            values($1,false,$2,now(),$3)
        "#, [id.into(), Uuid::new_v4().into(), actor.id.into()])).await.unwrap();
        env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres, r#"
            insert into device_audio_forwarding_group(device_id,group_master_key,created_by,created_at)
            values($1,$2,$3,now())
        "#, [id.into(), groups[0].clone().into(), actor.id.into()])).await.unwrap();
    }
    let first = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert_eq!(
        first.items.len(),
        crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE as usize
    );
    assert!(first.items.iter().all(|entry| !entry.enabled));
    assert_eq!(
        first.total_count,
        crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE + 2
    );
    assert_eq!(
        first.page_size,
        crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE
    );
    assert!(first.next_cursor.is_some());
    let second = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq {
            cursor: first.next_cursor,
        },
    )
    .await
    .unwrap();
    assert_eq!(second.items.len(), 2);
    assert_eq!(second.total_count, first.total_count);
    assert_eq!(second.page_size, first.page_size);
    assert!(second.next_cursor.is_none());
    let unique: std::collections::BTreeSet<_> = first
        .items
        .into_iter()
        .chain(second.items)
        .map(|entry| (entry.device_id, entry.group_master_key))
        .collect();
    assert_eq!(
        unique.len(),
        crate::config::DEVICE_AUDIO_FORWARDING_PAGE_SIZE as usize + 2
    );
}

async fn receive(env: &Env, actor: Uuid, device: Uuid) -> device_audio::Model {
    let command = receive_command(
        &env.device_audio,
        actor,
        device,
        &format!("тест-{}.wav", Uuid::new_v4().simple()),
        native_audio_bytes().await,
    )
    .await;
    let audio::types::ReceiveDeviceAudioOutcome::Accepted(result) =
        audio::receive(&env.device_audio, actor, command)
            .await
            .unwrap()
    else {
        panic!("accepted");
    };
    device_audio::Entity::find_by_id(Uuid::parse_str(&result.audio.id).unwrap())
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .unwrap()
}

async fn deliveries(env: &Env, audio: Uuid) -> Vec<worker::Delivery> {
    worker::Delivery::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select audio_id,group_master_key,device_name,unit_id,actor_id,$2::uuid as lease_token from device_audio_forwarding_outbox where audio_id=$1 order by group_master_key", [audio.into(), Uuid::new_v4().into()])).all(env.device_audio.file_database().unwrap()).await.unwrap()
}

// #3646: durable admission, independent group messages and shared storage/ASR.
#[actix_web::test]
#[serial_test::serial]
async fn forwarding_delivery_replay_shares_audio_and_completed_transcription() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    let old = receive(&env, actor.id, device).await;
    configure(&env, &actor, device, true, groups.clone(), vec![])
        .await
        .unwrap();
    assert!(deliveries(&env, old.id).await.is_empty());
    let audio = receive(&env, actor.id, device).await;
    let deliveries = deliveries(&env, audio.id).await;
    assert_eq!(deliveries.len(), 2);
    configure(&env, &actor, device, false, vec![], groups.clone())
        .await
        .unwrap();
    let later = receive(&env, actor.id, device).await;
    assert!(self::deliveries(&env, later.id).await.is_empty());
    let (source, _) =
        crate::transcription::service::enqueue(&env.dbx, &audio.storage_key)
            .await
            .unwrap();
    env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update echo_gpu_transcription_queue set state='completed', transcribed_value='shared transcript', finished_at=now() at time zone 'UTC' where source_id=$1", [source.into()])).await.unwrap();
    let before = echo_gpu_client::lookup(&env.dbx, source)
        .await
        .unwrap()
        .unwrap()
        .0;
    let saved = audio::save_transcription(
        &env.device_audio,
        actor.id,
        audio::types::SaveDeviceAudioTranscriptionCommand {
            device_id: device,
            audio_id: audio.id,
            text: "Обнаружены грузовики".into(),
            expected_text_version: audio.text_version,
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        saved,
        audio::types::SaveDeviceAudioTranscriptionOutcome::Saved(_)
    ));
    let (first, replay) = tokio::join!(
        worker::deliver(&env, &deliveries[0]),
        worker::deliver(&env, &deliveries[0])
    );
    let first = first.unwrap().unwrap();
    assert_eq!(replay.unwrap(), Some(first));
    let second = worker::deliver(&env, &deliveries[1])
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    let matches = env
        .dbx
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select id from sigint_search where id = any($1) and search_tsv @@ plainto_tsquery('russian', $2)",
            [vec![first, second].into(), "грузовик".into()],
        ))
        .await
        .unwrap();
    assert_eq!(matches.len(), 2);
    let after = echo_gpu_client::lookup(&env.dbx, source)
        .await
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(before, after);
    assert_eq!(
        signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId
                    .is_in([first, second])
            )
            .count(&env.dbx)
            .await
            .unwrap(),
        0
    );
    let media = crate::messenger::audio_ref::for_messages(
        &env,
        &env.dbx,
        &[first, second],
    )
    .await
    .unwrap();
    assert_eq!(media.len(), 2);
    assert!(media
        .iter()
        .all(|media| media.storage_key.as_deref() == Some(&audio.storage_key)));
    let texts = crate::transcriber::completed_transcriptions(
        &env.dbx,
        &media.iter().map(|media| media.id).collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    assert_eq!(texts.len(), 2);
    let copied =
        crate::functest::tests::mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
    let copy_tx = env.dbx.begin().await.unwrap();
    crate::sigint::direct_submit::query::copy_signal_message_media(
        &env,
        &copy_tx,
        copied.id,
        None,
        &media[..1],
    )
    .await
    .unwrap();
    copy_tx.commit().await.unwrap();
    let copy =
        crate::messenger::audio_ref::for_messages(&env, &env.dbx, &[copied.id])
            .await
            .unwrap()
            .remove(0);
    assert_ne!(copy.id, media[0].id);
    assert_eq!(copy.storage_key, media[0].storage_key);
    crate::messenger::audio_ref::rename(
        &env.dbx,
        copied.id,
        copy.id,
        "renamed.wav",
    )
    .await
    .unwrap();
    assert_eq!(
        device_audio::Entity::find_by_id(audio.id)
            .one(env.device_audio.file_database().unwrap())
            .await
            .unwrap()
            .unwrap()
            .name,
        audio.name
    );
    let name = &audio.name;
    let found = signal_message::Entity::find()
        .filter(
            crate::attachments::search::message_filter(
                &format!("\"{name}\""),
                "attachments",
            )
            .unwrap(),
        )
        .all(&env.dbx)
        .await
        .unwrap();
    assert!(found.iter().any(|message| message.id == first));
    let tx = env.dbx.begin().await.unwrap();
    crate::messenger::audio_ref::delete(
        &tx,
        first,
        &[media
            .iter()
            .find(|media| media.signal_message_id == first)
            .unwrap()
            .id],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    signal_message::Entity::update_many()
        .col_expr(
            signal_message::Column::Deleted,
            sea_query::Expr::value(true),
        )
        .filter(signal_message::Column::Id.eq(first))
        .exec(&env.dbx)
        .await
        .unwrap();
    assert_eq!(
        worker::deliver(&env, &deliveries[0]).await.unwrap(),
        Some(first)
    );
    assert_eq!(
        crate::messenger::audio_ref::for_messages(&env, &env.dbx, &[second])
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(device_audio::Entity::find_by_id(audio.id)
        .one(env.device_audio.file_database().unwrap())
        .await
        .unwrap()
        .is_some());
}

#[actix_web::test]
#[serial_test::serial]
async fn forwarding_access_hidden_bindings_and_version_conflicts() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    assert!(!settings::configured(&env.dbx, device).await.unwrap());
    configure(&env, &actor, device, true, groups.clone(), vec![])
        .await
        .unwrap();
    let stale = settings::read(&env.dbx, &actor, device).await.unwrap();
    assert!(settings::configured(&env.dbx, device).await.unwrap());
    assert_eq!(
        stale.groups.iter().filter(|group| group.selected).count(),
        2
    );
    let other = crate::devices::audio::tests::audio_actor(
        &env.dbx,
        actor.organism_id.unwrap(),
        &["Admin", "Cyber"],
    )
    .await;
    let tx = env.dbx.begin().await.unwrap();
    let mut group = native::detail(&tx, &groups[1]).await.unwrap();
    group.settings.user_logins = vec![other.id.to_string()];
    group.settings.admin_logins = vec![other.id.to_string()];
    native::update_group(
        &tx,
        native::NativeGroupUpdateReq {
            master_key: groups[1].clone(),
            settings: group.settings,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let visible = settings::read(&env.dbx, &actor, device).await.unwrap();
    assert_eq!(visible.groups.len(), 1);
    let page = catalog::list(
        &env.dbx,
        &actor,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].group_master_key, groups[0]);
    assert_eq!(page.total_count, 1);
    let request = types::RemoveDeviceAudioForwardingReq {
        device_id: device.to_string(),
        group_master_key: groups[1].clone(),
        version: visible.version.clone().unwrap(),
    };
    assert!(matches!(
        catalog::remove(&env.dbx, &actor, &request).await,
        Err(crate::error::AppError::Forbidden(_))
    ));
    let mut unrelated = actor.clone();
    unrelated.organism_id = Some(
        crate::functest::tests::mk_organism(&env.dbx, Default::default())
            .await
            .unwrap()
            .id,
    );
    let unrelated_page = catalog::list(
        &env.dbx,
        &unrelated,
        &types::ListDeviceAudioForwardingReq { cursor: None },
    )
    .await
    .unwrap();
    assert!(unrelated_page.items.is_empty());
    assert_eq!(unrelated_page.total_count, 0);
    assert!(catalog::remove(&env.dbx, &unrelated, &request)
        .await
        .is_err());
    catalog::remove(
        &env.dbx,
        &actor,
        &types::RemoveDeviceAudioForwardingReq {
            group_master_key: groups[0].clone(),
            ..request
        },
    )
    .await
    .unwrap();
    assert!(settings::configured(&env.dbx, device).await.unwrap());
    configure(&env, &actor, device, false, vec![], vec![groups[0].clone()])
        .await
        .unwrap();
    assert!(!settings::configured(&env.dbx, device).await.unwrap());
    let preserved = env.dbx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select group_master_key from device_audio_forwarding_group where device_id=$1", [device.into()])).await.unwrap().unwrap();
    assert_eq!(
        preserved.try_get::<String>("", "group_master_key").unwrap(),
        groups[1]
    );
    assert!(configure(
        &env,
        &actor,
        device,
        true,
        vec![],
        vec![groups[1].clone()]
    )
    .await
    .is_err());
    let tx = env.dbx.begin().await.unwrap();
    let change = types::DeviceAudioForwardingChange {
        version: stale.version,
        enabled: true,
        add_groups: vec![],
        remove_groups: vec![],
    };
    assert!(matches!(
        settings::apply(&tx, &actor, device, &change).await,
        Err(crate::error::AppError::ConflictJson { .. })
    ));
    tx.rollback().await.unwrap();
    let mut viewer = actor.clone();
    viewer.roles = serde_json::json!(["CyberViewer"]);
    assert!(catalog::list(
        &env.dbx,
        &viewer,
        &types::ListDeviceAudioForwardingReq { cursor: None }
    )
    .await
    .is_err());
    assert!(configure(&env, &viewer, device, false, vec![], vec![])
        .await
        .is_err());
    configure(&env, &actor, device, true, vec![], vec![])
        .await
        .unwrap();
    assert!(settings::read(&env.dbx, &actor, device)
        .await
        .unwrap()
        .groups
        .iter()
        .all(|group| !group.selected));
    assert!(settings::configured(&env.dbx, device).await.unwrap());
    crate::entities::signal_group::Entity::update_many()
        .col_expr(
            crate::entities::signal_group::Column::IsArchived,
            sea_query::Expr::value(true),
        )
        .filter(crate::entities::signal_group::Column::MasterKey.eq(&groups[1]))
        .exec(&env.dbx)
        .await
        .unwrap();
    assert!(!settings::configured(&env.dbx, device).await.unwrap());
}

#[actix_web::test]
#[serial_test::serial]
async fn forwarding_media_survives_disabled_devices_and_archived_target_is_skipped(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    configure(&env, &actor, device, true, groups.clone(), vec![])
        .await
        .unwrap();
    let audio = receive(&env, actor.id, device).await;
    let deliveries = deliveries(&env, audio.id).await;
    let tx = env.dbx.begin().await.unwrap();
    crate::messenger::group::set_signal_group_archived(
        &tx,
        &deliveries[1].group_master_key,
        true,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(worker::deliver(&env, &deliveries[1])
        .await
        .unwrap()
        .is_none());
    let message = worker::deliver(&env, &deliveries[0])
        .await
        .unwrap()
        .unwrap();
    system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::DevicesSectionEnabled,
            sea_query::Expr::value(false),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    let mut reader = actor.clone().into_active_model();
    reader.roles = Set(serde_json::json!(["Rer"]));
    reader.update(&env.dbx).await.unwrap();
    let media =
        crate::messenger::audio_ref::for_messages(&env, &env.dbx, &[message])
            .await
            .unwrap()
            .remove(0);
    let request = actix_web::test::TestRequest::get()
        .insert_header(("Range", "bytes=0-15"))
        .to_http_request();
    let response = audio::message_representation(
        &env,
        actor.id,
        media.id,
        audio::types::DeviceAudioRepresentation::Content,
        Some(&request),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 206);
    let outsider = crate::devices::audio::tests::audio_actor(
        &env.dbx,
        actor.organism_id.unwrap(),
        &["Rer"],
    )
    .await;
    assert!(audio::message_representation(
        &env,
        outsider.id,
        media.id,
        audio::types::DeviceAudioRepresentation::Content,
        None
    )
    .await
    .is_err());
    let bytes = crate::messenger::audio_ref::bytes(&env, &media)
        .await
        .unwrap();
    assert_eq!(bytes.len(), audio.source_size_bytes as usize);
    assert_eq!(
        &sha2::Sha256::digest(&bytes)[..],
        audio.source_sha256.as_slice()
    );
    assert!(audio::list(
        &env.device_audio,
        actor.id,
        audio::types::ListDeviceAudioCommand {
            device_id: device,
            unprocessed_only: false,
            limit: 20,
            cursor: None
        }
    )
    .await
    .is_err());
}

use sha2::Digest;

#[actix_web::test]
#[serial_test::serial]
async fn forwarding_reuses_every_queue_state_and_enqueues_without_device_asr() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device, groups) = fixture(&env).await;
    configure(&env, &actor, device, true, vec![groups[0].clone()], vec![])
        .await
        .unwrap();
    system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::EnableAudioTranscription,
            sea_query::Expr::value(true),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    env.device_audio.file_database().unwrap().execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into device_audio_asr_setting(device_id,enabled,updated_at,updated_by_login_id) values($1,false,now(),$2)", [device.into(),actor.id.into()])).await.unwrap();
    for state in [
        None,
        Some("queued"),
        Some("processing"),
        Some("retrying"),
        Some("terminal"),
    ] {
        let audio = receive(&env, actor.id, device).await;
        assert!(audio.automatic_transcription_pending.is_none());
        let prior = if let Some(state) = state {
            let (source, _) = crate::transcription::service::enqueue(
                &env.dbx,
                &audio.storage_key,
            )
            .await
            .unwrap();
            env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "update echo_gpu_transcription_queue set state=$2 where source_id=$1", [source.into(), state.into()])).await.unwrap();
            Some(
                echo_gpu_client::lookup(&env.dbx, source)
                    .await
                    .unwrap()
                    .unwrap()
                    .0,
            )
        } else {
            None
        };
        assert!(worker::batch(&env).await.unwrap());
        let source = crate::transcription::service::source_id(
            &env.dbx,
            &audio.storage_key,
        )
        .await
        .unwrap()
        .unwrap();
        let task = echo_gpu_client::lookup(&env.dbx, source)
            .await
            .unwrap()
            .unwrap()
            .0;
        if let Some(prior) = prior {
            assert_eq!(task, prior);
        } else {
            assert_eq!(task.state, "queued");
        }
        assert!(!worker::batch(&env).await.unwrap());
    }
}
