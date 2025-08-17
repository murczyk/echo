use crate::config::Config;
use crate::delta::login::types::*;
use crate::types::*;
use actix_web::web::Query;
use anyhow::{bail, Context};
use base64::Engine;
use itertools::Itertools;
use oauth2::basic::BasicClient;
use oauth2::*;
use reqwest::Client;
use std::char::decode_utf16;
use std::str::from_utf8;

pub async fn handle_receive_code(
    env: actix_web::web::Data<Env>,
    req: actix_web::HttpRequest,
) -> anyhow::Result<UserInfo> {
    let authority = crate::utils::http::extract_authority_header(&req);
    let is_echoua =
        authority.clone().filter(|x| x.contains("echoua")).is_some();

    let query_str = req.query_string().to_owned();
    let params = Query::<Params>::from_query(&query_str)
        .context("failed to parse params")?;
    let code = &params.code;
    let result = login(&env.config, code.clone(), is_echoua).await;
    let (token, _) = result.context("bad request")?;
    let user_info =
        decode_token(&token).context("failed to extract user info")?;
    Ok(user_info)
}

pub async fn login(
    config: &Config,
    code: String,
    is_echoua: bool,
) -> anyhow::Result<(String, Option<String>)> {
    let (http_client, client) =
        build_clients(config, is_echoua).context(h!())?;

    let code = AuthorizationCode::new(code.clone());

    let token_res =
        client.exchange_code(code).request_async(&http_client).await;

    match token_res {
        Ok(tokens) => {
            let access_token = tokens.access_token().secret().clone();
            let refresh_token =
                tokens.refresh_token().map(|x| x.secret().clone());
            Ok((access_token, refresh_token))
        }
        Err(RequestTokenError::Parse(err, data)) => {
            let data = from_utf8(&data).context(h!())?;
            error!(
                "failed to obtain token: {}; received: {} {}",
                err,
                data,
                h!()
            );
            bail!(err)
        }
        Err(e) => bail!(e),
    }
}

pub async fn build_auth_url(
    config: &Config,
    is_echoua: bool,
) -> anyhow::Result<String> {
    let (_, client) = build_clients(config, is_echoua).context(h!())?;

    let mut url_builder = client.authorize_url(CsrfToken::new_random);
    let api_config = config.secret_config().context(h!())?;
    let scopes = api_config.scope.split(",").collect::<Vec<_>>();
    for scope in scopes {
        url_builder = url_builder.add_scope(Scope::new(String::from(scope)));
    }
    let res = String::from(url_builder.url().0.as_str());
    let claims = urlencoding::encode(&api_config.claims_json);
    let res = format!("{res}&claims={claims}");
    debug!("auth url: {res}");
    Ok(res)
}

pub fn build_clients(
    main_config: &Config,
    is_echoua: bool,
) -> anyhow::Result<Clients> {
    let config = main_config.secret_config().context(h!())?;
    let auth_url = config.auth_url.clone();

    let client_id = ClientId::new(config.client_id.clone());
    let client_secret = ClientSecret::new(config.client_secret.clone());
    let auth_url = AuthUrl::new(auth_url).context(h!())?;
    let token_url =
        TokenUrl::new(config.token_endpoint.clone()).context(h!())?;

    let redirect_url = if is_echoua {
        match config.redirect_url_echoua.clone() {
            Some(url) => url,
            None => config.redirect_url.clone(),
        }
    } else {
        config.redirect_url.clone()
    };
    debug!("redirect url: {redirect_url}");
    let client: Oauth2Cli = BasicClient::new(client_id)
        .set_client_secret(client_secret)
        .set_auth_uri(auth_url)
        .set_token_uri(token_url)
        .set_redirect_uri(
            RedirectUrl::new(redirect_url).context("Invalid redirect URL")?,
        );

    let referer_url = format!("https://{}/login", main_config.public_host);
    debug!("referer url: {referer_url}");
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Referer", referer_url.parse().context(h!())?);
    // headers.insert("Referer", current_url_str.parse().unwrap());
    let http_client: Client = oauth2::reqwest::ClientBuilder::new()
        // Following redirects opens the client up to SSRF vulnerabilities.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(config.user_agent.clone())
        .default_headers(headers)
        .build()
        .context("failed to build oauth client")?;
    let clients: Clients = (http_client, client);
    Ok(clients)
}

fn decode_token(token: &str) -> Option<UserInfo> {
    let segment = token.split(".").collect_vec()[1];
    '_if: {
        let Ok(decoded_bytes) =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(segment)
        else {
            break '_if;
        };
        let Ok(decoded_str) = String::from_utf8(decoded_bytes) else {
            break '_if;
        };
        return serde_json::from_str::<UserInfo>(&decoded_str).ok();
    }
    None
}

