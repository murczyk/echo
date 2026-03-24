use crate::config::AgentConfig;
use anyhow::{Context, Result, bail};
use reqwest::blocking::{Client, Response};
use serde::Serialize;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

const API_TIMEOUT_SECS: u64 = 30;

pub struct EchoApiClient {
    base_url: String,
    http: Client,
}

impl EchoApiClient {
    pub fn login(config: &AgentConfig) -> Result<Self> {
        let http = Client::builder()
            .cookie_store(true)
            .timeout(Duration::from_secs(API_TIMEOUT_SECS))
            .build()
            .context("failed to build HTTP client")?;
        let client = Self {
            base_url: config.echo_server.clone(),
            http,
        };

        client.post_json(
            "/api/user/login",
            &json!({
                "user": config.echo_login,
                "password": config.echo_password,
            }),
        )?;

        Ok(client)
    }

    pub fn message_by_id(&self, message_id: i64) -> Result<Value> {
        let raw = self.post_json(
            "/api/rer-importer/messages-by-id",
            &json!({ "message_ids": [message_id] }),
        )?;
        let messages = flatten_message_entries(raw.get("messages"))
            .context("messages-by-id returned invalid messages")?;
        let message = messages
            .into_iter()
            .find(|message| message["id"].as_i64() == Some(message_id))
            .ok_or_else(|| anyhow::anyhow!("message {message_id} not found"))?;
        Ok(message)
    }

    pub fn same_frequency_context(
        &self,
        message_id: i64,
        hours_before: i64,
        hours_after: i64,
        limit: usize,
    ) -> Result<Value> {
        let target_message = self.message_by_id(message_id)?;
        let target_freq =
            value_as_string(&target_message, &["message", "freq"]).ok_or_else(
                || anyhow::anyhow!("message {message_id} has no freq"),
            )?;
        let target_timestamp =
            value_as_i64(&target_message, &["message", "timestamp"]);

        let same_frequency_messages = match target_timestamp {
            Some(target_timestamp) => self.fetch_same_frequency_messages(
                &target_freq,
                target_timestamp,
                hours_before,
                hours_after,
                message_id,
                limit,
            )?,
            None => Vec::new(),
        };

        let message_network_ids =
            value_as_i64_array(&target_message, &["message", "network_ids"]);
        let message_networks = self.network_info(&message_network_ids)?;
        let frequency_matched_networks =
            self.frequency_networks(&target_freq)?;
        let network_callsigns =
            self.network_callsigns_map(&message_network_ids)?;

        Ok(json!({
            "message_id": message_id,
            "frequency": target_freq,
            "hours_before": hours_before,
            "hours_after": hours_after,
            "target_message": target_message,
            "same_frequency_messages": same_frequency_messages,
            "message_network_ids": message_network_ids,
            "message_networks": message_networks,
            "message_network_callsigns": network_callsigns,
            "frequency_matched_networks": frequency_matched_networks,
        }))
    }

    pub fn callsigns_search(&self, query: &str, limit: u64) -> Result<Value> {
        self.post_json(
            "/api/sigint/callsigns",
            &json!({
                "after_id": null,
                "before_id": null,
                "filter_text": query,
                "filter_callsign": query,
                "filter_position": null,
                "filter_comment": null,
                "filter_unit": null,
                "filter_unit_army": null,
                "filter_unit_division": null,
                "filter_unit_regiment": null,
                "filter_unit_battalion": null,
                "filter_developing": "All",
                "since_date_inclusive_ms": null,
                "till_date_inclusive_ms": null,
                "limit": limit,
                "sort_by": ["CallsignAsc"],
            }),
        )
    }

    pub fn network_info(&self, network_ids: &[i64]) -> Result<Value> {
        if network_ids.is_empty() {
            return Ok(json!([]));
        }

        self.post_json("/api/sigint/network-info-batch-id", network_ids)
    }

    pub fn network_callsigns(&self, network_id: i64) -> Result<Value> {
        self.post_json(
            "/api/sigint/network-callsigns/list",
            &json!({
                "network_id": network_id,
                "sort_by": ["NetworkCallsignAsc"],
            }),
        )
    }

