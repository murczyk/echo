use crate::config;
use crate::types::*;
use actix_identity::Identity;
use actix_session::SessionExt;
use actix_web::{
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    Error,
};
use redis::aio::ConnectionManager;
use redis::{AsyncCommands, RedisResult};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;
use tokio::task_local;
use uuid::Uuid;

/// JSON value stored in Redis representing request, response and timing details
/// We store both request before and after the response is sent in order to track hanging requests.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ActivityDetails {
    pub request_id: String,
    pub timestamp: i64,
    pub request_method: String,
    pub request_path: String,
    pub request_hostname: Option<String>,
    pub request_query_params: Option<HashMap<String, String>>,
    pub request_headers: Option<HashMap<String, String>>,
    pub request_body: Option<String>,
    pub request_content_type: Option<String>,
    pub response_status: Option<u16>,
    pub response_time_ms: Option<u64>,
    pub event_type: String, // "request" or "response"
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RequestLogContext {
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub query_string: Option<String>,
    pub query_params: Option<HashMap<String, String>>,
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
    pub username: Option<String>,
    pub session_id: Option<String>,
}

task_local! {
    static REQUEST_LOG_CONTEXT: RequestLogContext;
}

pub fn request_log_context() -> Option<RequestLogContext> {
    REQUEST_LOG_CONTEXT.try_with(|ctx| ctx.clone()).ok()
}

pub async fn request_context_middleware<B>(
    mut req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<B>, Error>
where
    B: MessageBody,
{
    if !config::FEATURE_ERROR_CONTEXT {
        return next.call(req).await;
    }

    let method = req.method().to_string();
    let path = req.path().to_string();
    let query_string = {
        let raw = req.query_string();
        if raw.is_empty() {
            None
        } else {
            Some(raw.to_string())
        }
    };
    let query_params = query_string.as_ref().map(|qs| parse_query_params(qs));
    let client_ip = req
        .connection_info()
        .realip_remote_addr()
        .map(|s| s.to_string());
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|ua| ua.to_str().ok())
        .map(|s| s.to_string());
    let session_id = req.get_session().get::<String>("id").ok().flatten();
    let username = match req.extract::<Option<Identity>>().await {
        Ok(Some(identity)) => identity.id().ok(),
        _ => None,
    };

    let context = RequestLogContext {
        request_id: Uuid::new_v4().to_string(),
        method,
        path,
        query_string,
        query_params,
        client_ip,
        user_agent,
        username,
        session_id,
    };

    REQUEST_LOG_CONTEXT
        .scope(context, async move { next.call(req).await })
        .await
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// Activity middleware with Redis connection for tracking requests.
///
/// This middleware requires a Redis `ConnectionManager` to track API activity,
/// implement rate limiting, or perform other Redis-based operations.
///
/// Note: This function cannot be used directly with `from_fn` due to the extra
/// parameter. Use `mk_activity_middleware` to create a closure-based version.
///
/// # Arguments
/// * `req` - The incoming service request
/// * `next` - The next middleware in the chain
/// * `redis_conn` - A Redis `ConnectionManager` for data operations
pub async fn activity_middleware<B>(
    req: ServiceRequest,
    next: Next<B>,
    redis_conn: Option<ConnectionManager>,
) -> Result<ServiceResponse<B>, Error>
where
    B: MessageBody,
{
    let start_time = Instant::now();
    let request_id = Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp();

    // Extract request details
    let method = req.method().to_string();
    let path = req.path().to_string();
    let query_string = req.query_string();

    // Parse query parameters
    let query_params = if query_string.is_empty() {
        None
    } else {
        Some(parse_query_params(query_string))
    };

    // Extract headers
    let headers = Some(
        req.headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.to_string(), v.to_string()))
            })
            .collect::<HashMap<String, String>>(),
    );

    // Get content type
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|ct| ct.to_str().ok())
        .map(|s| s.to_string());

    // Get client IP
    let client_ip = req
        .connection_info()
        .realip_remote_addr()
        .map(|s| s.to_string());

    // Get user agent
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|ua| ua.to_str().ok())
        .map(|s| s.to_string());

    // Get hostname from Host header
    let request_hostname = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    // Extract body for POST requests if it's JSON or form data
    let mut request_body = None;
    if method == "POST" || method == "PUT" || method == "PATCH" {
        if let Some(ct) = &content_type {
            if ct.contains("application/json")
                || ct.contains("application/x-www-form-urlencoded")
            {
                // IMPORTANT: Reading the request body here would consume the stream,
                // preventing the actual handler from accessing it. To capture request bodies,
                // you would need to implement a different approach such as:
                // 1. Using a request extension to store the body after the handler processes it
                // 2. Implementing a custom body wrapper that allows multiple reads
                // 3. Using a reverse proxy layer that logs requests before they reach the app
                // For now, we leave request_body as None to avoid breaking the application
                request_body = None;
            }
        }
    }

    // Create initial activity details for request
    let request_activity = ActivityDetails {
        request_id: request_id.clone(),
        timestamp,
        request_method: method.clone(),
        request_path: path.clone(),
        request_hostname: request_hostname.clone(),
        request_query_params: query_params,
        request_headers: headers.clone(),
        request_body,
        request_content_type: content_type,
        response_status: None,
        response_time_ms: None,
        event_type: "request".to_string(),
        client_ip: client_ip.clone(),
        user_agent: user_agent.clone(),
    };

    // Store request event in Redis
    if let Some(mut redis) = redis_conn.clone() {
        let _ = store_activity_in_redis(&mut redis, &request_activity).await;
    }

    // Call next middleware/handler
    let result = next.call(req).await;

    // Post-processing
    match &result {
        Ok(response) => {
            let response_time_ms = start_time.elapsed().as_millis() as u64;
            let status_code = response.response().status().as_u16();

            // Create response activity details
            let response_activity = ActivityDetails {
                request_id: request_id.clone(),
                timestamp: chrono::Utc::now().timestamp(),
                request_method: method,
                request_path: path,
                request_hostname,
                request_query_params: None,
                request_headers: None,
                request_body: None,
                request_content_type: None,
                response_status: Some(status_code),
                response_time_ms: Some(response_time_ms),
                event_type: "response".to_string(),
                client_ip,
                user_agent,
            };

            // Store response event in Redis
            if let Some(mut redis) = redis_conn {
                let _ = store_activity_in_redis(&mut redis, &response_activity)
                    .await;
            }
        }
        Err(_) => {
            // Even on error, we might want to log the response
            let response_time_ms = start_time.elapsed().as_millis() as u64;

            let error_activity = ActivityDetails {
                request_id: request_id.clone(),
                timestamp: chrono::Utc::now().timestamp(),
                request_method: method,
                request_path: path,
                request_hostname,
                request_query_params: None,
                request_headers: None,
                request_body: None,
                request_content_type: None,
                response_status: Some(500),
                response_time_ms: Some(response_time_ms),
                event_type: "error".to_string(),
                client_ip,
                user_agent,
            };

            if let Some(mut redis) = redis_conn {
                let _ =
                    store_activity_in_redis(&mut redis, &error_activity).await;
            }
        }
    }

    result
}

