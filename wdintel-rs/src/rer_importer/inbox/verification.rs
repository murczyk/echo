use super::*;

pub(crate) async fn run(
    mode: Mode,
    request: crate::CompareInboxPs,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("PGOPTIONS").as_deref()
            == Ok(ANALYTICS_VERIFY_PGOPTIONS),
        "set PGOPTIONS={ANALYTICS_VERIFY_PGOPTIONS:?} before starting the verifier"
    );
    let payload = tokio::fs::read_to_string(&request.request_path)
        .await
        .c(h!())?;
    let req: InboxMessagesReq = serde_json::from_str(&payload).c(h!())?;
    anyhow::ensure!(
        req.nolimit != Some(true)
            && (!inbox_request_is_unbounded(&req)
                || req.load_latest == Some(true)),
        "verification requires a limited inbox request"
    );
    let env = crate::server::new_readonly_env(mode).await.c(h!())?;
    let login = crate::users::login_id_by_name(&env.dbx, &request.login)
        .await
        .c(h!())?;
    crate::users::ensure_rer_role_by_id(&env.dbx, &login)
        .await
        .c(h!())?;
    let logins = crate::users::get_organism_login_ids_by_id(&env.dbx, &login)
        .await
        .c(h!())?;
    let before = primary_result(&login, &logins, &env, &req).await.c(h!())?;
    let mut diagnostics = InboxReadDiagnostics::new(req.page_id.as_deref());
    let result = tokio::time::timeout(
        core::time::Duration::from_millis(ANALYTICS_VERIFY_TIMEOUT_MS),
        get_inbox_messages_with_analytics_candidates_inner(
            &login,
            &logins,
            &env,
            &req,
            &mut diagnostics,
        ),
    )
    .await
    .c(h!())?;
    diagnostics.finish(&result);
    let route = diagnostics.route;
    let reason = diagnostics.reason;
    drop(diagnostics);
    let result = result.c(h!())?;
    let result = serde_json::to_value(&result).c(h!())?;
    let after = primary_result(&login, &logins, &env, &req).await.c(h!())?;
    anyhow::ensure!(before == after, "primary inputs changed during replay");
    anyhow::ensure!(result == before, "primary/gateway inbox result mismatch");
    anyhow::ensure!(
        !request.require_hybrid || route == "analytics_hybrid",
        "hybrid completion required: route={} reason={}",
        route,
        reason
    );
    let digest = tokio::time::timeout(
        core::time::Duration::from_millis(ANALYTICS_VERIFY_TIMEOUT_MS),
        verify_digest(&login, env, &req),
    )
    .await
    .c(h!())?
    .c(h!())?;
    println!(
        "{}",
        serde_json::json!({
            "matched": true,
            "route": route,
            "reason": reason,
            "rows": result.as_array().map(Vec::len),
            "request_sha256": sha256::digest(payload),
            "result_sha256": sha256::digest(result.to_string()),
            "digest_matched": true,
            "digest_count": digest.0,
        })
    );
    Ok(())
}

async fn verify_digest(
    login: &Uuid,
    env: Arc<Env>,
    req: &InboxMessagesReq,
) -> anyhow::Result<InboxDigest> {
    let query = build_inbox_digest_query(login, &env, req).await.c(h!())?;
    let before = query_inbox_digest(env.dbx.clone(), query.clone())
        .await
        .c(h!())?;
    let result = query_inbox_digest_with_analytics(
        *login,
        Data::from(env.clone()),
        req.clone(),
        false,
        query.clone(),
    )
    .await
    .c(h!())?;
    let after = query_inbox_digest(env.dbx.clone(), query).await.c(h!())?;
    anyhow::ensure!(before == after, "primary digest changed during replay");
    anyhow::ensure!(result == before, "primary/gateway digest mismatch");
    Ok(result)
}

async fn primary_result(
    login: &Uuid,
    logins: &Vec<Uuid>,
    env: &Env,
    req: &InboxMessagesReq,
) -> anyhow::Result<serde_json::Value> {
    let result = tokio::time::timeout(
        core::time::Duration::from_millis(ANALYTICS_VERIFY_TIMEOUT_MS),
        get_inbox_messages(login, logins, env, req),
    )
    .await
    .c(h!())?
    .c(h!())?;
    serde_json::to_value(result).c(h!())
}
