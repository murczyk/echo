use crate::config::SIGINT_NETWORK_ACTIVITY_DECISION_LIST_LIMIT;
use crate::entities::{sigint_activity_decision_changelog, sigint_network};
use crate::error::AppError;
use crate::types::*;
use crate::users::{has_any_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::Json;
use chrono::NaiveDateTime;
use sea_orm::*;

#[derive(Clone, Copy)]
pub(super) struct ActivityDecisionActor {
    kind: &'static str,
    login_id: Option<Uuid>,
    worker_name: Option<&'static str>,
}

impl ActivityDecisionActor {
    pub(super) fn user(login_id: Uuid) -> Self {
        Self {
            kind: "user",
            login_id: Some(login_id),
            worker_name: None,
        }
    }

    pub(super) fn worker(worker_name: &'static str) -> Self {
        Self {
            kind: "worker",
            login_id: None,
            worker_name: Some(worker_name),
        }
    }
}

pub(super) enum ActivityDecisionTarget<'a> {
    Network {
        network_id: i64,
    },
    Frequency {
        network_id: i64,
        network_freq_id: i64,
        freq: &'a str,
    },
}

#[derive(Clone, Copy)]
pub(super) struct ActivityState {
    active_from: Option<NaiveDateTime>,
    active_to: Option<NaiveDateTime>,
}

impl ActivityState {
    pub(super) fn network(network: &sigint_network::Model) -> Self {
        Self {
            active_from: network.active_from,
            active_to: network.active_to,
        }
    }

    pub(super) fn frequency(
        network_freq: &crate::entities::sigint_network_freq::Model,
    ) -> Self {
        Self {
            active_from: Some(network_freq.active_from),
            active_to: network_freq.active_to,
        }
    }
}

#[derive(Default)]
pub(super) struct ActivityDecisionEvidence {
    pub(super) lookback_since: Option<NaiveDateTime>,
    pub(super) lookback_till: Option<NaiveDateTime>,
    pub(super) interception_count: Option<i64>,
    pub(super) threshold_count: Option<i64>,
    pub(super) last_interception_at: Option<NaiveDateTime>,
    pub(super) metadata: Option<serde_json::Value>,
}

pub(super) async fn record_activity_decision_if_changed<'a, 'async_trait, C>(
    dbx: &'a C,
    target: ActivityDecisionTarget<'_>,
    actor: ActivityDecisionActor,
    reason: &str,
    old_state: ActivityState,
    new_state: ActivityState,
    evidence: ActivityDecisionEvidence,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if old_state.active_to.is_none() == new_state.active_to.is_none() {
        return Ok(false);
    }

    let (target_kind, network_id, network_freq_id, freq) = match target {
        ActivityDecisionTarget::Network { network_id } => {
            ("network", network_id, None, None)
        }
        ActivityDecisionTarget::Frequency {
            network_id,
            network_freq_id,
            freq,
        } => (
            "frequency",
            network_id,
            Some(network_freq_id),
            Some(freq.to_string()),
        ),
    };
    let decision = if new_state.active_to.is_none() {
        "activate"
    } else {
        "deactivate"
    };

    sigint_activity_decision_changelog::ActiveModel {
        id: NotSet,
        target_kind: Set(target_kind.to_string()),
        network_id: Set(network_id),
        network_freq_id: Set(network_freq_id),
        freq: Set(freq),
        decision: Set(decision.to_string()),
        actor_kind: Set(actor.kind.to_string()),
        actor_login_id: Set(actor.login_id),
        worker_name: Set(actor.worker_name.map(str::to_string)),
        reason: Set(reason.to_string()),
        old_active_from: Set(old_state.active_from),
        old_active_to: Set(old_state.active_to),
        new_active_from: Set(new_state.active_from),
        new_active_to: Set(new_state.active_to),
        lookback_since: Set(evidence.lookback_since),
        lookback_till: Set(evidence.lookback_till),
        interception_count: Set(evidence.interception_count),
        threshold_count: Set(evidence.threshold_count),
        last_interception_at: Set(evidence.last_interception_at),
        metadata: Set(evidence.metadata),
        created_at: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?;

    Ok(true)
}

#[derive(Debug, Deserialize)]
pub struct NetworkActivityDecisionsReq {
    pub network_id: i64,
}

#[derive(Debug, Serialize)]
pub struct NetworkActivityDecision {
    pub id: i64,
    pub decision: String,
    pub actor_kind: String,
    pub actor_login_id: Option<Uuid>,
    pub worker_name: Option<String>,
    pub reason: String,
    pub old_active_from: Option<i64>,
    pub old_active_to: Option<i64>,
    pub new_active_from: Option<i64>,
    pub new_active_to: Option<i64>,
    pub lookback_since: Option<i64>,
    pub lookback_till: Option<i64>,
    pub interception_count: Option<i64>,
    pub threshold_count: Option<i64>,
    pub last_interception_at: Option<i64>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct NetworkFrequencyActivityDecisions {
    pub network_freq_id: i64,
    pub freq: String,
    pub decisions: Vec<NetworkActivityDecision>,
}

#[derive(Debug, Serialize)]
pub struct NetworkActivityDecisionsRsp {
    pub network_decisions: Vec<NetworkActivityDecision>,
    pub frequency_decisions: Vec<NetworkFrequencyActivityDecisions>,
}

#[post("/api/sigint/network/activity-decisions")]
pub async fn list_network_activity_decisions(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkActivityDecisionsReq>,
) -> Result<Json<NetworkActivityDecisionsRsp>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user).context(h!())?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await
    .c(h!())?;

    let decisions = sigint_activity_decision_changelog::Entity::find()
        .filter(
            sigint_activity_decision_changelog::Column::NetworkId
                .eq(req.network_id),
        )
        .order_by_desc(sigint_activity_decision_changelog::Column::CreatedAt)
        .order_by_desc(sigint_activity_decision_changelog::Column::Id)
        .limit(SIGINT_NETWORK_ACTIVITY_DECISION_LIST_LIMIT)
        .all(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(group_activity_decisions(decisions)))
}

