use super::*;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{Database, Value};

static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DEFAULT_TEST_DATABASE_URL: &str =
    "postgres://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd";

#[derive(Clone)]
struct Fixture {
    namespace: String,
    client_id: i32,
    disabled_client_id: i32,
    account_id: i32,
    sender_id: i32,
    inbox_id: i32,
    private_chat_id: String,
    group_chat_id: String,
}

async fn test_db() -> anyhow::Result<DatabaseConnection> {
    let url = std::env::var("ECHO_MESSENGERS_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("ECHO_SWAPP_TEST_DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_string());
    Database::connect(url).await.c(h!())
}

fn test_config() -> Config {
    toml::from_str("").expect("empty test config must use defaults")
}

async fn insert_id(
    db: &DatabaseConnection,
    sql: &str,
    values: Vec<Value>,
) -> anyhow::Result<i32> {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .c(h!())?
    .c(h!())?
    .try_get("", "id")
    .c(h!())
}

async fn execute(
    db: &DatabaseConnection,
    sql: &str,
    values: Vec<Value>,
) -> anyhow::Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn create_fixture(db: &DatabaseConnection) -> anyhow::Result<Fixture> {
    let namespace =
        format!("chat-test-{}", Utc::now().timestamp_nanos_opt().c(h!())?);
    let client_id = insert_id(
        db,
        "insert into echo_client (name, display_name, show_chats_admin_panel) values ($1, $1, true) returning id",
        vec![namespace.clone().into()],
    )
    .await
    .c(h!())?;
    let disabled_client_id = insert_id(
        db,
        "insert into echo_client (name, display_name, show_chats_admin_panel) values ($1, $1, false) returning id",
        vec![format!("{namespace}-disabled").into()],
    )
    .await
    .c(h!())?;
    execute(
        db,
        "insert into echo_client_config (client_id, process_name, signal_api_attachment_path) values ($1, $2, $3)",
        vec![
            client_id.into(),
            namespace.clone().into(),
            format!("/tmp/{namespace}").into(),
        ],
    )
    .await
    .c(h!())?;
    let account_id = insert_id(
        db,
        "insert into echo_account (source, phone_number, is_linked, linked_at) values ($1::text::echo_message_source, $2, true, $3) returning id",
        vec![
            "signal".into(),
            format!("+380{:09}", client_id).into(),
            (Utc::now().naive_utc() - ChronoDuration::hours(3)).into(),
        ],
    )
    .await
    .c(h!())?;
    execute(
        db,
        "insert into echo_client_lock (client_id, account_id) values ($1, $2)",
        vec![client_id.into(), account_id.into()],
    )
    .await
    .c(h!())?;
    let participant_phone = format!("+38067{:06}", client_id);
    let sender_id = insert_id(
        db,
        "insert into echo_sender (uuid, name, phone_number, account_id) values ($1, $2, $3, $4) returning id",
        vec![
            format!("{namespace}-uuid").into(),
            "Контакт".into(),
            participant_phone.clone().into(),
            account_id.into(),
        ],
    )
    .await
    .c(h!())?;
    let recipient_id = insert_id(
        db,
        "insert into echo_recipient (phone_number, name, account_id) values ($1, $2, $3) returning id",
        vec![
            participant_phone.clone().into(),
            "Контакт".into(),
            account_id.into(),
        ],
    )
    .await
    .c(h!())?;
    let group_id = insert_id(
        db,
        "insert into echo_group (group_id, internal_id, name, account_id) values ($1, $1, $2, $3) returning id",
        vec![
            format!("{namespace}-group").into(),
            "Тестова група".into(),
            account_id.into(),
        ],
    )
    .await
    .c(h!())?;
    let inbox_id = insert_inbox(
        db,
        client_id,
        account_id,
        sender_id,
        None,
        "вхідне",
        Utc::now().naive_utc() - ChronoDuration::minutes(2),
    )
    .await
    .c(h!())?;
    let outbox_id = insert_id(
        db,
        "insert into echo_outbox_message (body, client_id) values ('вихідне', $1) returning id",
        vec![client_id.into()],
    )
    .await
    .c(h!())?;
    insert_id(
        db,
        "insert into echo_outbox_message_instance (status, message_id, recipient_id, account_id, sent_at) values ('sent', $1, $2, $3, $4) returning id",
        vec![
            outbox_id.into(),
            recipient_id.into(),
            account_id.into(),
            (Utc::now().naive_utc() - ChronoDuration::minutes(1)).into(),
        ],
    )
    .await
    .c(h!())?;
    for offset in 0..55 {
        insert_inbox(
            db,
            client_id,
            account_id,
            sender_id,
            Some(group_id),
            &format!("групове-{offset}"),
            Utc::now().naive_utc() - ChronoDuration::seconds(offset),
        )
        .await
        .c(h!())?;
    }
    let private_chat_id = encode_chat_id(&ChatKey {
        version: 1,
        client_id,
        account_id,
        kind: ChatKind::Private,
        target: format!("p:{participant_phone}"),
    })
    .c(h!())?;
    let group_chat_id = encode_chat_id(&ChatKey {
        version: 1,
        client_id,
        account_id,
        kind: ChatKind::Group,
        target: group_id.to_string(),
    })
    .c(h!())?;
    Ok(Fixture {
        namespace,
        client_id,
        disabled_client_id,
        account_id,
        sender_id,
        inbox_id,
        private_chat_id,
        group_chat_id,
    })
}

