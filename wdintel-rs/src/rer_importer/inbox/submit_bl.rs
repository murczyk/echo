use crate::entities::datasource;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::*;
use crate::users::{has_any_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::web::Data;
use sea_orm::*;

#[derive(Debug)]
pub(crate) struct SubmittedInboxItem {
    pub(crate) signal_message_id: i64,
    pub(crate) signal_message_uuid: Option<uuid::Uuid>,
    pub(crate) inbox_id: i64,
    pub(crate) warnings: Vec<InboxSubmitWarning>,
}

pub(crate) async fn submit_generic_inbox(
    user: Identity,
    env: &Data<Env>,
    item: InboxSubmitItem,
) -> Result<GenericInboxSubmitRsp, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Rer", "Cyber", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;
    let login = login_id_from_identity(&user)?;
    let logins = crate::users::get_organism_login_ids(&env.dbx, user)
        .await
        .context(h!())?;
    let submitted =
        submit_generic_inbox_message(env, &login, &logins, item).await?;
    Ok(GenericInboxSubmitRsp {
        warnings: submitted.warnings,
    })
}

pub(crate) async fn submit_generic_inbox_message(
    env: &Data<Env>,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    if item.device_name_id.is_some() {
        crate::devices::access::require_message_devices(&env.dbx, login)
            .await
            .c(h!())?;
    }
    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLoginId.eq(*login))
        .filter(datasource::Column::Enabled.eq(true))
        .filter(datasource::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let submitted =
        submit_generic_inbox_item(env, &txn, &datasource, login, logins, item)
            .await
            .c(h!())?;
    let inbox_id = submitted.inbox_id;

    txn.commit().await.c(h!())?;
    super::fanout_inbox_changed(env, vec![inbox_id]).await;
    Ok(submitted)
}

pub(crate) async fn submit_generic_inbox_item(
    env: &Data<Env>,
    txn: &DatabaseTransaction,
    datasource: &datasource::Model,
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
) -> Result<SubmittedInboxItem, AppError> {
    super::validate_generic_submit_item(&item).c(h!())?;
    let sender_login =
        crate::api_senders::resolve_login(txn, *login, item.sender_id)
            .await
            .c(h!())?;
    let groups = super::ensure_submit_groups(
        txn,
        datasource,
        login,
        item.group_names.as_deref().unwrap_or(&[]),
    )
    .await
    .c(h!())?;
    let item = parse_missing_submit_unit(env, txn, &groups, item)
        .await
        .c(h!())?;
    let keys = groups
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    let destination_groups = crate::entities::signal_group::Entity::find()
        .filter(crate::entities::signal_group::Column::MasterKey.is_in(keys))
        .all(txn)
        .await
        .c(h!())?;
    for group in destination_groups {
        crate::messenger::group::requirements::validate(&group, &item)
            .c(h!())?;
    }
    let device_name_id = item.device_name_id;
    let submitted = submit_inbox_item_with_groups(
        env.as_ref(),
        txn,
        Some(datasource.id),
        &groups,
        login,
        logins,
        item,
        false,
    )
    .await
    .c(h!())?;
    if let Some(device_name_id) = device_name_id {
        crate::entities::sigint_inbox_item::ActiveModel {
            id: Set(submitted.inbox_id),
            device_name_id: Set(Some(device_name_id)),
            ..Default::default()
        }
        .update(txn)
        .await
        .c(h!())?;
    }
    if let Some(sender_login) = sender_login {
        crate::api_senders::attribute_message(
            txn,
            submitted.signal_message_id,
            sender_login,
        )
        .await
        .c(h!())?;
    }
    Ok(submitted)
}