    fn frequency_networks(&self, freq: &str) -> Result<Value> {
        self.post_json(
            "/api/sigint/network-list",
            &json!({
                "filter_freq": freq,
                "filter_unit": null,
                "show_only_further_inverstigation": false,
                "show_inactive": true,
                "show_only_deleted": false,
                "aor_ids": null,
                "ids": null,
                "limit": 20,
                "offset": 0,
                "sort_by": ["NameAsc"],
            }),
        )
    }

    fn fetch_same_frequency_messages(
        &self,
        freq: &str,
        target_timestamp: i64,
        hours_before: i64,
        hours_after: i64,
        message_id: i64,
        limit: usize,
    ) -> Result<Vec<Value>> {
        let raw = self.post_json(
            "/api/rer-importer/get-inbox",
            &json!({
                "since_id_noninclusive": null,
                "before_id_noninclusive": null,
                "since_date_inclusive_ms": target_timestamp - hours_to_ms(hours_before)?,
                "till_date_inclusive_ms": target_timestamp + hours_to_ms(hours_after)?,
                "only_show_unprocessed": null,
                "checked_only": null,
                "selected_groups": null,
                "selected_senders": null,
                "denied_senders": null,
                "selected_freqs": [freq],
                "selected_posts": null,
                "denied_posts": null,
                "denied_freqs": null,
                "selected_callsigns": null,
                "selected_units": null,
                "selected_locations": null,
                "nolimit": true,
                "or_with_extended_form": null,
                "load_latest": null,
                "return_duplicates": null,
                "or_bookmarked": null,
                "or_important": null,
                "or_with_coords": null,
                "newest_first": false,
                "search": null,
                "highlight_callsigns": false,
                "highlight_keywords": false,
                "highlight_searchres": false,
                "highlight_signals": false,
                "highlight_points": false,
                "selected_tags": null,
                "selected_aors": null,
                "selected_networks": null,
                "without_network": null,
                "metadata_cc": null,
                "metadata_sender": null,
                "metadata_receiver": null,
                "metadata_hash": null,
                "only_with_metadata": null,
                "without_metadata": null,
                "sort_by": "IMSTimestamp",
                "report_tags_only_this_unit": null,
                "ignore_imported_coords": null,
                "include_peleng_locations": null,
                "units_exact_match_only": null,
                "calculate_freq_pelengs_summary": false,
                "skip_group_stats": true,
                "filter_tags_option": null,
                "page_id": "echo-agent-same-frequency-context",
                "without_model_tags": null,
            }),
        )?;
        let mut messages = flatten_message_entries(raw.get("inbox_items"))
            .context("get-inbox returned invalid inbox_items")?;
        rank_same_frequency_messages(
            &mut messages,
            message_id,
            target_timestamp,
            limit,
        );
        Ok(messages)
    }

    fn network_callsigns_map(&self, network_ids: &[i64]) -> Result<Value> {
        let mut result = BTreeMap::new();
        for network_id in network_ids {
            let payload = self.network_callsigns(*network_id)?;
            result.insert(network_id.to_string(), payload);
        }
        Ok(serde_json::to_value(result)?)
    }

    fn post_json<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
    ) -> Result<Value> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .post(url)
            .json(payload)
            .send()
            .with_context(|| format!("request to {path} failed"))?;
        parse_json_response(path, response)
    }
}

fn parse_json_response(path: &str, response: Response) -> Result<Value> {
    let status = response.status();
    let body = response
        .text()
        .with_context(|| format!("failed reading response body for {path}"))?;
    if !status.is_success() {
        bail!("request to {path} failed with {status}: {body}");
    }
    serde_json::from_str(&body)
        .with_context(|| format!("failed to decode JSON response from {path}"))
}