async fn insert_inbox(
    db: &DatabaseConnection,
    client_id: i32,
    account_id: i32,
    sender_id: i32,
    group_id: Option<i32>,
    body: &str,
    timestamp: NaiveDateTime,
) -> anyhow::Result<i32> {
    insert_id(
        db,
        "insert into echo_inbox_message (body, internal_id, sender_id, group_id, account_id, timestamp, client_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        vec![
            body.to_string().into(),
            format!("test-{client_id}-{}", Utc::now().timestamp_nanos_opt().c(h!())?).into(),
            sender_id.into(),
            group_id.into(),
            account_id.into(),
            timestamp.into(),
            client_id.into(),
        ],
    )
    .await
    .c(h!())
}

async fn cleanup_fixture(
    db: &DatabaseConnection,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    db.execute_unprepared(&format!(
        r#"
        delete from echo_message_reaction_queue where account_id = {account_id};
        delete from echo_outbox_message_reaction where account_id = {account_id};
        delete from echo_attachment where account_id = {account_id};
        delete from echo_outbox_message_attachment where message_id in (select id from echo_outbox_message where client_id = {client_id});
        delete from echo_outbox_message_instance where account_id = {account_id};
        delete from echo_outbox_message where client_id = {client_id};
        delete from echo_inbox_message where client_id = {client_id};
        delete from echo_client_lock where client_id = {client_id};
        delete from echo_client_config where client_id = {client_id};
        delete from echo_sender where account_id = {account_id};
        delete from echo_recipient where account_id = {account_id};
        delete from echo_group where account_id = {account_id};
        delete from echo_account where id = {account_id};
        delete from echo_client where id in ({client_id}, {disabled_client_id})
        "#,
        account_id = fixture.account_id,
        client_id = fixture.client_id,
        disabled_client_id = fixture.disabled_client_id,
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[tokio::test]
async fn database_chat_scope_identity_pagination_mutations_and_attachment(
) -> anyhow::Result<()> {
    let _guard = DB_TEST_LOCK.lock().await;
    let db = test_db().await.c(h!())?;
    let fixture = create_fixture(&db).await.c(h!())?;
    let task_db = db.clone();
    let task_fixture = fixture.clone();
    let result = tokio::spawn(async move {
        exercise_database_chat_flow(&task_db, &task_fixture).await
    })
    .await;
    cleanup_fixture(&db, &fixture).await.c(h!())?;
    result.c(h!())?.c(h!())
}

async fn exercise_database_chat_flow(
    db: &DatabaseConnection,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    let config = test_config();
    let chat_redis = crate::chat_redis::ChatRedis::connect(&config).await;
    let capability = capability(db).await.c(h!())?;
    assert!(capability
        .clients
        .iter()
        .any(|item| item.id == fixture.client_id));
    assert!(!capability
        .clients
        .iter()
        .any(|item| item.id == fixture.disabled_client_id));

    let options = filter_options(db, fixture.client_id).await.c(h!())?;
    assert_eq!(
        options
            .private
            .iter()
            .filter(|item| item.id == fixture.private_chat_id)
            .count(),
        1
    );
    assert!(options
        .groups
        .iter()
        .any(|item| item.id == fixture.group_chat_id));

    let chats = list(db, &chat_redis, ChatListQuery { before: None })
        .await
        .c(h!())?;
    assert_eq!(
        chats
            .chats
            .iter()
            .filter(|chat| chat.id == fixture.private_chat_id)
            .count(),
        1
    );
    let private = messages(
        db,
        &chat_redis,
        &fixture.private_chat_id,
        MessagePageQuery { before: None },
    )
    .await
    .c(h!())?;
    assert_eq!(private.messages.len(), 2);
    assert_eq!(private.messages[0].body, "вхідне");
    assert_eq!(private.messages[1].body, "вихідне");
    verify_message_keyset(db, &chat_redis, fixture)
        .await
        .c(h!())?;
    verify_visibility_precedes_pagination(db, &chat_redis, fixture)
        .await
        .c(h!())?;
    verify_scope_and_filters(db, &chat_redis, fixture)
        .await
        .c(h!())?;
    verify_mutations_and_retention(db, &config, fixture)
        .await
        .c(h!())?;
    verify_attachment_access(db, fixture).await.c(h!())
}

async fn verify_visibility_precedes_pagination(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    execute(
        db,
        r#"
        with hidden_groups as (
            insert into echo_group (group_id, internal_id, name, account_id)
            select $1 || '-' || item, $1 || '-' || item, 'Прихована група ' || item, $2
            from generate_series(1, 101) item
            returning id
        ), hidden_filters as (
            insert into echo_chat_filter (client_id, account_id, chat_kind, group_id)
            select $3, $2, 'group', id from hidden_groups
        )
        insert into echo_inbox_message (
            body, internal_id, sender_id, group_id, account_id, timestamp, client_id
        )
        select 'приховане', $1 || '-message-' || id, $4, id, $2,
            (now() at time zone 'utc') + id * interval '1 minute', $3
        from hidden_groups
        "#,
        vec![
            fixture.namespace.clone().into(),
            fixture.account_id.into(),
            fixture.client_id.into(),
            fixture.sender_id.into(),
        ],
    )
    .await
    .c(h!())?;
    let chats = list(db, chat_redis, ChatListQuery { before: None })
        .await
        .c(h!())?;
    assert!(chats
        .chats
        .iter()
        .any(|chat| chat.id == fixture.group_chat_id));
    Ok(())
}

async fn verify_message_keyset(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    let first = messages(
        db,
        chat_redis,
        &fixture.group_chat_id,
        MessagePageQuery { before: None },
    )
    .await
    .c(h!())?;
    assert_eq!(first.messages.len(), CHAT_MESSAGE_PAGE_SIZE as usize);
    let second = messages(
        db,
        chat_redis,
        &fixture.group_chat_id,
        MessagePageQuery {
            before: first.next_cursor,
        },
    )
    .await
    .c(h!())?;
    assert_eq!(second.messages.len(), 5);
    let first_ids = first
        .messages
        .iter()
        .map(|message| &message.id)
        .collect::<HashSet<_>>();
    assert!(second
        .messages
        .iter()
        .all(|message| !first_ids.contains(&message.id)));
    Ok(())
}

async fn verify_scope_and_filters(
    db: &DatabaseConnection,
    chat_redis: &crate::chat_redis::ChatRedis,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    let disabled = encode_chat_id(&ChatKey {
        version: 1,
        client_id: fixture.disabled_client_id,
        account_id: fixture.account_id,
        kind: ChatKind::Private,
        target: "p:+380000000000".to_string(),
    })
    .c(h!())?;
    assert!(messages(
        db,
        chat_redis,
        &disabled,
        MessagePageQuery { before: None }
    )
    .await
    .is_err());
    let unknown = encode_chat_id(&ChatKey {
        version: 1,
        client_id: fixture.client_id,
        account_id: fixture.account_id,
        kind: ChatKind::Private,
        target: "p:+380000000000".to_string(),
    })
    .c(h!())?;
    assert!(messages(
        db,
        chat_redis,
        &unknown,
        MessagePageQuery { before: None }
    )
    .await
    .is_err());
    execute(
        db,
        "insert into echo_client_settings (client_id, hide_private) values ($1, true)",
        vec![fixture.client_id.into()],
    )
    .await
    .c(h!())?;
    assert!(messages(
        db,
        chat_redis,
        &fixture.private_chat_id,
        MessagePageQuery { before: None }
    )
    .await
    .is_err());
    execute(
        db,
        "insert into echo_chat_filter (client_id, account_id, chat_kind, participant_key) values ($1, $2, 'private', $3)",
        vec![
            fixture.client_id.into(),
            fixture.account_id.into(),
            decode_chat_id(&fixture.private_chat_id).c(h!())?.target.into(),
        ],
    )
    .await
    .c(h!())?;
    messages(
        db,
        chat_redis,
        &fixture.private_chat_id,
        MessagePageQuery { before: None },
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn verify_mutations_and_retention(
    db: &DatabaseConnection,
    config: &Config,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    assert!(send(
        db,
        config,
        &fixture.private_chat_id,
        SendReq {
            text: " ".to_string(),
            attachments: vec![],
        }
    )
    .await
    .is_err());
    let queued = send(
        db,
        config,
        &fixture.private_chat_id,
        SendReq {
            text: "нове".to_string(),
            attachments: vec![],
        },
    )
    .await
    .c(h!())?;
    assert_eq!(queued.message.delivery_status, "scheduled");
    reply(
        db,
        config,
        &fixture.private_chat_id,
        ReplyReq {
            inbox_message_id: fixture.inbox_id,
            text: "відповідь".to_string(),
            attachments: vec![],
        },
    )
    .await
    .c(h!())?;
    let private = messages(
        db,
        &crate::chat_redis::ChatRedis::connect(config).await,
        &fixture.private_chat_id,
        MessagePageQuery { before: None },
    )
    .await
    .c(h!())?;
    assert_eq!(
        private
            .messages
            .iter()
            .filter(|message| message.body == "відповідь")
            .count(),
        1
    );
    react(
        db,
        &fixture.private_chat_id,
        ReactionReq {
            inbox_message_id: fixture.inbox_id,
            code: "👍".to_string(),
        },
    )
    .await
    .c(h!())?;
    assert!(reply(
        db,
        config,
        &fixture.group_chat_id,
        ReplyReq {
            inbox_message_id: fixture.inbox_id,
            text: "неправильний чат".to_string(),
            attachments: vec![],
        }
    )
    .await
    .is_err());
    echo_im::store_messenger_data(fixture.client_id, true, db)
        .await
        .c(h!())?;
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select seen_inbox_message_ttl_days, inbox_and_outbox_message_ttl_days, outbound_message_ttl_days from echo_client_config where client_id = $1",
            [fixture.client_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    assert_eq!(
        row.try_get::<Option<i32>>("", "seen_inbox_message_ttl_days")
            .c(h!())?,
        Some(30)
    );
    assert_eq!(
        row.try_get::<Option<i32>>("", "inbox_and_outbox_message_ttl_days")
            .c(h!())?,
        Some(30)
    );
    assert_eq!(
        row.try_get::<Option<i32>>("", "outbound_message_ttl_days")
            .c(h!())?,
        Some(30)
    );
    Ok(())
}

async fn verify_attachment_access(
    db: &DatabaseConnection,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    let path = std::env::temp_dir()
        .join(format!("{}-attachment.txt", fixture.namespace));
    tokio::fs::write(&path, b"chat attachment").await.c(h!())?;
    let attachment_id = insert_id(
        db,
        "insert into echo_attachment (name, path, message_id, account_id) values ('evidence.txt', $1, $2, $3) returning id",
        vec![
            path.to_string_lossy().to_string().into(),
            fixture.inbox_id.into(),
            fixture.account_id.into(),
        ],
    )
    .await
    .c(h!())?;
    let (bytes, filename, content_type, inline) =
        attachment(db, &fixture.private_chat_id, "in", attachment_id)
            .await
            .c(h!())?;
    assert_eq!(bytes, b"chat attachment");
    assert_eq!(filename, "evidence.txt");
    assert_eq!(content_type, "text/plain; charset=utf-8");
    assert!(!inline);
    assert!(attachment(db, &fixture.group_chat_id, "in", attachment_id)
        .await
        .is_err());
    let reply_attachment_id = insert_id(
        db,
        r#"
        insert into echo_outbox_message_attachment (message_id, content_base64, extension)
        select message_id, 'cmVwbHkgYXR0YWNobWVudA==', 'txt'
        from echo_outbox_message_instance
        where reply_to_inbox_message_id = $1
        order by id desc
        limit 1
        returning id
        "#,
        vec![fixture.inbox_id.into()],
    )
    .await
    .c(h!())?;
    let (bytes, _, content_type, inline) =
        attachment(db, &fixture.private_chat_id, "out", reply_attachment_id)
            .await
            .c(h!())?;
    assert_eq!(bytes, b"reply attachment");
    assert_eq!(content_type, "text/plain; charset=utf-8");
    assert!(!inline);
    tokio::fs::remove_file(path).await.c(h!())?;
    Ok(())
}

#[tokio::test]
async fn unread_and_webhook_transitions_are_durable_and_idempotent(
) -> anyhow::Result<()> {
    let _guard = DB_TEST_LOCK.lock().await;
    let db = test_db().await.c(h!())?;
    let fixture = create_fixture(&db).await.c(h!())?;
    let task_db = db.clone();
    let task_fixture = fixture.clone();
    let result = tokio::spawn(async move {
        exercise_unread_and_webhook(&task_db, &task_fixture).await
    })
    .await;
    cleanup_fixture(&db, &fixture).await.c(h!())?;
    result.c(h!())?.c(h!())
}

async fn exercise_unread_and_webhook(
    db: &DatabaseConnection,
    fixture: &Fixture,
) -> anyhow::Result<()> {
    let config = test_config();
    let chat_redis = crate::chat_redis::ChatRedis::connect(&config).await;
    execute(
        db,
        "insert into echo_client_settings (client_id, private_webhook_url) values ($1, 'https://example.invalid/chat-test')",
        vec![fixture.client_id.into()],
    )
    .await
    .c(h!())?;
    ingestion_tick(db, &test_config(), &chat_redis)
        .await
        .c(h!())?;
    let initial_unread = unread_ids(
        &chat_redis,
        &fixture.private_chat_id,
        account_linked_at(
            db,
            &decode_chat_id(&fixture.private_chat_id).c(h!())?,
        )
        .await
        .c(h!())?,
    )
    .await;
    assert_eq!(initial_unread.ids, HashSet::from([fixture.inbox_id]));
    mark_read(
        db,
        &chat_redis,
        &fixture.private_chat_id,
        MarkReadReq {
            inbox_message_ids: vec![fixture.inbox_id],
        },
        false,
    )
    .await
    .c(h!())?;
    let new_id = insert_inbox(
        db,
        fixture.client_id,
        fixture.account_id,
        fixture.sender_id,
        None,
        "непрочитане",
        Utc::now().naive_utc(),
    )
    .await
    .c(h!())?;
    ingestion_tick(db, &test_config(), &chat_redis)
        .await
        .c(h!())?;
    ingestion_tick(db, &test_config(), &chat_redis)
        .await
        .c(h!())?;
    let unread = unread_ids(
        &chat_redis,
        &fixture.private_chat_id,
        account_linked_at(
            db,
            &decode_chat_id(&fixture.private_chat_id).c(h!())?,
        )
        .await
        .c(h!())?,
    )
    .await;
    assert_eq!(unread.ids, HashSet::from([new_id]));
    mark_read(
        db,
        &chat_redis,
        &fixture.private_chat_id,
        MarkReadReq {
            inbox_message_ids: vec![new_id],
        },
        false,
    )
    .await
    .c(h!())?;
    let delivery_count = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*)::bigint as count from echo_chat_webhook_delivery where client_id = $1 and inbox_message_id = $2",
            [fixture.client_id.into(), new_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?
        .try_get::<i64>("", "count")
        .c(h!())?;
    assert_eq!(delivery_count, 1);
    for _ in 0..CHAT_WEBHOOK_MAX_ATTEMPTS {
        execute(
            db,
            "update echo_chat_webhook_delivery set next_attempt_at = now() at time zone 'utc' where client_id = $1 and inbox_message_id = $2",
            vec![fixture.client_id.into(), new_id.into()],
        )
        .await
        .c(h!())?;
        webhook_tick(db).await.c(h!())?;
    }
    let failed = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select attempts, failed_at is not null as failed from echo_chat_webhook_delivery where client_id = $1 and inbox_message_id = $2",
            [fixture.client_id.into(), new_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    assert_eq!(
        failed.try_get::<i32>("", "attempts").c(h!())?,
        CHAT_WEBHOOK_MAX_ATTEMPTS
    );
    assert!(failed.try_get::<bool>("", "failed").c(h!())?);
    execute(
        db,
        "update echo_chat_webhook_delivery set failed_at = (now() at time zone 'utc') - interval '31 days' where client_id = $1 and inbox_message_id = $2",
        vec![fixture.client_id.into(), new_id.into()],
    )
    .await
    .c(h!())?;
    cleanup_webhook_deliveries(db).await.c(h!())?;
    let delivery_count = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*)::bigint as count from echo_chat_webhook_delivery where client_id = $1 and inbox_message_id = $2",
            [fixture.client_id.into(), new_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?
        .try_get::<i64>("", "count")
        .c(h!())?;
    assert_eq!(delivery_count, 0);
    Ok(())
}

#[test]
fn opaque_ids_cursors_and_input_limits_are_stable() {
    let key = ChatKey {
        version: 1,
        client_id: 7,
        account_id: 9,
        kind: ChatKind::Private,
        target: "p:+380501234567".to_string(),
    };
    let id = encode_chat_id(&key).unwrap();
    let decoded = decode_chat_id(&id).unwrap();
    assert_eq!(decoded.client_id, key.client_id);
    assert_eq!(decoded.target, key.target);
    assert!(decode_chat_id("not-an-id").is_err());
    assert!(
        validate_webhook_url("https://user:secret@example.test/hook").is_err()
    );
    assert!(validate_webhook_url("https://127.0.0.1/hook").is_err());
    assert!(validate_webhook_url("https://100.100.100.200/hook").is_err());
    assert!(validate_webhook_url("https://198.18.0.1/hook").is_err());
    assert!(validate_webhook_url("https://192.88.99.2/hook").is_err());
    assert!(validate_webhook_url("https://[2001:db8::1]/hook").is_err());
    let mut attachments = vec![Attachment {
        id: 11,
        name: None,
        url: "/ui-api/chats/chat/attachments/in/11".to_string(),
        media_kind: "file",
        content_type: "application/octet-stream",
        size_bytes: Some(1),
        available: true,
    }];
    make_attachment_urls_absolute(
        &mut attachments,
        Some("https://echo.example.test/messengers/"),
    )
    .unwrap();
    assert_eq!(
        attachments[0].url,
        "https://echo.example.test/messengers/ui-api/chats/chat/attachments/in/11"
    );
    assert!(validate_attachments(
        (0..=CHAT_ATTACHMENT_MAX_COUNT)
            .map(|_| AttachmentInput {
                content_base64: String::new(),
                filename: None,
            })
            .collect()
    )
    .is_err());
}
