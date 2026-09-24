use super::types::{
    UnitActivityBucket, UnitActivityPeriod, UnitActivityReq, UnitActivityRsp,
};
use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::NaiveDateTime;
use sea_orm::{
    ColumnTrait, DbBackend, EntityTrait, FromQueryResult, QueryFilter,
    Statement,
};

#[derive(FromQueryResult)]
struct UnitActivityRow {
    started_at: NaiveDateTime,
    interception_count: i64,
}

#[post("/api/admin/sigint/unit/activity")]
pub async fn unit_activity(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UnitActivityReq>,
) -> Result<Json<UnitActivityRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    sigint_unit::Entity::find_by_id(req.unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;

    Ok(Json(load_unit_activity(&env.dbx, &req).await.c(h!())?))
}

async fn load_unit_activity(
    dbx: &sea_orm::DatabaseConnection,
    req: &UnitActivityReq,
) -> anyhow::Result<UnitActivityRsp> {
    let (first_bucket, last_bucket, bucket_size) = match req.period {
        UnitActivityPeriod::Day => (
            "date_trunc('hour', now() at time zone 'utc') - interval '23 hours'",
            "date_trunc('hour', now() at time zone 'utc')",
            "1 hour",
        ),
        UnitActivityPeriod::Week => (
            "date_trunc('day', now() at time zone 'utc') - interval '6 days'",
            "date_trunc('day', now() at time zone 'utc')",
            "1 day",
        ),
        UnitActivityPeriod::Month => (
            "date_trunc('day', now() at time zone 'utc') - interval '29 days'",
            "date_trunc('day', now() at time zone 'utc')",
            "1 day",
        ),
        UnitActivityPeriod::ThreeMonths => (
            "date_trunc('week', now() at time zone 'utc') - interval '12 weeks'",
            "date_trunc('week', now() at time zone 'utc')",
            "1 week",
        ),
    };
    let sql = format!(
        r#"
select bucket.started_at,
       count(distinct link.item_id)::bigint as interception_count
from generate_series(
    {first_bucket},
    {last_bucket},
    interval '{bucket_size}'
) as bucket(started_at)
left join sigint_inbox_item_unit link
    on link.unit_id = $1
    and link.created_at >= {first_bucket}
    and link.created_at < {last_bucket} + interval '{bucket_size}'
    and link.created_at >= bucket.started_at
    and link.created_at < bucket.started_at + interval '{bucket_size}'
group by bucket.started_at
order by bucket.started_at
        "#
    );
    let rows =
        UnitActivityRow::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [req.unit_id.into()],
        ))
        .all(dbx)
        .await
        .c(h!())?;

    Ok(UnitActivityRsp {
        buckets: rows
            .into_iter()
            .map(|row| UnitActivityBucket {
                started_at: row.started_at.and_utc().timestamp_millis(),
                interception_count: row.interception_count,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        sea_orm_active_enums::SigintInboxItemUnitKind, sigint_inbox_item_unit,
        sigint_unit,
    };
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_sigint_unit,
    };
    use chrono::{Duration, Utc};
    use sea_orm::{ActiveModelTrait, Set};
    use serial_test::serial;

    async fn link_item(
        dbx: &sea_orm::DatabaseConnection,
        item_id: i64,
        unit_id: i64,
        kind: SigintInboxItemUnitKind,
        created_at: NaiveDateTime,
    ) {
        sigint_inbox_item_unit::ActiveModel {
            item_id: Set(item_id),
            unit_id: Set(unit_id),
            kind: Set(kind),
            created_at: Set(created_at),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn activity_counts_distinct_recent_interceptions_for_the_unit() {
        let env = cleanup().await.unwrap();
        let unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let other_unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let first = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let second = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let old = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let other = mk_sigint_inbox_item(&env.dbx, Default::default())
            .await
            .unwrap();
        let recent = Utc::now().naive_utc() - Duration::minutes(5);
        link_item(
            &env.dbx,
            first.id,
            unit.id,
            SigintInboxItemUnitKind::Parsed,
            recent,
        )
        .await;
        link_item(
            &env.dbx,
            first.id,
            unit.id,
            SigintInboxItemUnitKind::Network,
            recent,
        )
        .await;
        link_item(
            &env.dbx,
            second.id,
            unit.id,
            SigintInboxItemUnitKind::Parsed,
            recent,
        )
        .await;
        link_item(
            &env.dbx,
            old.id,
            unit.id,
            SigintInboxItemUnitKind::Parsed,
            Utc::now().naive_utc() - Duration::days(2),
        )
        .await;
        link_item(
            &env.dbx,
            other.id,
            other_unit.id,
            SigintInboxItemUnitKind::Parsed,
            recent,
        )
        .await;

        let activity = load_unit_activity(
            &env.dbx,
            &UnitActivityReq {
                unit_id: unit.id,
                period: UnitActivityPeriod::Day,
            },
        )
        .await
        .unwrap();

        assert_eq!(activity.buckets.len(), 24);
        assert_eq!(
            activity
                .buckets
                .iter()
                .map(|bucket| bucket.interception_count)
                .sum::<i64>(),
            2
        );
    }
}
