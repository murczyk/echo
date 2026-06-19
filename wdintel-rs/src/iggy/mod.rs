use crate::error::AppError;
use crate::types::*;
use iggy::prelude::{
    defaults, Client, CompressionAlgorithm, Identifier, IggyClient, IggyError,
    IggyExpiry, MaxTopicSize, Permissions, StreamClient, StreamPermissions,
    SystemClient, TopicClient, UserClient,
};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::time::timeout;
use url::Url;

pub mod worker;

pub async fn test_connection(
    url: &str,
    login: &str,
    password: &str,
) -> Result<(), AppError> {
    let client = connect(url, login, password).await?;
    shutdown(&client).await?;
    Ok(())
}

pub async fn ensure_topics(
    url: &str,
    login: &str,
    password: &str,
    topics: &[&str],
) -> Result<(), AppError> {
    let client = connect(url, login, password).await?;
    let result = match timeout(
        timeout_duration(),
        ensure_topics_with_client(&client, topics),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(timeout_error("створення тем")),
    };
    let shutdown_result = shutdown(&client).await;
    result?;
    shutdown_result
}

pub async fn ensure_topics_for_all_users(
    url: &str,
    login: &str,
    password: &str,
    topics: &[&str],
) -> Result<(), AppError> {
    let client = connect(url, login, password).await?;
    let result = match timeout(
        timeout_duration(),
        ensure_topics_and_user_permissions(&client, topics),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            Err(timeout_error("створення тем і оновлення прав користувачів"))
        }
    };
    let shutdown_result = shutdown(&client).await;
    result?;
    shutdown_result
}

pub async fn shutdown(client: &IggyClient) -> Result<(), AppError> {
    timeout(timeout_duration(), client.shutdown())
        .await
        .map_err(|_| timeout_error("закриття з'єднання"))?
        .c(h!())?;
    Ok(())
}

pub async fn connect(
    url: &str,
    login: &str,
    password: &str,
) -> Result<IggyClient, AppError> {
    let connection_string = connection_string(url, login, password)?;
    let client =
        IggyClient::from_connection_string(&connection_string).c(h!())?;
    let connect_result =
        match timeout(timeout_duration(), client.connect()).await {
            Ok(result) => result.c(h!()).map_err(AppError::from),
            Err(_) => Err(timeout_error("підключення")),
        };
    if let Err(err) = connect_result {
        shutdown_after_error(&client).await;
        return Err(err);
    }
    let auth_result = match timeout(timeout_duration(), client.get_me()).await {
        Ok(result) => result.c(h!()).map(|_| ()).map_err(AppError::from),
        Err(_) => Err(timeout_error("автентифікації")),
    };
    if let Err(err) = auth_result {
        shutdown_after_error(&client).await;
        return Err(err);
    }
    Ok(client)
}

async fn shutdown_after_error(client: &IggyClient) {
    if let Err(err) = shutdown(client).await {
        warn!("Failed to close Iggy connection after error: {err:#?}");
    }
}

pub fn stream_and_topic(topic: &str) -> (&str, &str) {
    topic
        .split_once('/')
        .unwrap_or((crate::config::API_INTEGRATION_IGGY_DEFAULT_STREAM, topic))
}

async fn ensure_topics_with_client(
    client: &IggyClient,
    topics: &[&str],
) -> Result<(), AppError> {
    for configured_topic in topics {
        let (stream, topic) = stream_and_topic(configured_topic);
        ensure_stream(client, stream).await?;
        ensure_topic(client, stream, topic).await?;
    }
    Ok(())
}

async fn ensure_topics_and_user_permissions(
    client: &IggyClient,
    topics: &[&str],
) -> Result<(), AppError> {
    ensure_topics_with_client(client, topics).await?;
    let stream_ids = configured_stream_ids(client, topics).await?;
    ensure_user_stream_permissions(client, &stream_ids).await
}

