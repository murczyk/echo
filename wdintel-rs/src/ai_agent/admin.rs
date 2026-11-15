use super::types::*;
use super::{
    access, chat_monitoring, dispatcher, lifecycle, reasoning, review,
};
use crate::config::{
    AI_AGENT_ADMIN_REQUEST_PAGE_SIZE, AI_AGENT_ECHO_PROXY_PING_PATH,
    AI_AGENT_ECHO_PROXY_TEST_TIMEOUT_SEC, AI_AGENT_MATTERMOST_TIMEOUT_SEC,
};
use crate::entities::{
    ai_agent_allowed_engine, ai_agent_container, ai_agent_conversation,
    ai_agent_dispatcher, ai_agent_echo_proxy, ai_agent_engine_runtime_profile,
    ai_agent_request, ai_agent_request_event, ai_agent_security_review,
    ai_agent_settings, ai_agent_user_link, ai_engine, login, organism,
    secret_group_user, sigint_zone,
};
use crate::error::AppError;
use crate::h;
use crate::mattermost;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{get, post, web::Json};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition,
    ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use url::Url;
use uuid::Uuid;

async fn ensure_admin_non_api_agent(
    env: &Env,
    user: &Identity,
) -> Result<(), AppError> {
    crate::users::ensure_admin(&env.dbx, user).await?;
    let login_id = crate::users::login_id_from_identity(user)?;
    let login = login::Entity::find_by_id(login_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)?;
    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    if roles
        .iter()
        .any(|role| role == crate::config::AI_AGENT_ROLE_API)
    {
        return Err(AppError::Forbidden(
            "ApiAgent cannot use the AI agent control plane".to_string(),
        ));
    }
    Ok(())
}

#[get("/api/admin/ai-agent/settings")]
pub async fn get_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentAdminSettingsItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    Ok(Json(settings_item(&env).await?))
}

