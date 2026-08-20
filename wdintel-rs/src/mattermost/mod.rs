use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crate::utils::http::is_valid_hostname;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use url::Url;

pub struct WebhookTarget {
    url: Url,
    hostname: Option<String>,
    addresses: Vec<SocketAddr>,
}

pub fn validate_webhook(webhook: Option<&str>) -> Result<(), AppError> {
    let Some(webhook) = webhook else {
        return Ok(());
    };
    let url = Url::parse(webhook)
        .map_err(|_| AppError::BL {
            msg: "Mattermost webhook URL is invalid".to_string(),
        })
        .c(h!())?;
    let host_is_safe = url.host_str().is_some_and(|host| {
        host.parse::<IpAddr>().map_or_else(
            |_| is_valid_hostname(host),
            |address| match address {
                IpAddr::V4(address) => {
                    !address.is_private()
                        && !address.is_loopback()
                        && !address.is_link_local()
                        && !address.is_unspecified()
                        && !address.is_multicast()
                }
                IpAddr::V6(address) => {
                    !address.is_loopback()
                        && !address.is_unspecified()
                        && !address.is_multicast()
                        && !address.is_unique_local()
                }
            },
        )
    });
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !host_is_safe
    {
        return Err(AppError::BL {
            msg: "Mattermost webhook must use HTTPS without embedded credentials or private IPs"
                .to_string(),
        });
    }
    Ok(())
}

pub async fn resolve_webhook(webhook: &str) -> Result<WebhookTarget, AppError> {
    validate_webhook(Some(webhook)).c(h!())?;
    let url = Url::parse(webhook)
        .map_err(|_| AppError::BL {
            msg: "Mattermost webhook URL is invalid".to_string(),
        })
        .c(h!())?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BL {
            msg: "Mattermost webhook URL is invalid".to_string(),
        })
        .c(h!())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::BL {
            msg: "Mattermost webhook URL is invalid".to_string(),
        })
        .c(h!())?;
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| AppError::BL {
            msg: "Mattermost webhook host did not resolve".to_string(),
        })
        .c(h!())?
        .collect::<Vec<_>>();
    validate_webhook_addresses(&addresses).c(h!())?;
    Ok(WebhookTarget {
        url,
        hostname: host.parse::<IpAddr>().is_err().then_some(host),
        addresses,
    })
}

pub async fn post<T: Serialize + ?Sized>(
    target: &WebhookTarget,
    timeout: Duration,
    payload: &T,
    transport_error: &'static str,
    rejection_error: &'static str,
) -> Result<(), AppError> {
    let client = webhook_client(target, timeout).c(h!())?;
    client
        .post(target.url.clone())
        .json(payload)
        .send()
        .await
        .map_err(|_| AppError::BL {
            msg: transport_error.to_string(),
        })
        .c(h!())?
        .error_for_status()
        .map_err(|_| AppError::BL {
            msg: rejection_error.to_string(),
        })
        .c(h!())?;
    Ok(())
}

fn webhook_client(
    target: &WebhookTarget,
    timeout: Duration,
) -> Result<reqwest::Client, AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    let client = if let Some(hostname) = target.hostname.as_deref() {
        client.resolve_to_addrs(hostname, &target.addresses)
    } else {
        client
    };
    client.build().map_err(|_| AppError::BL {
        msg: "Mattermost client initialization failed".to_string(),
    })
}

fn validate_webhook_addresses(
    addresses: &[SocketAddr],
) -> Result<(), AppError> {
    if addresses.is_empty()
        || addresses.iter().any(|address| !is_public_ip(address.ip()))
    {
        return Err(AppError::BL {
            msg: "Mattermost webhook must resolve only to public IPs"
                .to_string(),
        });
    }
    Ok(())
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_broadcast()
                && !address.is_documentation()
        }
        IpAddr::V6(address) => address.to_ipv4_mapped().map_or_else(
            || {
                !address.is_loopback()
                    && !address.is_unspecified()
                    && !address.is_multicast()
                    && !address.is_unique_local()
                    && !address.is_unicast_link_local()
            },
            |address| is_public_ip(IpAddr::V4(address)),
        ),
    }
}

pub fn sanitize_field(value: &str, max_chars: usize) -> String {
    let value = value
        .chars()
        .take(max_chars)
        .map(|character| match character {
            '@' => '＠',
            '\n' | '\r' | '\t' => ' ',
            '`' => 'ˋ',
            '*' => '∗',
            '_' => '＿',
            '[' => '［',
            ']' => '］',
            '(' => '（',
            ')' => '）',
            '~' => '〜',
            character if character.is_control() => ' ',
            character => character,
        })
        .collect::<String>();
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn private_webhook_addresses_are_rejected() {
        let addresses = [SocketAddr::from(([127, 0, 0, 1], 443))];

        assert!(validate_webhook_addresses(&addresses).is_err());
    }

    #[tokio::test]
    async fn post_sends_json_payload() {
        let (target, request) = target_with_response(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;

        post(
            &target,
            Duration::from_secs(1),
            &json!({ "text": "test message" }),
            "transport failed",
            "endpoint rejected request",
        )
        .await
        .unwrap();

        let request = request.await.unwrap();
        assert!(request.starts_with("POST / HTTP/1.1\r\n"));
        assert!(request.contains("content-type: application/json"));
        assert!(request.ends_with("{\"text\":\"test message\"}"));
    }

    #[tokio::test]
    async fn post_rejects_error_statuses() {
        let (target, _request) = target_with_response(
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;

        let err = post(
            &target,
            Duration::from_secs(1),
            &json!({ "text": "test message" }),
            "transport failed",
            "endpoint rejected request",
        )
        .await
        .unwrap_err();

        assert!(format!("{err:#}").contains("endpoint rejected request"));
    }

    #[tokio::test]
    async fn post_does_not_follow_redirects() {
        let (target, _request) = target_with_response(
            b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;

        post(
            &target,
            Duration::from_secs(1),
            &json!({ "text": "test message" }),
            "transport failed",
            "endpoint rejected request",
        )
        .await
        .unwrap();
    }

    async fn target_with_response(
        response: &'static [u8],
    ) -> (WebhookTarget, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
                if request_is_complete(&request) {
                    break;
                }
            }
            request_tx
                .send(String::from_utf8(request).unwrap())
                .unwrap();
            stream.write_all(response).await.unwrap();
        });
        (
            WebhookTarget {
                url: Url::parse(&format!("http://{address}/")).unwrap(),
                hostname: None,
                addresses: vec![],
            },
            request_rx,
        )
    }

    fn request_is_complete(request: &[u8]) -> bool {
        let Some(headers_end) =
            request.windows(4).position(|part| part == b"\r\n\r\n")
        else {
            return false;
        };
        let headers_end = headers_end + 4;
        let headers = String::from_utf8_lossy(&request[..headers_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|value| value.parse::<usize>().ok())
            })
            .unwrap_or_default();
        request.len() >= headers_end + content_length
    }
}
