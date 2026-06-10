use crate::error::AppError;
use crate::types::*;
use iggy::prelude::{Client, IggyClient, SystemClient};
use std::time::Duration;
use tokio::time::timeout;
use url::Url;

pub async fn test_connection(
    url: &str,
    login: &str,
    password: &str,
) -> Result<(), AppError> {
    let connection_string = connection_string(url, login, password)?;
    let client =
        IggyClient::from_connection_string(&connection_string).c(h!())?;
    let timeout_duration = Duration::from_secs(
        crate::config::API_INTEGRATION_IGGY_TEST_TIMEOUT_SEC,
    );
    timeout(timeout_duration, client.connect())
        .await
        .map_err(|_| timeout_error("підключення"))?
        .c(h!())?;

    let test_result = timeout(timeout_duration, client.get_me()).await;
    let shutdown_result = timeout(timeout_duration, client.shutdown())
        .await
        .map_err(|_| timeout_error("закриття з'єднання"))?
        .c(h!());
    match test_result {
        Ok(result) => result.c(h!())?,
        Err(_) => return Err(timeout_error("автентифікації")),
    };
    shutdown_result?;
    Ok(())
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