fn flatten_message_entries(entries: Option<&Value>) -> Result<Vec<Value>> {
    let Some(entries) = entries else {
        return Ok(Vec::new());
    };
    let entries = entries
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("message entries must be an array"))?;

    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let pair = entry.as_array().ok_or_else(|| {
            anyhow::anyhow!("message entry must be a 2-item array")
        })?;
        if pair.len() != 2 {
            bail!("message entry must contain [id, message]");
        }
        result.push(json!({
            "id": pair[0],
            "message": pair[1],
        }));
    }
    Ok(result)
}

fn rank_same_frequency_messages(
    messages: &mut Vec<Value>,
    target_message_id: i64,
    target_timestamp: i64,
    limit: usize,
) {
    messages.sort_by(|left, right| {
        compare_message_relevance(
            left,
            right,
            target_message_id,
            target_timestamp,
        )
    });
    if messages.len() > limit {
        messages.truncate(limit);
    }
    messages.sort_by(compare_message_timeline);
}

fn compare_message_relevance(
    left: &Value,
    right: &Value,
    target_message_id: i64,
    target_timestamp: i64,
) -> Ordering {
    let left_id = value_as_i64(left, &["id"]).unwrap_or_default();
    let right_id = value_as_i64(right, &["id"]).unwrap_or_default();
    let left_priority = relevance_priority(left_id, target_message_id);
    let right_priority = relevance_priority(right_id, target_message_id);
    match left_priority.cmp(&right_priority) {
        Ordering::Equal => {
            compare_message_distance(left, right, target_timestamp)
        }
        ordering => ordering,
    }
}

fn relevance_priority(message_id: i64, target_message_id: i64) -> i8 {
    if message_id == target_message_id {
        0
    } else {
        1
    }
}

fn compare_message_distance(
    left: &Value,
    right: &Value,
    target_timestamp: i64,
) -> Ordering {
    let left_distance =
        message_distance_ms(left, target_timestamp).unwrap_or(i64::MAX);
    let right_distance =
        message_distance_ms(right, target_timestamp).unwrap_or(i64::MAX);
    match left_distance.cmp(&right_distance) {
        Ordering::Equal => {
            let left_id = value_as_i64(left, &["id"]).unwrap_or_default();
            let right_id = value_as_i64(right, &["id"]).unwrap_or_default();
            left_id.cmp(&right_id)
        }
        ordering => ordering,
    }
}

fn compare_message_timeline(left: &Value, right: &Value) -> Ordering {
    let left_timestamp =
        value_as_i64(left, &["message", "timestamp"]).unwrap_or_default();
    let right_timestamp =
        value_as_i64(right, &["message", "timestamp"]).unwrap_or_default();
    match left_timestamp.cmp(&right_timestamp) {
        Ordering::Equal => {
            let left_id = value_as_i64(left, &["id"]).unwrap_or_default();
            let right_id = value_as_i64(right, &["id"]).unwrap_or_default();
            left_id.cmp(&right_id)
        }
        ordering => ordering,
    }
}

fn message_distance_ms(message: &Value, target_timestamp: i64) -> Option<i64> {
    let timestamp = value_as_i64(message, &["message", "timestamp"])?;
    Some((timestamp - target_timestamp).abs())
}

fn hours_to_ms(hours: i64) -> Result<i64> {
    const MILLIS_PER_HOUR: i64 = 60 * 60 * 1000;
    hours
        .checked_mul(MILLIS_PER_HOUR)
        .ok_or_else(|| anyhow::anyhow!("hours value is too large"))
}

fn value_as_string(value: &Value, path: &[&str]) -> Option<String> {
    value_at_path(value, path)?.as_str().map(ToOwned::to_owned)
}

fn value_as_i64(value: &Value, path: &[&str]) -> Option<i64> {
    value_at_path(value, path)?.as_i64()
}

fn value_as_i64_array(value: &Value, path: &[&str]) -> Vec<i64> {
    let Some(entries) = value_at_path(value, path).and_then(Value::as_array)
    else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for entry in entries {
        if let Some(number) = entry.as_i64()
            && seen.insert(number)
        {
            result.push(number);
        }
    }
    result
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}
