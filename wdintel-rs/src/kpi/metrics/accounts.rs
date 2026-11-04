use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use opentelemetry::KeyValue;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QuerySelect, RelationTrait,
};

use super::export::Snapshot;
use crate::config::*;
use crate::entities::{
    login, organism, sea_orm_active_enums::DeactivationReasonEnum,
};
use crate::h;
use crate::types::{Env, ShortContext};

#[derive(FromQueryResult)]
struct Account {
    deleted: bool,
    deactivation_reason: Option<DeactivationReasonEnum>,
    organism_enabled: Option<bool>,
    last_active_at: Option<NaiveDateTime>,
    roles: serde_json::Value,
    organism_id: Option<i64>,
    sigint_zone_id: Option<i64>,
}

impl Account {
    fn status(&self) -> &'static str {
        if self.deleted {
            match self.deactivation_reason {
                Some(DeactivationReasonEnum::Admin) => "admin",
                Some(DeactivationReasonEnum::Inactive) => "inactive",
                None => "unknown",
            }
        } else if self.organism_enabled == Some(false) {
            "organism"
        } else {
            "active"
        }
    }

    fn recency(&self, until: DateTime<Utc>) -> &'static str {
        let Some(last_active_at) = self
            .last_active_at
            .map(|date| date.and_utc().timestamp_millis())
        else {
            return "missing";
        };
        let age = until.timestamp_millis() - last_active_at;
        if age < 0 || last_active_at < 0 {
            "invalid"
        } else if age
            < Duration::days(KPI_METRICS_RECENT_DAYS).num_milliseconds()
        {
            "recent"
        } else if age
            <= Duration::days(KPI_METRICS_STALE_DAYS).num_milliseconds()
        {
            "aging"
        } else {
            "stale"
        }
    }
}

pub(super) async fn collect(env: &Env) -> anyhow::Result<Option<Snapshot>> {
    let transaction = super::super::read_transaction(env).await.c(h!())?;
    let accounts = login::Entity::find()
        .join(JoinType::LeftJoin, login::Relation::Organism.def())
        .filter(
            Condition::any()
                .add(organism::Column::DeletedPermanently.eq(false))
                .add(login::Column::OrganismId.is_null()),
        )
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(crate::ai_agent::unmanaged_login_condition())
        .select_only()
        .columns([
            login::Column::Deleted,
            login::Column::DeactivationReason,
            login::Column::LastActiveAt,
            login::Column::Roles,
            login::Column::OrganismId,
            login::Column::SigintZoneId,
        ])
        .column_as(organism::Column::Enabled, "organism_enabled")
        .into_model::<Account>()
        .all(&transaction)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    snapshot(accounts, Utc::now()).map(Some).c(h!())
}

fn snapshot(
    accounts: Vec<Account>,
    until: DateTime<Utc>,
) -> anyhow::Result<Snapshot> {
    let mut snapshot = Snapshot::default();
    snapshot.record(KPI_METRICS_ACCOUNTS, accounts.len() as f64, &[]);
    let mut statuses = BTreeMap::from([
        ("active", 0),
        ("admin", 0),
        ("inactive", 0),
        ("organism", 0),
        ("unknown", 0),
    ]);
    let mut recencies = BTreeMap::new();
    for scope in ["active", "blocked"] {
        for recency in ["recent", "aging", "stale", "missing", "invalid"] {
            recencies.insert((scope, recency), 0);
        }
    }
    let mut groups = BTreeMap::new();
    for account in accounts {
        let status = account.status();
        *statuses.entry(status).or_default() += 1;
        let scope = if status == "active" {
            "active"
        } else {
            "blocked"
        };
        *recencies
            .entry((scope, account.recency(until)))
            .or_default() += 1;
        group_account(&mut groups, account).c(h!())?;
    }
    for (status, count) in statuses {
        snapshot.record(
            KPI_METRICS_ACCOUNT_STATUS,
            f64::from(count),
            &[KeyValue::new("status", status)],
        );
    }
    for ((scope, recency), count) in recencies {
        snapshot.record(
            KPI_METRICS_ACCOUNT_RECENCY,
            f64::from(count),
            &[
                KeyValue::new("scope", scope),
                KeyValue::new("recency", recency),
            ],
        );
    }
    for ((name, label, value), count) in groups {
        snapshot.record(name, f64::from(count), &[KeyValue::new(label, value)]);
    }
    Ok(snapshot)
}

type Groups = BTreeMap<(&'static str, &'static str, String), i32>;

