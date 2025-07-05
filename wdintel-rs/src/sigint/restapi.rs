//! This implements REST stuff for [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)

use crate::entities::*;
use crate::error::AppError;
use crate::here;
use crate::types::*;
use log::{error, warn};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct GroupInfo {
    #[serde(rename = "groupId")]
    pub group_id: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Thumbnail {
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub filename: Option<String>,
    pub id: String,
    pub size: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Attachment {
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub filename: Option<String>,
    pub thumbnail: Option<Thumbnail>,
    pub id: Option<String>,
    pub size: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Quote {
    pub id: i64,
    pub author: String,
    #[serde(rename = "authorNumber")]
    pub author_number: Option<String>,
    #[serde(rename = "authorUuid")]
    pub author_uuid: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Reaction {
    pub emoji: String,
    #[serde(rename = "targetAuthor")]
    pub target_author: String,
    #[serde(rename = "targetAuthorNumber")]
    pub target_author_number: Option<String>,
    #[serde(rename = "targetAuthorUuid")]
    pub target_author_uuid: String,
    #[serde(rename = "targetSentTimestamp")]
    pub target_sent_timestamp: i64,
    #[serde(rename = "isRemove")]
    pub is_remove: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct DataMessage {
    pub timestamp: i64,
    pub message: Option<String>,
    #[serde(rename = "expiresInSeconds")]
    pub expires_in_seconds: i64,
    #[serde(rename = "viewOnce")]
    pub view_once: bool,
    pub attachments: Option<Vec<Attachment>>,
    pub reaction: Option<Reaction>,
    pub quote: Option<Quote>,
    #[serde(rename = "groupInfo")]
    pub group_info: Option<GroupInfo>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Exception {
    pub message: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Envelope {
    pub source: Option<String>,
    #[serde(rename = "sourceNumber")]
    pub source_number: Option<String>,
    #[serde(rename = "sourceUuid")]
    pub source_uuid: Option<String>,
    #[serde(rename = "sourceName")]
    pub source_name: Option<String>,
    #[serde(rename = "sourceDevice")]
    pub source_device: i64,
    pub timestamp: i64,
    #[serde(rename = "dataMessage")]
    pub data_message: Option<DataMessage>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Message {
    pub exception: Option<Exception>,
    pub envelope: Envelope,
    pub account: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Group {
    pub name: String,
    pub id: String,
    pub internal_id: String,
    pub members: Vec<String>,
    pub blocked: bool,
    pub pending_invites: Vec<String>,
    pub pending_requests: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct V2Send {
    pub message: String,
    pub number: String,
    pub recipients: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct V2SendRsp {
    pub timestamp: String,
}

pub async fn receive_messages(
    config: &crate::config::Config,
    rq: &reqwest::Client,
    dbx: &sea_orm::DatabaseConnection,
) -> Result<Vec<Message>, AppError> {
    let url = format!(
        "{}/v1/receive/{}?max_messages={}",
        crate::config::SIGNAL_CLIENT_ADDR,
        config.signal_api_phone,
        crate::config::SIGNAL_MAX_MESSAGES,
    );
    // let url = format!(
    //     "{}/v1/receive/{}?timeout=60",
    //     crate::config::SIGNAL_CLIENT_ADDR,
    //     crate::config::signal_api_phone(mode),
    // );
    let rsp = rq
        .get(url)
        .header("content-type", "application/json")
        .send()
        .await?;
    let rsp_t = rsp.text().await?;
    // let rsp_e = crate::utils::json::parse_partial(&rsp_t).and_then(|x| {
    //     serde_json::from_value::<Vec<Message>>(x).map_err(|e| e.into())
    // });
    let rsp_e = match crate::utils::json::parse_partial(&rsp_t) {
        Ok(x) => {
            if let Some(error) = x.error.clone() {
                let m_id: Option<i64> = signal_restapi_error::ActiveModel {
                    id: NotSet,
                    created_at: NotSet,
                    res_txt: Set(x.error.clone().unwrap_or("".to_string())),
                    res: NotSet,
                }
                .insert(dbx)
                .await
                .ok()
                .map(|x| x.id);
                println!(
                    "> error: Error written to sigint_restapi_errors table id={m_id:?}. x.error[:100]: {}",
                    String::from_iter(error.chars().take(100))
                );
            }

            serde_json::from_value::<Vec<Message>>(x.value)
                .context(h!())
                .map_err(|e| AppError::AnyhowError { source: e })
        }
        Err(e) => Err(e),
    };
    if let Err(ref e) = rsp_e {
        let m_jv: Option<serde_json::Value> = serde_json::from_str(&rsp_t).ok();
        let m_id: Option<i64> = signal_restapi_error::ActiveModel {
            id: NotSet,
            created_at: NotSet,
            res_txt: Set(rsp_t.clone()),
            res: Set(m_jv),
        }
        .insert(dbx)
        .await
        .ok()
        .map(|x| x.id);
        println!(
            "> error: {e:?}. Error written to sigint_restapi_errors table id={m_id:?}. rsp_t[:100]: {}",
            String::from_iter(rsp_t.chars().take(100))
        );
    }
    let mut messages = vec![];
    for msg in rsp_e? {
        if let Ok(Some(full_message)) = load_full_message(&msg, rq).await {
            messages.push(full_message);
        } else {
            messages.push(msg);
        }
    }
    Ok(messages)
}

async fn load_full_message(
    message: &Message,
    rq: &reqwest::Client,
) -> Result<Option<Message>, AppError> {
    '_if: {
        let Some(msg) = &message.envelope.data_message else {
            break '_if;
        };
        let Some(attachments) = &msg.attachments else {
            break '_if;
        };
        let attachment = attachments
            .iter()
            .filter(|x| "text/x-signal-plain".eq(&x.content_type))
            .next();
        let Some(attachment) = attachment else {
            if let Some(text) = &msg.message {
                if text.len() > 1000 {
                    warn!(
                        "missing full text attachment on {}, found: {:?}",
                        text, attachments
                    );
                }
            }
            break '_if;
        };
        let Some(filename) = attachment.filename.clone() else {
            break '_if;
        };
        let response = fetch_attachment_text(&filename, rq).await;
        let Ok(full_message) = &response else {
            if let Some(err) = response.err() {
                error!("failed to fetch attachment: {}", err);
            }
            break '_if;
        };
        let mut msg = msg.clone();
        msg.message = Some(full_message.clone());
        let mut result = message.clone();
        result.envelope.data_message = Some(msg);
        return Ok(Some(result));
    }
    Ok(None)
}

pub async fn receive_groups(
    config: &crate::config::Config,
    rq: &reqwest::Client,
) -> Result<Vec<Group>, AppError> {
    let url = format!(
        "{}/v1/groups/{}",
        crate::config::SIGNAL_CLIENT_ADDR,
        config.signal_api_phone,
    );
    let rsp = rq
        .get(url)
        .header("content-type", "application/json")
        .send()
        .await?;
    let rsp_t = rsp.text().await?;
    let rsp_e: Result<Vec<Group>, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let groups = rsp_e.context(h!())?;
    Ok(groups)
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct TrustIdentityReq {
    pub trust_all_known_keys: Option<bool>,
}

pub async fn trust_identity(
    config: &crate::config::Config,
    rq: &reqwest::Client,
    number_to_trust: &str,
) -> Result<(), AppError> {
    let url = format!(
        "{}/v1/identities/{}/trust/{}",
        crate::config::SIGNAL_CLIENT_ADDR,
        config.signal_api_phone,
        number_to_trust,
    );
    let req = TrustIdentityReq {
        trust_all_known_keys: Some(true),
    };
    let rsp = rq
        .post(url)
        .json(&req)
        .header("content-type", "application/json")
        .send()
        .await?;
    if !rsp.status().is_success() {
        return Err(anyhow::anyhow!(
            "Bad status: {}, url: {}",
            rsp.status(),
            rsp.url()
        )
        .context(format!("number_to_trust = {number_to_trust}"))
        .context(here!())
        .into());
    }
    Ok(())
}

async fn fetch_attachment_text(
    id: &str,
    rq: &reqwest::Client,
) -> Result<String, AppError> {
    let url =
        format!("{}/v1/attachments{}", crate::config::SIGNAL_CLIENT_ADDR, id);
    let rsp = rq.get(url).send().await?;
    rsp.text().await.map_err(|e| e.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_message_01() {
        let contents =
            std::fs::read_to_string("data/restapi_message_01.json").unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_02() {
        let contents =
            std::fs::read_to_string("data/restapi_message_02.json").unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_03() {
        let contents =
            std::fs::read_to_string("data/restapi_message_03.json").unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_04() {
        let contents =
            std::fs::read_to_string("data/restapi_message_04.json").unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_05() {
        let contents =
            std::fs::read_to_string("data/restapi_message_05_attachment.json")
                .unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_06() {
        let contents = std::fs::read_to_string(
            "data/restapi_message_06_quoteattachment.json",
        )
        .unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_07() {
        let contents =
            std::fs::read_to_string("data/restapi_message_07_thumbnail.json")
                .unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_08() {
        let contents = std::fs::read_to_string(
            "data/restapi_message_08_image_nofilename.json",
        )
        .unwrap();
        let _res: Message = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_message_09() {
        let contents =
            std::fs::read_to_string("data/restapi_message_09.json").unwrap();
        let _res: Vec<Message> = serde_json::from_str(&contents).unwrap();
    }

    #[test]
    fn test_parse_group_01() {
        let contents =
            std::fs::read_to_string("data/restapi_group_01.json").unwrap();
        let _res: Group = serde_json::from_str(&contents).unwrap();
    }
}
