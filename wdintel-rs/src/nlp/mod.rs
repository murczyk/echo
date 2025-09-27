use self::types::*;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crate::utils::*;

pub mod types;

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