async fn parse_missing_submit_unit(
    env: &Env,
    txn: &DatabaseTransaction,
    groups: &[(String, i64)],
    mut item: InboxSubmitItem,
) -> anyhow::Result<InboxSubmitItem> {
    if crate::inbox::unit_resolution::has_resolved_unit_text(
        txn,
        item.unit.as_deref(),
        item.unit.as_deref(),
    )
    .await
    .c(h!())?
    {
        return Ok(item);
    }
    let body = super::normalized_optional_string(item.full_body.as_deref())
        .or_else(|| super::normalized_optional_string(item.text.as_deref()))
        .c(h!())?
        .replace("\r\n", "\n");
    let aor_id = match groups.first() {
        Some((master_key, _)) => {
            crate::messenger::group::resolve_group_aor_id(txn, master_key)
                .await
                .c(h!())?
        }
        None => None,
    };
    let parsed = crate::unit::parse_message_unit(
        txn,
        env,
        &body,
        super::submit_item_callsigns(&item),
        aor_id,
    )
    .await
    .c(h!())?;
    if let Some(unit) = parsed
        .synonym
        .or(parsed.unit_v2)
        .or(parsed.unit_and_location.unit)
    {
        item.unit = Some(unit);
    }
    Ok(item)
}

pub(crate) async fn submit_inbox_item_with_groups(
    env: &Env,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_location_mode(
        env,
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        allow_empty_content,
        false,
        super::InboxLocationSubmitMode::Parse,
    )
    .await
}

pub(crate) async fn submit_inbox_item_with_groups_location_mode(
    env: &Env,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        &env.config,
        env.settlements.clone(),
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        None,
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
        None,
        None,
    )
    .await
}

pub(crate) async fn submit_inbox_item_with_groups_location_mode_context(
    config: &crate::config::Config,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
    signal_message_uuid: Option<uuid::Uuid>,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        config,
        settlements,
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        None,
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
        signal_message_uuid,
        None,
    )
    .await
}

pub(crate) async fn edit_inbox_item_with_groups_location_mode(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
    source_group_master_key: Option<&str>,
) -> Result<SubmittedInboxItem, AppError> {
    submit_inbox_item_with_groups_inner(
        &env.config,
        env.settlements.clone(),
        txn,
        datasource_id,
        groups,
        login,
        logins,
        item,
        Some(signal_message_id),
        allow_empty_content,
        keep_timestamp_missing,
        location_mode,
        None,
        source_group_master_key,
    )
    .await
}

async fn submit_inbox_item_with_groups_inner(
    config: &crate::config::Config,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    txn: &DatabaseTransaction,
    datasource_id: Option<i64>,
    groups: &[(String, i64)],
    login: &uuid::Uuid,
    logins: &Vec<uuid::Uuid>,
    item: InboxSubmitItem,
    signal_message_id: Option<i64>,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
    location_mode: super::InboxLocationSubmitMode,
    signal_message_uuid: Option<uuid::Uuid>,
    source_group_master_key: Option<&str>,
) -> Result<SubmittedInboxItem, AppError> {
    if let Some(device_name_id) = item.device_name_id {
        crate::sigint::direct_submit::query::validate_device_name_id(
            txn,
            device_name_id,
        )
        .await
        .c(h!())?;
    }
    let mut prepared = prepare_inbox_submit_item(
        txn,
        groups,
        &item,
        allow_empty_content,
        keep_timestamp_missing,
    )
    .await?;

    if let Some(signal_message_id) = signal_message_id {
        delete_cleared_edit_comment(
            txn,
            signal_message_id,
            login,
            logins,
            &mut prepared.message,
        )
        .await?;
    }

    let signal_message = match signal_message_id {
        Some(signal_message_id) => super::update_submit_signal_message(
            txn,
            config,
            signal_message_id,
            login,
            &prepared.message,
            prepared.timestamp,
            prepared.operator_tags,
            groups,
            source_group_master_key,
        )
        .await
        .c(h!())?,
        None => super::upsert_submit_signal_message(
            txn,
            config,
            datasource_id,
            login,
            None,
            &prepared.message,
            prepared.timestamp,
            prepared.operator_tags,
            groups,
            signal_message_uuid,
        )
        .await
        .c(h!())?,
    };
    let inbox_id = super::submit_upsert_inbox_item(
        settlements,
        txn,
        signal_message.id,
        &prepared.message,
        login,
        logins,
        location_mode,
        item.parse_body_coordinates,
        signal_message_id.is_some(),
    )
    .await
    .c(h!())?;
    match signal_message_id {
        Some(_) => {
            super::replace_submit_tags(
                txn,
                inbox_id,
                signal_message.id_uuid,
                login,
                prepared.tag_ids,
            )
            .await
            .c(h!())?;
        }
        None => {
            super::add_submit_tags(
                txn,
                inbox_id,
                signal_message.id_uuid,
                login,
                prepared.tag_ids,
            )
            .await
            .c(h!())?;
        }
    }
    let InboxSubmitItem { network, dmr, .. } = item;
    let warnings = super::save_submit_dmr_metadata(
        inbox_id,
        signal_message.id_uuid,
        network.as_ref(),
        dmr,
        txn,
    )
    .await
    .c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_message(
        txn,
        signal_message.id,
        format!("submitted inbox message {}", signal_message.id),
    )
    .await
    .c(h!())?;
    crate::ai_position::worker::enqueue_message_if_enabled(txn, inbox_id)
        .await
        .c(h!())?;

    Ok(SubmittedInboxItem {
        signal_message_id: signal_message.id,
        signal_message_uuid: signal_message.id_uuid,
        inbox_id,
        warnings,
    })
}

