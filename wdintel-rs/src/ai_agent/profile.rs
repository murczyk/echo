use super::{access, admin, dispatcher, lifecycle};
use crate::config::{
    read_config, Config, AI_AGENT_COPIED_LOGIN_PREFIX, AI_AGENT_DISPATCHER_ID,
    AI_AGENT_MATTERMOST_TIMEOUT_SEC, AI_AGENT_SETTINGS_ID,
    AI_AGENT_TEMPLATE_LOGIN_ID,
};
use crate::entities::{
    ai_agent_allowed_engine, ai_agent_container, ai_agent_conversation,
    ai_agent_dispatcher, ai_agent_echo_proxy, ai_agent_request,
    ai_agent_request_event, ai_agent_security_review, ai_agent_settings,
    ai_agent_user_link, ai_engine, login, secret_group_user,
};
use crate::error::AppError;
use crate::h;
use crate::mattermost;
use crate::types::{Mode, ShortContext};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, QueryFilter, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

const LOCAL_AI_AGENT_PROFILE_VERSION: u8 = 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalAiAgentProfile {
    version: u8,
    public_host: String,
    dispatcher: ProfileDispatcher,
    echo_proxies: Vec<ProfileEchoProxy>,
    settings: ProfileSettings,
    engines: Vec<ProfileEngine>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileDispatcher {
    host: String,
    port: i32,
    ssh_user: String,
    namespace: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileEchoProxy {
    id: Uuid,
    hostname: String,
    upstream_host: String,
    upstream_port: i32,
    enabled: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileSettings {
    feature_enabled: bool,
    default_ai_engine_id: Option<Uuid>,
    reviewer_ai_engine_id: Option<Uuid>,
    security_review_enabled: bool,
    mattermost_webhook_url: Option<String>,
    #[serde(default)]
    mattermost_chat_enabled: bool,
    allowed_ai_engine_ids: Vec<Uuid>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileEngine {
    id: Uuid,
    name: String,
    url: String,
    token: Option<String>,
    model_name: String,
    enabled: bool,
}

pub async fn export(mode: Mode, output: &Path) -> Result<(), AppError> {
    let (config, dbx) = config_and_db(mode).await?;
    let Some(profile) = load_profile(&dbx, &config.public_host).await? else {
        println!("No local AI agent profile is configured; nothing to export");
        return Ok(());
    };
    validate_profile(&profile, &config.public_host).c(h!())?;
    validate_profile_webhook_target(&profile).await.c(h!())?;
    write_profile(output, &profile).c(h!())?;
    println!("Exported local AI agent profile");
    Ok(())
}

pub async fn import(mode: Mode, input: &Path) -> Result<(), AppError> {
    let (config, dbx) = config_and_db(mode).await?;
    let profile = read_profile(input).c(h!())?;
    validate_profile(&profile, &config.public_host).c(h!())?;
    validate_profile_webhook_target(&profile).await.c(h!())?;
    replace_profile(&dbx, &profile).await?;
    validate_restored_profile(&dbx, &config.public_host).await?;
    println!("Restored and validated local AI agent profile");
    Ok(())
}

pub async fn discard_runtime(
    mode: Mode,
    clear_control_plane: bool,
) -> Result<(), AppError> {
    let (_, dbx) = config_and_db(mode).await?;
    let txn = dbx.begin().await.c(h!())?;
    discard_copied_runtime(&txn).await?;
    if clear_control_plane {
        clear_copied_control_plane(&txn).await?;
    }
    txn.commit().await.c(h!())?;
    println!("Discarded copied AI agent runtime and control plane={clear_control_plane}");
    Ok(())
}

async fn config_and_db(
    mode: Mode,
) -> Result<(Config, DatabaseConnection), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config).await?;
    dispatcher::import_legacy_config(&dbx, config.ai_agent_dispatcher.as_ref())
        .await?;
    Ok((config, dbx))
}

async fn load_profile(
    dbx: &DatabaseConnection,
    public_host: &str,
) -> Result<Option<LocalAiAgentProfile>, AppError> {
    let Some(dispatcher) =
        ai_agent_dispatcher::Entity::find_by_id(AI_AGENT_DISPATCHER_ID)
            .one(dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let settings = ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let allowed_ai_engine_ids = ai_agent_allowed_engine::Entity::find()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|allowed| allowed.ai_engine_id)
        .collect::<Vec<_>>();
    let engine_ids = profile_engine_ids(&settings, &allowed_ai_engine_ids);
    let engines = ai_engine::Entity::find()
        .filter(ai_engine::Column::Id.is_in(engine_ids.iter().copied()))
        .all(dbx)
        .await
        .c(h!())?;
    if engines.len() != engine_ids.len() {
        return Err(AppError::BL {
            msg: "Local AI agent settings reference a missing engine"
                .to_string(),
        });
    }
    let echo_proxies = ai_agent_echo_proxy::Entity::find()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|proxy| ProfileEchoProxy {
            id: proxy.id,
            hostname: proxy.hostname,
            upstream_host: proxy.upstream_host,
            upstream_port: proxy.upstream_port,
            enabled: proxy.enabled,
        })
        .collect();
    Ok(Some(LocalAiAgentProfile {
        version: LOCAL_AI_AGENT_PROFILE_VERSION,
        public_host: public_host.to_string(),
        dispatcher: ProfileDispatcher {
            host: dispatcher.host,
            port: dispatcher.port,
            ssh_user: dispatcher.ssh_user,
            namespace: dispatcher.namespace,
        },
        echo_proxies,
        settings: ProfileSettings {
            feature_enabled: settings.feature_enabled,
            default_ai_engine_id: settings.default_ai_engine_id,
            reviewer_ai_engine_id: settings.reviewer_ai_engine_id,
            security_review_enabled: settings.security_review_enabled,
            mattermost_webhook_url: settings.mattermost_webhook_url,
            mattermost_chat_enabled: settings.mattermost_chat_enabled,
            allowed_ai_engine_ids,
        },
        engines: engines.into_iter().map(ProfileEngine::from).collect(),
    }))
}

fn profile_engine_ids(
    settings: &ai_agent_settings::Model,
    allowed_ai_engine_ids: &[Uuid],
) -> HashSet<Uuid> {
    let mut engine_ids = allowed_ai_engine_ids
        .iter()
        .copied()
        .collect::<HashSet<Uuid>>();
    engine_ids.extend(settings.default_ai_engine_id);
    engine_ids.extend(settings.reviewer_ai_engine_id);
    engine_ids
}

fn write_profile(
    path: &Path,
    profile: &LocalAiAgentProfile,
) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec(profile).c(h!())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .c(h!())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).c(h!())?;
    file.write_all(&bytes).c(h!())?;
    file.sync_all().c(h!())?;
    Ok(())
}

