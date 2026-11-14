//! Logs an ERROR while this server's AI harness differs from the release the
//! running build requires (#4186). AI chat refuses every request in that state,
//! but each refusal is only a business-logic error, so on 2026-11-13
//! echo-pivnich stayed in it for hours before anyone noticed.

use super::access;
use super::dispatcher::DispatcherClient;
use crate::config::{
    AI_AGENT_DISPATCHER_ID, AI_AGENT_HARNESS_CHECK_INTERVAL_SEC,
    AI_AGENT_HARNESS_CHECK_STARTUP_DELAY_SEC, AI_AGENT_HARNESS_RELEASE,
    AI_AGENT_SETTINGS_ID,
};
use crate::entities::{ai_agent_dispatcher, ai_agent_settings};
use crate::error::AppError;
use crate::h;
use crate::types::{error, warn, Env, ShortContext, ShortContextErr};
use sea_orm::EntityTrait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// How `require_template` in `echo_ai_agent_dispatcher.py` refuses a template
/// whose release is missing or isn't the one the namespace expects.
const TEMPLATE_RELEASE_REJECTION: &str =
    "selected template belongs to another harness release";

/// Releases the dispatcher reports for this server's namespace.
struct ObservedHarness {
    namespace: String,
    ai_enabled: bool,
    template: Template,
    containers: Vec<Option<String>>,
}

#[derive(Debug)]
enum Template {
    Release(Option<String>),
    /// The dispatcher refused the template because of its harness release;
    /// new containers can't be cloned from it.
    Rejected(String),
    /// Preflight failed for another reason, such as a timeout; only the
    /// containers are checked.
    Unknown(String),
}

pub async fn run_nofail(env: Arc<Env>, cancellation: CancellationToken) {
    // A deploy restarts this worker before it upgrades the harness, so the
    // first check waits for that upgrade.
    let mut delay = AI_AGENT_HARNESS_CHECK_STARTUP_DELAY_SEC;
    loop {
        let _loop_guard = crate::utils::worker_watch::loop_guard(
            "ai_agent_harness_check_worker",
        );
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
        check(&env).await;
        delay = AI_AGENT_HARNESS_CHECK_INTERVAL_SEC;
    }
}

async fn check(env: &Env) {
    let observed = match observe(env).await {
        Ok(Some(observed)) => observed,
        Ok(None) => return,
        Err(err) => {
            warn!("AI harness check failed: {err:?}");
            return;
        }
    };
    if let Template::Unknown(err) = &observed.template {
        warn!("AI harness check could not read the namespace template: {err}");
    }
    if let Some(mismatch) = describe_mismatch(
        AI_AGENT_HARNESS_RELEASE,
        &observed.template,
        &observed.containers,
    ) {
        error!(
            "AI harness mismatch on {} (namespace {}, AI enabled: {}): this build requires harness {AI_AGENT_HARNESS_RELEASE}, but {mismatch}. AI chat refuses requests until the harness is upgraded: python3 deploy/ai-control-panel/deploy-notice.py --sync <server>",
            env.config.public_host, observed.namespace, observed.ai_enabled
        );
    }
}

