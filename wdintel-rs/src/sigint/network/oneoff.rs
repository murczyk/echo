use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::sigint::network::bl::*;
use crate::sigint::network::merge::*;
use crate::types::*;
use chrono::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};

const MERGE_NETWORKS_API_LOGIN: &str = "merge_networks_api";

pub async fn oneoff_merge_all_possible_networks(
    mode: Mode,
) -> anyhow::Result<(), AppError> {
    info!("> merge_all_possible_networks start");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;

    // Fetch all active networks (deleted = false) with their unit_id
    let networks_list = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .columns([sigint_network::Column::Id, sigint_network::Column::Name])
        .column(sigint_network_unit::Column::UnitId)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_network::Column::Id)
        .into_tuple::<(i64, String, i64)>()
        .all(&txn)
        .await
        .context(h!())?;

    // Group networks by (name, unit_id)
    let mut grouped_networks: HashMap<(String, i64), Vec<i64>> = HashMap::new();
    for (id, name, unit_id) in networks_list {
        grouped_networks
            .entry((name, unit_id))
            .or_default()
            .push(id);
    }

    // Keep track of merged networks to avoid duplicate merges
    let mut merged = HashSet::new();

    println!("Starting network merging process...");
    for ((name, unit_id), network_ids) in grouped_networks {
        let mut iter = network_ids.into_iter();
        if let Some(primary_id) = iter.next() {
            for secondary_id in iter {
                if !merged.contains(&secondary_id) {
                    println!(
                        "Merging network {secondary_id} into network {primary_id} (Name: '{name}', Unit ID: {unit_id})"
                    );

                    // Merge networks
                    if let Err(e) = merge_two_networks(
                        &txn,
                        MERGE_NETWORKS_API_LOGIN,
                        true,
                        false,
                        secondary_id,
                        primary_id,
                    )
                    .await
                    {
                        eprintln!(
                            "❌ Failed to merge network {secondary_id} into {primary_id}: {e}"
                        );
                    }

                    println!(
                        "✅ Successfully merged network {secondary_id} into {primary_id}"
                    );

                    // Mark secondary_id as merged
                    merged.insert(secondary_id);
                }
            }
        }
    }

    println!("Network merging process completed.");
    txn.commit().await.context(h!())?;
    Ok(())
}

pub async fn oneoff_merge_two_networks(
    mode: Mode,
    ps: &crate::OneoffMergeNetworksPs,
) -> anyhow::Result<(), AppError> {
    debug!("oneoff_merge_networks");

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;
    let config = crate::config::read_config(mode).context(h!())?;
    let mut redis = crate::new_redis(&config).await.context(h!())?;

    match merge_two_networks(
        &txn,
        MERGE_NETWORKS_API_LOGIN,
        true,
        false,
        ps.network_id_from,
        ps.network_id_to,
    )
    .await
    {
        Ok(_) => {
            txn.commit().await.context(h!())?;

            let event = EventMsg::new(EventType::ETNetworkChanged);
            fanout(&mut redis, event).await.context(h!())?;

            info!(
                "✅ Merge successful! Merged network {} into {}",
                ps.network_id_from, ps.network_id_to
            );
        }
        Err(e) => {
            txn.rollback().await.context(h!())?;
            error!("❌ Merge failed: {:?}", e);
        }
    }

    debug!("oneoff_merge_networks completed");
    Ok(())
}

pub async fn oneoff_network_activity_stat(
    mode: Mode,
    ps: &crate::OneoffGetNetworksActivityStatsPs,
) -> anyhow::Result<(), AppError> {
    debug!("oneoff_network_activity_stat");
    let start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S")
            .context(h!())?;

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&dbx, &ps.login)
            .await
            .context(h!())?;

    let freqs_count =
        bl_get_network_active_freqs_count(&dbx, &groups, start_dt, end_dt)
            .await
            .context(h!())?;

    let callsigns_count =
        bl_get_network_active_callsigns_count(&dbx, &groups, start_dt, end_dt)
            .await
            .context(h!())?;

    println!(
        "Інтенсивність роботи радіомереж за період з {start_dt} по {end_dt}"
    );
    println!("-----------------------------------------");
    println!("К-сть виявлених частот:   {freqs_count}");
    println!("К-сть виявлених позивних: {callsigns_count}");

    debug!("oneoff_merge_networks completed");
    Ok(())
}

// ── modulation→encryption data migration ────────────────────────────────────

