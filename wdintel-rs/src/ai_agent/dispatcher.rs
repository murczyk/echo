use super::access;
use crate::config::{
    AiAgentDispatcherConfig, AI_AGENT_DISPATCHER_CONTROL_MAX_BYTES,
    AI_AGENT_DISPATCHER_CONTROL_MAX_FRAMES,
    AI_AGENT_DISPATCHER_CONTROL_TIMEOUT_SEC, AI_AGENT_DISPATCHER_ID,
    AI_AGENT_DISPATCHER_IDENTITY_FILE, AI_AGENT_DISPATCHER_KNOWN_HOSTS_FILE,
    AI_AGENT_DISPATCHER_MAX_FRAME_BYTES, AI_AGENT_DISPATCHER_PORT_DEFAULT,
    AI_AGENT_ERROR_MAX_CHARS,
};
use crate::entities::ai_agent_dispatcher;
use crate::error::AppError;
use crate::h;
use crate::types::{info, warn, Deserialize, Env, Serialize, ShortContext};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use regex::Regex;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, DatabaseConnection, EntityTrait};
use serde_json::{Map, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdout, Command};
use tokio_util::codec::{FramedRead, LinesCodec};
use uuid::Uuid;

static NAMESPACE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^echo-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")
        .expect("AI agent dispatcher namespace regex is valid")
});

static SSH_USER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^[a-z_][a-z0-9_-]{0,31}$")
        .expect("AI agent dispatcher SSH user regex is valid")
});

#[derive(Clone)]
pub struct DispatcherClient {
    host: String,
    port: u16,
    user: String,
    identity_file: String,
    known_hosts_file: String,
    namespace: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DispatcherEnvelope {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(default)]
    pub done: bool,
    pub event: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct DispatcherResponse {
    pub result: Value,
    pub events: Vec<Value>,
}

pub struct DispatcherStream {
    request_id: String,
    child: Child,
    stdout: FramedRead<ChildStdout, LinesCodec>,
    stderr_task: tokio::task::JoinHandle<Vec<String>>,
}

impl DispatcherClient {
    pub async fn from_env(env: &Env) -> Result<Self, AppError> {
        let dispatcher =
            ai_agent_dispatcher::Entity::find_by_id(AI_AGENT_DISPATCHER_ID)
                .one(&env.dbx)
                .await
                .c(h!())?
                .ok_or_else(|| AppError::ServiceUnavailable {
                    msg: "AI agent dispatcher is not configured".to_string(),
                    retry_after_secs: 30,
                })?;
        Self::from_record(&dispatcher)
    }

