use crate::config::Config;
use crate::entities::{association, knowledge};
use crate::xlsx_sync::replace_xlsx_file;
use actix_web::error::{
    ErrorBadRequest, ErrorInternalServerError, ErrorUnauthorized,
};
use actix_web::http::header;
use actix_web::{post, web, Error, HttpRequest, HttpResponse};
use anyhow::Context;
use base64::engine::general_purpose::STANDARD as Base64;
use base64::Engine;
use futures_util::TryStreamExt;
use goi_echo_worker::api::{
    AssociationApiItem, ImportSignedFrequenciesRsp, KnowledgeApiItem,
    ListAssociationsReq,
};
use goi_echo_worker::knowledge::KnowledgeRow;
use goi_echo_worker::row::AssociationRow;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Config,
}

#[post("/api/associations")]
pub async fn list_associations(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    req: web::Json<ListAssociationsReq>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;

    let mut query =
        association::Entity::find().order_by_asc(association::Column::Id);
    if let Some(since_id) = req.since_id_nonincl {
        query = query.filter(association::Column::Id.gt(since_id));
    }

    if !client_accepts_ndjson(&http_req) {
        let items = query
            .all(&state.db)
            .await
            .context("fetching associations")
            .map_err(ErrorInternalServerError)?
            .into_iter()
            .map(to_api_item)
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(HttpResponse::Ok().json(items));
    }

    let db = state.db.clone();
    let stream = async_stream::stream! {
        let mut associations = match query
            .stream(&db)
            .await
            .context("streaming associations")
            .map_err(ErrorInternalServerError)
        {
            Ok(associations) => associations,
            Err(err) => {
                yield Err(err);
                return;
            }
        };
        while let Some(association) = match associations
            .try_next()
            .await
            .context("reading streamed association")
            .map_err(ErrorInternalServerError)
        {
            Ok(association) => association,
            Err(err) => {
                yield Err(err);
                return;
            }
        } {
            let item = match to_api_item(association) {
                Ok(item) => item,
                Err(err) => {
                    yield Err(err);
                    return;
                }
            };
            let mut body = match serde_json::to_vec(&item)
                .context("serializing association item")
                .map_err(ErrorInternalServerError)
            {
                Ok(body) => body,
                Err(err) => {
                    yield Err(err);
                    return;
                }
            };
            body.push(b'\n');
            yield Ok(web::Bytes::from(body));
        }
    };

    Ok(HttpResponse::Ok()
        .content_type("application/x-ndjson")
        .streaming(stream))
}

#[post("/api/knowledge")]
pub async fn list_knowledge(
    http_req: HttpRequest,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;

    let items = knowledge::Entity::find()
        .order_by_asc(knowledge::Column::Id)
        .all(&state.db)
        .await
        .context("fetching knowledge")
        .map_err(ErrorInternalServerError)?
        .into_iter()
        .map(to_knowledge_api_item)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(HttpResponse::Ok().json(items))
}

#[post("/api/frequencies/signed/import")]
pub async fn import_signed_frequencies(
    http_req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    require_basic_auth(&http_req, &state.config)?;
    validate_xlsx_body(body.as_ref())?;

    let path = state.config.preferred_frequencies_xlsx_path();
    let replaced = replace_xlsx_file(&path, body.as_ref())
        .await
        .with_context(|| format!("replacing {}", path.display()))
        .map_err(ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(ImportSignedFrequenciesRsp {
        path: path.display().to_string(),
        bytes_written: if replaced { body.len() } else { 0 },
    }))
}

fn to_api_item(
    association: association::Model,
) -> Result<AssociationApiItem, Error> {
    let row: AssociationRow = serde_json::from_value(association.row)
        .context("deserializing association row")
        .map_err(ErrorInternalServerError)?;
    Ok(AssociationApiItem {
        id: association.id,
        row,
        created_at: association.created_at.with_timezone(&chrono::Utc),
        deleted: association.deleted,
    })
}

fn to_knowledge_api_item(
    knowledge: knowledge::Model,
) -> Result<KnowledgeApiItem, Error> {
    let row: KnowledgeRow = serde_json::from_value(knowledge.row)
        .context("deserializing knowledge row")
        .map_err(ErrorInternalServerError)?;
    Ok(KnowledgeApiItem {
        id: knowledge.id,
        row,
        created_at: knowledge.created_at.with_timezone(&chrono::Utc),
        deleted: false,
    })
}