pub async fn oneoff_migrate_modulation_to_encryption(
    mode: Mode,
    dry_run: bool,
) -> anyhow::Result<(), AppError> {
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let encryption_exists = table_exists(&db, "encryption").await?;
    let modulation_exists = table_exists(&db, "modulation").await?;

    info!(
        "oneoff_migrate_modulation_to_encryption: encryption_exists={encryption_exists} \
         modulation_exists={modulation_exists} dry_run={dry_run}"
    );

    if !encryption_exists {
        return Err(AppError::BL {
            msg: "DDL-міграцію ще не застосовано — таблиця 'encryption' не існує. \
                  Спочатку запустіть міграцію (migrate up)."
                .to_string(),
        });
    }

    let needs_full_migration = freq_migration_pending(&db).await?;

    if needs_full_migration {
        if !modulation_exists {
            return Err(AppError::BL {
                msg: "Таблиця 'modulation' не знайдена — неможливо виконати data-міграцію."
                    .to_string(),
            });
        }

        println!("\n══ Data-міграція modulation → encryption ══════════════════════════════════");

        preflight(&db).await?;
        print_migration_preview(&db).await?;

        println!(
            "── Виконання{} ─────────────────────────────────────────────────────────────",
            if dry_run { " [dry-run, буде відкат]" } else { "" }
        );

        let txn = db.begin().await.c(h!())?;
        run_data_migration(&txn).await?;

        if dry_run {
            txn.rollback().await.c(h!())?;
            println!(
                "✓ Dry-run завершено — всі зміни відкатано, база не змінена."
            );
        } else {
            txn.commit().await.c(h!())?;
            println!(
                "✓ Data-міграцію успішно виконано і підтверджено (COMMIT)."
            );
        }
    } else {
        println!("\n══ Data-fix (немає незмігрованих рядків modulation_id) ════════════════════");
        print_data_fix_preview(&db).await?;

        let txn = db.begin().await.c(h!())?;
        run_enc_data_fix(&txn).await?;

        if dry_run {
            txn.rollback().await.c(h!())?;
            println!("✓ Dry-run завершено — всі зміни відкатано.");
        } else {
            txn.commit().await.c(h!())?;
            println!("✓ Data-fix виконано і підтверджено (COMMIT).");
        }
    }

    Ok(())
}

async fn table_exists(
    db: &DatabaseConnection,
    name: &str,
) -> Result<bool, AppError> {
    Ok(db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "SELECT 1 FROM information_schema.tables \
                 WHERE table_schema='public' AND table_name='{name}' LIMIT 1"
            ),
        ))
        .await
        .c(h!())?
        .is_some())
}

async fn freq_migration_pending(
    db: &DatabaseConnection,
) -> Result<bool, AppError> {
    Ok(db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT 1 FROM sigint_network_freq \
             WHERE encryption_id IS NULL \
             LIMIT 1"
                .to_string(),
        ))
        .await
        .c(h!())?
        .is_some())
}

async fn preflight(db: &DatabaseConnection) -> Result<(), AppError> {
    println!("\n── Preflight перевірки ─────────────────────────────────────────────────────");

    let mut errors: Vec<String> = vec![];
    let mut warnings: Vec<String> = vec![];

    // 1. Orphaned FK in sigint_network_freq
    let orphaned_freq: i64 = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS cnt FROM sigint_network_freq snf \
             WHERE snf.modulation_id IS NOT NULL \
               AND NOT EXISTS (SELECT 1 FROM modulation m WHERE m.id = snf.modulation_id)"
                .to_string(),
        ))
        .await
        .c(h!())?
        .and_then(|r| r.try_get::<i64>("", "cnt").ok())
        .unwrap_or(0);

    if orphaned_freq > 0 {
        errors.push(format!(
            "{orphaned_freq} рядків у sigint_network_freq мають modulation_id без відповідного \
             запису в modulation (orphaned FK) — виправте перед міграцією."
        ));
    }

    // 2. Orphaned FK in sigint_network_encryption_key
    let orphaned_keys: i64 = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS cnt FROM sigint_network_encryption_key k \
             WHERE k.modulation_id IS NOT NULL \
               AND NOT EXISTS (SELECT 1 FROM modulation m WHERE m.id = k.modulation_id)"
                .to_string(),
        ))
        .await
        .c(h!())?
        .and_then(|r| r.try_get::<i64>("", "cnt").ok())
        .unwrap_or(0);

    if orphaned_keys > 0 {
        errors.push(format!(
            "{orphaned_keys} рядків у sigint_network_encryption_key мають modulation_id без \
             відповідного запису в modulation (orphaned FK)."
        ));
    }

    // 3. Unknown modulation names (will fall to 'Не визначено')
    let known = "'NFM','AM','DMR','DMR (ARC40)','DMR (AES256)','HYTERA','HYTERA (256 bit)',\
                 'TYT','TYT (16 bit)','TYT (128 bit)','TETRA','Граніт','GSM','Умовна'";
    let unknown_names: Vec<String> = db
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "SELECT DISTINCT m.name AS name \
                 FROM sigint_network_freq snf \
                 JOIN modulation m ON m.id = snf.modulation_id \
                 WHERE m.name NOT IN ({known}) \
                 ORDER BY m.name"
            ),
        ))
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|r| r.try_get::<String>("", "name").ok())
        .collect();

    if !unknown_names.is_empty() {
        let unknown_cnt: i64 = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                format!(
                    "SELECT COUNT(*) AS cnt \
                     FROM sigint_network_freq snf \
                     JOIN modulation m ON m.id = snf.modulation_id \
                     WHERE m.name NOT IN ({known})"
                ),
            ))
            .await
            .c(h!())?
            .and_then(|r| r.try_get::<i64>("", "cnt").ok())
            .unwrap_or(0);

        warnings.push(format!(
            "{unknown_cnt} рядків мають невідомі назви модуляцій (→ 'Не визначено'): {}",
            unknown_names.join(", ")
        ));
    }

    if errors.is_empty() && warnings.is_empty() {
        println!("  ✓ Всі перевірки пройдено без зауважень.\n");
    } else {
        for w in &warnings {
            println!("  ⚠  [WARNING] {w}");
        }
        for e in &errors {
            println!("  ✗  [ERROR]   {e}");
        }
        println!();
    }

    if !errors.is_empty() {
        return Err(AppError::BL {
            msg: format!(
                "{} критичних помилок preflight — міграцію скасовано.",
                errors.len()
            ),
        });
    }

    Ok(())
}

