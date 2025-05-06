use crate::types::*;
use chrono::prelude::*;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionActivity {
    pub start: NaiveDateTime,
    pub last_activity: NaiveDateTime,
    pub pages_time_spent_secs: BTreeMap<String, i32>,
    pub pages_filters: BTreeMap<String, BTreeSet<String>>,
}

impl Default for SessionActivity {
    fn default() -> Self {
        SessionActivity {
            start: Utc::now().naive_utc(),
            last_activity: Utc::now().naive_utc(),
            pages_time_spent_secs: BTreeMap::new(),
            pages_filters: BTreeMap::new(),
        }
    }
}

pub async fn record_new_session(
    user_id: &str,
    env: &actix_web::web::Data<Env>,
) -> anyhow::Result<()> {
    if let Some(greptime) = env.greptime() {
        let user_id = user_id.to_string();
        let public_host = env.config.public_host.clone();

        tokio::spawn(async move {
            let now = Utc::now().naive_utc();
            let id = Uuid::now_v7().to_string();
            let username = Some(user_id);
            let public_host = Some(public_host);

            let client = match greptime.get().await {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to get connection from pool: {:?}", e);
                    return;
                }
            };

            let stmt = match client.prepare(
                "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload) 
                 VALUES ($1, $2, $3, $4, $5, $6)"
            ).await {
                Ok(stmt) => stmt,
                Err(e) => {
                    warn!("Failed to prepare statement: {:?}", e);
                    return;
                }
            };

            let res = client
                .execute(
                    &stmt,
                    &[
                        &now,
                        &id,
                        &public_host,
                        &username,
                        &Option::<String>::None,
                        &Option::<serde_json::Value>::None,
                    ],
                )
                .await;

            if let Err(e) = res {
                warn!("Failed to insert activity_page_visit: {:?}", e);
            }
        });
    }

    Ok(())
}

pub async fn record_page_visit(
    user_id: &str,
    page: &Option<String>,
    env: &actix_web::web::Data<Env>,
    payload: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    if let Some(greptime) = env.greptime() {
        let user_id = user_id.to_string();
        let page = page.clone();
        let payload = payload.clone();
        // deadpool_postgres fails to write JSON, so we manually convert to Vec<u8> here
        let payload: Option<Vec<u8>> = match payload {
            Some(ref p) => {
                let str = serde_json::to_string(&p).context(h!())?;
                let bytes = str.as_bytes().to_vec();
                Some(bytes)
            }
            None => None,
        };
        let public_host = env.config.public_host.clone();

        tokio::spawn(async move {
            let now = Utc::now().naive_utc();
            let id = Uuid::now_v7().to_string();
            let username = Some(user_id);
            let public_host = Some(public_host);

            let client = match greptime.get().await {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to get connection from pool: {:?}", e);
                    return;
                }
            };

            let stmt = match client.prepare(
                "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload) 
                 VALUES ($1, $2, $3, $4, $5, $6)"
            ).await {
                Ok(stmt) => stmt,
                Err(e) => {
                    warn!("Failed to prepare statement: {:?}", e);
                    return;
                }
            };

            let res = client
                .execute(
                    &stmt,
                    &[&now, &id, &public_host, &username, &page, &payload],
                )
                .await;

            if let Err(e) = res {
                warn!("Failed to insert activity_page_visit: {:?}", e);
            }
        });
    }

    Ok(())
}
