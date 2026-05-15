use crate::config::{
    PALITRA_GOI_SYNC_JOB_KIND_DELETE, PALITRA_GOI_SYNC_JOB_KIND_MOVE,
    PALITRA_GOI_SYNC_JOB_KIND_UPLOAD, PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC,
    PALITRA_GOI_SYNC_WORKER_SLEEP_SEC,
};
use crate::entities::*;
use crate::error::AppError;
use crate::organism::goi;
use crate::organism::types::CheckOrganismGoiConnectionReq;
use crate::palitra::types::PalitraAccess;
use crate::types::*;
use sea_orm::prelude::Expr;
use sea_orm::Statement;
use sea_orm::*;
use std::collections::BTreeSet;
use std::time::Duration;

pub async fn palitra_goi_sync_worker_nofail(env: Arc<Env>) {
    loop {
        let no_jobs = match palitra_goi_sync_worker_step(env.as_ref()).await {
            Ok(no_jobs) => no_jobs,
            Err(err) => {
                warn!("palitra_goi_sync_worker failed: {err:#}");
                true
            }
        };
        if no_jobs {
            tokio::time::sleep(Duration::from_secs(
                PALITRA_GOI_SYNC_WORKER_SLEEP_SEC,
            ))
            .await;
        }
    }
}

async fn palitra_goi_sync_worker_step(env: &Env) -> Result<bool, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let Some(job) = take_next_job(&txn).await.c(h!())? else {
        txn.commit().await.c(h!())?;
        return Ok(true);
    };
    txn.commit().await.c(h!())?;

    let result = match job.kind.as_str() {
        PALITRA_GOI_SYNC_JOB_KIND_UPLOAD => sync_upload_job(env, &job).await,
        PALITRA_GOI_SYNC_JOB_KIND_MOVE => sync_move_job(&env.dbx, &job).await,
        PALITRA_GOI_SYNC_JOB_KIND_DELETE => {
            sync_delete_job(&env.dbx, &job).await
        }
        kind => Err(anyhow::anyhow!(
            "unknown palitra GOI sync job kind '{kind}'"
        )
        .context(h!())),
    };

    match result {
        Ok(()) => {
            palitra_goi_sync_job::Entity::delete_many()
                .filter(palitra_goi_sync_job::Column::Id.eq(job.id))
                .filter(
                    palitra_goi_sync_job::Column::LastAttemptAt
                        .eq(job.last_attempt_at),
                )
                .filter(
                    palitra_goi_sync_job::Column::AttemptCount
                        .eq(job.attempt_count),
                )
                .exec(&env.dbx)
                .await
                .c(h!())?;
        }
        Err(err) => {
            palitra_goi_sync_job::Entity::update_many()
                .filter(palitra_goi_sync_job::Column::Id.eq(job.id))
                .filter(
                    palitra_goi_sync_job::Column::LastAttemptAt
                        .eq(job.last_attempt_at),
                )
                .filter(
                    palitra_goi_sync_job::Column::AttemptCount
                        .eq(job.attempt_count),
                )
                .col_expr(
                    palitra_goi_sync_job::Column::LastError,
                    Expr::value(Some(format!("{err:#}"))),
                )
                .exec(&env.dbx)
                .await
                .c(h!())?;
        }
    }

    Ok(false)
}

