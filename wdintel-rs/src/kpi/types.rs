use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiPeriod {
    pub since: i64,
    pub until: i64,
}

#[derive(Clone, Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiCount {
    pub id: String,
    pub label: String,
    pub count: i64,
}

#[derive(Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiDuration {
    pub samples: i64,
    pub excluded: i64,
    pub median_seconds: Option<f64>,
    pub p90_seconds: Option<f64>,
}

#[derive(Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiReportsRsp {
    pub period: KpiPeriod,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub by_kind: Vec<KpiCount>,
    pub by_author: Vec<KpiCount>,
    pub by_day: Vec<KpiCount>,
    pub generation: KpiDuration,
}

#[derive(Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiNotificationsRsp {
    pub period: KpiPeriod,
    pub total: i64,
    pub by_status: Vec<KpiCount>,
    pub transport: KpiDuration,
}

#[derive(Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiActivityRsp {
    pub period: KpiPeriod,
    pub available: bool,
    pub reason: Option<String>,
    pub observed_from: Option<String>,
    pub observed_until: Option<String>,
    pub accounts: Option<i64>,
    pub by_day: Vec<KpiCount>,
    pub by_page: Vec<KpiCount>,
    pub queue_enqueued: i64,
    pub queue_dropped: i64,
    pub unmapped_account_groups: i64,
}

#[derive(Deserialize, Elm, ElmDecode, ElmEncode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiRequestsRsp {
    pub period: KpiPeriod,
    pub available: bool,
    pub reason: Option<String>,
    pub total: Option<i64>,
    pub server_errors: Option<i64>,
    pub client_errors: Option<i64>,
    pub by_status: Vec<KpiCount>,
}