fn read_profile(path: &Path) -> anyhow::Result<LocalAiAgentProfile> {
    ensure_private_profile_file(path)?;
    let bytes = fs::read(path).c(h!())?;
    serde_json::from_slice(&bytes).c(h!())
}

fn ensure_private_profile_file(path: &Path) -> anyhow::Result<()> {
    let permissions = fs::metadata(path).c(h!())?.permissions();
    if permissions.mode() & 0o077 != 0 {
        anyhow::bail!("AI agent profile file must have mode 0600");
    }
    Ok(())
}

fn validate_profile(
    profile: &LocalAiAgentProfile,
    public_host: &str,
) -> anyhow::Result<()> {
    if profile.version != LOCAL_AI_AGENT_PROFILE_VERSION {
        anyhow::bail!("unsupported local AI agent profile version");
    }
    if profile.public_host != public_host {
        anyhow::bail!("local AI agent profile belongs to another public_host");
    }
    validate_dispatcher(&profile.dispatcher)?;
    validate_proxies(&profile.echo_proxies, public_host)?;
    validate_profile_engines(profile)?;
    validate_profile_settings(profile)?;
    Ok(())
}

fn validate_dispatcher(dispatcher: &ProfileDispatcher) -> anyhow::Result<()> {
    if !access::is_dispatcher_hostname(&dispatcher.host)
        || !(1..=65_535).contains(&dispatcher.port)
        || !dispatcher::valid_ssh_user(&dispatcher.ssh_user)
        || !dispatcher::valid_namespace(&dispatcher.namespace)
    {
        anyhow::bail!("local AI agent profile has an invalid dispatcher");
    }
    Ok(())
}

