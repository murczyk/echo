use super::*;
use crate::error::AppError;

#[tokio::test]
#[serial_test::serial]
async fn device_document_authorization_rechecks_linked_human_3064() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let human = reader(&env).await;
    let foreign = reader(&env).await;
    let visible = device(&env, &human).await;
    let hidden = device(&env, &foreign).await;
    let agent = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["ApiAgent", "Cyber", "Rer"])),
            organism_id: Set(foreign.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    ai_agent_user_link::ActiveModel {
        id: Set(Uuid::now_v7()),
        human_login_id: Set(human.id),
        agent_login_id: Set(agent.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let resolved = access::reader(&env, agent.id).await.unwrap();
    assert_eq!(resolved.id, human.id);
    access::authorize(&env, &resolved, visible.id)
        .await
        .unwrap();
    assert!(access::authorize(&env, &resolved, hidden.id).await.is_err());
    assert_eq!(
        access::visible_ids(&env, &resolved, false).await.unwrap(),
        vec![visible.id]
    );
    let mut archived = visible.into_active_model();
    archived.archived = Set(true);
    archived.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
    let archived = archived.update(&env.dbx).await.unwrap();
    assert!(access::visible_ids(&env, &resolved, false)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        access::visible_ids(&env, &resolved, true).await.unwrap(),
        vec![archived.id]
    );
    let mut restricted = human.clone().into_active_model();
    restricted.roles = Set(json!(["CyberViewerRestricted"]));
    restricted.update(&env.dbx).await.unwrap();
    for id in [human.id, agent.id] {
        assert!(matches!(
            access::reader(&env, id).await,
            Err(AppError::Forbidden(_))
        ));
        assert!(!access::available(&env, id).await);
        assert!(matches!(
            crate::devices::access::require_message_devices(&env.dbx, &id)
                .await,
            Err(AppError::Forbidden(_)),
        ));
    }
    let mut agent = agent.into_active_model();
    agent.roles = Set(json!(["Cyber"]));
    let agent = agent.update(&env.dbx).await.unwrap();
    assert!(matches!(
        crate::devices::access::require_message_devices(&env.dbx, &agent.id)
            .await,
        Err(AppError::Forbidden(_)),
    ));
    let mut agent = agent.into_active_model();
    agent.roles = Set(json!(["ApiAgent", "Cyber", "Rer"]));
    let agent = agent.update(&env.dbx).await.unwrap();
    let mut restored = human.clone().into_active_model();
    restored.roles = Set(json!(["CyberViewerRestricted", "CyberViewer"]));
    restored.update(&env.dbx).await.unwrap();
    access::reader(&env, agent.id).await.unwrap();
    crate::devices::access::require_message_devices(&env.dbx, &agent.id)
        .await
        .unwrap();

    let mut revoked = human.into_active_model();
    revoked.roles = Set(json!(["Rer"]));
    revoked.update(&env.dbx).await.unwrap();
    assert!(access::reader(&env, agent.id).await.is_err());
    assert!(!access::available(&env, agent.id).await);
}
