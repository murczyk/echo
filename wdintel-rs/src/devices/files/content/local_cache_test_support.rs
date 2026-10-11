use std::path::Path;

use sea_orm::{ActiveModelTrait, Set};

use crate::{messenger::media_local_cache, types::Env};

pub(in crate::devices) async fn retain_without_storage(
    env: &mut Env,
    directory: &Path,
    key: &str,
    bytes: &[u8],
    encrypted: bool,
) {
    crate::entities::system_settings::ActiveModel {
        messenger_media_cache_enabled: Set(Some(true)),
        messenger_media_cache_retention_hours: Set(Some(24)),
        messenger_media_cache_max_size_gib: Set(Some(1)),
        messenger_media_cache_min_free_gib: Set(Some(0)),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    env.config.storage_dir = directory.display().to_string();
    env.config.s3_config = Some(crate::config::S3Config {
        s3_endpoint: "https://storage.invalid".to_owned(),
        s3_region: "test".to_owned(),
        s3_bucket: "device-retention-test".to_owned(),
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    });
    let config = media_local_cache::configured_config(&env.config, &env.dbx)
        .await
        .unwrap();
    let source = directory.join("sealed-source");
    tokio::fs::write(&source, bytes).await.unwrap();
    media_local_cache::retain_object_best_effort(
        &config,
        key,
        bytes.len() as i64,
        encrypted,
        &source,
        chrono::Utc::now().timestamp(),
    )
    .await;
    tokio::fs::remove_file(source).await.unwrap();
    env.s3 = None;
    env.s3_config = None;
}