pub fn read_string(slice: Vec<u8>) -> Option<String> {
    let size = slice.len() / 2;
    let iter =
        (0..size).map(|i| u16::from_be_bytes([slice[2 * i], slice[2 * i + 1]]));
    decode_utf16(iter).collect::<Result<String, _>>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_token() {
        let input = "eyJraWQiOiJmYjdmMGRiYy1iMTE1LTQwMzQtOTUzNS1hMDZkZTBiNDU4MzMiLCJhbGciOiJSUzI1NiJ9.eyJlbnRyeVVVSUQiOiJmNzIxNWI4ZC1lOTM1LTRlMGMtODExMi04NTAyNmM5OTMzMTAiLCJzdWIiOiJrcmFiYnkiLCJhdXRoZW50aWNhdGVkIjp0cnVlLCJnZW5lcmF0aXZlVW5pdCI6eyJpZCI6ImUxNzE0NThmLWJiNTQtNGQyNy1hY2EyLWFjODBmMzc1YmNhNSIsIm5hbWUiOiLQldCl0J4ifSwidXNlcl9uYW1lIjoia3JhYmJ5IiwiZGlzcGxheU5hbWUiOiLQndGW0LrRltGC0ZbQvSDQkNC90LTRgNGW0Lkg0JTQvNC40YLRgNC-0LLQuNGHIiwiaXNzIjoiaHR0cHM6Ly9zdGcuZGVsdGEubWlsLmdvdi51YS9hdXRoIiwibWZhIjoiRklETyIsImF1dGhvcml6YXRpb25fZ3JhbnRfdHlwZSI6ImF1dGhvcml6YXRpb25fY29kZSIsImNsaWVudF9pZCI6IjAxYzE1YTQwLTZmZDktNDYzNy1hNjliLWM5NjEyNzc1NzI4YyIsImF1dGhvcml0aWVzIjpbIkRFTFRBX0NIQVQiLCJERUxUQV9EUklWRSIsIkRFTFRBX01PTklUT1IiLCJERUxUQV9VU0VSIiwiU1dBR0dFUiIsIlNlYyBTZXJ2aWNlIiwiU2VjIFNlcnZpY2UgMyIsIlNlYyBTZXJ2aWNlIDQiLCJTZWMgU2VydmljZTIiLCJWRU5ET1JfU1dBR0dFUl9WSUVXRVIiXSwiYXVkIjoiMDFjMTVhNDAtNmZkOS00NjM3LWE2OWItYzk2MTI3NzU3MjhjIiwibmJmIjoxNzMzNTU2Mjg5LCJvcGVyYXRpdmVVbml0Ijp7ImlkIjoiZTE3MTQ1OGYtYmI1NC00ZDI3LWFjYTItYWM4MGYzNzViY2E1IiwibmFtZSI6ItCV0KXQniJ9LCJzY29wZSI6WyJvdmVybGF5OnJlYWQiLCJvYmplY3Q6cmVhZCIsImF0dGFjaG1lbnQ6cmVhZCIsIm9wZW5pZCIsIlZFTkRPUiIsIm9iamVjdDp3cml0ZSIsImF0dGFjaG1lbnQ6d3JpdGUiXSwidXNlclBvc2l0aW9uIjoi0J7Qv9C10YDQsNGC0L7RgCDQstGW0LTQtNGW0LvQtdC90L3RjyDRgNCw0LTRltC-0LXQu9C10LrRgtGA0L7QvdC90L7RlyDRgNC-0LfQstGW0LTQutC4INCy0LfQstC-0LTRgyDRgNCw0LTRltC-0LXQu9C10LrRgtGA0L7QvdC90L7RlyDRgNC-0LfQstGW0LTQutC4INGA0L7RgtC4INGA0LDQtNGW0L7QtdC70LXQutGC0YDQvtC90L3QvtGXINGA0L7Qt9Cy0ZbQtNC60Lgg0LHQsNGC0LDQu9GM0LnQvtC90YMg0YLQtdGF0L3RltGH0L3QuNGFINC30LDRgdC-0LHRltCyINGA0L7Qt9Cy0ZbQtNC60LgiLCJleHAiOjE3MzM1NTY1ODksImlhdCI6MTczMzU1NjI4OSwiY2xpZW50X25hbWUiOiLQldCl0J4iLCJvcGVyYXRpb24iOnsiaWQiOiI5YTI0YmQyOC0xYjE1LTIyZmYtZmFmMS1kMDMzZDU1NzI5ZjYiLCJuYW1lIjoiSW50ZWdyYXRpb25PcHMifSwianRpIjoiNjFhZmZhMjAtYjYxYi00OTM3LTgyN2UtYmU0YzA2NmI1ZWVhIiwiZW1haWwiOiJhbmRyaWkuZC5uaWtpdGluQGdtYWlsLmNvbSJ9.f-6tRfbSiQ4Crl9-xDVl59tNGCdl0xPhpSBYCyjf5dpxlNQXOaNq3P8xzTzaoN_i_9ZEk9LmD6ZxdtYR3Q29NvjsqWUb_C6d82LucbuRFdz-brAzewc3Lf9VCOXLPFzoiZl5zgyJy68albDPjxHovVa1OMFa-Nlf0uOqKMjsGUVrMFnEbYuiwd26rGUpqBdbnnYZOGvXmU5Qc0M0B1BkRYrTfcDmrg9h354WXNJ_qZf6QAt3G3v8EqPcnIYE8dB6iDZaDSGD438uslMDOEK3hmWo11dk6UXDWGM6bBYBBa-Le_HdW6ApFGQ9RyHLo4hv6QmGfbNKsxUITg0TCKfOFQ";
        let output = decode_token(input).unwrap();
        assert_eq!(output.user_name, "krabby");
    }
}