fn validate_proxies(
    proxies: &[ProfileEchoProxy],
    public_host: &str,
) -> anyhow::Result<()> {
    let mut hostnames = HashSet::new();
    let mut has_public_proxy = false;
    for proxy in proxies {
        if !hostnames.insert(&proxy.hostname)
            || !access::is_dispatcher_hostname(&proxy.hostname)
            || !access::is_dispatcher_upstream_host(&proxy.upstream_host)
            || !(1..=65_535).contains(&proxy.upstream_port)
        {
            anyhow::bail!("local AI agent profile has an invalid Echo proxy");
        }
        has_public_proxy |= proxy.enabled && proxy.hostname == public_host;
    }
    if !has_public_proxy {
        anyhow::bail!(
            "local AI agent profile has no enabled public_host proxy"
        );
    }
    Ok(())
}

fn validate_profile_engines(
    profile: &LocalAiAgentProfile,
) -> anyhow::Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for engine in &profile.engines {
        if !ids.insert(engine.id)
            || !names.insert(&engine.name)
            || engine.name.trim().is_empty()
            || engine.url.trim().is_empty()
            || engine.model_name.trim().is_empty()
        {
            anyhow::bail!("local AI agent profile has an invalid engine");
        }
    }
    Ok(())
}

fn validate_profile_settings(
    profile: &LocalAiAgentProfile,
) -> anyhow::Result<()> {
    mattermost::validate_webhook(
        profile.settings.mattermost_webhook_url.as_deref(),
    )
    .context(h!())?;
    if profile.settings.security_review_enabled
        && profile.settings.mattermost_webhook_url.is_none()
    {
        anyhow::bail!(
            "Mattermost webhook is required while security review is enabled"
        );
    }
    if profile.settings.mattermost_chat_enabled
        && profile.settings.mattermost_webhook_url.is_none()
    {
        anyhow::bail!(
            "Mattermost webhook is required while chat monitoring is enabled"
        );
    }
    let engine_ids = profile
        .engines
        .iter()
        .map(|engine| engine.id)
        .collect::<HashSet<_>>();
    let allowed_ids = profile
        .settings
        .allowed_ai_engine_ids
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let engines = profile
        .engines
        .iter()
        .map(|engine| (engine.id, engine))
        .collect::<HashMap<_, _>>();
    if allowed_ids.len() != profile.settings.allowed_ai_engine_ids.len()
        || !allowed_ids.is_subset(&engine_ids)
        || allowed_ids.iter().any(|id| {
            !engines.get(id).is_some_and(|engine| {
                access::is_agent_engine(&engine_record(engine))
            })
        })
        || profile
            .settings
            .default_ai_engine_id
            .is_some_and(|id| !allowed_ids.contains(&id))
        || profile
            .settings
            .reviewer_ai_engine_id
            .is_some_and(|id| !engine_ids.contains(&id))
        || profile
            .settings
            .reviewer_ai_engine_id
            .is_some_and(|id| !engines[&id].enabled)
        || (profile.settings.feature_enabled
            && profile.settings.default_ai_engine_id.is_none())
    {
        anyhow::bail!("local AI agent profile has invalid settings");
    }
    Ok(())
}

