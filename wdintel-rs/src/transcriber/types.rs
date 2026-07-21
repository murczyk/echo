use crate::types::{Deserialize, Serialize, Uuid};

#[derive(Debug, Serialize)]
pub struct InstanceRsp {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub is_active: bool,
    pub rs_port: i32,
    pub py_port: i32,
    pub created_at: i64,
    pub ordering: i32,
}

impl From<echo_gpu_client::Instance> for InstanceRsp {
    fn from(instance: echo_gpu_client::Instance) -> Self {
        Self {
            id: instance.id,
            name: instance.name,
            host: instance.host,
            is_active: instance.is_active,
            rs_port: instance.rs_port,
            py_port: instance.py_port,
            created_at: instance.created_at.and_utc().timestamp_millis(),
            ordering: instance.ordering,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateInstanceReq {
    pub name: String,
    pub host: String,
    pub rs_port: i32,
    pub py_port: i32,
    pub ordering: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateInstanceReq {
    pub id: Uuid,
    pub name: Option<String>,
    pub host: Option<String>,
    pub is_active: Option<bool>,
    pub rs_port: Option<i32>,
    pub py_port: Option<i32>,
    pub ordering: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct InstanceIdReq {
    pub id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestartStatus {
    Requested,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct InstanceMutationRsp {
    pub instance: Option<InstanceRsp>,
    pub deleted: bool,
    pub restart_status: RestartStatus,
    pub restart_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HealthProbeRsp {
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

impl From<echo_gpu_client::HealthProbe> for HealthProbeRsp {
    fn from(probe: echo_gpu_client::HealthProbe) -> Self {
        Self {
            ok: probe.ok,
            status: probe.status,
            error: probe.error,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InstanceHealthRsp {
    pub rust: HealthProbeRsp,
    pub python: HealthProbeRsp,
}

impl From<echo_gpu_client::InstanceHealth> for InstanceHealthRsp {
    fn from(health: echo_gpu_client::InstanceHealth) -> Self {
        Self {
            rust: health.rust.into(),
            python: health.python.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct QueueStatusRsp {
    pub queued: u64,
    pub processing: u64,
    pub retrying: u64,
    pub completed: u64,
    pub terminal: u64,
    pub oldest_due_age_seconds: Option<i64>,
}

impl From<echo_gpu_client::QueueStatus> for QueueStatusRsp {
    fn from(status: echo_gpu_client::QueueStatus) -> Self {
        Self {
            queued: status.queued,
            processing: status.processing,
            retrying: status.retrying,
            completed: status.completed,
            terminal: status.terminal,
            oldest_due_age_seconds: status.oldest_due_at.map(|value| {
                (chrono::Utc::now().naive_utc() - value)
                    .num_seconds()
                    .max(0)
            }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct MessageTranscriptionRsp {
    pub media_id: Uuid,
    pub text: String,
}