#[post("/api/admin/ai-agent/settings")]
pub async fn update_settings(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminSettingsUpdateReq>,
) -> Result<Json<AiAgentAdminSettingsItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let allowed_ids = req
        .allowed_ai_engine_ids
        .iter()
        .map(|id| access::parse_uuid(id))
        .collect::<Result<Vec<_>, _>>()?;
    let unique_ids = allowed_ids.iter().copied().collect::<HashSet<_>>();
    if unique_ids.len() != allowed_ids.len() {
        return Err(AppError::BL {
            msg: "ШІ провайдери не повинні дублюватися".to_string(),
        });
    }
    validate_allowed_engines(&env, &allowed_ids).await?;
    let runtime_profiles = validate_runtime_profiles(
        &env,
        &req.provider_runtime_profiles,
        &unique_ids,
    )
    .await?;
    let default_ai_engine_id = req
        .default_ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()?;
    let reviewer_ai_engine_id = req
        .reviewer_ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()?;
    let refusal_rewrite_ai_engine_id = req
        .refusal_rewrite_ai_engine_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()
        .context(h!())?;
    if default_ai_engine_id.is_some_and(|id| !unique_ids.contains(&id)) {
        return Err(AppError::BL {
            msg: "Default provider must be in the allowlist".to_string(),
        });
    }
    validate_reviewer_engine(&env, reviewer_ai_engine_id).await?;
    if req.feature_enabled && default_ai_engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Виберіть провайдера за замовчуванням".to_string(),
        });
    }
    if req.security_review_enabled && reviewer_ai_engine_id.is_none() {
        return Err(AppError::BL {
            msg: "Виберіть провайдера перевірки безпеки".to_string(),
        });
    }
    if refusal_rewrite_ai_engine_id.is_some_and(|id| !unique_ids.contains(&id))
    {
        return Err(AppError::BL {
            msg: "Refusal rewrite provider must be in the allowlist"
                .to_string(),
        });
    }
    if let Some(rewrite_id) = refusal_rewrite_ai_engine_id {
        let rewrite_engine = access::allowed_engine_by_id(&env.dbx, rewrite_id)
            .await
            .context(h!())?;
        if !access::refusal_rewrite_compatible(&rewrite_engine) {
            return Err(AppError::BL {
                msg:
                    "Провайдер перезапису відмов має працювати через Echo-шлюз"
                        .to_string(),
            });
        }
    }
    if req.refusal_rewrite_enabled && refusal_rewrite_ai_engine_id.is_none() {
        let default_rewrite_engine = access::ordered_allowed_engines(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .any(|ai_engine| {
                crate::ai_engine::client::model_id(&ai_engine)
                    == crate::config::AI_AGENT_REFUSAL_REWRITE_DEFAULT_MODEL
                    && access::refusal_rewrite_compatible(&ai_engine)
            });
        if !default_rewrite_engine {
            return Err(AppError::BL {
                msg: "Виберіть провайдера перезапису відмов, або додайте gpt-6-luna до дозволених"
                    .to_string(),
            });
        }
    }
    let template_login_id = req
        .template_login_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()?
        .unwrap_or(
            Uuid::parse_str(crate::config::AI_AGENT_TEMPLATE_LOGIN_ID)
                .c(h!())?,
        );
    validate_template_ownership(&env, template_login_id).await?;
    let current_template_login_id =
        access::template_login_id(&access::settings(&env.dbx).await?)?;
    if req.feature_enabled || template_login_id != current_template_login_id {
        lifecycle::preflight_template(&env, template_login_id).await?;
    }
    let txn = env.dbx.begin().await.c(h!())?;
    crate::ai_control_panel::probe::lock_lifecycle(&txn)
        .await
        .c(h!())?;
    let settings = ai_agent_settings::Entity::find_by_id(
        crate::config::AI_AGENT_SETTINGS_ID,
    )
    .lock_exclusive()
    .one(&txn)
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)?;
    lifecycle::reconcile_template_login_id(&txn, template_login_id).await?;
    let mattermost_webhook_url = updated_webhook(
        req.mattermost_webhook_url.as_deref(),
        req.clear_mattermost_webhook,
        settings.mattermost_webhook_url.clone(),
    );
    let mattermost_chat_webhook_url = updated_webhook(
        req.mattermost_chat_webhook_url.as_deref(),
        req.clear_mattermost_chat_webhook,
        settings.mattermost_chat_webhook_url.clone(),
    );
    for webhook in [
        mattermost_webhook_url.as_deref(),
        mattermost_chat_webhook_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        mattermost::resolve_webhook(
            webhook,
            Duration::from_secs(AI_AGENT_MATTERMOST_TIMEOUT_SEC),
        )
        .await
        .c(h!())?;
    }
    if req.security_review_enabled && mattermost_webhook_url.is_none() {
        return Err(AppError::BL {
            msg: "Mattermost webhook is required while security review is enabled"
                .to_string(),
        });
    }
    if req.mattermost_chat_enabled && mattermost_chat_webhook_url.is_none() {
        return Err(AppError::BL {
            msg: "Mattermost chat webhook is required while chat monitoring is enabled"
                .to_string(),
        });
    }
    let has_unsent_alerts = ai_agent_security_review::Entity::find()
        .filter(ai_agent_security_review::Column::State.eq("suspicious"))
        .filter(
            Condition::any()
                .add(ai_agent_security_review::Column::AlertState.is_null())
                .add(ai_agent_security_review::Column::AlertState.ne("sent")),
        )
        .one(&txn)
        .await
        .c(h!())?
        .is_some();
    if mattermost_webhook_url.is_none() && has_unsent_alerts {
        return Err(AppError::BL {
            msg: "Mattermost webhook cannot be cleared while security alerts are pending"
                .to_string(),
        });
    }
    let mut settings = settings.into_active_model();
    settings.feature_enabled = Set(req.feature_enabled);
    settings.template_login_id = Set(Some(template_login_id));
    settings.default_ai_engine_id = Set(default_ai_engine_id);
    settings.reviewer_ai_engine_id = Set(reviewer_ai_engine_id);
    settings.security_review_enabled = Set(req.security_review_enabled);
    settings.refusal_rewrite_enabled = Set(Some(req.refusal_rewrite_enabled));
    settings.refusal_rewrite_ai_engine_id = Set(refusal_rewrite_ai_engine_id);
    settings.mattermost_chat_enabled = Set(req.mattermost_chat_enabled);
    settings.mattermost_webhook_url = Set(mattermost_webhook_url);
    settings.mattermost_chat_webhook_url = Set(mattermost_chat_webhook_url);
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(&txn).await.c(h!())?;
    if !req.mattermost_chat_enabled {
        chat_monitoring::discard_pending_in_transaction(&txn).await?;
    }
    ai_agent_allowed_engine::Entity::delete_many()
        .exec(&txn)
        .await
        .c(h!())?;
    for (position, ai_engine_id) in (0..).zip(allowed_ids) {
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(ai_engine_id),
            created_at: Set(Utc::now().naive_utc()),
            position: Set(Some(position)),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }
    for (ai_engine_id, profile) in runtime_profiles {
        let runtime_profile =
            ai_agent_engine_runtime_profile::Entity::find_by_id(ai_engine_id)
                .lock_exclusive()
                .one(&txn)
                .await
                .c(h!())?;
        if let Some(runtime_profile) = runtime_profile {
            let mut runtime_profile = runtime_profile.into_active_model();
            runtime_profile.context_window_tokens =
                Set(profile.context_window_tokens);
            runtime_profile.max_output_tokens = Set(profile.max_output_tokens);
            runtime_profile.compaction_reserve_tokens =
                Set(profile.compaction_reserve_tokens);
            runtime_profile.compaction_keep_recent_tokens =
                Set(profile.compaction_keep_recent_tokens);
            runtime_profile.vision_input_enabled =
                Set(Some(profile.vision_input_enabled));
            runtime_profile.updated_at = Set(Utc::now().naive_utc());
            runtime_profile.update(&txn).await.c(h!())?;
        } else {
            ai_agent_engine_runtime_profile::ActiveModel {
                ai_engine_id: Set(ai_engine_id),
                context_window_tokens: Set(profile.context_window_tokens),
                max_output_tokens: Set(profile.max_output_tokens),
                compaction_reserve_tokens: Set(
                    profile.compaction_reserve_tokens
                ),
                compaction_keep_recent_tokens: Set(
                    profile.compaction_keep_recent_tokens
                ),
                vision_input_enabled: Set(Some(profile.vision_input_enabled)),
                created_at: Set(Utc::now().naive_utc()),
                updated_at: Set(Utc::now().naive_utc()),
            }
            .insert(&txn)
            .await
            .c(h!())?;
        }
    }
    txn.commit().await.c(h!())?;
    Ok(Json(settings_item(&env).await?))
}

fn updated_webhook(
    replacement: Option<&str>,
    clear: bool,
    saved: Option<String>,
) -> Option<String> {
    if clear {
        None
    } else {
        replacement
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or(saved)
    }
}

async fn settings_item(
    env: &Env,
) -> Result<AiAgentAdminSettingsItem, AppError> {
    let settings = access::settings(&env.dbx).await?;
    let template_login_id = access::template_login_id(&settings)?;
    let allowed_ai_engine_ids = access::ordered_allowed_engines(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|ai_engine| ai_engine.id.to_string())
        .collect::<Vec<_>>();
    let mut provider_runtime_profiles =
        ai_agent_engine_runtime_profile::Entity::find()
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|profile| AiAgentProviderRuntimeProfileItem {
                ai_engine_id: profile.ai_engine_id.to_string(),
                context_window_tokens: profile.context_window_tokens,
                max_output_tokens: profile.max_output_tokens,
                compaction_reserve_tokens: profile.compaction_reserve_tokens,
                compaction_keep_recent_tokens: profile
                    .compaction_keep_recent_tokens,
                vision_input_enabled: profile
                    .vision_input_enabled
                    .unwrap_or(false),
            })
            .collect::<Vec<_>>();
    provider_runtime_profiles
        .sort_by(|a, b| a.ai_engine_id.cmp(&b.ai_engine_id));
    Ok(AiAgentAdminSettingsItem {
        feature_enabled: settings.feature_enabled,
        template_login_id: template_login_id.to_string(),
        default_ai_engine_id: settings
            .default_ai_engine_id
            .map(|id| id.to_string()),
        reviewer_ai_engine_id: settings
            .reviewer_ai_engine_id
            .map(|id| id.to_string()),
        security_review_enabled: settings.security_review_enabled,
        refusal_rewrite_enabled: settings
            .refusal_rewrite_enabled
            .unwrap_or(false),
        refusal_rewrite_ai_engine_id: settings
            .refusal_rewrite_ai_engine_id
            .map(|id| id.to_string()),
        mattermost_chat_enabled: settings.mattermost_chat_enabled,
        has_mattermost_webhook: settings.mattermost_webhook_url.is_some(),
        has_mattermost_chat_webhook: settings
            .mattermost_chat_webhook_url
            .is_some(),
        allowed_ai_engine_ids,
        provider_runtime_profiles,
    })
}

