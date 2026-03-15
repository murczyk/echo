use crate::config::{
    ORGANISM_GOI_API_PORT_DEFAULT, ORGANISM_GOI_PATH_DEFAULT,
    ORGANISM_GOI_SSH_PORT_DEFAULT, ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS,
};
use crate::entities::organism;
use crate::error::AppError;
use crate::organism::types::{
    CheckOrganismGoiConnectionReq, CheckOrganismGoiConnectionRsp,
    OrganismGoiSettings, SetupOrganismGoiWorkerReq,
    UpdateOrganismGoiSettingsReq,
};
use crate::types::*;
use crate::utils::string::{
    normalize_optional_trimmed, normalize_trimmed_or_default,
};
use actix_web::post;
use actix_web::web::Json;
use sea_orm::*;

mod goi_ssh;
pub mod worker;

struct GoiSettingsInput {
    ssh_host: Option<String>,
    ssh_user: Option<String>,
    ssh_port: i32,
    path: String,
    api_host: Option<String>,
    api_port: i32,
    api_login: Option<String>,
    api_password: Option<String>,
}

#[post("/api/organism/goi-settings")]
pub async fn organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let organism = organism::Entity::find_by_id(req.into_inner())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    Ok(Json(goi_settings_from_organism(organism)))
}

#[post("/api/organism/goi-settings/update")]
pub async fn update_organism_goi_settings(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateOrganismGoiSettingsReq>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_settings_req(&req)?;

    let organism = goi_find_organism(&env.dbx, req.organism_id).await?;
    let settings = GoiSettingsInput {
        ssh_host: normalize_optional_trimmed(req.ssh_host),
        ssh_user: normalize_optional_trimmed(req.ssh_user),
        ssh_port: req.ssh_port,
        path: normalize_trimmed_or_default(req.path, ORGANISM_GOI_PATH_DEFAULT),
        api_host: normalize_optional_trimmed(req.api_host),
        api_port: req.api_port,
        api_login: normalize_optional_trimmed(req.api_login),
        api_password: normalize_optional_trimmed(req.api_password),
    };
    let organism = goi_store_settings(&env.dbx, organism, settings).await?;

    Ok(Json(goi_settings_from_organism(organism)))
}

#[post("/api/organism/goi-settings/setup-worker")]
pub async fn setup_organism_goi_worker(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SetupOrganismGoiWorkerReq>,
) -> Result<Json<OrganismGoiSettings>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    goi_validate_setup_worker_req(&req)?;

    let organism = goi_find_organism(&env.dbx, req.organism_id).await?;
    let pg_password = goi_generate_worker_secret();
    let api_password = goi_generate_worker_secret();
    let ssh_req = CheckOrganismGoiConnectionReq {
        ssh_host: req.ssh_host.clone(),
        ssh_user: req.ssh_user.clone(),
        ssh_port: req.ssh_port,
        path: req.path.clone(),
    };
    let setup_command =
        goi_build_setup_worker_command(&pg_password, &api_password);

    goi_run_setup_worker(ssh_req, setup_command).await?;

    let settings = GoiSettingsInput {
        ssh_host: Some(req.ssh_host.trim().to_string()),
        ssh_user: Some(req.ssh_user.trim().to_string()),
        ssh_port: req.ssh_port,
        path: normalize_trimmed_or_default(req.path, ORGANISM_GOI_PATH_DEFAULT),
        api_host: normalize_optional_trimmed(req.api_host),
        api_port: req.api_port,
        api_login: Some("goi".to_string()),
        api_password: Some(api_password),
    };
    let organism = goi_store_settings(&env.dbx, organism, settings).await?;

    Ok(Json(goi_settings_from_organism(organism)))
}

#[post("/api/organism/goi-settings/check-connection")]
pub async fn check_organism_goi_connection(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CheckOrganismGoiConnectionReq>,
) -> Result<Json<CheckOrganismGoiConnectionRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin").await?;

    let req = req.into_inner();
    let (listed_entries, error) = match goi_validate_connection_req(&req) {
        Ok(()) => {
            match tokio::task::spawn_blocking(move || {
                goi_ssh::goi_check_connection_sync(req)
            })
            .await
            {
                Ok(Ok(listed_entries)) => (listed_entries, None),
                Ok(Err(err)) => {
                    (Vec::new(), Some(format!("GOI SSH check failed: {err}")))
                }
                Err(err) => {
                    (Vec::new(), Some(format!("GOI SSH check failed: {err}")))
                }
            }
        }
        Err(err) => (Vec::new(), Some(format!("GOI SSH check failed: {err}"))),
    };

    Ok(Json(CheckOrganismGoiConnectionRsp {
        ok: error.is_none(),
        listed_entries,
        error,
    }))
}