/// Store activity details in Redis with TTL and maintain capped collection
async fn store_activity_in_redis(
    redis: &mut ConnectionManager,
    activity: &ActivityDetails,
) -> RedisResult<()> {
    let collection_key = "echo-md-requests";
    let activity_json = serde_json::to_string(activity).unwrap_or_default();
    let member_key = format!("{}:{}", activity.timestamp, activity.request_id);

    // Add to sorted set (using timestamp as score for ordering)
    let _: () = redis
        .zadd(collection_key, &member_key, activity.timestamp)
        .await?;

    // Store the actual data with TTL
    let data_key = format!("{collection_key}:{member_key}");
    let _: () = redis.set_ex(&data_key, activity_json, 3600).await?; // 1 hour TTL

    // Maintain cap of 10000 elements
    let count: i64 = redis.zcard(collection_key).await?;
    if count > 10000 {
        // Remove oldest elements
        let to_remove = count - 10000;
        let removed_members: Vec<String> = redis
            .zrange(collection_key, 0, (to_remove - 1) as isize)
            .await?;

        // Remove from sorted set
        if !removed_members.is_empty() {
            let _: () = redis.zrem(collection_key, &removed_members).await?;

            // Delete associated data keys
            for member in removed_members {
                let data_key = format!("{collection_key}:{member}");
                let _: () = redis.del(&data_key).await?;
            }
        }
    }

    // Refresh TTL on the sorted set
    let _: () = redis.expire(collection_key, 3600).await?;

    Ok(())
}

/// Creates an activity middleware with optional access to Redis connection.
///
/// This factory function returns a middleware closure that has access to an optional
/// Redis `ConnectionManager`, allowing you to track API activity, rate limiting, or
/// other Redis-based operations within the middleware when Redis is available.
///
/// # Arguments
/// * `redis_conn` - An optional Redis `ConnectionManager` that will be cloned for each request
///
/// # Returns
/// A closure that can be used with `actix_web::middleware::from_fn`
///
/// # Example
/// ```
/// let redis_client = redis::Client::open("redis://127.0.0.1:6379/")?;
/// let redis_conn = ConnectionManager::new(redis_client).await?;
/// let activity_middleware = mk_activity_middleware(Some(redis_conn));
///
/// // Or without Redis:
/// let activity_middleware = mk_activity_middleware(None);
///
/// App::new()
///     .wrap(actix_web::middleware::from_fn(activity_middleware.clone()))
/// ```
pub fn mk_activity_middleware<B>(
    redis_conn: Option<ConnectionManager>,
) -> impl Fn(
    ServiceRequest,
    Next<B>,
) -> Pin<Box<dyn Future<Output = Result<ServiceResponse<B>, Error>>>>
       + Clone