async fn configured_stream_ids(
    client: &IggyClient,
    topics: &[&str],
) -> Result<Vec<usize>, AppError> {
    let mut stream_ids = Vec::new();
    for configured_topic in topics {
        let (stream, _) = stream_and_topic(configured_topic);
        let stream = client
            .get_stream(&Identifier::try_from(stream).c(h!())?)
            .await
            .c(h!())?
            .c(h!())?;
        let stream_id = stream.id as usize;
        if !stream_ids.contains(&stream_id) {
            stream_ids.push(stream_id);
        }
    }
    Ok(stream_ids)
}

async fn ensure_user_stream_permissions(
    client: &IggyClient,
    stream_ids: &[usize],
) -> Result<(), AppError> {
    for user in client.get_users().await.c(h!())? {
        if user.id == defaults::DEFAULT_ROOT_USER_ID {
            continue;
        }
        let user_id = Identifier::try_from(user.id).c(h!())?;
        let user = client.get_user(&user_id).await.c(h!())?.c(h!())?;
        let mut permissions = user.permissions.unwrap_or_default();
        for stream_id in stream_ids {
            grant_stream_access(&mut permissions, *stream_id);
        }
        client
            .update_permissions(&user_id, Some(permissions))
            .await
            .c(h!())?;
    }
    Ok(())
}

fn grant_stream_access(permissions: &mut Permissions, stream_id: usize) {
    let stream_permissions = permissions
        .streams
        .get_or_insert_with(BTreeMap::new)
        .entry(stream_id)
        .or_insert_with(StreamPermissions::default);
    stream_permissions.read_stream = true;
    stream_permissions.read_topics = true;
    stream_permissions.poll_messages = true;
    stream_permissions.send_messages = true;
}

async fn ensure_stream(
    client: &IggyClient,
    stream: &str,
) -> Result<(), AppError> {
    let stream_id = Identifier::try_from(stream).c(h!())?;
    if client.get_stream(&stream_id).await.c(h!())?.is_some() {
        return Ok(());
    }
    match client.create_stream(stream).await {
        Ok(_) | Err(IggyError::StreamNameAlreadyExists(_)) => Ok(()),
        Err(err) => Err(err).c(h!())?,
    }
}

async fn ensure_topic(
    client: &IggyClient,
    stream: &str,
    topic: &str,
) -> Result<(), AppError> {
    let stream_id = Identifier::try_from(stream).c(h!())?;
    let topic_id = Identifier::try_from(topic).c(h!())?;
    if client
        .get_topic(&stream_id, &topic_id)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(());
    }
    match client
        .create_topic(
            &stream_id,
            topic,
            crate::config::API_INTEGRATION_IGGY_TOPIC_PARTITIONS_COUNT,
            CompressionAlgorithm::None,
            None,
            IggyExpiry::NeverExpire,
            MaxTopicSize::ServerDefault,
        )
        .await
    {
        Ok(_) | Err(IggyError::TopicNameAlreadyExists(_, _)) => Ok(()),
        Err(err) => Err(err).c(h!())?,
    }
}

fn timeout_duration() -> Duration {
    Duration::from_secs(crate::config::API_INTEGRATION_IGGY_TEST_TIMEOUT_SEC)
}

fn timeout_error(action: &str) -> AppError {
    AppError::BL {
        msg: format!("Перевищено час очікування Iggy: {action}"),
    }
}

fn connection_string(
    url: &str,
    login: &str,
    password: &str,
) -> Result<String, AppError> {
    let mut url = Url::parse(url).c(h!())?;
    url.set_username(login).map_err(|_| AppError::BL {
        msg: "Некоректний Iggy логін".to_string(),
    })?;
    url.set_password(Some(password)).map_err(|_| AppError::BL {
        msg: "Некоректний Iggy пароль".to_string(),
    })?;
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_topic_can_include_a_stream() {
        assert_eq!(stream_and_topic("events/inbox"), ("events", "inbox"));
        assert_eq!(
            stream_and_topic("inbox"),
            (crate::config::API_INTEGRATION_IGGY_DEFAULT_STREAM, "inbox")
        );
    }
}