pub async fn goi_upload_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_upload_file_sync(req, remote_file_path, file_data)
    })
    .await
    .c(h!())?
}

pub async fn goi_upload_file_loose(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
    file_data: Vec<u8>,
) {
    let ssh_target = format!("{}:{}", req.ssh_host, req.ssh_port);
    let remote_file_path_for_log = remote_file_path.clone();
    if let Err(err) = goi_upload_file(req, remote_file_path, file_data).await {
        log::warn!(
            "Skipping GOI file upload for {ssh_target} {remote_file_path_for_log}: {err:#}"
        );
    }
}

pub async fn goi_delete_file(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) -> anyhow::Result<()> {
    goi_validate_connection_req(&req)?;

    tokio::task::spawn_blocking(move || {
        goi_ssh::goi_delete_file_sync(req, remote_file_path)
    })
    .await
    .c(h!())?
}

pub async fn goi_delete_file_loose(
    req: CheckOrganismGoiConnectionReq,
    remote_file_path: String,
) {
    let ssh_target = format!("{}:{}", req.ssh_host, req.ssh_port);
    let remote_file_path_for_log = remote_file_path.clone();
    if let Err(err) = goi_delete_file(req, remote_file_path).await {
        log::warn!(
            "Skipping GOI file delete for {ssh_target} {remote_file_path_for_log}: {err:#}"
        );
    }
}

async fn goi_find_organism(
    dbx: &DatabaseConnection,
    organism_id: i64,
) -> Result<organism::Model, AppError> {
    organism::Entity::find_by_id(organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

async fn goi_run_setup_worker(
    ssh_req: CheckOrganismGoiConnectionReq,
    setup_command: String,
) -> Result<(), AppError> {
    match tokio::task::spawn_blocking(move || {
        goi_ssh::goi_exec_command_sync(
            ssh_req,
            setup_command,
            ORGANISM_GOI_SSH_SETUP_TIMEOUT_MS,
        )
    })
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(AppError::BL {
            msg: format!("GOI worker setup failed: {err:#}"),
        }),
        Err(err) => Err(AppError::BL {
            msg: format!("GOI worker setup failed: {err}"),
        }),
    }
}

async fn goi_store_settings(
    dbx: &DatabaseConnection,
    organism: organism::Model,
    settings: GoiSettingsInput,
) -> Result<organism::Model, AppError> {
    let mut organism: organism::ActiveModel = organism.into();
    organism.goi_ssh_host = Set(settings.ssh_host);
    organism.goi_ssh_user = Set(settings.ssh_user);
    organism.goi_ssh_port = Set(settings.ssh_port);
    organism.goi_path = Set(settings.path);
    organism.goi_api_host = Set(settings.api_host);
    organism.goi_api_port = Set(settings.api_port);
    organism.goi_api_login = Set(settings.api_login);
    organism.goi_api_password = Set(settings.api_password);
    Ok(organism.update(dbx).await.c(h!())?)
}

fn goi_validate_ssh_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("invalid SSH port: {port}"),
    })
}

fn goi_validate_api_port(port: i32) -> Result<(), AppError> {
    if (1..=65535).contains(&port) {
        return Ok(());
    }
    Err(AppError::BL {
        msg: format!("invalid API port: {port}"),
    })
}

fn goi_settings_from_organism(
    organism: organism::Model,
) -> OrganismGoiSettings {
    let ssh_host = normalize_optional_trimmed(organism.goi_ssh_host);
    let api_host = normalize_optional_trimmed(organism.goi_api_host)
        .or_else(|| ssh_host.clone());
    OrganismGoiSettings {
        organism_id: organism.id,
        ssh_host,
        ssh_user: normalize_optional_trimmed(organism.goi_ssh_user),
        ssh_port: if organism.goi_ssh_port > 0 {
            organism.goi_ssh_port
        } else {
            ORGANISM_GOI_SSH_PORT_DEFAULT
        },
        path: normalize_trimmed_or_default(
            organism.goi_path,
            ORGANISM_GOI_PATH_DEFAULT,
        ),
        api_host,
        api_port: if organism.goi_api_port > 0 {
            organism.goi_api_port
        } else {
            ORGANISM_GOI_API_PORT_DEFAULT
        },
        api_login: normalize_optional_trimmed(organism.goi_api_login),
        api_password: normalize_optional_trimmed(organism.goi_api_password),
    }
}

fn goi_validate_connection_req(
    req: &CheckOrganismGoiConnectionReq,
) -> Result<(), AppError> {
    if req.ssh_host.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH host is required".to_string(),
        });
    }
    if req.ssh_user.trim().is_empty() {
        return Err(AppError::BL {
            msg: "SSH user is required".to_string(),
        });
    }
    if req.path.trim().is_empty() {
        return Err(AppError::BL {
            msg: "GOI path is required".to_string(),
        });
    }
    goi_validate_ssh_port(req.ssh_port)
}

