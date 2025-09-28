use crate::entities::*;
use crate::types::*;
use sea_orm::*;

const CHECK_INTERVAL_SECS: u64 = 5 * 60; // 5 minutes

pub async fn aor_assignments_check_worker(dbx: &DatabaseConnection) {
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("aor_assignments_worker");
        if let Err(e) = aor_assignments_check_once(dbx).await {
            error!("aor_assignments_check_worker error: {e:?}");
        }
        tokio::time::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS))
            .await;
    }
}

pub async fn aor_assignments_check_once(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    check_signal_groups(dbx).await.c(h!())?;
    check_networks(dbx).await.c(h!())?;
    Ok(())
}

async fn check_signal_groups(dbx: &DatabaseConnection) -> anyhow::Result<()> {
    // Build counts for all group master_keys that have AoR rows
    let mut counts: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    let group_aors = signal_group_aor::Entity::find().all(dbx).await.c(h!())?;
    for ga in group_aors {
        *counts.entry(ga.master_key.clone()).or_insert(0) += 1;
    }

    // Iterate all groups and validate exactly 1 AoR per group
    let groups = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    for g in groups {
        let cnt = counts.get(&g.master_key).cloned().unwrap_or(0);
        if cnt == 0 {
            error!(
                "[AOR Check] signal_group master_key={} name={:?} has zero AORs assigned (expected at least 1)",
                g.master_key, g.name
            );
        }
    }
    Ok(())
}

async fn check_networks(dbx: &DatabaseConnection) -> anyhow::Result<()> {
    // Build counts map for networks that have AoR rows
    let mut counts: std::collections::HashMap<i64, i64> =
        std::collections::HashMap::new();
    let net_aors = sigint_network_aor::Entity::find().all(dbx).await.c(h!())?;
    for na in net_aors {
        *counts.entry(na.network_id).or_insert(0) += 1;
    }

    // Consider only non-deleted networks
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    for n in networks {
        let cnt = counts.get(&n.id).cloned().unwrap_or(0);
        if cnt == 0 {
            error!(
                "[AORCheck] network id={} name={} has zero AORs assigned (expected at least 1)",
                n.id, n.name
            );
        }
    }
    Ok(())
}