pub(crate) fn require_basic_auth(
    http_req: &HttpRequest,
    config: &Config,
) -> Result<(), Error> {
    let auth_value = http_req
        .headers()
        .get(header::AUTHORIZATION)
        .ok_or_else(|| ErrorUnauthorized("missing authorization header"))?;
    let auth_value = auth_value
        .to_str()
        .map_err(|_| ErrorUnauthorized("invalid authorization header"))?;
    let encoded = auth_value
        .strip_prefix("Basic ")
        .ok_or_else(|| ErrorUnauthorized("unsupported authorization scheme"))?;
    let decoded = Base64
        .decode(encoded)
        .map_err(|_| ErrorUnauthorized("invalid authorization value"))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| ErrorUnauthorized("invalid credentials"))?;
    let mut parts = decoded.splitn(2, ':');
    let login = parts.next().unwrap_or_default();
    let password = parts.next().unwrap_or_default();
    if login == config.api_login && password == config.api_password {
        Ok(())
    } else {
        Err(ErrorUnauthorized("invalid credentials"))
    }
}

fn client_accepts_ndjson(http_req: &HttpRequest) -> bool {
    http_req
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .any(|part| part.trim().starts_with("application/x-ndjson"))
        })
        .unwrap_or(false)
}

fn validate_xlsx_body(body: &[u8]) -> Result<(), Error> {
    if body.is_empty() {
        return Err(ErrorBadRequest("request body is empty"));
    }
    if body.len() < 4 || &body[..4] != b"PK\x03\x04" {
        return Err(ErrorBadRequest(
            "request body is not an XLSX file (ZIP header missing)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{http::StatusCode, test, App};
    use goi_echo_worker::xlsx::empty_xlsx_buffer;
    use rust_xlsxwriter::Workbook;
    use sea_orm::DatabaseConnection;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[actix_web::test]
    async fn import_signed_frequencies_writes_readonly_sibling_when_present() {
        let dir = temp_dir("goi-frequency-readonly-import");
        fs::create_dir_all(&dir).expect("create temp dir");
        let frequencies_path = dir.join("frequencies.xlsx");
        let readonly_path = dir.join("frequencies-readonly.xlsx");
        let original_frequencies = empty_xlsx_buffer().expect("regular xlsx");
        let original_readonly = xlsx_buffer_with_value("original");
        fs::write(&frequencies_path, &original_frequencies)
            .expect("write regular xlsx");
        fs::write(&readonly_path, &original_readonly)
            .expect("write readonly xlsx");

        let state = AppState {
            db: DatabaseConnection::Disconnected,
            config: Config {
                pg_host: None,
                pg_port: None,
                pg_user: None,
                pg_password: None,
                pg_dbname: None,
                api_login: "login".to_string(),
                api_password: "password".to_string(),
                associations_xlsx_path: None,
                knowledge_xlsx_path: None,
                frequencies_xlsx_path: Some(
                    frequencies_path.display().to_string(),
                ),
                palettes_path: None,
                categories_path: None,
                listen_host: None,
                listen_port: None,
                poll_sleep_ms: None,
            },
        };
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(state))
                .service(import_signed_frequencies),
        )
        .await;
        let body = empty_xlsx_buffer().expect("request xlsx");
        let auth = format!("Basic {}", Base64.encode("login:password"));

        let req = test::TestRequest::post()
            .uri("/api/frequencies/signed/import")
            .insert_header((header::AUTHORIZATION, auth))
            .set_payload(body.clone())
            .to_request();
        let res = test::call_service(&app, req).await;

        assert_eq!(res.status(), StatusCode::OK);
        let rsp: ImportSignedFrequenciesRsp = test::read_body_json(res).await;
        assert_eq!(rsp.path, readonly_path.display().to_string());
        assert_eq!(rsp.bytes_written, body.len());
        assert_eq!(
            fs::read(&frequencies_path).expect("read regular xlsx"),
            original_frequencies
        );
        assert_eq!(fs::read(&readonly_path).expect("read readonly xlsx"), body);

        fs::remove_dir_all(dir).ok();
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("{prefix}-{}-{suffix}", std::process::id()))
    }

    fn xlsx_buffer_with_value(value: &str) -> Vec<u8> {
        let mut workbook = Workbook::new();
        workbook
            .add_worksheet()
            .write_string(0, 0, value)
            .expect("write cell");
        workbook.save_to_buffer().expect("save workbook")
    }
}