async fn validate_runtime_profiles(
    env: &Env,
    profiles: &[AiAgentProviderRuntimeProfileItem],
    allowed_ids: &HashSet<Uuid>,
) -> Result<Vec<(Uuid, AiAgentProviderRuntimeProfileItem)>, AppError> {
    let mut runtime_profiles = Vec::with_capacity(profiles.len());
    let mut profile_ids = HashSet::with_capacity(profiles.len());
    for profile in profiles {
        let ai_engine_id = access::parse_uuid(&profile.ai_engine_id)?;
        if !profile_ids.insert(ai_engine_id) {
            return Err(AppError::BL {
                msg: "Профілі провайдерів не повинні дублюватися".to_string(),
            });
        }
        validate_runtime_profile(profile)?;
        if !allowed_ids.contains(&ai_engine_id) {
            return Err(AppError::BL {
                msg: "Runtime-профіль має належати дозволеному провайдеру"
                    .to_string(),
            });
        }
        runtime_profiles.push((ai_engine_id, profile.clone()));
    }
    if allowed_ids
        .iter()
        .any(|ai_engine_id| !profile_ids.contains(ai_engine_id))
    {
        return Err(AppError::BL {
            msg: "Налаштуйте runtime-профіль кожного дозволеного провайдера"
                .to_string(),
        });
    }
    let profile_ids = profile_ids.into_iter().collect::<Vec<_>>();
    validate_allowed_engines(env, &profile_ids).await?;
    Ok(runtime_profiles)
}

fn validate_runtime_profile(
    profile: &AiAgentProviderRuntimeProfileItem,
) -> Result<(), AppError> {
    let valid = (4_096..=2_000_000).contains(&profile.context_window_tokens)
        && (256..=131_072).contains(&profile.max_output_tokens)
        && profile
            .max_output_tokens
            .checked_add(1_024)
            .is_some_and(|tokens| tokens < profile.context_window_tokens)
        && profile.compaction_reserve_tokens >= profile.max_output_tokens
        && profile.compaction_reserve_tokens < profile.context_window_tokens
        && profile.compaction_keep_recent_tokens >= 1_024
        && profile
            .compaction_keep_recent_tokens
            .checked_add(profile.compaction_reserve_tokens)
            .is_some_and(|tokens| tokens < profile.context_window_tokens);
    if !valid {
        return Err(AppError::BL {
            msg: "Некоректний runtime-профіль провайдера".to_string(),
        });
    }
    Ok(())
}

async fn validate_allowed_engines(
    env: &Env,
    ids: &[Uuid],
) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Id.is_in(ids.to_vec()))
        .all(&env.dbx)
        .await
        .c(h!())?;
    if engines.len() != ids.len()
        || engines
            .iter()
            .any(|ai_engine| !access::is_agent_engine(ai_engine))
    {
        return Err(AppError::BL {
            msg: "AI agents require enabled supported providers".to_string(),
        });
    }
    Ok(())
}

