use std::collections::HashSet;

use self::types::*;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crate::utils::*;

pub mod types;

pub async fn check_ready(rq: &reqwest::Client) -> anyhow::Result<()> {
    check_ready_at(rq, crate::config::NLP_ADDR).await
}

async fn check_ready_at(
    rq: &reqwest::Client,
    address: &str,
) -> anyhow::Result<()> {
    let url = format!("{address}/health/ready");
    let rsp = rq
        .get(url)
        .timeout(core::time::Duration::from_millis(
            crate::config::MESSENGER_NLP_READY_REQUEST_TIMEOUT_MS,
        ))
        .send()
        .await
        .c(h!())?;
    check_status(rsp).c(h!())?;
    Ok(())
}

pub async fn tokenize_words(
    rq: &reqwest::Client,
    sentence: &str,
) -> Result<Vec<WordToken>, AppError> {
    let local_url = format!("{}/api/tokenize/words", crate::config::NLP_ADDR);
    let req = TokenizeWordsPyReq {
        sentence: sentence.to_string(),
    };
    let rsp = rq
        .post(&local_url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&req).c(h!())?)
        .send()
        .await
        .c(h!())?;
    let rsp = check_status(rsp).c(h!())?;
    let rsp_t = rsp.text().await.c(h!())?;
    let rsp_e: Result<TokenizeWordsPyRsp, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let rsp_data = rsp_e.c(h!())?;
    Ok(rsp_data.words)
}

pub async fn token_lexemes(
    rq: &reqwest::Client,
    token: &str,
) -> Result<Vec<String>, AppError> {
    let local_url = format!("{}/api/token/lexeme", crate::config::NLP_ADDR);
    let req = TokenNormalFormPyReq {
        token: token.to_string(),
    };
    let rsp = rq
        .post(&local_url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&req).c(h!())?)
        .send()
        .await
        .c(h!())?;
    let rsp_t = rsp.text().await.c(h!())?;
    let rsp_e: Result<TokenNormalFormPyRsp, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let rsp_data = rsp_e.c(h!())?;
    Ok(rsp_data.lexeme)
}

pub async fn token_lexemes_batch(
    rq: &reqwest::Client,
    tokens: Vec<String>,
) -> Result<Vec<Vec<String>>, AppError> {
    let local_url =
        format!("{}/api/token/lexeme/batch", crate::config::NLP_ADDR);
    let req = TokenNormalFormBatchPyReq { tokens };
    let rsp = rq
        .post(&local_url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&req).c(h!())?)
        .send()
        .await
        .c(h!())?;
    let rsp = crate::utils::check_status(rsp).c(h!())?;
    let rsp_t = rsp.text().await.c(h!())?;
    let rsp_e: Result<Vec<TokenNormalFormPyRsp>, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let rsp_data = rsp_e.c(h!())?;
    let result: Vec<Vec<String>> =
        rsp_data.into_iter().map(|x| x.lexeme).collect();
    Ok(result)
}

pub async fn predict_tags(
    rq: &reqwest::Client,
    texts: Vec<String>,
    tags: Option<HashSet<String>>,
) -> Result<Vec<PredictTagsPyRsp>, AppError> {
    let local_url = format!("{}/api/tags/predict", crate::config::NLP_ADDR);
    let req = PredictTagsPyReq {
        texts,
        tags: tags.unwrap_or_default(),
    };
    let rsp = rq
        .post(&local_url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&req).c(h!())?)
        .send()
        .await
        .c(h!())?;
    let rsp_t = rsp.text().await.c(h!())?;
    let rsp_e: Result<Vec<PredictTagsPyRsp>, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let rsp_data = rsp_e.c(h!())?;
    Ok(rsp_data)
}

pub async fn complete_callsigns(
    rq: &reqwest::Client,
    message: &str,
) -> Result<Vec<String>, AppError> {
    if !crate::config::FEATURE_CALLSIGNS_ALG2 {
        return Ok(vec![]);
    }
    let local_url =
        format!("{}/api/completions/callsigns", crate::config::NLP_ADDR);
    let req = CompleteCallsignReq {
        message: message.to_string(),
    };
    let rsp = rq
        .post(&local_url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&req).c(h!())?)
        .send()
        .await
        .c(h!())?;
    let rsp_t = rsp.text().await.c(h!())?;
    let rsp_e: Result<CompleteCallsignRsp, serde_json::Error> =
        serde_json::from_str(&rsp_t);
    if let Err(ref e) = rsp_e {
        println!("> error: {e:?}\nrsp_t: {rsp_t}");
    }
    let rsp_data = rsp_e.c(h!())?;
    if rsp_data.completions.is_empty() {
        return Ok(vec![]);
    }
    let comp_s = rsp_data.completions[0].clone();
    Ok(uniq_via_btreeset(
        &comp_s
            .split(", ")
            .map(|x| x.trim().to_lowercase())
            .filter(|x| !x.is_empty())
            .collect::<Vec<String>>(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve_health_response(status: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn ready_check_accepts_successful_response() {
        let address = serve_health_response("200 OK").await;
        check_ready_at(&reqwest::Client::new(), &address)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn ready_check_rejects_error_response() {
        let address = serve_health_response("503 Service Unavailable").await;
        assert!(check_ready_at(&reqwest::Client::new(), &address)
            .await
            .is_err());
    }
}