where
    B: MessageBody + 'static,
{
    move |req: ServiceRequest, next: Next<B>| {
        let redis_conn = redis_conn.clone();
        Box::pin(
            async move { activity_middleware(req, next, redis_conn).await },
        )
    }
}

/// Background worker that collects activity details from Redis and batch inserts into GreptimeDB
pub async fn activity_details_worker(
    mut redis: redis::aio::ConnectionManager,
    greptimedb: deadpool_postgres::Pool,
) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let collection_key = "echo-md-requests";

        // Get all members from sorted set
        let members: Result<Vec<(String, f64)>, _> =
            redis.zrange_withscores(collection_key, 0, -1).await;

        let members = match members {
            Ok(m) if !m.is_empty() => m,
            _ => continue, // Skip if no activities or error
        };

        let mut activities = Vec::new();
        let mut keys_to_delete = Vec::new();

        // Collect all activities
        for (member, _score) in &members {
            let data_key = format!("{collection_key}:{member}");
            keys_to_delete.push(data_key.clone());

            let data: Result<Option<String>, _> = redis.get(&data_key).await;
            if let Ok(Some(json_data)) = data {
                if let Ok(activity) =
                    serde_json::from_str::<ActivityDetails>(&json_data)
                {
                    activities.push(activity);
                }
            }
        }

        if activities.is_empty() {
            continue;
        }

        // Insert into GreptimeDB
        if let Ok(client) = greptimedb.get().await {
            // Build bulk insert SQL
            let mut sql = String::from(
                "INSERT INTO activity_details (ts, request_id, request_method, request_path, request_hostname,
                 request_query_params, request_headers, request_body, request_content_type,
                 response_status, response_time_ms, event_type, client_ip, user_agent)
                 VALUES\n"
            );

            let mut first = true;
            for activity in &activities {
                let ts =
                    chrono::DateTime::from_timestamp(activity.timestamp, 0)
                        .map(|dt| dt.naive_utc())
                        .unwrap_or_else(|| chrono::Utc::now().naive_utc());

                // Convert HashMaps to JSON for GreptimeDB
                let query_params_json = activity
                    .request_query_params
                    .as_ref()
                    .map(|p| {
                        serde_json::to_string(p)
                            .unwrap_or_else(|_| "null".to_string())
                    })
                    .unwrap_or_else(|| "null".to_string());
                let headers_json = activity
                    .request_headers
                    .as_ref()
                    .map(|h| {
                        serde_json::to_string(h)
                            .unwrap_or_else(|_| "null".to_string())
                    })
                    .unwrap_or_else(|| "null".to_string());

                let response_status = activity
                    .response_status
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "null".to_string());
                let response_time_ms = activity
                    .response_time_ms
                    .map(|t| t.to_string())
                    .unwrap_or_else(|| "null".to_string());

                if !first {
                    sql.push_str(",\n");
                }
                first = false;

                // Escape single quotes in string fields
                let escape_string = |s: &Option<String>| -> String {
                    match s {
                        Some(str) => format!("'{}'", str.replace("'", "''")),
                        None => "null".to_string(),
                    }
                };

                sql.push_str(&format!(
                    "    ('{}', '{}', '{}', '{}', {}, '{}', '{}', {}, {}, {}, {}, '{}', {}, {})",
                    ts.format("%Y-%m-%d %H:%M:%S"),
                    activity.request_id.replace("'", "''"),
                    activity.request_method.replace("'", "''"),
                    activity.request_path.replace("'", "''"),
                    escape_string(&activity.request_hostname),
                    query_params_json.replace("'", "''"),
                    headers_json.replace("'", "''"),
                    escape_string(&activity.request_body),
                    escape_string(&activity.request_content_type),
                    response_status,
                    response_time_ms,
                    activity.event_type.replace("'", "''"),
                    escape_string(&activity.client_ip),
                    escape_string(&activity.user_agent),
                ));
            }

            let mut success = true;
            if let Err(e) = client.simple_query(&sql).await {
                warn!("Failed to bulk insert activity_details: {e:?}");
                success = false;
            }

            // Only clean up Redis if all inserts were successful
            if success {
                // Remove from sorted set
                let member_keys: Vec<&str> =
                    members.iter().map(|(m, _)| m.as_str()).collect();
                let _: Result<(), _> =
                    redis.zrem(collection_key, &member_keys).await;

                // Delete individual data keys
                for key in &keys_to_delete {
                    let _: Result<(), _> = redis.del(key).await;
                }

                trace!("Processed {} activity records", activities.len());
            }
        }
    }
}