    pub fn from_record(
        dispatcher: &ai_agent_dispatcher::Model,
    ) -> Result<Self, AppError> {
        let namespace = required(
            Some(&dispatcher.namespace),
            "AI agent dispatcher namespace",
        )?;
        if !valid_namespace(&namespace) {
            return Err(AppError::BL {
                msg: "AI agent dispatcher namespace is invalid".to_string(),
            });
        }
        let user = required(
            Some(&dispatcher.ssh_user),
            "AI agent dispatcher SSH user",
        )?;
        if !valid_ssh_user(&user) {
            return Err(AppError::BL {
                msg: "AI agent dispatcher SSH user is invalid".to_string(),
            });
        }
        let host =
            required(Some(&dispatcher.host), "AI agent dispatcher host")?;
        if !access::is_dispatcher_hostname(&host) {
            return Err(AppError::BL {
                msg: "AI agent dispatcher host is invalid".to_string(),
            });
        }
        let port =
            u16::try_from(dispatcher.port).map_err(|_| AppError::BL {
                msg: "AI agent dispatcher port is invalid".to_string(),
            })?;
        if port == 0 {
            return Err(AppError::BL {
                msg: "AI agent dispatcher port is invalid".to_string(),
            });
        }
        Ok(Self {
            host,
            port,
            user,
            identity_file: AI_AGENT_DISPATCHER_IDENTITY_FILE.to_string(),
            known_hosts_file: AI_AGENT_DISPATCHER_KNOWN_HOSTS_FILE.to_string(),
            namespace,
        })
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub async fn call(
        &self,
        operation: &str,
        agent_id: Option<Uuid>,
        payload: Value,
    ) -> Result<DispatcherResponse, AppError> {
        tokio::time::timeout(
            Duration::from_secs(AI_AGENT_DISPATCHER_CONTROL_TIMEOUT_SEC),
            self.call_bounded(operation, agent_id, payload),
        )
        .await
        .map_err(|_| AppError::ServiceUnavailable {
            msg: "AI agent dispatcher timed out".to_string(),
            retry_after_secs: 5,
        })?
    }

    pub async fn start_stream(
        &self,
        operation: &str,
        agent_id: Uuid,
        payload: Value,
    ) -> Result<DispatcherStream, AppError> {
        self.start_stream_for(operation, Some(agent_id), payload)
            .await
    }

    async fn call_bounded(
        &self,
        operation: &str,
        agent_id: Option<Uuid>,
        payload: Value,
    ) -> Result<DispatcherResponse, AppError> {
        let mut stream =
            self.start_stream_for(operation, agent_id, payload).await?;
        let mut terminal = None;
        let mut events = Vec::new();
        let mut frame_count = 0_usize;
        let mut total_bytes = 0_usize;
        while let Some(envelope) = stream.next().await? {
            frame_count = frame_count.saturating_add(1);
            total_bytes = total_bytes
                .saturating_add(serde_json::to_vec(&envelope).c(h!())?.len());
            if frame_count > AI_AGENT_DISPATCHER_CONTROL_MAX_FRAMES
                || total_bytes > AI_AGENT_DISPATCHER_CONTROL_MAX_BYTES
            {
                let _ = stream.terminate().await;
                return Err(AppError::BL {
                    msg: "AI agent dispatcher control response exceeded its limit"
                        .to_string(),
                });
            }
            if let Some(event) = envelope.event.clone() {
                events.push(event);
            }
            if envelope.done {
                terminal = Some(envelope);
                break;
            }
        }
        let mut response = terminal_response(terminal.ok_or_else(|| {
            AppError::BL {
                msg: "AI agent dispatcher returned no terminal response"
                    .to_string(),
            }
        })?)?;
        stream.finish().await?;
        response.events = events;
        Ok(response)
    }

    async fn start_stream_for(
        &self,
        operation: &str,
        agent_id: Option<Uuid>,
        payload: Value,
    ) -> Result<DispatcherStream, AppError> {
        let request_id = Uuid::now_v7().to_string();
        let request =
            dispatcher_request(&request_id, operation, agent_id, payload)?;
        let mut child = self.command().spawn().c(h!())?;
        write_request(&mut child, &request).await?;
        let stdout = child.stdout.take().c(h!())?;
        let stderr = child.stderr.take().c(h!())?;
        let stderr_task = tokio::spawn(async move {
            let mut lines = FramedRead::new(
                stderr,
                LinesCodec::new_with_max_length(
                    AI_AGENT_DISPATCHER_MAX_FRAME_BYTES,
                ),
            );
            let mut recent = Vec::new();
            while let Some(line) = lines.next().await {
                match line {
                    Ok(line) => {
                        recent.push(access::truncate(line, 1_000));
                        if recent.len() > 32 {
                            recent.remove(0);
                        }
                    }
                    Err(_) => {
                        recent.push(
                            "dispatcher stderr frame exceeded limit"
                                .to_string(),
                        );
                        break;
                    }
                }
            }
            recent
        });
        Ok(DispatcherStream {
            request_id,
            child,
            stdout: FramedRead::new(
                stdout,
                LinesCodec::new_with_max_length(
                    AI_AGENT_DISPATCHER_MAX_FRAME_BYTES,
                ),
            ),
            stderr_task,
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new("ssh");
        command
            .kill_on_drop(true)
            .arg("-F")
            .arg("/dev/null")
            .arg("-T")
            .arg("-p")
            .arg(self.port.to_string())
            .arg("-i")
            .arg(&self.identity_file)
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("IdentitiesOnly=yes")
            .arg("-o")
            .arg("PreferredAuthentications=publickey")
            .arg("-o")
            .arg("PasswordAuthentication=no")
            .arg("-o")
            .arg("KbdInteractiveAuthentication=no")
            .arg("-o")
            .arg("StrictHostKeyChecking=yes")
            .arg("-o")
            .arg(format!("UserKnownHostsFile={}", self.known_hosts_file))
            .arg("-o")
            .arg("ClearAllForwardings=yes")
            .arg("-o")
            .arg("ForwardAgent=no")
            .arg("-o")
            .arg("PermitLocalCommand=no")
            .arg(format!("{}@{}", self.user, self.host))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

pub async fn import_legacy_config(
    dbx: &DatabaseConnection,
    legacy: Option<&AiAgentDispatcherConfig>,
) -> Result<(), AppError> {
    if ai_agent_dispatcher::Entity::find_by_id(AI_AGENT_DISPATCHER_ID)
        .one(dbx)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(());
    }
    let Some(legacy) = legacy else {
        return Ok(());
    };
    if legacy.identity_file != AI_AGENT_DISPATCHER_IDENTITY_FILE
        || legacy.known_hosts_file != AI_AGENT_DISPATCHER_KNOWN_HOSTS_FILE
    {
        return Err(AppError::BL {
            msg:
                "Legacy AI agent dispatcher must use the fixed credential paths"
                    .to_string(),
        });
    }
    let port = legacy.port.unwrap_or(AI_AGENT_DISPATCHER_PORT_DEFAULT);
    let host = legacy.host.trim().to_ascii_lowercase();
    let ssh_user = legacy.user.trim().to_string();
    let namespace = legacy.namespace.trim().to_string();
    if !access::is_dispatcher_hostname(&host)
        || port == 0
        || !valid_ssh_user(&ssh_user)
        || !valid_namespace(&namespace)
    {
        return Err(AppError::BL {
            msg: "Legacy AI agent dispatcher configuration is invalid"
                .to_string(),
        });
    }
    let now = chrono::Utc::now().naive_utc();
    let inserted =
        ai_agent_dispatcher::Entity::insert(ai_agent_dispatcher::ActiveModel {
            id: Set(AI_AGENT_DISPATCHER_ID),
            host: Set(host),
            port: Set(i32::from(port)),
            ssh_user: Set(ssh_user),
            namespace: Set(namespace),
            last_tested_at: Set(None),
            last_test_error: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        })
        .on_conflict(
            OnConflict::column(ai_agent_dispatcher::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(dbx)
        .await
        .c(h!())?;
    if inserted > 0 {
        info!(
            "Imported legacy [ai_agent_dispatcher] into the database; remove the section from config.toml"
        );
    }
    Ok(())
}

pub fn valid_namespace(value: &str) -> bool {
    NAMESPACE_RE.is_match(value)
}

pub fn valid_ssh_user(value: &str) -> bool {
    SSH_USER_RE.is_match(value)
}

impl DispatcherStream {
    pub async fn next(
        &mut self,
    ) -> Result<Option<DispatcherEnvelope>, AppError> {
        let Some(line) = self.stdout.next().await.transpose().c(h!())? else {
            return Ok(None);
        };
        let envelope: DispatcherEnvelope =
            serde_json::from_str(&line).c(h!())?;
        validate_envelope_id(&envelope, &self.request_id)?;
        Ok(Some(envelope))
    }

    pub async fn finish(mut self) -> Result<(), AppError> {
        let status = self.child.wait().await.c(h!())?;
        let stderr = self.stderr_task.await.c(h!())?;
        if !status.success() {
            warn!(
                "AI agent dispatcher stream failed status={status} stderr_lines={}",
                stderr.len()
            );
            return Err(AppError::BL {
                msg: "AI agent dispatcher stream failed".to_string(),
            });
        }
        Ok(())
    }

    pub async fn terminate(&mut self) -> Result<(), AppError> {
        self.child.kill().await.c(h!())?;
        Ok(())
    }
}

fn dispatcher_request(
    request_id: &str,
    operation: &str,
    agent_id: Option<Uuid>,
    payload: Value,
) -> Result<Vec<u8>, AppError> {
    let mut body = match payload {
        Value::Object(body) => body,
        _ => {
            return Err(AppError::BL {
                msg: "Dispatcher payload must be a JSON object".to_string(),
            });
        }
    };
    body.insert("id".to_string(), Value::String(request_id.to_string()));
    body.insert(
        "operation".to_string(),
        Value::String(operation.to_string()),
    );
    if let Some(agent_id) = agent_id {
        body.insert(
            "agent_id".to_string(),
            Value::String(agent_id.to_string()),
        );
    }
    serde_json::to_vec(&Value::Object(body))
        .c(h!())
        .map_err(Into::into)
}

async fn write_request(
    child: &mut Child,
    request: &[u8],
) -> Result<(), AppError> {
    let mut stdin = child.stdin.take().c(h!())?;
    stdin.write_all(request).await.c(h!())?;
    stdin.write_all(b"\n").await.c(h!())?;
    drop(stdin);
    Ok(())
}

fn validate_envelope_id(
    envelope: &DispatcherEnvelope,
    request_id: &str,
) -> Result<(), AppError> {
    if envelope.id.as_deref() != Some(request_id) {
        return Err(AppError::BL {
            msg: "AI agent dispatcher response ID mismatch".to_string(),
        });
    }
    Ok(())
}

fn terminal_response(
    envelope: DispatcherEnvelope,
) -> Result<DispatcherResponse, AppError> {
    if !envelope.ok {
        let detail = envelope
            .error
            .as_deref()
            .map(str::trim)
            .filter(|detail| !detail.is_empty())
            .unwrap_or("operation rejected");
        return Err(AppError::BL {
            msg: format!(
                "AI agent dispatcher: {}",
                access::truncate(detail, AI_AGENT_ERROR_MAX_CHARS)
            ),
        });
    }
    Ok(DispatcherResponse {
        result: envelope.result.unwrap_or(Value::Object(Map::new())),
        events: Vec::new(),
    })
}

fn required(value: Option<&str>, name: &str) -> Result<String, AppError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::ServiceUnavailable {
            msg: format!("{name} is not configured"),
            retry_after_secs: 30,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_flattened_and_does_not_send_namespace() {
        let request = dispatcher_request(
            "request-1",
            "start",
            Some(
                Uuid::parse_str("019fc7f7-9770-7f83-9c1a-211af29b02e6")
                    .unwrap(),
            ),
            serde_json::json!({"timeout_seconds": 30}),
        )
        .unwrap();
        let request: Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(request["id"], "request-1");
        assert_eq!(request["operation"], "start");
        assert_eq!(request["timeout_seconds"], 30);
        assert!(request.get("namespace").is_none());
    }

    #[test]
    fn namespace_is_locally_validated() {
        assert!(valid_namespace("echo-staging"));
        assert!(!valid_namespace("echo.example.com"));
    }

    #[test]
    fn ssh_user_is_locally_validated() {
        assert!(valid_ssh_user("echo-ai-agent-staging"));
        assert!(valid_ssh_user("echo-ai-agent-923dcf98a17e56bc"));
        assert!(!valid_ssh_user("root@example.com"));
        assert!(!valid_ssh_user("Echo Agent"));
    }

    #[test]
    fn terminal_response_includes_dispatcher_error() {
        let err = terminal_response(DispatcherEnvelope {
            id: Some("request-1".to_string()),
            ok: false,
            done: true,
            event: None,
            result: None,
            error: Some("agent runner failed".to_string()),
        })
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Business-logic error: AI agent dispatcher: agent runner failed"
        );
    }
}
