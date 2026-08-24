use super::analytics::{query, types::AnalysisRunSummary};
use super::devices::types::DeviceCurrentState;
use crate::config::DEVICE_MATTERMOST_TIMEOUT_SEC;
use crate::entities::device;
use crate::file_registry::entities::file_analysis_run;
use crate::h;
use crate::mattermost::{self, WebhookTarget};
use crate::types::{Env, ShortContext};
use anyhow::{Context, Result};
use sea_orm::EntityTrait;
use serde::Serialize;
use std::{fmt::Write as _, sync::Arc, time::Duration};
use url::{Host, Url};
use uuid::Uuid;

const DEVICE_NAME_MAX_CHARS: usize = 255;
const ANALYSIS_TAG_NAME_MAX_CHARS: usize = 128;
const ANALYSIS_TAG_MAX_COUNT: usize = 50;

#[derive(Serialize)]
struct MattermostPayload<'a> {
    text: &'a str,
}

pub(crate) fn spawn_device_created_notification(
    env: Arc<Env>,
    device: &DeviceCurrentState,
) {
    let device_id = device.id;
    let text = render_device_created(&env.config.public_host, device);
    drop(tokio::spawn(async move {
        let result: Result<()> = async {
            let text = text.context(h!())?;
            let Some(target) = webhook_target(&env).await.context(h!())? else {
                return Ok(());
            };
            post_text(&target, &text).await
        }
        .await;
        if let Err(error) = result {
            log::error!(
                "device Mattermost notification failed: event=device_created, device_id={device_id}, error={error:?}",
            );
        }
    }));
}

pub(crate) async fn analysis_run_completed_nofail(env: &Env, run_id: Uuid) {
    let result: Result<()> = async {
        let Some(target) = webhook_target(env).await.context(h!())? else {
            return Ok(());
        };
        let file_db = env.file_registry_db().context(h!())?.connection();
        let run = file_analysis_run::Entity::find_by_id(run_id)
            .one(file_db)
            .await
            .c(h!())?
            .context(h!())?;
        if run.completed_at.is_none() {
            anyhow::bail!("analysis run {run_id} is not complete");
        }
        let device = load_device(env, run.device_id).await.context(h!())?;
        let summary =
            query::analysis_run_summary(file_db, &run).await.c(h!())?;
        let Some(text) = render_analysis_run_completed(
            &env.config.public_host,
            device.id,
            device.name.as_deref(),
            device.external_url.as_deref(),
            &summary,
        )
        .context(h!())?
        else {
            return Ok(());
        };
        post_text(&target, &text).await
    }
    .await;
    if let Err(error) = result {
        log::error!(
            "device Mattermost notification failed: event=analysis_run_completed, run_id={run_id}, error={error:?}",
        );
    }
}

async fn webhook_target(env: &Env) -> Result<Option<WebhookTarget>> {
    let Some(webhook) = super::settings::mattermost_webhook_url(&env.dbx)
        .await
        .context(h!())?
    else {
        return Ok(None);
    };
    Ok(Some(
        mattermost::resolve_webhook(
            &webhook,
            Duration::from_secs(DEVICE_MATTERMOST_TIMEOUT_SEC),
        )
        .await
        .context(h!())?,
    ))
}

async fn post_text(target: &WebhookTarget, text: &str) -> Result<()> {
    mattermost::post(
        target,
        Duration::from_secs(DEVICE_MATTERMOST_TIMEOUT_SEC),
        &MattermostPayload { text },
        "Device Mattermost notification transport failed",
        "Device Mattermost notification endpoint rejected the request",
    )
    .await
    .context(h!())
}

async fn load_device(env: &Env, device_id: Uuid) -> Result<device::Model> {
    device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .context(h!())
}

fn render_device_created(
    public_host: &str,
    device: &DeviceCurrentState,
) -> Result<String> {
    let mut text = format!(
        "Додано пристрій {}",
        device_markdown_link(public_host, device.id, device.name.as_deref())
            .context(h!())?
    );
    if let Some(source) =
        source_link(device.external_url.as_deref()).context(h!())?
    {
        text.push(' ');
        text.push_str(&source);
    }
    Ok(text)
}

fn render_analysis_run_completed(
    public_host: &str,
    device_id: Uuid,
    name: Option<&str>,
    external_url: Option<&str>,
    summary: &AnalysisRunSummary,
) -> Result<Option<String>> {
    if summary.items.is_empty() {
        return Ok(None);
    }
    let mut heading = format!(
        "Завершено аналіз пристрою {}",
        device_markdown_link(public_host, device_id, name).context(h!())?
    );
    if let Some(source) = source_link(external_url).context(h!())? {
        heading.push(' ');
        heading.push_str(&source);
    }

    let visible_tag_count = summary.items.len().min(ANALYSIS_TAG_MAX_COUNT);
    heading.reserve(32 + visible_tag_count.saturating_mul(32));
    heading.push('\n');
    write!(heading, "Файли: {}", summary.file_count)
        .expect("writing to a String cannot fail");
    for item in summary.items.iter().take(ANALYSIS_TAG_MAX_COUNT) {
        heading.push_str(", ");
        let tag_name = mattermost::sanitize_field(
            &item.tag_name,
            ANALYSIS_TAG_NAME_MAX_CHARS,
        );
        write!(heading, "{tag_name}: {}", item.file_count)
            .expect("writing to a String cannot fail");
    }
    let omitted_tag_count =
        summary.items.len().saturating_sub(ANALYSIS_TAG_MAX_COUNT);
    if omitted_tag_count > 0 {
        write!(heading, ", Інші теги: {omitted_tag_count}")
            .expect("writing to a String cannot fail");
    }
    Ok(Some(heading))
}