fn group_activity_decisions(
    decisions: Vec<sigint_activity_decision_changelog::Model>,
) -> NetworkActivityDecisionsRsp {
    let mut network_decisions = Vec::new();
    let mut frequency_decisions = BTreeMap::new();

    for decision in decisions {
        let network_freq_id = decision.network_freq_id;
        let freq = decision.freq.clone();
        let decision = map_activity_decision(decision);
        if let (Some(network_freq_id), Some(freq)) = (network_freq_id, freq) {
            frequency_decisions
                .entry((network_freq_id, freq))
                .or_insert_with(Vec::new)
                .push(decision);
        } else {
            network_decisions.push(decision);
        }
    }

    NetworkActivityDecisionsRsp {
        network_decisions,
        frequency_decisions: frequency_decisions
            .into_iter()
            .map(|((network_freq_id, freq), decisions)| {
                NetworkFrequencyActivityDecisions {
                    network_freq_id,
                    freq,
                    decisions,
                }
            })
            .collect(),
    }
}

fn map_activity_decision(
    decision: sigint_activity_decision_changelog::Model,
) -> NetworkActivityDecision {
    NetworkActivityDecision {
        id: decision.id,
        decision: decision.decision,
        actor_kind: decision.actor_kind,
        actor_login_id: decision.actor_login_id,
        worker_name: decision.worker_name,
        reason: decision.reason,
        old_active_from: timestamp_millis(decision.old_active_from),
        old_active_to: timestamp_millis(decision.old_active_to),
        new_active_from: timestamp_millis(decision.new_active_from),
        new_active_to: timestamp_millis(decision.new_active_to),
        lookback_since: timestamp_millis(decision.lookback_since),
        lookback_till: timestamp_millis(decision.lookback_till),
        interception_count: decision.interception_count,
        threshold_count: decision.threshold_count,
        last_interception_at: timestamp_millis(decision.last_interception_at),
        metadata: decision.metadata,
        created_at: decision.created_at.and_utc().timestamp_millis(),
    }
}

fn timestamp_millis(timestamp: Option<NaiveDateTime>) -> Option<i64> {
    timestamp.map(|timestamp| timestamp.and_utc().timestamp_millis())
}
