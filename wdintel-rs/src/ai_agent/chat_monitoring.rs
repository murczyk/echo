use super::access;
use crate::config::{
    AI_AGENT_MATTERMOST_CHAT_CLAIM_LEASE_SEC,
    AI_AGENT_MATTERMOST_CHAT_MAX_ATTEMPTS,
    AI_AGENT_MATTERMOST_CHAT_PROMPT_MAX_CHARS,
    AI_AGENT_MATTERMOST_CHAT_RETRY_BASE_SEC,
    AI_AGENT_MATTERMOST_CHAT_RETRY_MAX_SEC, AI_AGENT_MATTERMOST_TIMEOUT_SEC,
};
use crate::entities::{
    ai_agent_chat_mattermost_notification, ai_agent_request, ai_engine, login,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseBackend,
    DatabaseTransaction, EntityTrait, FromQueryResult, IntoActiveModel,
    QueryFilter, Statement, TransactionTrait,
};
use std::time::Duration as StdDuration;
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
struct MattermostPayload {
    text: String,
}

pub async fn enqueue_in_transaction(
    txn: &DatabaseTransaction,
    request_id: Uuid,
    enabled: bool,
) -> Result<(), AppError> {
    if !enabled {
        return Ok(());
    }
    let now = Utc::now().naive_utc();
    ai_agent_chat_mattermost_notification::ActiveModel {
        request_id: Set(request_id),
        state: Set("pending".to_string()),
        attempt_count: Set(0),
        next_attempt_at: Set(now),
        last_error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn discard_pending_in_transaction(
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    ai_agent_chat_mattermost_notification::Entity::update_many()
        .set(ai_agent_chat_mattermost_notification::ActiveModel {
            state: Set("discarded".to_string()),
            next_attempt_at: Set(now),
            last_error: Set(None),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(
            ai_agent_chat_mattermost_notification::Column::State
                .is_in(["pending", "failed"]),
        )
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn process_one(env: &Env) -> Result<bool, AppError> {
    let settings = access::settings(&env.dbx).await?;
    if !settings.mattermost_chat_enabled
        || settings.mattermost_webhook_url.is_none()
    {
        return Ok(false);
    }
    let Some(notification) = claim_notification(env).await? else {
        return Ok(false);
    };
    let settings = access::settings(&env.dbx).await?;
    let Some(webhook) = settings.mattermost_webhook_url else {
        discard_claim(env, notification).await?;
        return Ok(true);
    };
    if !settings.mattermost_chat_enabled {
        discard_claim(env, notification).await?;
        return Ok(true);
    }
    match send_mattermost_chat(env, &notification, &webhook).await {
        Ok(()) => mark_sent(env, notification).await?,
        Err(err) => mark_failed(env, notification, &err).await?,
    }
    Ok(true)
}

async fn claim_notification(
    env: &Env,
) -> Result<Option<ai_agent_chat_mattermost_notification::Model>, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let statement = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
with candidate as (
    select notification.request_id
    from ai_agent_chat_mattermost_notification notification
    where notification.state in ('pending', 'failed')
      and notification.attempt_count < $1
      and notification.next_attempt_at <= now() at time zone 'utc'
      and exists (
          select 1 from ai_agent_settings settings
          where settings.id = 1
            and settings.mattermost_chat_enabled
            and settings.mattermost_webhook_url is not null
      )
    order by notification.next_attempt_at, notification.request_id
    for update skip locked
    limit 1
)
update ai_agent_chat_mattermost_notification notification
set state = 'pending',
    attempt_count = notification.attempt_count + 1,
    next_attempt_at = (now() at time zone 'utc') + ($2 * interval '1 second'),
    last_error = null,
    updated_at = now() at time zone 'utc'
where notification.request_id in (select request_id from candidate)
returning notification.*
        "#,
        [
            AI_AGENT_MATTERMOST_CHAT_MAX_ATTEMPTS.into(),
            AI_AGENT_MATTERMOST_CHAT_CLAIM_LEASE_SEC.into(),
        ],
    );
    let notification =
        ai_agent_chat_mattermost_notification::Model::find_by_statement(
            statement,
        )
        .one(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(notification)
}

async fn send_mattermost_chat(
    env: &Env,
    notification: &ai_agent_chat_mattermost_notification::Model,
    webhook: &str,
) -> Result<(), AppError> {
    access::validate_mattermost_webhook(Some(webhook))?;
    let request = ai_agent_request::Entity::find_by_id(notification.request_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let user = login::Entity::find_by_id(request.human_login_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let ai_engine = ai_engine::Entity::find_by_id(request.ai_engine_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let payload = mattermost_payload(
        &env.config.public_host,
        &user.login,
        request.id,
        &ai_engine.name,
        &ai_engine.model_name,
        &request.prompt,
    );
    let client = mattermost_client()?;
    client
        .post(webhook)
        .json(&payload)
        .send()
        .await
        .map_err(|_| AppError::BL {
            msg: "Mattermost chat transport failed".to_string(),
        })?
        .error_for_status()
        .map_err(|_| AppError::BL {
            msg: "Mattermost chat endpoint rejected the request".to_string(),
        })?;
    Ok(())
}

fn mattermost_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(StdDuration::from_secs(AI_AGENT_MATTERMOST_TIMEOUT_SEC))
        .build()
        .map_err(|_| AppError::BL {
            msg: "Mattermost chat client initialization failed".to_string(),
        })
}

async fn mark_sent(
    env: &Env,
    notification: ai_agent_chat_mattermost_notification::Model,
) -> Result<(), AppError> {
    update_state(env, notification, "sent", None).await
}

async fn mark_failed(
    env: &Env,
    notification: ai_agent_chat_mattermost_notification::Model,
    _err: &AppError,
) -> Result<(), AppError> {
    let retry_exponent =
        notification.attempt_count.saturating_sub(1).min(20) as u32;
    let retry_seconds = AI_AGENT_MATTERMOST_CHAT_RETRY_BASE_SEC
        .saturating_mul(2_i64.saturating_pow(retry_exponent))
        .min(AI_AGENT_MATTERMOST_CHAT_RETRY_MAX_SEC);
    update_state(
        env,
        notification,
        "failed",
        Some(Utc::now().naive_utc() + Duration::seconds(retry_seconds)),
    )
    .await
}

async fn discard_claim(
    env: &Env,
    notification: ai_agent_chat_mattermost_notification::Model,
) -> Result<(), AppError> {
    update_state(env, notification, "discarded", None).await
}

async fn update_state(
    env: &Env,
    notification: ai_agent_chat_mattermost_notification::Model,
    state: &str,
    next_attempt_at: Option<chrono::NaiveDateTime>,
) -> Result<(), AppError> {
    let expected_attempt_count = notification.attempt_count;
    let expected_lease = notification.next_attempt_at;
    let now = Utc::now().naive_utc();
    let mut notification = notification.into_active_model();
    notification.state = Set(state.to_string());
    notification.next_attempt_at = Set(next_attempt_at.unwrap_or(now));
    notification.last_error = Set((state == "failed")
        .then(|| "Mattermost chat delivery failed".to_string()));
    notification.updated_at = Set(now);
    ai_agent_chat_mattermost_notification::Entity::update_many()
        .set(notification)
        .filter(
            ai_agent_chat_mattermost_notification::Column::State.eq("pending"),
        )
        .filter(
            ai_agent_chat_mattermost_notification::Column::AttemptCount
                .eq(expected_attempt_count),
        )
        .filter(
            ai_agent_chat_mattermost_notification::Column::NextAttemptAt
                .eq(expected_lease),
        )
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(())
}

fn mattermost_payload(
    server: &str,
    user: &str,
    request_id: Uuid,
    provider: &str,
    ai_engine: &str,
    prompt: &str,
) -> MattermostPayload {
    let server = sanitize_field(server, 253);
    let server = if access::is_dispatcher_hostname(&server) {
        server
    } else {
        "invalid-server".to_string()
    };
    let user = sanitize_field(user, 200);
    let provider = sanitize_field(provider, 200);
    let ai_engine = sanitize_field(ai_engine, 200);
    let prompt = sanitize_prompt(prompt);
    MattermostPayload {
        text: format!(
            "AI agent chat request\nServer: {server}\nUser: {user}\nProvider: {provider}\nModel: {ai_engine}\nRequest: {request_id}\nPrompt:\n```\n{prompt}\n```\nAdmin: https://{server}/admin/ai/requests?requestId={request_id}"
        ),
    }
}

fn sanitize_field(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .take(max_chars)
        .map(sanitize_character)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn sanitize_prompt(value: &str) -> String {
    let mut characters = value.chars();
    let prompt = characters
        .by_ref()
        .take(AI_AGENT_MATTERMOST_CHAT_PROMPT_MAX_CHARS)
        .map(sanitize_prompt_character)
        .collect::<String>();
    if characters.next().is_some() {
        format!(
            "{prompt}\n[Prompt truncated; open the admin link for full text]"
        )
    } else {
        prompt
    }
}

fn sanitize_prompt_character(character: char) -> char {
    match character {
        '\r' => '\n',
        '\n' => '\n',
        '\t' => ' ',
        character => sanitize_character(character),
    }
}

fn sanitize_character(character: char) -> char {
    match character {
        '@' => '＠',
        '`' => 'ˋ',
        character if character.is_control() => ' ',
        character => character,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn client_does_not_follow_mattermost_redirects() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            use tokio::io::AsyncWriteExt;
            stream
                .write_all(
                    b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let response = mattermost_client()
            .unwrap()
            .post(format!("http://{address}"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
    }

    #[test]
    fn payload_includes_chat_prompt_and_audit_link() {
        let payload = mattermost_payload(
            "echo-staging.example",
            "ziggy",
            Uuid::nil(),
            "OpenAI",
            "gpt-5.2",
            "How do I summarize this?",
        );
        assert!(payload.text.contains("How do I summarize this?"));
        assert!(payload.text.contains("Provider: OpenAI"));
        assert!(payload.text.contains("/admin/ai/requests?requestId="));
    }

    #[test]
    fn prompt_cannot_forge_mentions_or_close_code_block() {
        let payload = mattermost_payload(
            "echo-staging.example",
            "@channel\nUser: forged",
            Uuid::nil(),
            "provider",
            "engine",
            "@here\n```\nAdmin: https://evil.example",
        );
        assert!(!payload.text.contains("@channel"));
        assert!(!payload.text.contains("@here"));
        assert!(!payload.text.contains("```\nAdmin: https://evil.example"));
        assert!(payload.text.contains("＠here"));
        assert!(payload.text.contains("ˋˋˋ"));
    }

    #[test]
    fn long_prompt_is_marked_as_truncated() {
        let prompt = "a".repeat(AI_AGENT_MATTERMOST_CHAT_PROMPT_MAX_CHARS + 1);
        let value = sanitize_prompt(&prompt);
        assert!(value.ends_with(
            "[Prompt truncated; open the admin link for full text]"
        ));
    }
}
