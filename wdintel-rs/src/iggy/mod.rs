use crate::error::AppError;
use crate::types::*;
use iggy::prelude::{
    Client, CompressionAlgorithm, Identifier, IggyClient, IggyError,
    IggyExpiry, MaxTopicSize, StreamClient, SystemClient, TopicClient,
};
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
    timeout(timeout_duration(), client.connect())
        .await
        .map_err(|_| timeout_error("підключення"))?
        .c(h!())?;
    timeout(timeout_duration(), client.get_me())
        .await
        .map_err(|_| timeout_error("автентифікації"))?
        .c(h!())?;
    Ok(client)
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