async fn validate_template_ownership(
    env: &Env,
    template_login_id: Uuid,
) -> Result<(), AppError> {
    let by_id = login::Entity::find_by_id(template_login_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let by_name = login::Entity::find()
        .filter(
            login::Column::Login
                .eq(crate::config::AI_AGENT_TEMPLATE_LOGIN_NAME),
        )
        .one(&env.dbx)
        .await
        .c(h!())?;
    if by_id.as_ref().is_some_and(|login| {
        login.login != crate::config::AI_AGENT_TEMPLATE_LOGIN_NAME
    }) || by_name
        .as_ref()
        .is_some_and(|login| login.id != template_login_id)
    {
        return Err(AppError::BL {
            msg: "Template login UUID/name ownership conflict".to_string(),
        });
    }
    Ok(())
}

async fn validate_reviewer_engine(
    env: &Env,
    reviewer_ai_engine_id: Option<Uuid>,
) -> Result<(), AppError> {
    let Some(reviewer_ai_engine_id) = reviewer_ai_engine_id else {
        return Ok(());
    };
    let reviewer = ai_engine::Entity::find_by_id(reviewer_ai_engine_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .filter(|reviewer| reviewer.enabled)
        .ok_or_else(|| AppError::BL {
            msg: "Reviewer must be an enabled provider".to_string(),
        })?;
    let _ = reviewer;
    Ok(())
}

#[get("/api/admin/ai-agent/dispatcher")]
pub async fn get_dispatcher(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentDispatcherItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let dispatcher = ai_agent_dispatcher::Entity::find_by_id(
        crate::config::AI_AGENT_DISPATCHER_ID,
    )
    .one(&env.dbx)
    .await
    .c(h!())?;
    Ok(Json(dispatcher_item(dispatcher).await))
}

#[post("/api/admin/ai-agent/dispatcher")]
pub async fn update_dispatcher(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentDispatcherUpdateReq>,
) -> Result<Json<AiAgentDispatcherItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let host = req.host.trim().to_ascii_lowercase();
    let ssh_user = req.ssh_user.trim().to_string();
    let namespace = req.namespace.trim().to_string();
    if !access::is_dispatcher_hostname(&host)
        || !(1..=65_535).contains(&req.ssh_port)
        || !dispatcher::valid_ssh_user(&ssh_user)
        || !dispatcher::valid_namespace(&namespace)
    {
        return Err(AppError::BL {
            msg: "Некоректні параметри диспетчера".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    let txn = env.dbx.begin().await.c(h!())?;
    crate::ai_control_panel::probe::lock_lifecycle(&txn)
        .await
        .c(h!())?;
    let dispatcher = match ai_agent_dispatcher::Entity::find_by_id(
        crate::config::AI_AGENT_DISPATCHER_ID,
    )
    .one(&txn)
    .await
    .c(h!())?
    {
        Some(dispatcher) => {
            let mut dispatcher = dispatcher.into_active_model();
            dispatcher.host = Set(host);
            dispatcher.port = Set(req.ssh_port);
            dispatcher.ssh_user = Set(ssh_user);
            dispatcher.namespace = Set(namespace);
            dispatcher.last_tested_at = Set(None);
            dispatcher.last_test_error = Set(None);
            dispatcher.updated_at = Set(now);
            dispatcher.update(&txn).await.c(h!())?
        }
        None => ai_agent_dispatcher::ActiveModel {
            id: Set(crate::config::AI_AGENT_DISPATCHER_ID),
            host: Set(host),
            port: Set(req.ssh_port),
            ssh_user: Set(ssh_user),
            namespace: Set(namespace),
            last_tested_at: Set(None),
            last_test_error: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&txn)
        .await
        .c(h!())?,
    };
    dispatcher::DispatcherClient::from_record(&dispatcher)?;
    txn.commit().await.c(h!())?;
    Ok(Json(dispatcher_item(Some(dispatcher)).await))
}

#[post("/api/admin/ai-agent/dispatcher/test")]
pub async fn test_dispatcher(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentDispatcherItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let dispatcher = ai_agent_dispatcher::Entity::find_by_id(
        crate::config::AI_AGENT_DISPATCHER_ID,
    )
    .one(&env.dbx)
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)?;
    let client = dispatcher::DispatcherClient::from_record(&dispatcher)?;
    let error = client
        .call("list", None, serde_json::json!({}))
        .await
        .err()
        .map(|err| access::truncate(format!("{err:#}"), 500));
    let mut dispatcher = dispatcher.into_active_model();
    dispatcher.last_tested_at = Set(Some(Utc::now().naive_utc()));
    dispatcher.last_test_error = Set(error);
    dispatcher.updated_at = Set(Utc::now().naive_utc());
    let dispatcher = dispatcher.update(&env.dbx).await.c(h!())?;
    Ok(Json(dispatcher_item(Some(dispatcher)).await))
}

async fn dispatcher_item(
    dispatcher: Option<ai_agent_dispatcher::Model>,
) -> AiAgentDispatcherItem {
    let identity_file = crate::config::AI_AGENT_DISPATCHER_IDENTITY_FILE;
    let known_hosts_file = crate::config::AI_AGENT_DISPATCHER_KNOWN_HOSTS_FILE;
    let (
        configured,
        host,
        ssh_port,
        ssh_user,
        namespace,
        last_tested_at,
        last_test_error,
    ) = match dispatcher {
        Some(dispatcher) => (
            true,
            dispatcher.host,
            dispatcher.port,
            dispatcher.ssh_user,
            dispatcher.namespace,
            dispatcher
                .last_tested_at
                .map(|value| value.and_utc().timestamp_millis()),
            dispatcher.last_test_error,
        ),
        None => (
            false,
            String::new(),
            i32::from(crate::config::AI_AGENT_DISPATCHER_PORT_DEFAULT),
            String::new(),
            String::new(),
            None,
            None,
        ),
    };
    AiAgentDispatcherItem {
        configured,
        host,
        ssh_port,
        ssh_user,
        namespace,
        identity_file: identity_file.to_string(),
        known_hosts_file: known_hosts_file.to_string(),
        identity_file_present: tokio::fs::metadata(identity_file).await.is_ok(),
        known_hosts_file_present: tokio::fs::metadata(known_hosts_file)
            .await
            .is_ok(),
        last_tested_at,
        last_test_error,
    }
}

#[get("/api/admin/ai-agent/echo-proxies")]
pub async fn list_echo_proxies(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentEchoProxyListRsp>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let items = ai_agent_echo_proxy::Entity::find()
        .order_by_asc(ai_agent_echo_proxy::Column::Hostname)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(proxy_item)
        .collect();
    Ok(Json(AiAgentEchoProxyListRsp { items }))
}

#[post("/api/admin/ai-agent/echo-proxies/upsert")]
pub async fn upsert_echo_proxy(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentEchoProxyUpsertReq>,
) -> Result<Json<AiAgentEchoProxyItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let hostname = req.hostname.trim().to_ascii_lowercase();
    let upstream_host = req.upstream_host.trim().to_string();
    if !access::is_dispatcher_hostname(&hostname)
        || !access::is_dispatcher_upstream_host(&upstream_host)
        || !(1..=65_535).contains(&req.upstream_port)
    {
        return Err(AppError::BL {
            msg: "Некоректні параметри ECHO проксі".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    let proxy = match req.id.as_deref() {
        Some(id) => {
            let proxy = ai_agent_echo_proxy::Entity::find_by_id(
                access::parse_uuid(id)?,
            )
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
            let mut proxy = proxy.into_active_model();
            proxy.hostname = Set(hostname);
            proxy.upstream_host = Set(upstream_host);
            proxy.upstream_port = Set(req.upstream_port);
            proxy.enabled = Set(req.enabled);
            proxy.updated_at = Set(now);
            proxy.update(&env.dbx).await.c(h!())?
        }
        None => ai_agent_echo_proxy::ActiveModel {
            id: Set(Uuid::now_v7()),
            hostname: Set(hostname),
            upstream_host: Set(upstream_host),
            upstream_port: Set(req.upstream_port),
            enabled: Set(req.enabled),
            last_tested_at: Set(None),
            last_test_error: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&env.dbx)
        .await
        .c(h!())?,
    };
    Ok(Json(proxy_item(proxy)))
}

#[post("/api/admin/ai-agent/echo-proxies/delete")]
pub async fn delete_echo_proxy(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    ai_agent_echo_proxy::Entity::delete_by_id(access::parse_uuid(&req.id)?)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/admin/ai-agent/echo-proxies/test")]
pub async fn test_echo_proxy(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentIdReq>,
) -> Result<Json<AiAgentEchoProxyItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let proxy =
        ai_agent_echo_proxy::Entity::find_by_id(access::parse_uuid(&req.id)?)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let error = validate_echo_proxy(&proxy)
        .await
        .err()
        .map(|err| access::truncate(format!("{err:#}"), 500));
    let mut proxy = proxy.into_active_model();
    proxy.last_tested_at = Set(Some(Utc::now().naive_utc()));
    proxy.last_test_error = Set(error);
    proxy.updated_at = Set(Utc::now().naive_utc());
    let proxy = proxy.update(&env.dbx).await.c(h!())?;
    Ok(Json(proxy_item(proxy)))
}

pub(crate) async fn validate_echo_proxy(
    proxy: &ai_agent_echo_proxy::Model,
) -> anyhow::Result<()> {
    let timeout = Duration::from_secs(AI_AGENT_ECHO_PROXY_TEST_TIMEOUT_SEC);
    let upstream_addresses = tokio::net::lookup_host((
        proxy.upstream_host.as_str(),
        u16::try_from(proxy.upstream_port).c(h!())?,
    ))
    .await
    .c(h!())?
    .filter(|address| address.is_ipv4())
    .collect::<Vec<_>>();
    if upstream_addresses.is_empty() {
        anyhow::bail!("Echo proxy upstream did not resolve");
    }
    let ping_url = echo_proxy_ping_url(proxy)?;
    let client = reqwest::Client::builder()
        .connect_timeout(timeout)
        .timeout(timeout)
        .https_only(true)
        .tls_sni(true)
        .resolve_to_addrs(&proxy.hostname, &upstream_addresses)
        .build()
        .c(h!())?;
    let response = client.get(ping_url).send().await.c(h!())?;
    if !response.status().is_success() {
        anyhow::bail!("Echo ping returned HTTP {}", response.status());
    }
    Ok(())
}

fn echo_proxy_ping_url(
    proxy: &ai_agent_echo_proxy::Model,
) -> anyhow::Result<Url> {
    Url::parse(&format!(
        "https://{}:{}{}",
        proxy.hostname, proxy.upstream_port, AI_AGENT_ECHO_PROXY_PING_PATH
    ))
    .c(h!())
}

fn proxy_item(proxy: ai_agent_echo_proxy::Model) -> AiAgentEchoProxyItem {
    AiAgentEchoProxyItem {
        id: proxy.id.to_string(),
        hostname: proxy.hostname,
        upstream_host: proxy.upstream_host,
        upstream_port: proxy.upstream_port,
        enabled: proxy.enabled,
        last_tested_at: proxy
            .last_tested_at
            .map(|value| value.and_utc().timestamp_millis()),
        last_test_error: proxy.last_test_error,
    }
}

#[get("/api/admin/ai-agent/containers")]
pub async fn list_containers(
    env: actix_web::web::Data<Env>,
    user: Identity,
) -> Result<Json<AiAgentContainerListRsp>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let containers = ai_agent_container::Entity::find()
        .order_by_asc(ai_agent_container::Column::InstanceName)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut items = Vec::with_capacity(containers.len());
    for container in containers {
        let link = ai_agent_user_link::Entity::find_by_id(
            container.ai_agent_user_link_id,
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
        let human = login::Entity::find_by_id(link.human_login_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        let agent = login::Entity::find_by_id(link.agent_login_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        items.push(AiAgentContainerItem {
            linked_agent_id: link.id.to_string(),
            human_login_id: human.id.to_string(),
            human_login: human.login,
            agent_login_id: agent.id.to_string(),
            agent_login: agent.login,
            instance_name: container.instance_name,
            state: container.state,
            last_error: container.last_error,
            stats_json: container.stats.map(|stats| stats.to_string()),
            started_at: timestamp(container.started_at),
            stopped_at: timestamp(container.stopped_at),
            last_activity_at: timestamp(container.last_activity_at),
        });
    }
    Ok(Json(AiAgentContainerListRsp { items }))
}

#[post("/api/admin/ai-agent/requests/list")]
pub async fn list_requests(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminRequestListReq>,
) -> Result<Json<AiAgentAdminRequestListRsp>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await.c(h!())?;
    Ok(Json(list_request_page(&env.dbx, &req).await.c(h!())?))
}

async fn list_request_page(
    db: &impl ConnectionTrait,
    req: &AiAgentAdminRequestListReq,
) -> anyhow::Result<AiAgentAdminRequestListRsp> {
    let page_start_id = req
        .page_start_id
        .as_deref()
        .map(access::parse_uuid)
        .transpose()
        .c(h!())?;
    let search_id = req
        .search_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(access::parse_uuid)
        .transpose()
        .c(h!())?;
    let mut query = ai_agent_request::Entity::find();
    if let Some(id) = search_id {
        query = query.filter(
            Condition::any()
                .add(ai_agent_request::Column::Id.eq(id))
                .add(ai_agent_request::Column::ConversationId.eq(id)),
        );
    }
    if let Some(state) = req.state.as_deref() {
        query = query.filter(ai_agent_request::Column::State.eq(state));
    }
    if let Some(suspicious) = req.suspicious {
        query = query.filter(
            ai_agent_request::Column::Id.in_subquery(
                sea_orm::sea_query::Query::select()
                    .column(ai_agent_security_review::Column::RequestId)
                    .from(ai_agent_security_review::Entity)
                    .and_where(
                        ai_agent_security_review::Column::Suspicious
                            .eq(suspicious),
                    )
                    .to_owned(),
            ),
        );
    }
    if let Some(id) = page_start_id {
        query = query.filter(ai_agent_request::Column::Id.lte(id));
    }
    let mut requests = query
        .order_by_desc(ai_agent_request::Column::Id)
        .limit(AI_AGENT_ADMIN_REQUEST_PAGE_SIZE as u64 + 1)
        .all(db)
        .await
        .c(h!())?;
    let mut page_start_ids = page_start_id
        .or_else(|| requests.first().map(|request| request.id))
        .map(|id| id.to_string())
        .into_iter()
        .collect::<Vec<_>>();
    let total = if requests.len() > AI_AGENT_ADMIN_REQUEST_PAGE_SIZE as usize {
        page_start_ids.push(requests.pop().c(h!())?.id.to_string());
        None
    } else {
        page_start_id.is_none().then_some(requests.len() as i64)
    };
    Ok(AiAgentAdminRequestListRsp {
        items: request_items(db, requests).await.c(h!())?,
        page_size: AI_AGENT_ADMIN_REQUEST_PAGE_SIZE,
        total,
        page_start_ids: Some(page_start_ids),
    })
}

async fn request_items(
    db: &impl ConnectionTrait,
    requests: Vec<ai_agent_request::Model>,
) -> anyhow::Result<Vec<AiAgentAdminRequestItem>> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let humans = login::Entity::find()
        .filter(
            login::Column::Id.is_in(requests.iter().map(|r| r.human_login_id)),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|human| (human.id, human))
        .collect::<HashMap<_, _>>();
    let engines = ai_engine::Entity::find()
        .filter(
            ai_engine::Column::Id
                .is_in(requests.iter().map(|r| r.ai_engine_id)),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|engine| (engine.id, engine))
        .collect::<HashMap<_, _>>();
    let mut reviews = ai_agent_security_review::Entity::find()
        .filter(
            ai_agent_security_review::Column::RequestId
                .is_in(requests.iter().map(|r| r.id)),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|review| (review.request_id, review))
        .collect::<HashMap<_, _>>();
    requests
        .into_iter()
        .map(|request| {
            let human = humans.get(&request.human_login_id).c(h!())?;
            let engine = engines.get(&request.ai_engine_id).c(h!())?;
            let review = reviews
                .remove(&request.id)
                .map(review_item)
                .transpose()
                .c(h!())?;
            Ok(build_request_item(request, human, engine, review))
        })
        .collect()
}

#[post("/api/admin/ai-agent/requests/get")]
pub async fn get_request(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentRequestIdReq>,
) -> Result<Json<AiAgentAdminRequestDetail>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let request_id = access::parse_uuid(&req.request_id)?;
    let request = ai_agent_request::Entity::find_by_id(request_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let conversation =
        ai_agent_conversation::Entity::find_by_id(request.conversation_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    let metadata = request_metadata(&env.dbx, &request).await.c(h!())?;
    let request = request_item(&env, request).await?;
    let events = ai_agent_request_event::Entity::find()
        .filter(ai_agent_request_event::Column::RequestId.eq(request_id))
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|event| AiAgentRequestEventItem {
            sequence: event.sequence,
            event_type: event.event_type,
            payload_json: event.payload.to_string(),
            created_at: event.created_at.and_utc().timestamp_millis(),
            activity_presentation: event
                .payload
                .get("activityPresentation")
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok()),
            activity_only: event
                .payload
                .get("activityOnly")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
        .collect();
    Ok(Json(AiAgentAdminRequestDetail {
        request,
        conversation: super::conversation_detail(&env.dbx, conversation)
            .await?,
        events,
        metadata,
    }))
}

async fn request_metadata(
    db: &impl ConnectionTrait,
    request: &ai_agent_request::Model,
) -> anyhow::Result<AiAgentAdminRequestMetadata> {
    let ai_engine = ai_engine::Entity::find_by_id(request.ai_engine_id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let agent_login = match request.agent_login_id {
        Some(id) => login::Entity::find_by_id(id)
            .one(db)
            .await
            .c(h!())?
            .map(|agent| agent.login),
        None => None,
    };
    build_request_metadata(request, &ai_engine, agent_login)
}

fn build_request_metadata(
    request: &ai_agent_request::Model,
    ai_engine: &ai_engine::Model,
    agent_login: Option<String>,
) -> anyhow::Result<AiAgentAdminRequestMetadata> {
    let policy = reasoning::request_policy(request).c(h!())?;
    let completion_metadata = request
        .completion_metadata
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .c(h!())?;
    Ok(AiAgentAdminRequestMetadata {
        ai_engine_model_name: ai_engine.model_name.clone(),
        ai_engine_host: engine_host(&ai_engine.url),
        agent_login,
        provider_api: policy.as_ref().map(|p| p.api.as_str().to_string()),
        reasoning_preset: policy.as_ref().map(|p| p.preset),
        reasoning_effort: policy
            .as_ref()
            .and_then(|p| p.reasoning_effort.clone()),
        checkpoint_effort: policy
            .as_ref()
            .and_then(|p| p.checkpoint_effort.clone()),
        synthesis_effort: policy
            .as_ref()
            .and_then(|p| p.synthesis_effort.clone()),
        max_runtime_seconds: policy
            .as_ref()
            .map(|p| p.max_runtime_seconds as i64),
        finalization_seconds: policy
            .as_ref()
            .map(|p| p.finalization_seconds as i64),
        completion_metadata,
    })
}

fn engine_host(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

#[get("/api/admin/ai-agent/requests/{request_id}/events")]
pub async fn request_events(
    env: actix_web::web::Data<Env>,
    user: Identity,
    request_id: actix_web::web::Path<String>,
    query: actix_web::web::Query<super::SseQuery>,
    http_req: actix_web::HttpRequest,
) -> Result<actix_web::HttpResponse, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let request_id = access::parse_uuid(&request_id)?;
    ai_agent_request::Entity::find_by_id(request_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(super::request_event_stream(
        &env, request_id, &query, &http_req,
    ))
}

#[post("/api/admin/ai-agent/requests/retry-review")]
pub async fn retry_review(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentRequestIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    review::retry(&env, access::parse_uuid(&req.request_id)?).await?;
    Ok(Json(()))
}

async fn request_item(
    env: &Env,
    request: ai_agent_request::Model,
) -> Result<AiAgentAdminRequestItem, AppError> {
    let human = login::Entity::find_by_id(request.human_login_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let ai_engine = ai_engine::Entity::find_by_id(request.ai_engine_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let review = ai_agent_security_review::Entity::find_by_id(request.id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .map(review_item)
        .transpose()?;
    Ok(build_request_item(request, &human, &ai_engine, review))
}

fn build_request_item(
    request: ai_agent_request::Model,
    human: &login::Model,
    ai_engine: &ai_engine::Model,
    review: Option<AiAgentSecurityReviewItem>,
) -> AiAgentAdminRequestItem {
    AiAgentAdminRequestItem {
        id: request.id.to_string(),
        conversation_id: request.conversation_id.to_string(),
        human_login_id: human.id.to_string(),
        human_login: human.login.clone(),
        ai_engine_id: ai_engine.id.to_string(),
        ai_engine_name: ai_engine.name.clone(),
        prompt: request.prompt,
        response: request.response,
        state: request.state,
        error: request.error,
        queued_at: request.queued_at.and_utc().timestamp_millis(),
        started_at: timestamp(request.started_at),
        completed_at: timestamp(request.completed_at),
        review,
    }
}

fn review_item(
    review: ai_agent_security_review::Model,
) -> Result<AiAgentSecurityReviewItem, AppError> {
    Ok(AiAgentSecurityReviewItem {
        state: review.state,
        suspicious: review.suspicious,
        severity: review.severity,
        categories: serde_json::from_value(review.categories).c(h!())?,
        summary: review.summary,
        attempt_count: review.attempt_count,
        last_error: review.last_error,
        alert_state: review.alert_state,
        alert_attempt_count: review.alert_attempt_count,
        alert_last_error: review.alert_last_error,
    })
}

#[post("/api/admin/ai-agent/users/get")]
pub async fn get_user_agent(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminUserReq>,
) -> Result<Json<AiAgentAdminUserItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    Ok(Json(
        user_item(&env, access::parse_uuid(&req.login_id)?).await?,
    ))
}

#[post("/api/admin/ai-agent/users/start")]
pub async fn start_user_agent(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminUserReq>,
) -> Result<Json<AiAgentAdminUserItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let login_id = access::parse_uuid(&req.login_id)?;
    lifecycle::start_for_user(&env, login_id, None).await?;
    Ok(Json(user_item(&env, login_id).await?))
}

#[post("/api/admin/ai-agent/users/force-stop")]
pub async fn stop_user_agent(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminUserReq>,
) -> Result<Json<AiAgentAdminUserItem>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    let login_id = access::parse_uuid(&req.login_id)?;
    lifecycle::force_stop_for_user(&env, login_id).await?;
    Ok(Json(user_item(&env, login_id).await?))
}

#[post("/api/admin/ai-agent/users/test-connection")]
pub async fn test_user_agent(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiAgentAdminUserReq>,
) -> Result<Json<AiAgentConnectionTestRsp>, AppError> {
    ensure_admin_non_api_agent(&env, &user).await?;
    lifecycle::test_connection(&env, access::parse_uuid(&req.login_id)?)
        .await?;
    Ok(Json(AiAgentConnectionTestRsp {
        ok: true,
        message: "Connection verified".to_string(),
    }))
}

async fn user_item(
    env: &Env,
    human_login_id: Uuid,
) -> Result<AiAgentAdminUserItem, AppError> {
    crate::ai_agent::ensure_valid_human_target(&env.dbx, human_login_id)
        .await?;
    let human = login::Entity::find_by_id(human_login_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let organism_name = match human.organism_id {
        Some(id) => organism::Entity::find_by_id(id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|organism| organism.name),
        None => None,
    };
    let sigint_zone_name = match human.sigint_zone_id {
        Some(id) => sigint_zone::Entity::find_by_id(id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .map(|zone| zone.name),
        None => None,
    };
    let direct_hidden_groups = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::LoginId.eq(human.id))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_null())
        .order_by_asc(secret_group_user::Column::MasterKey)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| group.master_key)
        .collect();
    let link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::HumanLoginId.eq(human.id))
        .one(&env.dbx)
        .await
        .c(h!())?;
    let (link, agent, container) = if let Some(link) = link {
        let agent = login::Entity::find_by_id(link.agent_login_id)
            .one(&env.dbx)
            .await
            .c(h!())?;
        let container = ai_agent_container::Entity::find_by_id(link.id)
            .one(&env.dbx)
            .await
            .c(h!())?;
        (Some(link), agent, container)
    } else {
        (None, None, None)
    };
    let roles = agent
        .as_ref()
        .map(|agent| serde_json::from_value(agent.roles.clone()).c(h!()))
        .transpose()?
        .unwrap_or_default();
    Ok(AiAgentAdminUserItem {
        human_login_id: human.id.to_string(),
        human_login: human.login,
        linked_agent_id: link.as_ref().map(|link| link.id.to_string()),
        agent_login_id: agent.as_ref().map(|agent| agent.id.to_string()),
        agent_login: agent.as_ref().map(|agent| agent.login.clone()),
        linked_login_enabled: agent.as_ref().map(|agent| !agent.deleted),
        roles,
        organism_id: human.organism_id,
        organism_name,
        sigint_zone_id: human.sigint_zone_id,
        sigint_zone_name,
        direct_hidden_groups,
        instance_name: container
            .as_ref()
            .map(|container| container.instance_name.clone()),
        container_state: container
            .as_ref()
            .map(|container| container.state.clone()),
        container_last_error: container
            .as_ref()
            .and_then(|container| container.last_error.clone()),
        stats_json: container
            .and_then(|container| container.stats)
            .map(|stats| stats.to_string()),
    })
}

fn timestamp(value: Option<chrono::NaiveDateTime>) -> Option<i64> {
    value.map(|value| value.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn request_pages_remain_disjoint_when_new_requests_arrive() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let request = request_fixture(&txn, human.id).await;
        let mut expected = Vec::new();
        for _ in 0..45 {
            let id = Uuid::now_v7();
            expected.push(id.to_string());
            ai_agent_request::ActiveModel {
                id: Set(id),
                ..request.clone()
            }
            .insert(&txn)
            .await
            .unwrap();
        }
        expected.reverse();
        let mut req = AiAgentAdminRequestListReq {
            state: None,
            suspicious: None,
            page_start_id: None,
            search_id: None,
        };
        let first = list_request_page(&txn, &req).await.unwrap();
        assert_eq!(first.total, None);
        assert_eq!(first.items.len(), 20);
        let mut starts = first.page_start_ids.unwrap();
        assert_eq!(starts, vec![expected[0].clone(), expected[20].clone()]);
        ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            ..request
        }
        .insert(&txn)
        .await
        .unwrap();
        let mut loaded = first.items;
        while starts.len() == 2 {
            req.page_start_id = starts.pop();
            let page = list_request_page(&txn, &req).await.unwrap();
            assert_eq!(
                page.items.len(),
                if loaded.len() == 20 { 20 } else { 5 }
            );
            assert_eq!(page.total, None);
            starts = page.page_start_ids.unwrap();
            assert_eq!(starts.first(), page.items.first().map(|item| &item.id));
            loaded.extend(page.items);
        }
        assert_eq!(starts.len(), 1);
        assert_eq!(
            loaded.into_iter().map(|item| item.id).collect::<Vec<_>>(),
            expected
        );
        ai_agent_request::Entity::delete_many()
            .filter(
                ai_agent_request::Column::Id
                    .gt(access::parse_uuid(&expected[25]).unwrap()),
            )
            .exec(&txn)
            .await
            .unwrap();
        req.page_start_id = None;
        let full = list_request_page(&txn, &req).await.unwrap();
        assert_eq!(full.items.len(), 20);
        assert_eq!(full.total, Some(20));
        assert_eq!(full.page_start_ids, Some(vec![expected[25].clone()]));
        req.state = Some("failed".to_string());
        let empty = list_request_page(&txn, &req).await.unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, Some(0));
        assert_eq!(empty.page_start_ids, Some(Vec::new()));
        req.page_start_id = Some(expected[25].clone());
        let empty = list_request_page(&txn, &req).await.unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, None);
        assert_eq!(empty.page_start_ids, Some(vec![expected[25].clone()]));
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn request_list_finds_a_request_or_its_conversation_by_id() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let human = crate::functest::tests::find_test_login(&env.dbx)
            .await
            .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let other = request_fixture(&txn, human.id).await;
        ai_agent_request::ActiveModel {
            id: Set(Uuid::now_v7()),
            ..other
        }
        .insert(&txn)
        .await
        .unwrap();
        let request = request_fixture(&txn, human.id).await;
        let conversation_id = request.conversation_id.clone().unwrap();
        let mut expected = Vec::new();
        for _ in 0..3 {
            let id = Uuid::now_v7();
            expected.push(id.to_string());
            ai_agent_request::ActiveModel {
                id: Set(id),
                ..request.clone()
            }
            .insert(&txn)
            .await
            .unwrap();
        }
        expected.reverse();
        let mut req = AiAgentAdminRequestListReq {
            state: None,
            suspicious: None,
            page_start_id: None,
            search_id: Some(format!(
                " {} ",
                conversation_id.to_string().to_uppercase()
            )),
        };
        let conversation = list_request_page(&txn, &req).await.unwrap();
        assert_eq!(
            conversation
                .items
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(conversation.total, Some(3));
        req.search_id = Some(expected[1].clone());
        let single = list_request_page(&txn, &req).await.unwrap();
        assert_eq!(
            single
                .items
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec![expected[1].clone()]
        );
        req.search_id = Some("not-an-id".to_string());
        assert!(list_request_page(&txn, &req).await.is_err());
        txn.rollback().await.unwrap();
    }

    async fn request_fixture(
        db: &impl ConnectionTrait,
        human_login_id: Uuid,
    ) -> ai_agent_request::ActiveModel {
        let engine_id = Uuid::now_v7();
        ai_engine::ActiveModel {
            id: Set(engine_id),
            name: Set(format!("pagination-{engine_id}")),
            url: Set("http://127.0.0.1:18000/v1".to_string()),
            model_name: Set("test".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        let conversation_id = Uuid::now_v7();
        ai_agent_conversation::ActiveModel {
            id: Set(conversation_id),
            human_login_id: Set(human_login_id),
            ai_engine_id: Set(engine_id),
            title: Set("Pagination".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        ai_agent_request::ActiveModel {
            conversation_id: Set(conversation_id),
            human_login_id: Set(human_login_id),
            ai_engine_id: Set(engine_id),
            prompt: Set("Pagination".to_string()),
            state: Set("completed".to_string()),
            queued_at: Set(Utc::now().naive_utc()),
            ..Default::default()
        }
    }

    fn echo_proxy(upstream_port: i32) -> ai_agent_echo_proxy::Model {
        let now = Utc::now().naive_utc();
        ai_agent_echo_proxy::Model {
            id: Uuid::nil(),
            hostname: "echo.example.com".to_string(),
            upstream_host: "127.0.0.1".to_string(),
            upstream_port,
            enabled: true,
            last_tested_at: None,
            last_test_error: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn echo_proxy_ping_uses_tls_hostname_and_ping_path() {
        let url = echo_proxy_ping_url(&echo_proxy(443)).unwrap();

        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("echo.example.com"));
        assert_eq!(url.port_or_known_default(), Some(443));
        assert_eq!(url.path(), "/api/ping");
    }

    #[tokio::test]
    async fn echo_proxy_validation_rejects_tcp_without_tls() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let result = validate_echo_proxy(&echo_proxy(i32::from(port))).await;

        assert!(result.is_err());
    }
}