async fn print_migration_preview(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    println!("── Попередній перегляд змін ────────────────────────────────────────────────");
    println!(
        "  {:<8} {:<22} → {:<6} {:<22} {:>7}",
        "kind", "модуляція (стара)", "мод", "шифрування (нова)", "рядків"
    );
    println!("  {}", "─".repeat(74));

    let rows = db
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            "WITH mapped AS (
                 SELECT
                     snf.kind::text AS kind,
                     COALESCE(m.name, '(null)') AS old_mod,
                     CASE
                         WHEN snf.kind::text = 'VHF'
                              AND (m.name IS NULL OR m.name = 'NFM') THEN 'NFM'
                         WHEN snf.kind::text = 'VHF'
                              AND m.name = 'AM'                      THEN 'AM'
                         ELSE 'DMR'
                     END AS new_mod,
                     CASE
                         WHEN m.name = 'DMR (ARC40)'                             THEN 'ARC40'
                         WHEN m.name IN ('DMR (AES256)', 'HYTERA (256 bit)')     THEN 'AES256'
                         WHEN m.name IN ('TYT', 'TYT (128 bit)')                THEN 'TYT (128 bit)'
                         WHEN m.name = 'TYT (16 bit)'                           THEN 'TYT (16 bit)'
                         WHEN snf.kind::text = 'VHF'
                              AND (m.name IS NULL
                                   OR m.name IN ('NFM', 'AM', 'DMR'))           THEN 'Без шифрування'
                         ELSE 'Не визначено'
                     END AS new_enc
                 FROM sigint_network_freq snf
                 LEFT JOIN modulation m ON m.id = snf.modulation_id
             )
             SELECT kind, old_mod, new_mod, new_enc, COUNT(*) AS cnt
             FROM mapped
             GROUP BY kind, old_mod, new_mod, new_enc
             ORDER BY cnt DESC, kind, old_mod"
                .to_string(),
        ))
        .await
        .c(h!())?;

    let mut total: i64 = 0;
    for row in &rows {
        let kind: String = row.try_get("", "kind").unwrap_or_default();
        let old_mod: String = row.try_get("", "old_mod").unwrap_or_default();
        let new_mod: String = row.try_get("", "new_mod").unwrap_or_default();
        let new_enc: String = row.try_get("", "new_enc").unwrap_or_default();
        let cnt: i64 = row.try_get("", "cnt").unwrap_or(0);
        total += cnt;
        println!(
            "  {:<8} {:<22} → {:<6} {:<22} {:>7}",
            kind, old_mod, new_mod, new_enc, cnt
        );
    }

    println!("  {}", "─".repeat(74));
    println!("  {:>63} {:>7}", "Загалом:", total);
    println!();
    Ok(())
}

async fn print_data_fix_preview(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    let fix_count: i64 = db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "SELECT COUNT(*) AS cnt FROM sigint_network_freq
             WHERE (
                 modulation IN ('NFM', 'AM')
                 AND (
                     encryption_id IS NULL
                     OR encryption_id != (
                         SELECT id FROM encryption WHERE name = 'Без шифрування' LIMIT 1
                     )
                 )
             ) OR (
                 modulation = 'DMR' AND encryption_id IS NULL
             )"
                .to_string(),
        ))
        .await
        .c(h!())?
        .and_then(|r| r.try_get::<i64>("", "cnt").ok())
        .unwrap_or(0);

    println!(
        "  Буде виправлено {fix_count} рядків \
         (NFM/AM -> 'Без шифрування', DMR з NULL encryption_id → 'Не визначено')."
    );
    println!();
    Ok(())
}

