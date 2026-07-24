use super::json::{decode_json, read_json_body, require_empty_body};
use crate::devices::access::{DeviceActor, DeviceActorResolver};
use crate::devices::main_db::MainDb;
use crate::error::AppError;
use crate::types::Env;
use actix_identity::Identity;
use actix_web::dev::Payload;
use actix_web::web::Data;
use actix_web::{FromRequest, HttpRequest};
use futures_util::future::LocalBoxFuture;
use serde::de::DeserializeOwned;

pub(in crate::devices) struct DeviceApiJson<T> {
    pub actor: DeviceActor,
    pub env: Data<Env>,
    pub body: T,
}

impl<T> FromRequest for DeviceApiJson<T>
where
    T: DeserializeOwned + 'static,
{
    type Error = AppError;
    type Future = LocalBoxFuture<'static, Result<Self, Self::Error>>;

    fn from_request(
        request: &HttpRequest,
        payload: &mut Payload,
    ) -> Self::Future {
        let request = request.clone();
        let mut payload = payload.take();
        Box::pin(async move {
            let (actor, env) = resolve_actor(&request, &mut payload).await?;
            let body = read_json_body(&request, &mut payload).await?;
            let body = decode_json(&body)?;
            Ok(Self { actor, env, body })
        })
    }
}

pub(in crate::devices) struct DeviceApiNoBody {
    pub actor: DeviceActor,
    pub env: Data<Env>,
}

impl FromRequest for DeviceApiNoBody {
    type Error = AppError;
    type Future = LocalBoxFuture<'static, Result<Self, Self::Error>>;

    fn from_request(
        request: &HttpRequest,
        payload: &mut Payload,
    ) -> Self::Future {
        let request = request.clone();
        let mut payload = payload.take();
        Box::pin(async move {
            let (actor, env) = resolve_actor(&request, &mut payload).await?;
            require_empty_body(&mut payload).await?;
            Ok(Self { actor, env })
        })
    }
}

async fn resolve_actor(
    request: &HttpRequest,
    payload: &mut Payload,
) -> Result<(DeviceActor, Data<Env>), AppError> {
    let identity = Identity::from_request(request, payload)
        .await
        .map_err(|_| AppError::Unauthenticated)?;
    identity.id().map_err(|_| AppError::Unauthenticated)?;
    let env = request.app_data::<Data<Env>>().cloned().ok_or_else(|| {
        AppError::AnyhowError {
            source: anyhow::anyhow!("Devices API Env app data is missing"),
        }
    })?;
    let main_db = MainDb::new(&env.dbx);
    let actor = DeviceActorResolver::resolve(&main_db, &identity).await?;
    Ok((actor, env))
}
