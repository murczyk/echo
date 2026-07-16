use crate::error::AppError;
use crate::types::error;
use actix_web::{http::StatusCode, HttpResponse, ResponseError};
use std::fmt;

#[derive(Clone, Copy, Debug)]
pub(super) enum DirectSubmitAction {
    Save,
    Edit,
    Parse,
}

#[derive(Debug)]
pub(super) struct DirectSubmitApiError {
    source: AppError,
    action: DirectSubmitAction,
}

impl DirectSubmitApiError {
    pub(super) fn new(
        source: impl Into<AppError>,
        action: DirectSubmitAction,
    ) -> Self {
        Self {
            source: source.into(),
            action,
        }
    }

    fn code_and_message(&self) -> (&'static str, String) {
        match &self.source {
            AppError::BL { msg } => ("validation_error", msg.clone()),
            AppError::Form(errors) => (
                "validation_error",
                errors.values().cloned().collect::<Vec<_>>().join(" "),
            ),
            AppError::NotFound => (
                "not_found",
                match self.action {
                    DirectSubmitAction::Save => {
                        "Групу або вкладення не знайдено. Оновіть сторінку та спробуйте ще раз."
                    }
                    DirectSubmitAction::Edit => {
                        "Повідомлення, групу або вкладення не знайдено. Оновіть сторінку та спробуйте ще раз."
                    }
                    DirectSubmitAction::Parse => {
                        "Обрану групу не знайдено або вона більше недоступна."
                    }
                }
                .to_string(),
            ),
            AppError::Unauthenticated => (
                "unauthenticated",
                "Сеанс завершився. Увійдіть у систему ще раз.".to_string(),
            ),
            AppError::Forbidden(_) | AppError::ForbiddenWithHeader { .. } => (
                "forbidden",
                "У вас немає дозволу на виконання цієї дії.".to_string(),
            ),
            _ => (
                "internal_error",
                match self.action {
                    DirectSubmitAction::Save => "Не вдалося зберегти повідомлення.",
                    DirectSubmitAction::Edit => "Не вдалося оновити повідомлення.",
                    DirectSubmitAction::Parse => "Не вдалося розпізнати повідомлення.",
                }
                .to_string(),
            ),
        }
    }
}

impl fmt::Display for DirectSubmitApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.code_and_message().1)
    }
}

impl ResponseError for DirectSubmitApiError {
    fn status_code(&self) -> StatusCode {
        match self.source {
            AppError::BL { .. } | AppError::Form(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Unauthenticated => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) | AppError::ForbiddenWithHeader { .. } => {
                StatusCode::FORBIDDEN
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn error_response(&self) -> HttpResponse {
        let (code, message) = self.code_and_message();
        if self.status_code().is_server_error() {
            error!("Direct submit request failed: {:?}", self.source);
        }
        HttpResponse::build(self.status_code()).json(serde_json::json!({
            "code": code,
            "message": message,
        }))
    }
}