fn goi_validate_setup_worker_req(
    req: &SetupOrganismGoiWorkerReq,
) -> Result<(), AppError> {
    goi_validate_connection_req(&CheckOrganismGoiConnectionReq {
        ssh_host: req.ssh_host.clone(),
        ssh_user: req.ssh_user.clone(),
        ssh_port: req.ssh_port,
        path: req.path.clone(),
    })?;
    goi_validate_api_port(req.api_port)
}

fn goi_validate_settings_req(
    req: &UpdateOrganismGoiSettingsReq,
) -> Result<(), AppError> {
    goi_validate_ssh_port(req.ssh_port)?;
    goi_validate_api_port(req.api_port)?;

    let api_host = normalize_optional_trimmed(req.api_host.clone());
    let ssh_host = normalize_optional_trimmed(req.ssh_host.clone());
    let api_login = normalize_optional_trimmed(req.api_login.clone());
    let api_password = normalize_optional_trimmed(req.api_password.clone());
    let needs_api_auth =
        api_host.is_some() || api_login.is_some() || api_password.is_some();
    if needs_api_auth && api_host.is_none() && ssh_host.is_none() {
        return Err(AppError::BL {
            msg: "GOI API host or SSH host is required".to_string(),
        });
    }
    if needs_api_auth && api_login.is_none() {
        return Err(AppError::BL {
            msg: "GOI API login is required".to_string(),
        });
    }
    if needs_api_auth && api_password.is_none() {
        return Err(AppError::BL {
            msg: "GOI API password is required".to_string(),
        });
    }
    Ok(())
}

fn goi_generate_worker_secret() -> String {
    Uuid::new_v4().simple().to_string()
}

fn goi_build_setup_worker_command(
    pg_password: &str,
    api_password: &str,
) -> String {
    let worker_config = format!(
        concat!(
            "pg_host = \"127.0.0.1\"\n",
            "pg_port = 5432\n",
            "pg_user = \"goi\"\n",
            "pg_password = \"{}\"\n",
            "pg_dbname = \"goi\"\n",
            "\n",
            "api_login = \"goi\"\n",
            "api_password = \"{}\"\n",
            "\n",
            "associations_xlsx_path = \"/etc/goi/data/xlsx/associations.xlsx\"\n",
            "listen_host = \"0.0.0.0\"\n",
            "listen_port = 8088\n",
            "poll_sleep_ms = 1000\n"
        ),
        pg_password,
        api_password,
    );

    format!(
        r#"bash -se <<'GOI_ECHO_WORKER_SETUP'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo -n true
sudo apt-get update >/dev/null
sudo apt-get install -y ca-certificates curl iputils-ping >/dev/null

if ! sudo ping -c1 -W2 echo-ci.eagle-atria.ts.net >/dev/null 2>&1; then
  echo "echo-ci.eagle-atria.ts.net is unreachable from the GOI instance" >&2
  exit 1
fi

sudo curl -fsSL https://echo-ci.eagle-atria.ts.net/keys/echo-ci-archive-keyring.gpg \
  -o /usr/share/keyrings/echo-ci-archive-keyring.gpg
ARCH="$(dpkg --print-architecture)"
echo "deb [arch=${{ARCH}} signed-by=/usr/share/keyrings/echo-ci-archive-keyring.gpg] https://echo-ci.eagle-atria.ts.net/echo jammy main" \
  | sudo tee /etc/apt/sources.list.d/echo.list >/dev/null

sudo apt-get update >/dev/null
sudo apt-get install -y postgresql goi-echo-worker >/dev/null
sudo systemctl enable --now postgresql >/dev/null

sudo -u postgres psql -v ON_ERROR_STOP=1 postgres <<'GOI_SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goi') THEN
    ALTER ROLE goi WITH LOGIN PASSWORD '{pg_password}';
  ELSE
    CREATE ROLE goi WITH LOGIN PASSWORD '{pg_password}';
  END IF;
END $$;
GOI_SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'goi'" | grep -q 1; then
  sudo -u postgres createdb -O goi goi
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 postgres -c "ALTER DATABASE goi OWNER TO goi"

sudo install -d -m 0755 /etc/goi-echo-worker
cat <<'GOI_ECHO_WORKER_CONFIG' | sudo tee /etc/goi-echo-worker/config.toml >/dev/null
{worker_config}GOI_ECHO_WORKER_CONFIG
sudo chmod 600 /etc/goi-echo-worker/config.toml

sudo systemctl daemon-reload
sudo systemctl enable --now goi-echo-worker >/dev/null
sudo systemctl restart goi-echo-worker >/dev/null
sudo systemctl is-active --quiet goi-echo-worker

echo "GOI worker configured successfully"
GOI_ECHO_WORKER_SETUP"#,
    )
}