/// `None` when this server has no AI dispatcher or settings to check.
async fn observe(env: &Env) -> anyhow::Result<Option<ObservedHarness>> {
    let Some(dispatcher) =
        ai_agent_dispatcher::Entity::find_by_id(AI_AGENT_DISPATCHER_ID)
            .one(&env.dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let Some(settings) =
        ai_agent_settings::Entity::find_by_id(AI_AGENT_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let dispatcher = DispatcherClient::from_record(&dispatcher).c(h!())?;
    let template_id = access::template_login_id(&settings).c(h!())?;
    let inventory = dispatcher.call("list", None, json!({})).await.c(h!())?;
    // Transport failures are business-logic errors too, so only the
    // dispatcher's release refusal counts as a mismatch.
    let template = match dispatcher
        .call("preflight", None, json!({ "template_id": template_id }))
        .await
    {
        Ok(preflight) => Template::Release(release(&preflight.result)),
        Err(AppError::BL { msg }) if is_release_rejection(&msg) => {
            Template::Rejected(msg)
        }
        Err(err) => Template::Unknown(format!("{:?}", err.c(h!()))),
    };
    Ok(Some(ObservedHarness {
        namespace: dispatcher.namespace().to_string(),
        ai_enabled: settings.feature_enabled,
        template,
        containers: inventory
            .result
            .get("instances")
            .and_then(Value::as_array)
            .map(|instances| instances.iter().map(release).collect())
            .unwrap_or_default(),
    }))
}

fn is_release_rejection(message: &str) -> bool {
    message.contains(TEMPLATE_RELEASE_REJECTION)
}

fn release(value: &Value) -> Option<String> {
    value
        .get("harness_release")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Describes every release that differs from `required`, or `None` when the
/// template and all containers match it. A missing release counts as a
/// mismatch, because request validation refuses it too.
fn describe_mismatch(
    required: &str,
    template: &Template,
    containers: &[Option<String>],
) -> Option<String> {
    let mut parts = Vec::new();
    match template {
        Template::Release(Some(release)) if release == required => {}
        Template::Release(release) => parts.push(format!(
            "the namespace template has {}",
            release.as_deref().unwrap_or("no release")
        )),
        Template::Rejected(reason) => parts
            .push(format!("the dispatcher rejected the template ({reason})")),
        Template::Unknown(_) => {}
    }
    let mut stale = BTreeMap::<&str, usize>::new();
    for container in containers {
        let release = container.as_deref().unwrap_or("no release");
        if release != required {
            *stale.entry(release).or_default() += 1;
        }
    }
    if !stale.is_empty() {
        let count: usize = stale.values().sum();
        let releases = stale
            .iter()
            .map(|(release, count)| format!("{release} ×{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!(
            "{count} of {} containers have other releases ({releases})",
            containers.len()
        ));
    }
    (!parts.is_empty()).then(|| parts.join(" and "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUIRED: &str = "2026.11.13.2";

    fn template(release: &str) -> Template {
        Template::Release(Some(release.to_string()))
    }

    fn containers(releases: &[Option<&str>]) -> Vec<Option<String>> {
        releases
            .iter()
            .map(|release| release.map(str::to_string))
            .collect()
    }

    #[test]
    fn matching_template_and_containers_are_not_a_mismatch() {
        let all = containers(&[Some(REQUIRED), Some(REQUIRED)]);
        assert_eq!(
            describe_mismatch(REQUIRED, &template(REQUIRED), &all),
            None
        );
        assert_eq!(describe_mismatch(REQUIRED, &template(REQUIRED), &[]), None);
    }

    #[test]
    fn stale_namespace_reports_template_and_containers() {
        let all = containers(&[
            Some("2026.11.13.1"),
            Some("2026.11.13.1"),
            Some(REQUIRED),
        ]);
        assert_eq!(
            describe_mismatch(REQUIRED, &template("2026.11.13.1"), &all)
                .as_deref(),
            Some(
                "the namespace template has 2026.11.13.1 and 2 of 3 containers have other releases (2026.11.13.1 ×2)"
            )
        );
    }

    #[test]
    fn stale_containers_alone_are_a_mismatch() {
        let all = containers(&[Some(REQUIRED), None, Some("2026.11.12.2")]);
        assert_eq!(
            describe_mismatch(REQUIRED, &template(REQUIRED), &all).as_deref(),
            Some(
                "2 of 3 containers have other releases (2026.11.12.2 ×1, no release ×1)"
            )
        );
    }

    #[test]
    fn missing_template_release_is_a_mismatch() {
        assert_eq!(
            describe_mismatch(REQUIRED, &Template::Release(None), &[])
                .as_deref(),
            Some("the namespace template has no release")
        );
    }

    #[test]
    fn rejected_template_is_a_mismatch() {
        let rejected = Template::Rejected(
            "AI agent dispatcher: selected template belongs to another harness release"
                .to_string(),
        );
        let all = containers(&[Some("2026.11.13.1")]);
        assert_eq!(
            describe_mismatch(REQUIRED, &rejected, &all).as_deref(),
            Some(
                "the dispatcher rejected the template (AI agent dispatcher: selected template belongs to another harness release) and 1 of 1 containers have other releases (2026.11.13.1 ×1)"
            )
        );
    }

    #[test]
    fn unknown_template_still_reports_stale_containers() {
        let unknown = Template::Unknown("timed out".to_string());
        assert_eq!(
            describe_mismatch(
                REQUIRED,
                &unknown,
                &containers(&[Some(REQUIRED)])
            ),
            None
        );
        assert_eq!(
            describe_mismatch(
                REQUIRED,
                &unknown,
                &containers(&[Some("2026.11.13.1")])
            )
            .as_deref(),
            Some("1 of 1 containers have other releases (2026.11.13.1 ×1)")
        );
    }

    #[test]
    fn only_the_release_refusal_is_a_rejection() {
        assert!(is_release_rejection(
            "AI agent dispatcher: selected template belongs to another harness release"
        ));
        assert!(!is_release_rejection(
            "AI agent dispatcher returned no terminal response"
        ));
        assert!(!is_release_rejection(
            "AI agent dispatcher: selected template does not exist"
        ));
    }

    #[test]
    fn release_reads_the_dispatcher_field() {
        assert_eq!(
            release(&json!({ "harness_release": REQUIRED })).as_deref(),
            Some(REQUIRED)
        );
        assert_eq!(release(&json!({})), None);
    }
}