async fn delete_cleared_edit_comment(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    message: &mut InboxMessage,
) -> Result<(), AppError> {
    if message
        .extended_form
        .as_deref()
        .is_some_and(|comment| !comment.trim().is_empty())
    {
        return Ok(());
    }
    super::delete_editable_linked_message_comments(
        txn,
        signal_message_id,
        login,
        logins,
    )
    .await
    .c(h!())?;
    super::delete_editable_sigint_comments(
        txn,
        signal_message_id,
        login,
        logins,
    )
    .await
    .c(h!())?;
    message.extended_form = None;
    Ok(())
}

struct PreparedInboxSubmitItem {
    message: InboxMessage,
    timestamp: Option<chrono::NaiveDateTime>,
    tag_ids: Option<Vec<i64>>,
    operator_tags: Option<serde_json::Value>,
}

async fn prepare_inbox_submit_item(
    txn: &DatabaseTransaction,
    groups: &[(String, i64)],
    item: &InboxSubmitItem,
    allow_empty_content: bool,
    keep_timestamp_missing: bool,
) -> Result<PreparedInboxSubmitItem, AppError> {
    super::validate_submit_item_content(item)?;
    let tag_ids =
        super::resolve_submit_tag_ids(txn, item.tags.as_deref()).await?;
    let operator_tags = super::submit_operator_tags(item.tags.as_deref())?;
    let (mut message, timestamp) =
        super::generic_submit_item_to_inbox_message(item, allow_empty_content)?;
    let timestamp = if keep_timestamp_missing {
        message.date = None;
        message.time = None;
        message.timestamp = None;
        None
    } else {
        Some(timestamp)
    };
    let post = super::normalized_optional_string(message.post.as_deref());
    message.post_id = match message.post_id {
        Some(post_id) => Some(post_id),
        None => crate::sigint::post::get_or_create_post_id(txn, &post)
            .await
            .c(h!())?,
    };
    message.group_master_key = groups.first().map(|(key, _)| key.clone());
    message.post = post;
    super::prepare_submit_body_for_coordinate_extraction(&mut message)?;
    Ok(PreparedInboxSubmitItem {
        message,
        timestamp,
        tag_ids,
        operator_tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
    use crate::entities::{sigint_inbox_item, sigint_inbox_item_unit};
    use crate::functest::tests::{
        cleanup_locked, find_test_datasource, find_test_login, mk_sigint_unit,
    };
    use serde_json::json;

    #[tokio::test]
    #[serial]
    async fn issue_3920_generic_submit_parsed_missing_and_unresolved_units() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let label = "24 обБпС рБпЛА вБпЛА КТ";
        let unit = seed_submit_unit(
            &env,
            "взвБпЛА КТ рБпЛА 24 обБпС 7 дшд",
            "",
            label,
        )
        .await;
        let supplied_label = "Лейбл 3920";
        let supplied =
            seed_submit_unit(&env, "3920 мсп", "3920 мсп", supplied_label)
                .await;
        let body = format!("{label} | 2026-10-29\r\n17-45\r\n- С тест");
        let parsed = crate::sigint::direct_submit::bl::parse_signal_message(
            &login.id,
            &env,
            crate::sigint::direct_submit::types::DirectSubmitParsePayload {
                full_body: body.clone(),
                signal_group_master_key: None,
                include_ai_callsigns: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(parsed.unit_v2.as_deref(), Some(unit.name.as_str()));
        let cases = [
            (json!({}), Some(unit.name.as_str()), Some(unit.id)),
            (
                json!({"unit": null}),
                Some(unit.name.as_str()),
                Some(unit.id),
            ),
            (
                json!({"unit": "  "}),
                Some(unit.name.as_str()),
                Some(unit.id),
            ),
            (
                json!({"unit": "Невідомий 3920"}),
                Some(unit.name.as_str()),
                Some(unit.id),
            ),
            (
                json!({"full_body": null, "text": body}),
                Some(unit.name.as_str()),
                Some(unit.id),
            ),
            (
                json!({"full_body": "  ", "text": body}),
                Some(unit.name.as_str()),
                Some(unit.id),
            ),
            (
                json!({"unit": supplied.name}),
                Some(supplied.name.as_str()),
                Some(supplied.id),
            ),
            (
                json!({"unit": supplied_label}),
                Some(supplied_label),
                Some(supplied.id),
            ),
            (
                json!({"unit": " 3920   МСП "}),
                Some(" 3920   МСП "),
                Some(supplied.id),
            ),
            (
                json!({"unit": "3920 мсп, невідомий підрозділ"}),
                Some("3920 мсп, невідомий підрозділ"),
                Some(supplied.id),
            ),
            (
                json!({"full_body": "Звичайне повідомлення", "unit": "Невідомий 3920"}),
                Some("Невідомий 3920"),
                None,
            ),
            (
                json!({"full_body": "Звичайне повідомлення", "text": body}),
                None,
                None,
            ),
            (
                json!({"full_body": "98765 мсп | 2026-10-29\n- С тест"}),
                Some("98765 мсп"),
                None,
            ),
            (
                json!({"full_body": format!("{label}\n10.11.2026, 10:23 (МСК)\n- Принял.")}),
                Some(label),
                Some(unit.id),
            ),
            (
                json!({"full_body": format!("{label}\n10.11.2026, 11:08 (МСК)\n-уточни где они имущество скинули?\n-примерно метров 700 от нас, в ложбину спуститься")}),
                Some(label),
                Some(unit.id),
            ),
            (
                json!({"full_body": "\r\n 24 ОББПС  РБПЛА\tВБПЛА КТ \r\n10.11.2026, 10:23 (МСК)\r\n- Принял."}),
                Some("24 ОББПС  РБПЛА\tВБПЛА КТ"),
                Some(unit.id),
            ),
            (
                json!({"full_body": format!("Невідомий заголовок\n10.11.2026, 10:23 (МСК)\n{label}")}),
                None,
                None,
            ),
            (
                json!({"full_body": format!("{label} уточнення\n10.11.2026, 10:23 (МСК)\n- Принял.")}),
                None,
                None,
            ),
            (json!({"full_body": "Звичайне повідомлення"}), None, None),
        ];
        for (overrides, expected_unit, expected_id) in cases {
            let mut request = json!({
                "full_body": body,
                "text": "Явний текст 3920",
                "timestamp": "2026-10-29T12:00:00Z",
                "freq": "145.5000",
                "locations": ["Невідома локація 3920"],
                "group_names": ["SC1"],
            });
            request
                .as_object_mut()
                .unwrap()
                .extend(overrides.as_object().unwrap().clone());
            assert_submitted_unit(
                &env_data,
                &datasource,
                &login.id,
                request,
                expected_unit,
                expected_id,
            )
            .await;
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_4022_header_synonym_preserves_duplicate_unit_name_link() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let name = "Підрозділ 4022";
        let first =
            seed_submit_unit(&env, name, "", "Перший синонім 4022").await;
        let second =
            seed_submit_unit(&env, name, "", "Другий синонім 4022").await;
        for (label, unit_id) in [
            ("Перший синонім 4022", first.id),
            ("Другий синонім 4022", second.id),
        ] {
            let body = format!("{label}\n10.11.2026, 10:23 (МСК)\n- Принял.");
            assert_submitted_unit(
                &env_data,
                &datasource,
                &login.id,
                json!({
                    "full_body": body,
                    "timestamp": "2026-11-10T07:23:00Z",
                    "freq": "145.5000",
                    "locations": ["Невідома локація 3920"],
                    "group_names": ["SC1"],
                }),
                Some(label),
                Some(unit_id),
            )
            .await;
            let parsed = crate::sigint::direct_submit::bl::parse_signal_message(
                &login.id,
                &env,
                crate::sigint::direct_submit::types::DirectSubmitParsePayload {
                    full_body: body,
                    signal_group_master_key: None,
                    include_ai_callsigns: false,
                },
            )
            .await
            .unwrap();
            assert_eq!(parsed.unit.as_deref(), Some(label));
            assert_eq!(parsed.unit_v2.as_deref(), Some(name));
            assert_eq!(parsed.unit_id, Some(unit_id));
        }
        crate::sigint::unit::merge_units(
            login.id, &env.dbx, second.id, first.id,
        )
        .await
        .unwrap();
        let parsed = crate::sigint::direct_submit::bl::parse_signal_message(
            &login.id,
            &env,
            crate::sigint::direct_submit::types::DirectSubmitParsePayload {
                full_body:
                    "Другий синонім 4022\n10.11.2026, 10:23 (МСК)\n- Принял."
                        .to_string(),
                signal_group_master_key: None,
                include_ai_callsigns: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(parsed.unit_id, None);
        assert_eq!(parsed.unit_v2, None);
    }

    #[tokio::test]
    #[serial]
    async fn issue_4022_header_synonym_revalidates_cached_label_mapping() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let unit = seed_submit_unit(
            &env,
            "Перший підрозділ 4022",
            "",
            "Інший синонім 4022",
        )
        .await;
        let label = crate::sigint::unit::labels::insert_label(
            &env.dbx,
            unit.id,
            "Власний синонім 4022",
        )
        .await
        .unwrap();
        let body =
            "\n ВЛАСНИЙ  СИНОНІМ\t4022 \n10.11.2026, 10:23 (МСК)\n- Принял.";
        assert_eq!(
            env.unit_header_synonyms
                .resolve(&env.dbx, body)
                .await
                .unwrap()
                .unwrap()
                .id,
            unit.id
        );
        label.delete(&env.dbx).await.unwrap();
        for reassigned in [false, true] {
            if reassigned {
                seed_submit_unit(
                    &env,
                    "Другий підрозділ 4022",
                    "",
                    "власний синонім 4022",
                )
                .await;
            }
            let parsed = crate::sigint::direct_submit::bl::parse_signal_message(
                &login.id,
                &env,
                crate::sigint::direct_submit::types::DirectSubmitParsePayload {
                    full_body: body.to_string(),
                    signal_group_master_key: None,
                    include_ai_callsigns: false,
                },
            )
            .await
            .unwrap();
            assert_eq!(parsed.unit_id, None);
            assert_eq!(parsed.unit_v2, None);
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_4022_header_synonym_refresh_uses_submit_transaction() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let label = "Власний синонім 4022";
        let unit = seed_submit_unit(&env, "Підрозділ 4022", "", label).await;
        let mut options =
            ConnectOptions::new(crate::mk_conn_string(&env.config));
        options
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(1));
        let mut env = env.as_ref().clone();
        env.dbx = Database::connect(options).await.unwrap();
        let env = Data::new(env);
        for elapsed in [
            0,
            0,
            crate::config::SIGINT_UNIT_HEADER_SYNONYMS_REFRESH_SECS + 1,
        ] {
            advance_synonym_cache_time(elapsed).await;
            assert_submitted_unit(
                &env,
                &datasource,
                &login.id,
                json!({
                    "full_body": format!("{label}\n10.11.2026, 10:23 (МСК)\n- Принял."),
                    "timestamp": "2026-11-10T07:23:00Z",
                    "freq": "145.5000",
                    "locations": ["Невідома локація 3920"],
                    "group_names": ["SC1"],
                }),
                Some(label),
                Some(unit.id),
            )
            .await;
        }
    }

    #[tokio::test]
    #[serial]
    async fn header_synonym_snapshot_refreshes_after_expiry() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let env_data = Data::from(env.clone());
        let login = find_test_login(&env.dbx).await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let label = "Власний синонім 4022";
        let request = json!({
            "full_body": format!("{label}\n10.11.2026, 10:23 (МСК)\n- Принял."),
            "timestamp": "2026-11-10T07:23:00Z",
            "freq": "145.5000",
            "locations": ["Невідома локація 3920"],
            "group_names": ["SC1"],
        });
        assert_submitted_unit(
            &env_data,
            &datasource,
            &login.id,
            request.clone(),
            None,
            None,
        )
        .await;
        let unit = seed_submit_unit(&env, "Підрозділ 4022", "", label).await;
        assert_submitted_unit(
            &env_data,
            &datasource,
            &login.id,
            request.clone(),
            None,
            None,
        )
        .await;
        advance_synonym_cache_time(
            crate::config::SIGINT_UNIT_HEADER_SYNONYMS_REFRESH_SECS / 2,
        )
        .await;
        let disconnected = DatabaseConnection::default();
        assert_eq!(
            env.unit_header_synonyms
                .resolve(&disconnected, label)
                .await
                .unwrap(),
            None
        );
        advance_synonym_cache_time(
            crate::config::SIGINT_UNIT_HEADER_SYNONYMS_REFRESH_SECS / 2 + 1,
        )
        .await;
        for active in [true, false] {
            crate::entities::sigint_unit::ActiveModel {
                id: Set(unit.id),
                active: Set(active),
                ..Default::default()
            }
            .update(&env.dbx)
            .await
            .unwrap();
            assert_submitted_unit(
                &env_data,
                &datasource,
                &login.id,
                request.clone(),
                Some(label),
                Some(unit.id),
            )
            .await;
            assert_eq!(
                env.unit_header_synonyms
                    .resolve(&env.dbx, label)
                    .await
                    .unwrap(),
                Some(crate::unit::header_synonyms::HeaderSynonymUnit {
                    id: unit.id,
                    name: unit.name.clone(),
                })
            );
        }
        crate::entities::sigint_unit::ActiveModel {
            id: Set(unit.id),
            deleted: Set(true),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        let parsed = crate::sigint::direct_submit::bl::parse_signal_message(
            &login.id,
            &env,
            crate::sigint::direct_submit::types::DirectSubmitParsePayload {
                full_body: request["full_body"].as_str().unwrap().to_string(),
                signal_group_master_key: None,
                include_ai_callsigns: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(parsed.unit_id, None);
        assert_eq!(parsed.unit_v2, None);
        assert_submitted_unit(
            &env_data,
            &datasource,
            &login.id,
            request,
            None,
            None,
        )
        .await;
    }

    async fn advance_synonym_cache_time(seconds: u64) {
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(seconds)).await;
        tokio::time::resume();
    }

    async fn seed_submit_unit(
        env: &Env,
        name: &str,
        regiment: &str,
        label: &str,
    ) -> crate::entities::sigint_unit::Model {
        let unit = mk_sigint_unit(
            &env.dbx,
            crate::entities::sigint_unit::ActiveModel {
                name: Set(name.to_string()),
                regiment: Set(regiment.to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::sigint::unit::labels::insert_label(&env.dbx, unit.id, label)
            .await
            .unwrap();
        unit
    }

    async fn assert_submitted_unit(
        env: &Data<Env>,
        datasource: &datasource::Model,
        login: &uuid::Uuid,
        request: serde_json::Value,
        expected_unit: Option<&str>,
        expected_id: Option<i64>,
    ) {
        let item = serde_json::from_value(request.clone()).unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let submitted = submit_generic_inbox_item(
            env,
            &txn,
            datasource,
            login,
            &vec![*login],
            item,
        )
        .await
        .unwrap();
        let stored = sigint_inbox_item::Entity::find_by_id(submitted.inbox_id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.unit_v2.as_deref(), expected_unit, "{request}");
        assert_eq!(stored.freq.as_deref(), Some("145.5000"));
        assert_eq!(stored.location.as_deref(), Some("Невідома локація 3920"));
        let links = sigint_inbox_item_unit::Entity::find()
            .filter(sigint_inbox_item_unit::Column::ItemId.eq(stored.id))
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Parsed),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(
            links.iter().map(|link| link.unit_id).collect::<Vec<_>>(),
            expected_id.into_iter().collect::<Vec<_>>(),
            "{request}"
        );
        txn.rollback().await.unwrap();
    }
}