async fn run_data_migration(
    txn: &impl ConnectionTrait,
) -> anyhow::Result<(), AppError> {
    info!("Step 1: inserting encryption entries (IDs 1-6)");
    txn.execute_unprepared(
        "INSERT INTO encryption (id, name, enabled, created_at) VALUES
             (1, 'Без шифрування', true, now()),
             (2, 'ARC40',          true, now()),
             (3, 'AES256',         true, now()),
             (4, 'TYT (16 bit)',   true, now()),
             (5, 'TYT (128 bit)', true, now()),
             (6, 'Не визначено',  true, now())
         ON CONFLICT (id) DO NOTHING;",
    )
    .await
    .c(h!())?;

    info!("Step 2: setting modulation text + encryption_id on sigint_network_freq");
    txn.execute_unprepared(
        "WITH freq_mods AS (
             SELECT snf.id, snf.kind::text AS kind, m.name AS old_mod
             FROM sigint_network_freq snf
             LEFT JOIN modulation m ON m.id = snf.modulation_id
         )
         UPDATE sigint_network_freq snf
         SET
             modulation = CASE
                 WHEN fm.kind = 'VHF'
                      AND (fm.old_mod IS NULL OR fm.old_mod = 'NFM') THEN 'NFM'
                 WHEN fm.kind = 'VHF' AND fm.old_mod = 'AM'          THEN 'AM'
                 ELSE 'DMR'
             END,
             encryption_id = (
                 SELECT e.id FROM encryption e
                 WHERE e.name = CASE
                     WHEN fm.old_mod = 'DMR (ARC40)'                              THEN 'ARC40'
                     WHEN fm.old_mod IN ('DMR (AES256)', 'HYTERA (256 bit)')      THEN 'AES256'
                     WHEN fm.old_mod IN ('TYT', 'TYT (128 bit)')                 THEN 'TYT (128 bit)'
                     WHEN fm.old_mod = 'TYT (16 bit)'                            THEN 'TYT (16 bit)'
                     WHEN fm.kind = 'VHF'
                          AND (fm.old_mod IS NULL
                               OR fm.old_mod IN ('NFM', 'AM', 'DMR'))            THEN 'Без шифрування'
                     ELSE 'Не визначено'
                 END
                 LIMIT 1
             )
         FROM freq_mods fm
         WHERE snf.id = fm.id
           AND snf.encryption_id IS NULL;",
    )
    .await
    .c(h!())?;

    info!("Step 3: setting encryption_id on sigint_network_encryption_key");
    txn.execute_unprepared(
        "UPDATE sigint_network_encryption_key k
         SET encryption_id = (
             SELECT e.id FROM encryption e
             WHERE e.name = CASE
                 WHEN m.name = 'DMR (ARC40)'                             THEN 'ARC40'
                 WHEN m.name IN ('DMR (AES256)', 'HYTERA (256 bit)')     THEN 'AES256'
                 WHEN m.name IN ('TYT', 'TYT (128 bit)')                THEN 'TYT (128 bit)'
                 WHEN m.name = 'TYT (16 bit)'                           THEN 'TYT (16 bit)'
                 ELSE 'Не визначено'
             END
             LIMIT 1
         )
         FROM modulation m
         WHERE k.modulation_id = m.id AND k.encryption_id IS NULL;
         UPDATE sigint_network_encryption_key
         SET encryption_id = (SELECT id FROM encryption WHERE name = 'Не визначено' LIMIT 1)
         WHERE modulation_id IS NULL AND encryption_id IS NULL;",
    )
    .await
    .c(h!())?;

    info!("Data migration complete");
    Ok(())
}

async fn run_enc_data_fix(
    txn: &impl ConnectionTrait,
) -> anyhow::Result<(), AppError> {
    txn.execute_unprepared(
        "UPDATE sigint_network_freq
         SET encryption_id = (SELECT id FROM encryption WHERE name = 'Без шифрування' LIMIT 1)
         WHERE modulation IN ('NFM', 'AM')
           AND (
             encryption_id IS NULL
             OR encryption_id != (SELECT id FROM encryption WHERE name = 'Без шифрування' LIMIT 1)
           );
         UPDATE sigint_network_freq
         SET encryption_id = (SELECT id FROM encryption WHERE name = 'Не визначено' LIMIT 1)
         WHERE modulation = 'DMR' AND encryption_id IS NULL;",
    )
    .await
    .c(h!())?;

    info!("Data fix complete");
    Ok(())
}