fn device_name(device_id: Uuid, name: Option<&str>) -> String {
    name.map(|name| mattermost::sanitize_field(name, DEVICE_NAME_MAX_CHARS))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| device_id.to_string())
}

fn device_markdown_link(
    public_host: &str,
    device_id: Uuid,
    name: Option<&str>,
) -> Result<String> {
    let link = device_link(public_host, device_id).context(h!())?;
    Ok(format!("[{}]({link})", device_name(device_id, name)))
}

fn source_link(external_url: Option<&str>) -> Result<Option<String>> {
    let Some(external_url) = external_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let external_url = Url::parse(external_url)
        .context("device source is not a valid URL")
        .context(h!())?;
    if !matches!(external_url.scheme(), "http" | "https")
        || external_url.host_str().is_none()
    {
        anyhow::bail!("device source is not an HTTP(S) URL");
    }
    Ok(Some(format!(
        "([Джерело]({}))",
        markdown_link_destination(&external_url)
    )))
}

fn markdown_link_destination(url: &Url) -> String {
    let mut destination = String::with_capacity(url.as_str().len());
    for character in url.as_str().chars() {
        match character {
            '(' => destination.push_str("%28"),
            ')' => destination.push_str("%29"),
            '\\' => destination.push_str("%5C"),
            character => destination.push(character),
        }
    }
    destination
}

fn device_link(public_host: &str, device_id: Uuid) -> Result<String> {
    let public_host = Host::parse(public_host.trim())
        .context("public host is not a valid URL host")
        .context(h!())?;
    Ok(format!("https://{public_host}/devices/{device_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::analytics::types::AnalysisRunTagSummary;
    use crate::types::BTreeMap;
    use chrono::Utc;

    fn device_fixture(device_id: Uuid) -> DeviceCurrentState {
        DeviceCurrentState {
            id: device_id,
            name: Some("Ймовірно 57 орб 2 рр БпС комп 2 （MSI)".to_string()),
            aors: Vec::new(),
            unit: None,
            external_url: Some("https://secret.example/device".to_string()),
            custom_fields: BTreeMap::from([(
                "password".to_string(),
                "private-value".to_string(),
            )]),
            created_by: "creator".to_string(),
            archived: false,
            archived_at: None,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[test]
    fn created_payload_matches_compact_format_and_omits_missing_source() {
        let device_id = Uuid::from_u128(0x01a01df4_7cc6_7110_bcf6_6c72132387f8);
        let mut device = device_fixture(device_id);

        let text = render_device_created("localhost", &device).unwrap();

        assert_eq!(
            text,
            format!(
                "Додано пристрій \
                 [Ймовірно 57 орб 2 рр БпС комп 2 （MSI）]\
                 (https://localhost/devices/{device_id}) \
                 ([Джерело](https://secret.example/device))"
            )
        );
        assert!(!text.contains("private-value"));

        device.external_url = None;
        assert_eq!(
            render_device_created("localhost", &device).unwrap(),
            format!(
                "Додано пристрій \
                 [Ймовірно 57 орб 2 рр БпС комп 2 （MSI）]\
                 (https://localhost/devices/{device_id})"
            )
        );
    }

    #[test]
    fn completed_analysis_payload_matches_existing_format() {
        let device_id = Uuid::from_u128(0x01a01df4_7cc6_7110_bcf6_6c72132387f8);
        let device = device_fixture(device_id);
        let summary = AnalysisRunSummary {
            file_count: 12_573,
            items: vec![
                AnalysisRunTagSummary {
                    tag_name: "Тег 1".to_string(),
                    file_count: 123,
                },
                AnalysisRunTagSummary {
                    tag_name: "Тег 2".to_string(),
                    file_count: 321,
                },
            ],
        };

        let text = render_analysis_run_completed(
            "localhost",
            device.id,
            device.name.as_deref(),
            device.external_url.as_deref(),
            &summary,
        )
        .unwrap()
        .expect("a run with tagged files should render a notification");

        assert_eq!(
            text,
            format!(
                "Завершено аналіз пристрою \
                 [Ймовірно 57 орб 2 рр БпС комп 2 （MSI）]\
                 (https://localhost/devices/{device_id}) \
                 ([Джерело](https://secret.example/device))\n\
                 Файли: 12573, Тег 1: 123, Тег 2: 321"
            )
        );
    }

    #[test]
    fn completed_analysis_payload_is_omitted_without_tagged_files() {
        let device_id = Uuid::now_v7();
        let device = device_fixture(device_id);
        let summary = AnalysisRunSummary {
            file_count: 12_573,
            items: Vec::new(),
        };

        assert_eq!(
            render_analysis_run_completed(
                "localhost",
                device.id,
                device.name.as_deref(),
                device.external_url.as_deref(),
                &summary,
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn local_public_host_produces_device_link() {
        let device_id = Uuid::now_v7();

        assert_eq!(
            device_link("localhost", device_id).unwrap(),
            format!("https://localhost/devices/{device_id}")
        );
    }
}