fn group_account(groups: &mut Groups, account: Account) -> anyhow::Result<()> {
    let mut roles: BTreeSet<String> =
        serde_json::from_value(account.roles).c(h!())?;
    if roles.is_empty() {
        roles.insert("missing".into());
    }
    for role in roles {
        *groups
            .entry((KPI_METRICS_ACCOUNT_ROLE, "role", role))
            .or_default() += 1;
    }
    for (name, label, id) in [
        (
            KPI_METRICS_ACCOUNT_ORGANISM,
            "organism_id",
            account.organism_id,
        ),
        (
            KPI_METRICS_ACCOUNT_DIRECTION,
            "direction_id",
            account.sigint_zone_id,
        ),
    ] {
        let id = id.map_or_else(|| "missing".into(), |id| id.to_string());
        *groups.entry((name, label, id)).or_default() += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use sea_orm::{ConnectionTrait, DatabaseBackend, Set, Statement};

    // https://github.com/echoua/echo/issues/3826
    #[test]
    fn recency_preserves_millisecond_precision_at_age_boundaries() {
        let until =
            DateTime::from_timestamp_millis(Utc::now().timestamp_millis())
                .unwrap()
                + Duration::microseconds(750);
        for (days, microseconds) in [(30, 100), (90, -250)] {
            let account = Account {
                deleted: false,
                deactivation_reason: None,
                organism_enabled: None,
                last_active_at: Some(
                    (until - Duration::days(days)
                        + Duration::microseconds(microseconds))
                    .naive_utc(),
                ),
                roles: serde_json::json!([]),
                organism_id: None,
                sigint_zone_id: None,
            };
            assert_eq!(account.recency(until), "aging");
        }
    }

    // https://github.com/echoua/echo/issues/3826
    #[tokio::test]
    async fn snapshots_preserve_admin_account_scope_and_replace_role_groups(
    ) -> anyhow::Result<()> {
        let (env, _guard) = cleanup_locked().await.c(h!())?;
        let until = Utc::now();
        let (metrics, recorder) =
            crate::telemetry::Metrics::recording(&env.config);
        metrics.kpi.publish(
            "accounts",
            "current",
            until.timestamp_millis(),
            collect(&env).await,
        );
        metrics.force_flush_for_test();
        let baseline =
            recorder.gauge_f64_value(KPI_METRICS_ACCOUNTS, &[]).unwrap();
        let baseline_recencies: BTreeMap<_, _> = ["active", "blocked"]
            .into_iter()
            .map(|scope| {
                (
                    scope,
                    recorder
                        .gauge_f64_value(
                            KPI_METRICS_ACCOUNT_RECENCY,
                            &[("scope", scope), ("recency", "stale")],
                        )
                        .unwrap(),
                )
            })
            .collect();
        let baseline_aging = recorder
            .gauge_f64_value(
                KPI_METRICS_ACCOUNT_RECENCY,
                &[("scope", "active"), ("recency", "aging")],
            )
            .unwrap();
        seed_accounts(&env, until).await.c(h!())?;
        metrics.kpi.publish(
            "accounts",
            "current",
            until.timestamp_millis(),
            collect(&env).await,
        );
        metrics.force_flush_for_test();
        assert_eq!(
            recorder.gauge_f64_value(KPI_METRICS_ACCOUNTS, &[]),
            Some(baseline + 6.0)
        );
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_ACCOUNT_ROLE,
                &[("role", "kpi-metrics")]
            ),
            Some(4.0)
        );
        for scope in ["active", "blocked"] {
            let expected = baseline_recencies[scope]
                + if scope == "active" { 1.0 } else { 3.0 };
            assert_eq!(
                recorder.gauge_f64_value(
                    KPI_METRICS_ACCOUNT_RECENCY,
                    &[("scope", scope), ("recency", "stale")]
                ),
                Some(expected)
            );
        }
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_ACCOUNT_RECENCY,
                &[("scope", "active"), ("recency", "aging")]
            ),
            Some(baseline_aging + 2.0)
        );
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "update login set roles = $1 where roles @> $2",
                [
                    serde_json::json!(["kpi-new-role"]).into(),
                    serde_json::json!(["kpi-metrics"]).into(),
                ],
            ))
            .await
            .c(h!())?;
        metrics.kpi.publish(
            "accounts",
            "current",
            until.timestamp_millis(),
            collect(&env).await,
        );
        metrics.force_flush_for_test();
        assert!(recorder
            .gauge_f64_value(
                KPI_METRICS_ACCOUNT_ROLE,
                &[("role", "kpi-metrics")]
            )
            .is_none());
        assert_eq!(
            recorder.gauge_f64_value(
                KPI_METRICS_ACCOUNT_ROLE,
                &[("role", "kpi-new-role")]
            ),
            Some(4.0)
        );
        Ok(())
    }

    async fn seed_accounts(
        env: &Env,
        until: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        for (deleted, permanent, reason, enabled, organism_permanent) in [
            (
                true,
                false,
                Some(DeactivationReasonEnum::Admin),
                false,
                false,
            ),
            (
                true,
                false,
                Some(DeactivationReasonEnum::Inactive),
                true,
                false,
            ),
            (false, false, None, false, false),
            (false, false, None, true, false),
            (false, true, None, true, false),
            (false, false, None, true, true),
        ] {
            let organism = mk_organism(
                &env.dbx,
                organism::ActiveModel {
                    enabled: Set(enabled),
                    deleted_permanently: Set(organism_permanent),
                    ..Default::default()
                },
            )
            .await
            .c(h!())?;
            mk_login(
                &env.dbx,
                login::ActiveModel {
                    organism_id: Set(Some(organism.id)),
                    deleted: Set(deleted),
                    deleted_permanently: Set(permanent),
                    deactivation_reason: Set(reason),
                    roles: Set(serde_json::json!([
                        "kpi-metrics",
                        "kpi-metrics"
                    ])),
                    last_active_at: Set(Some(
                        (until - Duration::days(91)).naive_utc(),
                    )),
                    ..Default::default()
                },
            )
            .await
            .c(h!())?;
        }
        mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(AI_AGENT_TEMPLATE_LOGIN_NAME.into()),
                roles: Set(serde_json::json!(["kpi-metrics"])),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        for days in [31, 89] {
            mk_login(
                &env.dbx,
                login::ActiveModel {
                    roles: Set(serde_json::json!([])),
                    last_active_at: Set(Some(
                        (until - Duration::days(days)).naive_utc(),
                    )),
                    ..Default::default()
                },
            )
            .await
            .c(h!())?;
        }
        Ok(())
    }
}