async fn validate_profile_webhook_target(
    profile: &LocalAiAgentProfile,
) -> anyhow::Result<()> {
    if let Some(webhook) = profile.settings.mattermost_webhook_url.as_deref() {
        mattermost::resolve_webhook(
            webhook,
            Duration::from_secs(AI_AGENT_MATTERMOST_TIMEOUT_SEC),
        )
        .await
        .context(h!())?;
    }
    Ok(())
}

async fn replace_profile(
    dbx: &DatabaseConnection,
    profile: &LocalAiAgentProfile,
) -> Result<(), AppError> {
    let txn = dbx.begin().await.c(h!())?;
    discard_copied_runtime(&txn).await?;
    replace_dispatcher(&txn, &profile.dispatcher).await?;
    replace_echo_proxies(&txn, &profile.echo_proxies).await?;
    let engine_ids = replace_engines(&txn, &profile.engines).await?;
    let template_login_id =
        Uuid::parse_str(AI_AGENT_TEMPLATE_LOGIN_ID).c(h!())?;
    lifecycle::reconcile_template_login_id(&txn, template_login_id).await?;
    replace_settings(&txn, &profile.settings, &engine_ids).await?;
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn discard_copied_runtime<C>(dbx: &C) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    ai_agent_request_event::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_security_review::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_request::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_conversation::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_container::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    let agent_login_ids = ai_agent_user_link::Entity::find()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| link.agent_login_id)
        .collect::<Vec<_>>();
    ai_agent_user_link::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    archive_copied_agent_logins(dbx, &agent_login_ids).await?;
    Ok(())
}

async fn clear_copied_control_plane<C>(dbx: &C) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    ai_agent_allowed_engine::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_echo_proxy::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    ai_agent_dispatcher::Entity::delete_by_id(AI_AGENT_DISPATCHER_ID)
        .exec(dbx)
        .await
        .c(h!())?;
    let settings = ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?;
    let Some(settings) = settings else {
        return Ok(());
    };
    let mut settings = settings.into_active_model();
    settings.feature_enabled = Set(false);
    settings.template_login_id = Set(None);
    settings.default_ai_engine_id = Set(None);
    settings.reviewer_ai_engine_id = Set(None);
    settings.security_review_enabled = Set(false);
    settings.mattermost_webhook_url = Set(None);
    settings.mattermost_chat_enabled = Set(false);
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(dbx).await.c(h!())?;
    Ok(())
}

async fn archive_copied_agent_logins<C>(
    dbx: &C,
    agent_login_ids: &[Uuid],
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    for agent_login_id in agent_login_ids {
        secret_group_user::Entity::delete_many()
            .filter(secret_group_user::Column::LoginId.eq(*agent_login_id))
            .exec(dbx)
            .await
            .c(h!())?;
        let agent = login::Entity::find_by_id(*agent_login_id)
            .one(dbx)
            .await
            .c(h!())?;
        let Some(agent) = agent else {
            continue;
        };
        let mut agent = agent.into_active_model();
        agent.login = Set(copied_agent_login_name(*agent_login_id));
        agent.password = Set(None);
        agent.password_auth_enabled = Set(false);
        agent.roles = Set(serde_json::json!([]));
        agent.deleted = Set(true);
        agent.deactivation_reason = Set(Some(
            crate::entities::sea_orm_active_enums::DeactivationReasonEnum::Admin,
        ));
        agent.description = Set(Some(
            "Copied AI agent identity removed during database restore"
                .to_string(),
        ));
        agent.update(dbx).await.c(h!())?;
    }
    Ok(())
}

fn copied_agent_login_name(agent_login_id: Uuid) -> String {
    format!("{AI_AGENT_COPIED_LOGIN_PREFIX}{agent_login_id}")
}