async fn take_next_job(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Option<palitra_goi_sync_job::Model>> {
    let stmt = Statement::from_string(
        DatabaseBackend::Postgres,
        format!(
            r#"
        with next_job as (
            select id
            from palitra_goi_sync_job
            where last_attempt_at is null
               or last_attempt_at <= now() - interval '{} seconds'
            order by id
            for update skip locked
            limit 1
        )
        update palitra_goi_sync_job
        set
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            last_error = null
        where id in (select id from next_job)
        returning *
        "#,
            PALITRA_GOI_SYNC_JOB_RETRY_DELAY_SEC
        ),
    );
    palitra_goi_sync_job::Model::find_by_statement(stmt)
        .one(txn)
        .await
        .c(h!())
}

async fn sync_upload_job(
    env: &Env,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let geometry =
        super::read_latest_palitra_geometry_with_warning(&env.dbx, palitra.id)
            .await
            .c(h!())?;
    let access = super::read_palitra_access(&env.dbx, palitra.id)
        .await
        .c(h!())?;
    let remote_file_name = super::palitra_goi_remote_file_name(
        palitra.id,
        Some(&palitra.name),
        geometry.source_file_name.as_deref(),
    );
    let target_folder =
        super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
    let file_data = load_upload_file_data(env, job, &palitra).await.c(h!())?;
    upload_palitra_to_connected_organisms_strict(
        &env.dbx,
        &access,
        &remote_file_name,
        target_folder.as_deref(),
        &file_data,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn load_upload_file_data(
    env: &Env,
    job: &palitra_goi_sync_job::Model,
    palitra: &palitra::Model,
) -> anyhow::Result<Vec<u8>> {
    if let Some(file_data) = &job.file_data {
        return Ok(file_data.clone());
    }

    let s3_id = palitra.s3_id.as_deref().c(h!())?;
    let strongbox_key = env
        .config
        .s3_config
        .as_ref()
        .map(|s3_config| s3_config.strongbox_key.as_str())
        .c(h!())?;
    crate::storage::download_and_decrypt_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        strongbox_key,
        s3_id,
    )
    .await
    .map_err(|err| anyhow::anyhow!(err))
    .c(h!())
}

async fn sync_move_job(
    dbx: &DatabaseConnection,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .filter(palitra::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };

    let sync_item = super::bl::PalitraFolderSyncItem {
        palitra_id: palitra.id,
        source_folder: if job.source_folder.is_empty() {
            None
        } else {
            Some(job.source_folder.clone())
        },
    };
    super::sync_move_palitra_files_to_connected_organisms(
        dbx,
        std::slice::from_ref(&sync_item),
    )
    .await
    .c(h!())
}

async fn sync_delete_job(
    dbx: &DatabaseConnection,
    job: &palitra_goi_sync_job::Model,
) -> anyhow::Result<()> {
    let Some(palitra) = palitra::Entity::find_by_id(job.palitra_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let access = super::read_palitra_access(dbx, palitra.id).await.c(h!())?;
    let target_folders = if job.source_folder.is_empty() {
        let target_folder =
            super::bl::normalize_palitra_folder_from_db(palitra.folder.clone());
        if target_folder.is_some() {
            vec![target_folder, None]
        } else {
            vec![None]
        }
    } else {
        vec![super::bl::normalize_palitra_folder_from_db(Some(
            job.source_folder.clone(),
        ))]
    };
    let source_file_names = palitra_geometry::Entity::find()
        .filter(palitra_geometry::Column::PalitraId.eq(palitra.id))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|geometry| geometry.source_file_name)
        .collect::<Vec<_>>();
    delete_palitra_from_connected_organisms_strict(
        dbx,
        palitra.id,
        &palitra.name,
        &access,
        &target_folders,
        &source_file_names,
    )
    .await
    .c(h!())
}

async fn upload_palitra_to_connected_organisms_strict(
    dbx: &DatabaseConnection,
    access: &PalitraAccess,
    remote_file_name: &str,
    target_folder: Option<&str>,
    file_data: &[u8],
) -> anyhow::Result<()> {
    let PalitraAccess::ByOrganisms { organism_ids } = access else {
        return Ok(());
    };
    let goi_targets =
        super::collect_connected_goi_targets(dbx, organism_ids.as_slice())
            .await
            .c(h!())?;
    let mut errors = Vec::new();
    for target in goi_targets {
        let remote_file_path =
            compose_remote_path(&target, target_folder, remote_file_name);
        if let Err(err) = goi::goi_upload_file(
            target.clone(),
            remote_file_path.clone(),
            file_data.to_vec(),
        )
        .await
        {
            errors.push(format!(
                "{}:{} {}: {err:#}",
                target.ssh_host, target.ssh_port, remote_file_path
            ));
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    anyhow::bail!("palitra GOI upload failed: {}", errors.join("; "));
}

async fn delete_palitra_from_connected_organisms_strict(
    dbx: &DatabaseConnection,
    palitra_id: i64,
    palitra_name: &str,
    access: &PalitraAccess,
    target_folders: &[Option<String>],
    source_file_names: &[Option<String>],
) -> anyhow::Result<()> {
    let PalitraAccess::ByOrganisms { organism_ids } = access else {
        return Ok(());
    };
    let goi_targets =
        super::collect_connected_goi_targets(dbx, organism_ids.as_slice())
            .await
            .c(h!())?;
    let mut relative_paths = BTreeSet::new();
    for source_file_name in source_file_names {
        for file_name in super::palitra_goi_remote_file_names(
            palitra_id,
            Some(palitra_name),
            source_file_name.as_deref(),
        ) {
            for target_folder in target_folders {
                relative_paths.insert(compose_relative_path(
                    target_folder.as_deref(),
                    &file_name,
                ));
            }
        }
    }
    if relative_paths.is_empty() {
        return Ok(());
    }

    let mut errors = Vec::new();
    for target in goi_targets {
        let entries = match goi::goi_list_relative_files(target.clone()).await {
            Ok(entries) => entries,
            Err(err) => {
                errors.push(format!(
                    "{}:{} list relative files: {err:#}",
                    target.ssh_host, target.ssh_port
                ));
                continue;
            }
        };
        for entry in entries {
            if !matches_remote_relative_path(&entry, &relative_paths) {
                continue;
            }
            let remote_file_path =
                super::compose_goi_palette_remote_path(&target.path, &entry);
            if let Err(err) =
                goi::goi_delete_file(target.clone(), remote_file_path.clone())
                    .await
            {
                errors.push(format!(
                    "{}:{} {}: {err:#}",
                    target.ssh_host, target.ssh_port, remote_file_path
                ));
            }
        }
    }
    if errors.is_empty() {
        return Ok(());
    }
    anyhow::bail!("palitra GOI delete failed: {}", errors.join("; "));
}

fn compose_relative_path(
    target_folder: Option<&str>,
    file_name: &str,
) -> String {
    let file_name = file_name.trim().trim_start_matches('/');
    match target_folder
        .map(str::trim)
        .map(|folder| folder.trim_matches('/'))
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{file_name}"),
        None => file_name.to_string(),
    }
}

fn compose_remote_path(
    target: &CheckOrganismGoiConnectionReq,
    target_folder: Option<&str>,
    remote_file_name: &str,
) -> String {
    let relative_path = match target_folder
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => format!("{folder}/{remote_file_name}"),
        None => remote_file_name.to_string(),
    };
    super::compose_goi_palette_remote_path(&target.path, &relative_path)
}

fn matches_remote_relative_path(
    entry: &str,
    relative_paths: &BTreeSet<String>,
) -> bool {
    let entry = entry.trim().trim_start_matches("./").trim_matches('/');
    relative_paths.contains(entry)
}
