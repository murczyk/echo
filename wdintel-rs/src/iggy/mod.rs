use crate::error::AppError;
use crate::types::*;
use iggy::prelude::{Client, IggyClient, SystemClient};
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