async fn replace_dispatcher<C>(
    dbx: &C,
    profile: &ProfileDispatcher,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    ai_agent_dispatcher::Entity::delete_by_id(AI_AGENT_DISPATCHER_ID)
        .exec(dbx)
        .await
        .c(h!())?;
    let now = Utc::now().naive_utc();
    ai_agent_dispatcher::ActiveModel {
        id: Set(AI_AGENT_DISPATCHER_ID),
        host: Set(profile.host.clone()),
        port: Set(profile.port),
        ssh_user: Set(profile.ssh_user.clone()),
        namespace: Set(profile.namespace.clone()),
        last_tested_at: Set(None),
        last_test_error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(dbx)
    .await
    .c(h!())?;
    Ok(())
}

async fn replace_echo_proxies<C>(
    dbx: &C,
    proxies: &[ProfileEchoProxy],
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    ai_agent_echo_proxy::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    let now = Utc::now().naive_utc();
    for proxy in proxies {
        ai_agent_echo_proxy::ActiveModel {
            id: Set(proxy.id),
            hostname: Set(proxy.hostname.clone()),
            upstream_host: Set(proxy.upstream_host.clone()),
            upstream_port: Set(proxy.upstream_port),
            enabled: Set(proxy.enabled),
            last_tested_at: Set(None),
            last_test_error: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn replace_engines<C>(
    dbx: &C,
    engines: &[ProfileEngine],
) -> Result<HashMap<Uuid, Uuid>, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let mut engine_ids = HashMap::with_capacity(engines.len());
    for profile_engine in engines {
        let by_id = ai_engine::Entity::find_by_id(profile_engine.id)
            .one(dbx)
            .await
            .c(h!())?;
        let by_name = ai_engine::Entity::find()
            .filter(ai_engine::Column::Name.eq(&profile_engine.name))
            .one(dbx)
            .await
            .c(h!())?;
        let engine_id = reconciled_engine_id(
            profile_engine.id,
            by_id.as_ref().map(|engine| engine.id),
            by_name.as_ref().map(|engine| engine.id),
        )
        .c(h!())?;
        let engine = match by_id.or(by_name) {
            Some(engine) => update_engine(engine, profile_engine, dbx).await?,
            None => insert_engine(profile_engine, dbx).await?,
        };
        engine_ids.insert(profile_engine.id, engine.id);
        debug_assert_eq!(engine_id, engine.id);
    }
    Ok(engine_ids)
}

fn reconciled_engine_id(
    profile_id: Uuid,
    matching_id: Option<Uuid>,
    matching_name: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    match (matching_id, matching_name) {
        (Some(id), Some(name_id)) if id != name_id => {
            anyhow::bail!("AI engine ID/name ownership conflict");
        }
        (Some(id), _) | (None, Some(id)) => Ok(id),
        (None, None) => Ok(profile_id),
    }
}

async fn update_engine<C>(
    engine: ai_engine::Model,
    profile_engine: &ProfileEngine,
    dbx: &C,
) -> Result<ai_engine::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let mut engine = engine.into_active_model();
    engine.name = Set(profile_engine.name.clone());
    engine.url = Set(profile_engine.url.clone());
    engine.token = Set(profile_engine.token.clone());
    engine.model_name = Set(profile_engine.model_name.clone());
    engine.enabled = Set(profile_engine.enabled);
    engine.updated_at = Set(Utc::now().naive_utc());
    Ok(engine.update(dbx).await.c(h!())?)
}

async fn insert_engine<C>(
    profile_engine: &ProfileEngine,
    dbx: &C,
) -> Result<ai_engine::Model, AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let now = Utc::now().naive_utc();
    Ok(ai_engine::ActiveModel {
        id: Set(profile_engine.id),
        name: Set(profile_engine.name.clone()),
        url: Set(profile_engine.url.clone()),
        token: Set(profile_engine.token.clone()),
        model_name: Set(profile_engine.model_name.clone()),
        enabled: Set(profile_engine.enabled),
        callsign_enabled: Set(true),
        ocr_enabled: Set(false),
        ocr_request_profile: Set("openai_vision".to_string()),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(dbx)
    .await
    .c(h!())?)
}

async fn replace_settings<C>(
    dbx: &C,
    profile: &ProfileSettings,
    engine_ids: &HashMap<Uuid, Uuid>,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let settings = ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let template_login_id =
        Uuid::parse_str(AI_AGENT_TEMPLATE_LOGIN_ID).c(h!())?;
    let mut settings = settings.into_active_model();
    settings.feature_enabled = Set(profile.feature_enabled);
    settings.template_login_id = Set(Some(template_login_id));
    settings.default_ai_engine_id =
        Set(remap_engine_id(profile.default_ai_engine_id, engine_ids)?);
    settings.reviewer_ai_engine_id =
        Set(remap_engine_id(profile.reviewer_ai_engine_id, engine_ids)?);
    settings.security_review_enabled = Set(profile.security_review_enabled);
    settings.mattermost_chat_enabled = Set(profile.mattermost_chat_enabled);
    settings.mattermost_webhook_url =
        Set(profile.mattermost_webhook_url.clone());
    settings.updated_at = Set(Utc::now().naive_utc());
    settings.update(dbx).await.c(h!())?;
    ai_agent_allowed_engine::Entity::delete_many()
        .exec(dbx)
        .await
        .c(h!())?;
    for profile_engine_id in &profile.allowed_ai_engine_ids {
        ai_agent_allowed_engine::ActiveModel {
            ai_engine_id: Set(remap_required_engine_id(
                *profile_engine_id,
                engine_ids,
            )?),
            created_at: Set(Utc::now().naive_utc()),
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

fn remap_engine_id(
    profile_engine_id: Option<Uuid>,
    engine_ids: &HashMap<Uuid, Uuid>,
) -> Result<Option<Uuid>, AppError> {
    profile_engine_id
        .map(|id| remap_required_engine_id(id, engine_ids))
        .transpose()
}

fn remap_required_engine_id(
    profile_engine_id: Uuid,
    engine_ids: &HashMap<Uuid, Uuid>,
) -> Result<Uuid, AppError> {
    engine_ids
        .get(&profile_engine_id)
        .copied()
        .ok_or_else(|| AppError::BL {
            msg: "Local AI agent profile has an unknown engine reference"
                .to_string(),
        })
}

async fn validate_restored_profile(
    dbx: &DatabaseConnection,
    public_host: &str,
) -> Result<(), AppError> {
    let proxy = ai_agent_echo_proxy::Entity::find()
        .filter(ai_agent_echo_proxy::Column::Hostname.eq(public_host))
        .filter(ai_agent_echo_proxy::Column::Enabled.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "No enabled Echo proxy matches public_host".to_string(),
        })?;
    admin::validate_echo_proxy(&proxy).await.c(h!())?;
    let template_login_id =
        Uuid::parse_str(AI_AGENT_TEMPLATE_LOGIN_ID).c(h!())?;
    lifecycle::preflight_template_for_db(dbx, template_login_id).await
}

impl From<ai_engine::Model> for ProfileEngine {
    fn from(engine: ai_engine::Model) -> Self {
        Self {
            id: engine.id,
            name: engine.name,
            url: engine.url,
            token: engine.token,
            model_name: engine.model_name,
            enabled: engine.enabled,
        }
    }
}

fn engine_record(engine: &ProfileEngine) -> ai_engine::Model {
    let now = Utc::now().naive_utc();
    ai_engine::Model {
        id: engine.id,
        name: engine.name.clone(),
        url: engine.url.clone(),
        token: engine.token.clone(),
        model_name: engine.model_name.clone(),
        created_at: now,
        updated_at: now,
        enabled: engine.enabled,
        callsign_enabled: true,
        ocr_enabled: false,
        ocr_request_profile: "openai_vision".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AI_AGENT_TEMPLATE_LOGIN_NAME;
    use serial_test::serial;

    fn profile(public_host: &str) -> LocalAiAgentProfile {
        let engine_id = Uuid::now_v7();
        LocalAiAgentProfile {
            version: LOCAL_AI_AGENT_PROFILE_VERSION,
            public_host: public_host.to_string(),
            dispatcher: ProfileDispatcher {
                host: "echo-ai-agent.example.com".to_string(),
                port: 22031,
                ssh_user: "echo_ai_agent".to_string(),
                namespace: "echo-ziggy".to_string(),
            },
            echo_proxies: vec![ProfileEchoProxy {
                id: Uuid::now_v7(),
                hostname: public_host.to_string(),
                upstream_host: "127.0.0.1".to_string(),
                upstream_port: 8300,
                enabled: true,
            }],
            settings: ProfileSettings {
                feature_enabled: true,
                default_ai_engine_id: Some(engine_id),
                reviewer_ai_engine_id: Some(engine_id),
                security_review_enabled: true,
                mattermost_webhook_url: Some(
                    "https://hooks.example.com/secret".to_string(),
                ),
                mattermost_chat_enabled: true,
                allowed_ai_engine_ids: vec![engine_id],
            },
            engines: vec![ProfileEngine {
                id: engine_id,
                name: "ziggy-engine".to_string(),
                url: "http://vllm.example.com:8000/v1".to_string(),
                token: Some("secret-token".to_string()),
                model_name: "local".to_string(),
                enabled: true,
            }],
        }
    }

    #[test]
    fn profile_validation_rejects_another_public_host() {
        let profile = profile("ziggy.example.com");

        let result = validate_profile(&profile, "cbr.example.com");

        assert!(result.is_err());
    }

    #[test]
    fn profile_validation_rejects_unsupported_version() {
        let mut profile = profile("ziggy.example.com");
        profile.version += 1;

        let result = validate_profile(&profile, "ziggy.example.com");

        assert!(result.is_err());
    }

    #[test]
    fn engine_reconciliation_falls_back_to_unique_name() {
        let profile_id = Uuid::now_v7();
        let existing_id = Uuid::now_v7();

        let engine_id =
            reconciled_engine_id(profile_id, None, Some(existing_id)).unwrap();

        assert_eq!(engine_id, existing_id);
    }

    #[test]
    fn engine_reconciliation_rejects_conflicting_id_and_name() {
        let result = reconciled_engine_id(
            Uuid::now_v7(),
            Some(Uuid::now_v7()),
            Some(Uuid::now_v7()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn exported_profile_file_is_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profile.json");

        write_profile(&path, &profile("ziggy.example.com")).unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn profile_validation_rejects_private_mattermost_webhooks() {
        let mut profile = profile("ziggy.example.com");
        profile.settings.mattermost_webhook_url =
            Some("http://127.0.0.1/hooks/private".to_string());

        assert!(validate_profile(&profile, "ziggy.example.com").is_err());
    }

    #[test]
    fn profile_validation_requires_webhook_for_enabled_monitoring() {
        let mut profile = profile("ziggy.example.com");
        profile.settings.mattermost_webhook_url = None;

        assert!(validate_profile(&profile, "ziggy.example.com").is_err());
    }

    #[tokio::test]
    #[serial]
    async fn profile_import_creates_missing_template_login() {
        let (env, _cleanup_guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        clear_copied_control_plane(&env.dbx).await.unwrap();
        let template_login_id =
            Uuid::parse_str(AI_AGENT_TEMPLATE_LOGIN_ID).unwrap();
        login::Entity::delete_by_id(template_login_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        let mut profile = profile("ziggy.example.com");
        profile.engines[0].name = format!("profile-test-{}", Uuid::now_v7());

        replace_profile(&env.dbx, &profile).await.unwrap();

        let template = login::Entity::find_by_id(template_login_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let settings =
            ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(template.login, AI_AGENT_TEMPLATE_LOGIN_NAME);
        assert_eq!(settings.template_login_id, Some(template_login_id));

        clear_copied_control_plane(&env.dbx).await.unwrap();
        ai_engine::Entity::delete_by_id(profile.engines[0].id)
            .exec(&env.dbx)
            .await
            .unwrap();
        login::Entity::delete_by_id(template_login_id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }
}
