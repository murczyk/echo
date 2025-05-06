use crate::error::AppError;
use actix_multipart::Multipart;
use futures_util::StreamExt;

pub async fn extract(
    payload: &mut Multipart,
) -> Result<(actix_multipart::Field, Vec<u8>), AppError> {
    let mut val = vec![];
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(to_app_error)?;
        while let Some(chunk) = field.next().await {
            val.extend(chunk.map_err(to_app_error)?.to_vec());
        }
        return Ok((field, val));
    }

    Err(to_app_error("No file found"))
}

fn to_app_error<T>(e: T) -> AppError
where
    T: std::fmt::Display + std::fmt::Debug,
{
    format!("Multipart error: {:?}", e).into()
}
