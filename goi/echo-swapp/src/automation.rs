use crate::config::{
    AUTOMATION_MAP_SCREENSHOT_WARNING_PREFIX,
    AUTOMATION_SEND_LOG_RETENTION_DAYS,
};
use crate::error::{bad_request, conflict, not_found, ShortContext};
use crate::h;
use crate::map_screenshot::{self, MapCoordinate};
use crate::messenger::{self, MessengerKind};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use regex::Regex;
use sea_orm::{
    prelude::Json, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    FromQueryResult, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::OnceLock;

const OWNED_CLIENT_PREFIX: &str = "echo-swapp-";
const WORKER_MESSAGE_LIMIT: i64 = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAutomationReq {
    pub name: Option<String>,
    pub source_account_id: i32,
    pub source_group_id: i32,
    pub target_account_id: i32,
    pub target_group_id: i32,
    pub keyword_tokens: Vec<String>,
    pub frequency_tokens: Vec<String>,
    pub stale_message_cutoff_minutes: i32,
    pub resend_attachments: bool,
    #[serde(default)]
    pub coordinates_screenshot: bool,
    pub coordinate_presence_mode: Option<String>,
    pub polygon_filter_mode: Option<String>,
    pub polygon_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePolygonReq {
    pub name: Option<String>,
    pub coordinates: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolygonView {
    pub id: i64,
    pub name: String,
    pub coordinates: Vec<String>,
    pub points: Vec<PolygonPointView>,
    pub automation_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PolygonPointView {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseAutomationReq {
    pub is_paused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounters {
    pub last_24h: i64,
    pub last_7d: i64,
    pub all_time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationView {
    pub id: i64,
    pub name: String,
    pub source_account_id: i32,
    pub source_account_name: String,
    pub source_account_phone: String,
    pub source_account_is_linked: bool,
    pub source_group_id: i32,
    pub source_group_name: String,
    pub source_messenger_kind: String,
    pub target_account_id: i32,
    pub target_account_name: String,
    pub target_account_phone: String,
    pub target_account_is_linked: bool,
    pub target_group_id: i32,
    pub target_group_name: String,
    pub target_messenger_kind: String,
    pub keyword_tokens: Vec<String>,
    pub frequency_tokens: Vec<String>,
    pub stale_message_cutoff_minutes: i32,
    pub resend_attachments: bool,
    pub coordinates_screenshot: bool,
    pub coordinate_presence_mode: String,
    pub polygon_filter_mode: String,
    pub polygon_id: Option<i64>,
    pub polygon_name: Option<String>,
    pub polygon_coordinates: Vec<String>,
    pub is_paused: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub checkpoint_at: i64,
    pub usage: UsageCounters,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOptionView {
    pub id: i32,
    pub account_id: i32,
    pub group_id: String,
    pub name: String,
    pub messenger_name: String,
    pub messenger_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOptionView {
    pub id: i32,
    pub name: String,
    pub messenger_kind: String,
    pub phone: String,
    pub is_linked: bool,
}

#[derive(Clone, Debug, FromQueryResult)]
struct AutomationListRow {
    id: i64,
    name: String,
    source_account_id: i32,
    source_account_name: String,
    source_account_phone: String,
    source_account_is_linked: bool,
    source_group_id: i32,
    source_group_name: String,
    source_messenger_kind: String,
    target_account_id: i32,
    target_account_name: String,
    target_account_phone: String,
    target_account_is_linked: bool,
    target_group_id: i32,
    target_group_name: String,
    target_messenger_kind: String,
    keyword_tokens: Json,
    frequency_tokens: Json,
    stale_message_cutoff_minutes: i32,
    resend_attachments: bool,
    coordinates_screenshot: bool,
    coordinate_presence_mode: String,
    polygon_filter_mode: String,
    polygon_id: Option<i64>,
    polygon_name: Option<String>,
    polygon_coordinates: Option<Json>,
    is_paused: bool,
    status: String,
    last_error: Option<String>,
    usage_24h: i64,
    usage_7d: i64,
    usage_all: i64,
    checkpoint_at: NaiveDateTime,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Clone, Debug, FromQueryResult)]
struct AutomationWorkerRow {
    id: i64,
    source_account_id: i32,
    source_group_id: i32,
    target_account_id: i32,
    target_group_id: i32,
    keyword_tokens: Json,
    frequency_tokens: Json,
    stale_message_cutoff_minutes: i32,
    resend_attachments: bool,
    coordinates_screenshot: bool,
    coordinate_presence_mode: String,
    polygon_filter_mode: String,
    polygon_coordinates: Option<Json>,
    last_error: Option<String>,
    checkpoint_at: NaiveDateTime,
    last_processed_inbox_message_id: i32,
}

#[derive(Debug, FromQueryResult)]
struct InboxMessageRow {
    id: i32,
    internal_id: Option<String>,
    body: String,
    account_id: i32,
    message_at: NaiveDateTime,
}

#[derive(Debug, FromQueryResult)]
struct SendTargetRow {
    group_id: String,
    kind: String,
    client_name: String,
}

#[derive(Debug, FromQueryResult)]
struct AccountHealthRow {
    source_is_linked: bool,
    target_is_linked: bool,
}

#[derive(Debug, FromQueryResult)]
struct AttachmentRow {
    path: String,
}

#[derive(Debug)]
struct LoadedAttachments {
    content_base64: Vec<String>,
    warning: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct GroupOptionRow {
    id: i32,
    account_id: i32,
    group_id: String,
    name: String,
    messenger_name: String,
    messenger_kind: String,
}

#[derive(Debug, FromQueryResult)]
struct AccountOptionRow {
    id: i32,
    name: String,
    messenger_kind: String,
    phone: String,
    is_linked: bool,
}

#[derive(Debug, FromQueryResult)]
struct PolygonListRow {
    id: i64,
    name: String,
    coordinates: Json,
    automation_count: i64,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CoordinatePresenceMode {
    Any,
    SkipWithCoordinates,
    SkipWithoutCoordinates,
}

impl CoordinatePresenceMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "any" => Ok(Self::Any),
            "skip_with_coordinates" => Ok(Self::SkipWithCoordinates),
            "skip_without_coordinates" => Ok(Self::SkipWithoutCoordinates),
            _ => Err(bad_request(format!(
                "Невідомий режим фільтрації координат: {value}. Оновіть сторінку та виберіть режим ще раз."
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Any => "any",
            Self::SkipWithCoordinates => "skip_with_coordinates",
            Self::SkipWithoutCoordinates => "skip_without_coordinates",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PolygonFilterMode {
    None,
    Inside,
    Outside,
}

impl PolygonFilterMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "none" => Ok(Self::None),
            "inside" => Ok(Self::Inside),
            "outside" => Ok(Self::Outside),
            _ => Err(bad_request(format!(
                "Невідомий режим фільтрації за районом: {value}. Оновіть сторінку та виберіть режим ще раз."
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Inside => "inside",
            Self::Outside => "outside",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Point {
    lat: f64,
    lng: f64,
}

#[derive(Debug)]
struct NormalizedAutomation {
    name: String,
    source_account_id: i32,
    source_group_id: i32,
    target_account_id: i32,
    target_group_id: i32,
    keyword_tokens: Vec<String>,
    frequency_tokens: Vec<String>,
    stale_message_cutoff_minutes: i32,
    resend_attachments: bool,
    coordinates_screenshot: bool,
    coordinate_presence_mode: CoordinatePresenceMode,
    polygon_filter_mode: PolygonFilterMode,
    polygon_id: Option<i64>,
}

#[derive(Debug, Eq, PartialEq)]
enum MatchDecision {
    Send,
    Skip(&'static str),
}

pub async fn list(db: &DatabaseConnection) -> Result<Vec<AutomationView>> {
    let rows = AutomationListRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        list_sql().to_string(),
    ))
    .all(db)
    .await
    .c(h!())?;
    Ok(rows.into_iter().map(automation_view).collect())
}

pub async fn list_polygons(
    db: &DatabaseConnection,
) -> Result<Vec<PolygonView>> {
    let rows = PolygonListRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
        select
            polygon.id,
            polygon.name,
            polygon.coordinates,
            count(automation.id)::bigint as automation_count,
            polygon.created_at,
            polygon.updated_at
        from echo_automation_polygon polygon
        left join echo_automation automation on automation.polygon_id = polygon.id
        group by polygon.id
        order by polygon.updated_at desc, polygon.id desc
        "#,
    ))
    .all(db)
    .await
    .c(h!())?;
    let mut polygons = Vec::with_capacity(rows.len());
    for row in rows {
        polygons.push(polygon_view(row).await.c(h!())?);
    }
    Ok(polygons)
}

pub async fn create_polygon(
    db: &DatabaseConnection,
    req: SavePolygonReq,
) -> Result<PolygonView> {
    let (name, coordinates) = normalize_polygon_req(req).await.c(h!())?;
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            insert into echo_automation_polygon (name, coordinates, updated_at)
            values ($1, $2::jsonb, now() at time zone 'utc')
            returning id
            "#,
            vec![
                name.into(),
                serde_json::to_string(&coordinates).c(h!())?.into(),
            ],
        ))
        .await
        .c(h!())?
        .context("polygon insert did not return id")
        .c(h!())?;
    load_polygon_view(db, row.try_get("", "id").c(h!())?)
        .await
        .c(h!())
}

pub async fn update_polygon(
    db: &DatabaseConnection,
    id: i64,
    req: SavePolygonReq,
) -> Result<PolygonView> {
    let (name, coordinates) = normalize_polygon_req(req).await.c(h!())?;
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation_polygon
        set
            name = $2,
            coordinates = $3::jsonb,
            updated_at = now() at time zone 'utc'
        where id = $1
        "#,
        vec![
            id.into(),
            name.into(),
            serde_json::to_string(&coordinates).c(h!())?.into(),
        ],
    ))
    .await
    .c(h!())?;
    load_polygon_view(db, id).await.c(h!())
}

pub async fn delete_polygon(db: &DatabaseConnection, id: i64) -> Result<()> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*)::bigint as count from echo_automation where polygon_id = $1",
            [id.into()],
        ))
        .await
        .c(h!())?
        .context("polygon usage query did not return a row")
        .c(h!())?;
    let usage_count: i64 = row.try_get("", "count").c(h!())?;
    if usage_count > 0 {
        return Err(conflict(
            "Район інтересу використовується в автоматизаціях. Спочатку приберіть його з цих автоматизацій, а потім повторіть видалення.",
        ));
    }
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from echo_automation_polygon where id = $1",
        [id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn group_options(
    db: &DatabaseConnection,
) -> Result<Vec<GroupOptionView>> {
    let rows = GroupOptionRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
        select
            eg.id,
            eg.account_id,
            eg.group_id,
            coalesce(nullif(eg.name, ''), eg.group_id) as name,
            coalesce(nullif(ec.display_name, ''), regexp_replace(ec.name, '^echo-swapp-', '')) as messenger_name,
            ea.source::text as messenger_kind
        from echo_group eg
        join echo_account ea on ea.id = eg.account_id
        join echo_client_lock ecl on ecl.account_id = ea.id
        join echo_client ec on ec.id = ecl.client_id
        where ec.deleted = false
            and ec.name like 'echo-swapp-%'
            and eg.deleted_by_messanger = false
        order by messenger_kind, messenger_name, name
        "#,
    ))
    .all(db)
    .await
    .c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| GroupOptionView {
            id: row.id,
            account_id: row.account_id,
            group_id: row.group_id,
            name: row.name,
            messenger_name: row.messenger_name,
            messenger_kind: row.messenger_kind,
        })
        .collect())
}

pub async fn account_options(
    db: &DatabaseConnection,
) -> Result<Vec<AccountOptionView>> {
    let rows = AccountOptionRow::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        r#"
        select
            ea.id,
            coalesce(nullif(ec.display_name, ''), regexp_replace(ec.name, '^echo-swapp-', '')) as name,
            ea.source::text as messenger_kind,
            ea.phone_number as phone,
            ea.is_linked
        from echo_account ea
        join echo_client_lock ecl on ecl.account_id = ea.id
        join echo_client ec on ec.id = ecl.client_id
        where ec.deleted = false
            and ec.name like 'echo-swapp-%'
        order by messenger_kind, name, phone
        "#,
    ))
    .all(db)
    .await
    .c(h!())?;
    Ok(rows
        .into_iter()
        .map(|row| AccountOptionView {
            id: row.id,
            name: row.name,
            messenger_kind: row.messenger_kind,
            phone: row.phone,
            is_linked: row.is_linked,
        })
        .collect())
}

pub async fn ensure_schema(db: &DatabaseConnection) -> Result<()> {
    ensure_automation_columns(db).await.c(h!())?;
    ensure_automation_polygon_schema(db).await.c(h!())?;
    ensure_automation_delivery_schema(db).await.c(h!())?;
    ensure_automation_send_log_schema(db).await.c(h!())?;
    drop_legacy_automation_schema(db).await.c(h!())?;
    Ok(())
}

async fn ensure_automation_columns(db: &DatabaseConnection) -> Result<()> {
    db.execute_unprepared(
        r#"
        alter table echo_automation
            add column if not exists stale_message_cutoff_minutes integer,
            add column if not exists resend_attachments boolean,
            add column if not exists coordinate_presence_mode text,
            add column if not exists polygon_filter_mode text,
            add column if not exists polygon_id bigint,
            add column if not exists is_paused boolean,
            add column if not exists status text,
            add column if not exists last_processed_inbox_message_id integer,
            add column if not exists checkpoint_at timestamp without time zone,
            add column if not exists created_at timestamp without time zone,
            add column if not exists updated_at timestamp without time zone;

        update echo_automation
        set stale_message_cutoff_minutes = coalesce(stale_message_cutoff_minutes, 60),
            resend_attachments = coalesce(resend_attachments, false),
            coordinate_presence_mode = coalesce(coordinate_presence_mode, 'any'),
            polygon_filter_mode = coalesce(polygon_filter_mode, 'none'),
            is_paused = coalesce(is_paused, false),
            status = coalesce(status, 'idle'),
            last_processed_inbox_message_id = coalesce(last_processed_inbox_message_id, 0),
            checkpoint_at = coalesce(checkpoint_at, last_processed_at, '1970-01-01 00:00:00'),
            created_at = coalesce(created_at, now() at time zone 'utc'),
            updated_at = coalesce(updated_at, now() at time zone 'utc');

        alter table echo_automation
            alter column stale_message_cutoff_minutes set default 60,
            alter column stale_message_cutoff_minutes set not null,
            alter column resend_attachments set default false,
            alter column resend_attachments set not null,
            alter column coordinate_presence_mode set default 'any',
            alter column coordinate_presence_mode set not null,
            alter column polygon_filter_mode set default 'none',
            alter column polygon_filter_mode set not null,
            alter column is_paused set default false,
            alter column is_paused set not null,
            alter column status set default 'idle',
            alter column status set not null,
            alter column last_processed_inbox_message_id set default 0,
            alter column last_processed_inbox_message_id set not null,
            alter column checkpoint_at set default '1970-01-01 00:00:00',
            alter column checkpoint_at set not null,
            alter column created_at set default (now() at time zone 'utc'),
            alter column created_at set not null,
            alter column updated_at set default (now() at time zone 'utc'),
            alter column updated_at set not null;

        create index if not exists echo_automation_checkpoint_idx
            on echo_automation (is_paused, source_group_id, checkpoint_at, last_processed_inbox_message_id);
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn ensure_automation_polygon_schema(
    db: &DatabaseConnection,
) -> Result<()> {
    db.execute_unprepared(
        r#"
        create table if not exists echo_automation_polygon (
            id bigserial primary key,
            name text not null default '',
            coordinates jsonb not null,
            created_at timestamp without time zone default (now() at time zone 'utc') not null,
            updated_at timestamp without time zone default (now() at time zone 'utc') not null,
            constraint echo_automation_polygon_coordinates_chk
                check (jsonb_array_length(coordinates) >= 3)
        );

        do $$
        declare
            automation record;
            inserted_polygon_id bigint;
        begin
            if exists (
                select 1
                from pg_attribute
                where attrelid = 'echo_automation'::regclass
                    and attname = 'polygon_coordinates'
                    and not attisdropped
            ) then
                for automation in
                    execute '
                        select id, polygon_coordinates
                        from echo_automation
                        where polygon_id is null
                            and polygon_coordinates is not null
                    '
                loop
                    insert into echo_automation_polygon (name, coordinates)
                    values ('', automation.polygon_coordinates)
                    returning id into inserted_polygon_id;

                    update echo_automation
                    set polygon_id = inserted_polygon_id
                    where id = automation.id;
                end loop;
            end if;
        end $$;

        do $$
        begin
            if not exists (
                select 1
                from pg_constraint
                where conrelid = 'echo_automation'::regclass
                    and conname = 'echo_automation_polygon_fk'
            ) then
                alter table echo_automation
                    add constraint echo_automation_polygon_fk
                    foreign key (polygon_id)
                    references echo_automation_polygon(id);
            end if;

            if not exists (
                select 1
                from pg_constraint
                where conrelid = 'echo_automation'::regclass
                    and conname = 'echo_automation_polygon_ref_chk'
            ) then
                alter table echo_automation
                    add constraint echo_automation_polygon_ref_chk
                    check (polygon_filter_mode = 'none' or polygon_id is not null);
            end if;
        end $$;

        create index if not exists echo_automation_polygon_idx
            on echo_automation (polygon_id);
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn ensure_automation_delivery_schema(
    db: &DatabaseConnection,
) -> Result<()> {
    db.execute_unprepared(
        r#"
        alter table echo_automation_delivery
            add column if not exists source_internal_id text,
            add column if not exists source_message_at timestamp without time zone,
            add column if not exists created_at timestamp without time zone,
            add column if not exists updated_at timestamp without time zone;

        update echo_automation_delivery
        set created_at = coalesce(created_at, now() at time zone 'utc'),
            updated_at = coalesce(updated_at, now() at time zone 'utc');

        alter table echo_automation_delivery
            alter column created_at set default (now() at time zone 'utc'),
            alter column created_at set not null,
            alter column updated_at set default (now() at time zone 'utc'),
            alter column updated_at set not null;

        drop index if exists echo_automation_delivery_internal_uq;

        create unique index if not exists echo_automation_delivery_sent_internal_uq
            on echo_automation_delivery (automation_id, source_internal_id)
            where source_internal_id is not null
                and status = 'sent';

        create index if not exists echo_automation_delivery_source_at_idx
            on echo_automation_delivery (automation_id, source_message_at);
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn ensure_automation_send_log_schema(
    db: &DatabaseConnection,
) -> Result<()> {
    db.execute_unprepared(
        r#"
        create table if not exists echo_automation_send_log (
            id bigserial primary key,
            automation_id bigint not null,
            source_inbox_message_id integer not null,
            source_internal_id text,
            source_group_id integer not null,
            target_group_id integer not null,
            planned_at timestamp without time zone default (now() at time zone 'utc') not null,
            sent_at timestamp without time zone,
            created_at timestamp without time zone default (now() at time zone 'utc') not null
        );

        create unique index if not exists echo_automation_send_log_route_message_uq
            on echo_automation_send_log (
                source_group_id,
                target_group_id,
                source_inbox_message_id
            );

        create unique index if not exists echo_automation_send_log_route_internal_uq
            on echo_automation_send_log (
                source_group_id,
                target_group_id,
                source_internal_id
            )
            where source_internal_id is not null;

        create index if not exists echo_automation_send_log_created_at_idx
            on echo_automation_send_log (created_at desc);
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn drop_legacy_automation_schema(db: &DatabaseConnection) -> Result<()> {
    db.execute_unprepared(
        r#"
        alter table echo_automation
            drop constraint if exists echo_automation_tokens_chk,
            drop constraint if exists echo_automation_polygon_coords_chk,
            drop column if exists polygon_coordinates;
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub async fn create(
    db: &DatabaseConnection,
    req: SaveAutomationReq,
) -> Result<AutomationView> {
    let automation = normalize_req(req).await.c(h!())?;
    validate_group_accounts(db, &automation).await.c(h!())?;
    validate_polygon_ref(db, &automation).await.c(h!())?;
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            insert into echo_automation (
                name,
                source_account_id,
                source_group_id,
                target_account_id,
                target_group_id,
                keyword_tokens,
                frequency_tokens,
                stale_message_cutoff_minutes,
                resend_attachments,
                coordinates_screenshot,
                coordinate_presence_mode,
                polygon_filter_mode,
                polygon_id,
                updated_at
            )
            values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, now() at time zone 'utc')
            returning id
            "#,
            vec![
                automation.name.into(),
                automation.source_account_id.into(),
                automation.source_group_id.into(),
                automation.target_account_id.into(),
                automation.target_group_id.into(),
                serde_json::to_string(&automation.keyword_tokens)
                    .c(h!())?
                    .into(),
                serde_json::to_string(&automation.frequency_tokens)
                    .c(h!())?
                    .into(),
                automation.stale_message_cutoff_minutes.into(),
                automation.resend_attachments.into(),
                automation.coordinates_screenshot.into(),
                automation.coordinate_presence_mode.as_str().into(),
                automation.polygon_filter_mode.as_str().into(),
                automation.polygon_id.into(),
            ],
        ))
        .await
        .c(h!())?
        .context("automation insert did not return id")
        .c(h!())?;
    load_view(db, row.try_get("", "id").c(h!())?).await.c(h!())
}

pub async fn update(
    db: &DatabaseConnection,
    id: i64,
    req: SaveAutomationReq,
) -> Result<AutomationView> {
    let automation = normalize_req(req).await.c(h!())?;
    validate_group_accounts(db, &automation).await.c(h!())?;
    validate_polygon_ref(db, &automation).await.c(h!())?;
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation
        set
            name = $2,
            source_account_id = $3,
            source_group_id = $4,
            target_account_id = $5,
            target_group_id = $6,
            keyword_tokens = $7::jsonb,
            frequency_tokens = $8::jsonb,
            stale_message_cutoff_minutes = $9,
            resend_attachments = $10,
            coordinates_screenshot = $11,
            coordinate_presence_mode = $12,
            polygon_filter_mode = $13,
            polygon_id = $14,
            updated_at = now() at time zone 'utc'
        where id = $1
        "#,
        vec![
            id.into(),
            automation.name.into(),
            automation.source_account_id.into(),
            automation.source_group_id.into(),
            automation.target_account_id.into(),
            automation.target_group_id.into(),
            serde_json::to_string(&automation.keyword_tokens)
                .c(h!())?
                .into(),
            serde_json::to_string(&automation.frequency_tokens)
                .c(h!())?
                .into(),
            automation.stale_message_cutoff_minutes.into(),
            automation.resend_attachments.into(),
            automation.coordinates_screenshot.into(),
            automation.coordinate_presence_mode.as_str().into(),
            automation.polygon_filter_mode.as_str().into(),
            automation.polygon_id.into(),
        ],
    ))
    .await
    .c(h!())?;
    load_view(db, id).await.c(h!())
}

pub async fn delete(db: &DatabaseConnection, id: i64) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "delete from echo_automation where id = $1",
        [id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn set_paused(
    db: &DatabaseConnection,
    id: i64,
    is_paused: bool,
) -> Result<AutomationView> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation
        set is_paused = $2, updated_at = now() at time zone 'utc'
        where id = $1
        "#,
        [id.into(), is_paused.into()],
    ))
    .await
    .c(h!())?;
    load_view(db, id).await.c(h!())
}

pub async fn worker_tick(db: &DatabaseConnection) -> Result<()> {
    let automations =
        AutomationWorkerRow::find_by_statement(Statement::from_string(
            DatabaseBackend::Postgres,
            r#"
            select
                automation.id,
                source_account_id,
                source_group_id,
                target_account_id,
                target_group_id,
                keyword_tokens,
                frequency_tokens,
                stale_message_cutoff_minutes,
                resend_attachments,
                coordinates_screenshot,
                coordinate_presence_mode,
                polygon_filter_mode,
                polygon.coordinates as polygon_coordinates,
                automation.last_error,
                checkpoint_at,
                last_processed_inbox_message_id
            from echo_automation automation
            left join echo_automation_polygon polygon
                on polygon.id = automation.polygon_id
            where is_paused = false
            order by automation.id
            "#,
        ))
        .all(db)
        .await
        .c(h!())?;
    for automation in automations {
        if let Err(err) = process_automation(db, automation.clone()).await {
            set_error(db, automation.id, &err.to_string())
                .await
                .c(h!())?;
            log::error!(
                "echo-swapp automation {} failed: {err:#}",
                automation.id
            );
        }
    }
    Ok(())
}

async fn load_view(db: &DatabaseConnection, id: i64) -> Result<AutomationView> {
    let rows =
        AutomationListRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("{} where a.id = $1 {}", list_sql_head(), list_sql_tail()),
            [id.into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    rows.into_iter()
        .next()
        .map(automation_view)
        .ok_or_else(|| {
            not_found(format!(
                "Автоматизацію {id} не знайдено. Оновіть сторінку та повторіть спробу."
            ))
        })
        .c(h!())
}

async fn normalize_req(req: SaveAutomationReq) -> Result<NormalizedAutomation> {
    if req.source_account_id <= 0 {
        return Err(bad_request("Оберіть обліковий запис-джерело."));
    }
    if req.source_group_id <= 0 {
        return Err(bad_request("Оберіть групу-джерело."));
    }
    if req.target_account_id <= 0 {
        return Err(bad_request("Оберіть цільовий обліковий запис."));
    }
    if req.target_group_id <= 0 {
        return Err(bad_request("Оберіть цільову групу."));
    }
    if req.stale_message_cutoff_minutes < 0 {
        return Err(bad_request(
            "Час актуальності повідомлення не може бути від’ємним.",
        ));
    }
    let keyword_tokens = normalize_tokens(req.keyword_tokens);
    let frequency_tokens = normalize_tokens(req.frequency_tokens);
    let coordinate_presence_mode = CoordinatePresenceMode::parse(
        req.coordinate_presence_mode
            .as_deref()
            .unwrap_or(CoordinatePresenceMode::Any.as_str()),
    )
    .c(h!())?;
    let polygon_id = req.polygon_id.filter(|polygon_id| *polygon_id > 0);
    let polygon_filter_mode = if polygon_id.is_some() {
        PolygonFilterMode::parse(
            req.polygon_filter_mode
                .as_deref()
                .unwrap_or(PolygonFilterMode::None.as_str()),
        )
        .c(h!())?
    } else {
        PolygonFilterMode::None
    };
    if coordinate_presence_mode == CoordinatePresenceMode::SkipWithCoordinates
        && polygon_filter_mode != PolygonFilterMode::None
    {
        return Err(bad_request(
            "Не можна фільтрувати за районом, коли повідомлення з координатами ігноруються.",
        ));
    }
    if coordinate_presence_mode == CoordinatePresenceMode::SkipWithCoordinates
        && req.coordinates_screenshot
    {
        return Err(bad_request(
            "Не можна створювати знімок координат, коли повідомлення з координатами ігноруються.",
        ));
    }
    let polygon_id = if polygon_filter_mode == PolygonFilterMode::None {
        None
    } else {
        polygon_id
    };
    Ok(NormalizedAutomation {
        name: req.name.unwrap_or_default().trim().to_string(),
        source_account_id: req.source_account_id,
        source_group_id: req.source_group_id,
        target_account_id: req.target_account_id,
        target_group_id: req.target_group_id,
        keyword_tokens,
        frequency_tokens,
        stale_message_cutoff_minutes: req.stale_message_cutoff_minutes,
        resend_attachments: req.resend_attachments,
        coordinates_screenshot: req.coordinates_screenshot,
        coordinate_presence_mode,
        polygon_filter_mode,
        polygon_id,
    })
}

async fn validate_polygon_ref(
    db: &DatabaseConnection,
    automation: &NormalizedAutomation,
) -> Result<()> {
    let Some(polygon_id) = automation.polygon_id else {
        return Ok(());
    };
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select coordinates from echo_automation_polygon where id = $1",
            [polygon_id.into()],
        ))
        .await
        .c(h!())?
        .ok_or_else(|| {
            not_found(format!(
                "Район інтересу {polygon_id} не знайдено. Оновіть список і виберіть район ще раз."
            ))
        })
        .c(h!())?;
    let coordinates: Json = row.try_get("", "coordinates").c(h!())?;
    let coordinates = json_vec(Some(&coordinates));
    let polygon = parse_polygon(&coordinates).await.c(h!())?;
    if polygon.len() < 3 {
        return Err(bad_request(
            "Для фільтрації за районом потрібно щонайменше 3 коректні координати.",
        ));
    }
    Ok(())
}

async fn validate_group_accounts(
    db: &DatabaseConnection,
    automation: &NormalizedAutomation,
) -> Result<()> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select
                exists (
                    select 1
                    from echo_group
                    where id = $1
                        and account_id = $2
                        and deleted_by_messanger = false
                ) as source_ok,
                exists (
                    select 1
                    from echo_group
                    where id = $3
                        and account_id = $4
                        and deleted_by_messanger = false
                ) as target_ok
            "#,
            vec![
                automation.source_group_id.into(),
                automation.source_account_id.into(),
                automation.target_group_id.into(),
                automation.target_account_id.into(),
            ],
        ))
        .await
        .c(h!())?
        .context("group-account validation did not return a row")
        .c(h!())?;
    let source_ok: bool = row.try_get("", "source_ok").c(h!())?;
    if !source_ok {
        return Err(bad_request(
            "Група-джерело не належить вибраному обліковому запису. Виберіть групу зі списку цього облікового запису.",
        ));
    }
    let target_ok: bool = row.try_get("", "target_ok").c(h!())?;
    if !target_ok {
        return Err(bad_request(
            "Цільова група не належить вибраному обліковому запису. Виберіть групу зі списку цього облікового запису.",
        ));
    }
    Ok(())
}

async fn process_automation(
    db: &DatabaseConnection,
    automation: AutomationWorkerRow,
) -> Result<()> {
    let mut last_warning = automation.last_error.clone().filter(|warning| {
        automation.coordinates_screenshot
            && warning.contains(AUTOMATION_MAP_SCREENSHOT_WARNING_PREFIX)
    });
    set_status(db, automation.id, "running", last_warning.as_deref())
        .await
        .c(h!())?;
    if let Some(warning) =
        account_health_warning(db, &automation).await.c(h!())?
    {
        set_status(db, automation.id, "warning", Some(&warning))
            .await
            .c(h!())?;
        return Ok(());
    }
    record_edit_warnings(db, &automation).await.c(h!())?;
    let messages = load_candidate_messages(db, &automation).await.c(h!())?;
    if messages.is_empty() {
        advance_empty_checkpoint(db, &automation).await.c(h!())?;
    }
    for message in messages {
        process_message(db, &automation, &message, &mut last_warning)
            .await
            .c(h!())?;
        update_checkpoint(db, automation.id, message.id, message.message_at)
            .await
            .c(h!())?;
    }
    if let Some(warning) = last_warning {
        set_status(db, automation.id, "warning", Some(&warning))
            .await
            .c(h!())?;
    } else {
        set_status(db, automation.id, "idle", None).await.c(h!())?;
    }
    Ok(())
}

async fn account_health_warning(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
) -> Result<Option<String>> {
    let rows =
        AccountHealthRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
        select
            source_account.is_linked as source_is_linked,
            target_account.is_linked as target_is_linked
        from echo_automation automation
        join echo_account source_account
            on source_account.id = automation.source_account_id
        join echo_account target_account
            on target_account.id = automation.target_account_id
        where automation.id = $1
        "#,
            [automation.id.into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    let row = rows
        .into_iter()
        .next()
        .with_context(|| {
            format!("automation accounts not found: {}", automation.id)
        })
        .c(h!())?;
    let mut warnings = Vec::new();
    if !row.source_is_linked {
        warnings.push("source account is not linked");
    }
    if !row.target_is_linked {
        warnings.push("target account is not linked");
    }
    if warnings.is_empty() {
        Ok(None)
    } else {
        Ok(Some(warnings.join("; ")))
    }
}

async fn process_message(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
    message: &InboxMessageRow,
    last_warning: &mut Option<String>,
) -> Result<()> {
    if already_sent(db, automation.id, message).await.c(h!())? {
        return Ok(());
    }
    let coords = extract_points(&message.body).await;
    let polygon = if automation.polygon_filter_mode == "none" {
        Vec::new()
    } else {
        let polygon_coordinates =
            json_vec(automation.polygon_coordinates.as_ref());
        parse_polygon(&polygon_coordinates).await.c(h!())?
    };
    let decision = message_matches_filters(
        &AutomationFilter {
            keyword_tokens: json_vec(Some(&automation.keyword_tokens)),
            frequency_tokens: json_vec(Some(&automation.frequency_tokens)),
            stale_message_cutoff_minutes: automation
                .stale_message_cutoff_minutes,
            coordinate_presence_mode: CoordinatePresenceMode::parse(
                &automation.coordinate_presence_mode,
            )
            .c(h!())?,
            polygon_filter_mode: PolygonFilterMode::parse(
                &automation.polygon_filter_mode,
            )
            .c(h!())?,
            polygon,
        },
        &message.body,
        message.message_at,
        Utc::now().naive_utc(),
        &coords,
    );
    match decision {
        MatchDecision::Skip(reason) => {
            record_delivery(
                db,
                automation.id,
                message,
                "skipped",
                Some(reason),
                false,
            )
            .await
            .c(h!())?;
            Ok(())
        }
        MatchDecision::Send => send_matching_message(
            db,
            automation,
            message,
            &coords,
            last_warning,
        )
        .await
        .c(h!()),
    }
}

async fn send_matching_message(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
    message: &InboxMessageRow,
    coordinates: &[Point],
    last_warning: &mut Option<String>,
) -> Result<()> {
    if send_is_planned(
        db,
        automation.source_group_id,
        automation.target_group_id,
        message,
    )
    .await
    .c(h!())?
    {
        record_planned_send_skip(db, automation.id, message)
            .await
            .c(h!())?;
        return Ok(());
    }
    let target = load_send_target(
        db,
        automation.target_account_id,
        automation.target_group_id,
    )
    .await
    .c(h!())?;
    let kind = messenger_kind_from_db(&target.kind).c(h!())?;
    let mut attachments = if automation.resend_attachments {
        load_attachment_base64(db, message).await.c(h!())?
    } else {
        LoadedAttachments {
            content_base64: Vec::new(),
            warning: None,
        }
    };
    let coordinate_screenshot_attempted =
        automation.coordinates_screenshot && !coordinates.is_empty();
    if coordinate_screenshot_attempted {
        add_coordinate_screenshot(&mut attachments, coordinates).await;
    }
    let client_name = public_client_name(&target.client_name);
    let txn = db.begin().await.c(h!())?;
    let Some(send_log_id) = plan_send(
        &txn,
        automation.id,
        automation.source_group_id,
        automation.target_group_id,
        message,
    )
    .await
    .c(h!())?
    else {
        txn.rollback().await.c(h!())?;
        record_planned_send_skip(db, automation.id, message)
            .await
            .c(h!())?;
        return Ok(());
    };
    messenger::enqueue(
        &txn,
        &client_name,
        kind,
        vec![target.group_id],
        vec![],
        message.body.clone(),
        attachments.content_base64,
    )
    .await
    .c(h!())?;
    mark_send_sent(&txn, send_log_id).await.c(h!())?;
    record_delivery(
        &txn,
        automation.id,
        message,
        "sent",
        attachments.warning.as_deref(),
        true,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    messenger::tick_after_send(db, &client_name, kind)
        .await
        .c(h!())?;
    if coordinate_screenshot_attempted || last_warning.is_none() {
        *last_warning = attachments.warning;
    }
    Ok(())
}

async fn add_coordinate_screenshot(
    attachments: &mut LoadedAttachments,
    coordinates: &[Point],
) {
    let coordinates = coordinates
        .iter()
        .map(|point| MapCoordinate {
            lat: point.lat,
            lng: point.lng,
        })
        .collect::<Vec<_>>();
    match map_screenshot::create(&coordinates).await {
        Ok(screenshot) => attachments.content_base64.push(screenshot),
        Err(err) => {
            let warning =
                format!("{AUTOMATION_MAP_SCREENSHOT_WARNING_PREFIX} {err:#}");
            log::warn!("{warning}");
            append_warning(&mut attachments.warning, warning);
        }
    }
}

fn append_warning(warning: &mut Option<String>, value: String) {
    match warning {
        Some(warning) => {
            warning.push_str("; ");
            warning.push_str(&value);
        }
        None => *warning = Some(value),
    }
}

async fn send_is_planned(
    db: &impl ConnectionTrait,
    source_group_id: i32,
    target_group_id: i32,
    message: &InboxMessageRow,
) -> Result<bool> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select exists (
                select 1
                from echo_automation_send_log
                where source_group_id = $1
                    and target_group_id = $2
                    and (
                        source_inbox_message_id = $3
                        or ($4 is not null and source_internal_id = $4)
                    )
            ) as planned
            "#,
            vec![
                source_group_id.into(),
                target_group_id.into(),
                message.id.into(),
                message.internal_id.clone().into(),
            ],
        ))
        .await
        .c(h!())?
        .context("planned-send query did not return a row")
        .c(h!())?;
    row.try_get("", "planned").c(h!())
}

async fn record_planned_send_skip(
    db: &impl ConnectionTrait,
    automation_id: i64,
    message: &InboxMessageRow,
) -> Result<()> {
    record_delivery(
        db,
        automation_id,
        message,
        "skipped",
        Some("message is already planned for this target group"),
        false,
    )
    .await
    .c(h!())
}

async fn plan_send(
    db: &impl ConnectionTrait,
    automation_id: i64,
    source_group_id: i32,
    target_group_id: i32,
    message: &InboxMessageRow,
) -> Result<Option<i64>> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            insert into echo_automation_send_log (
                automation_id,
                source_inbox_message_id,
                source_internal_id,
                source_group_id,
                target_group_id
            )
            values ($1, $2, $3, $4, $5)
            on conflict do nothing
            returning id
            "#,
            vec![
                automation_id.into(),
                message.id.into(),
                message.internal_id.clone().into(),
                source_group_id.into(),
                target_group_id.into(),
            ],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(row.try_get("", "id").c(h!())?))
}

async fn mark_send_sent(
    db: &impl ConnectionTrait,
    send_log_id: i64,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation_send_log
        set sent_at = now() at time zone 'utc'
        where id = $1
        "#,
        [send_log_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub async fn delete_expired_send_log(db: &DatabaseConnection) -> Result<u64> {
    let cutoff = Utc::now().naive_utc()
        - ChronoDuration::days(AUTOMATION_SEND_LOG_RETENTION_DAYS);
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "delete from echo_automation_send_log where created_at < $1",
            [cutoff.into()],
        ))
        .await
        .c(h!())?;
    Ok(result.rows_affected())
}

async fn load_candidate_messages(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
) -> Result<Vec<InboxMessageRow>> {
    InboxMessageRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
            select
                id,
                internal_id,
                body,
                account_id,
                coalesce(timestamp, created_at) as message_at
            from echo_inbox_message
            where group_id = $1
                and account_id = $5
                and deleted = false
                and (
                    $6 = 0
                    or coalesce(timestamp, created_at) >= (now() at time zone 'utc') - make_interval(mins => $6)
                )
                and (
                    coalesce(timestamp, created_at) > $2
                    or (
                        coalesce(timestamp, created_at) = $2
                        and id > $3
                    )
                )
            order by coalesce(timestamp, created_at), id
            limit $4
            "#,
        vec![
            automation.source_group_id.into(),
            automation.checkpoint_at.into(),
            automation.last_processed_inbox_message_id.into(),
            WORKER_MESSAGE_LIMIT.into(),
            automation.source_account_id.into(),
            automation.stale_message_cutoff_minutes.into(),
        ],
    ))
    .all(db)
    .await
    .c(h!())
}

async fn advance_empty_checkpoint(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
) -> Result<()> {
    if automation.stale_message_cutoff_minutes <= 0 {
        return Ok(());
    }
    let checkpoint_at = Utc::now().naive_utc()
        - ChronoDuration::minutes(i64::from(
            automation.stale_message_cutoff_minutes,
        ));
    if checkpoint_at <= automation.checkpoint_at {
        return Ok(());
    }
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation
        set
            checkpoint_at = $2,
            last_processed_inbox_message_id = 0,
            last_processed_at = now() at time zone 'utc',
            updated_at = now() at time zone 'utc'
        where id = $1
            and checkpoint_at < $2
        "#,
        [automation.id.into(), checkpoint_at.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_send_target(
    db: &DatabaseConnection,
    target_account_id: i32,
    target_group_id: i32,
) -> Result<SendTargetRow> {
    let rows =
        SendTargetRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
        select
            eg.group_id,
            ea.source::text as kind,
            ec.name as client_name
        from echo_group eg
        join echo_account ea on ea.id = eg.account_id
        join echo_client_lock ecl on ecl.account_id = ea.id
        join echo_client ec on ec.id = ecl.client_id
        where eg.id = $1
            and eg.account_id = $2
            and ec.deleted = false
        limit 1
        "#,
            [target_group_id.into(), target_account_id.into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    rows.into_iter()
        .next()
        .with_context(|| {
            format!(
                "target group not found for selected target account: {target_group_id}"
            )
        })
        .c(h!())
}

async fn load_attachment_base64(
    db: &DatabaseConnection,
    message: &InboxMessageRow,
) -> Result<LoadedAttachments> {
    let rows =
        AttachmentRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
        select path
        from echo_attachment
        where message_id = $1 and account_id = $2
        order by id
        "#,
            [message.id.into(), message.account_id.into()],
        ))
        .all(db)
        .await
        .c(h!())?;
    let mut attachments = Vec::new();
    let mut missing = Vec::new();
    for row in rows {
        match tokio::fs::read(&row.path).await {
            Ok(bytes) => {
                attachments.push(general_purpose::STANDARD.encode(bytes))
            }
            Err(err) => missing.push(format!("{}: {err}", row.path)),
        }
    }
    let warning = if missing.is_empty() {
        None
    } else {
        Some(format!(
            "some attachments are unavailable: {}",
            missing.join("; ")
        ))
    };
    Ok(LoadedAttachments {
        content_base64: attachments,
        warning,
    })
}

async fn record_edit_warnings(
    db: &DatabaseConnection,
    automation: &AutomationWorkerRow,
) -> Result<()> {
    const DESCRIPTION: &str =
        "source message was edited after this automation forwarded it";
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
        insert into echo_automation_warning (
            automation_id,
            source_inbox_message_id,
            event_at,
            description
        )
        select
            $1,
            changed.message_id,
            changed.created_at,
            $3
        from echo_inbox_message_changed changed
        join echo_inbox_message message on message.id = changed.message_id
        join echo_automation_delivery delivery
            on delivery.automation_id = $1
            and delivery.source_inbox_message_id = changed.message_id
            and delivery.status = 'sent'
        where message.group_id = $2
            and not exists (
                select 1
                from echo_automation_warning warning
                where warning.automation_id = $1
                    and warning.source_inbox_message_id = changed.message_id
                    and warning.description = $3
            )
        "#,
            vec![
                automation.id.into(),
                automation.source_group_id.into(),
                DESCRIPTION.into(),
            ],
        ))
        .await
        .c(h!())?;
    if result.rows_affected() > 0 {
        log::warn!(
            "recorded {} edited-message automation warnings for automation {}",
            result.rows_affected(),
            automation.id
        );
    }
    Ok(())
}

async fn record_delivery(
    db: &impl ConnectionTrait,
    automation_id: i64,
    message: &InboxMessageRow,
    status: &str,
    error: Option<&str>,
    is_sent: bool,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        insert into echo_automation_delivery (
            automation_id,
            source_inbox_message_id,
            source_internal_id,
            source_message_at,
            status,
            error,
            sent_at,
            updated_at
        )
        values ($1, $2, $3, $4, $5, $6, case when $7 then now() at time zone 'utc' else null end, now() at time zone 'utc')
        on conflict (automation_id, source_inbox_message_id) do update set
            source_internal_id = excluded.source_internal_id,
            source_message_at = excluded.source_message_at,
            status = excluded.status,
            error = excluded.error,
            sent_at = coalesce(excluded.sent_at, echo_automation_delivery.sent_at),
            updated_at = excluded.updated_at
        where echo_automation_delivery.status <> 'sent'
            or excluded.status = 'sent'
        "#,
        vec![
            automation_id.into(),
            message.id.into(),
            message.internal_id.clone().into(),
            message.message_at.into(),
            status.into(),
            error.map(str::to_string).into(),
            is_sent.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn already_sent(
    db: &DatabaseConnection,
    automation_id: i64,
    message: &InboxMessageRow,
) -> Result<bool> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select exists (
                select 1
                from echo_automation_delivery
                where automation_id = $1
                    and status = 'sent'
                    and (
                        source_inbox_message_id = $2
                        or (
                            $3 is not null
                            and source_internal_id = $3
                        )
                    )
            ) as already_sent
            "#,
            vec![
                automation_id.into(),
                message.id.into(),
                message.internal_id.clone().into(),
            ],
        ))
        .await
        .c(h!())?
        .context("already-sent query did not return a row")
        .c(h!())?;
    row.try_get("", "already_sent").c(h!())
}

async fn update_checkpoint(
    db: &DatabaseConnection,
    automation_id: i64,
    inbox_message_id: i32,
    message_at: NaiveDateTime,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation
        set
            checkpoint_at = $3,
            last_processed_inbox_message_id = $2,
            last_processed_at = now() at time zone 'utc',
            updated_at = now() at time zone 'utc'
        where id = $1
        "#,
        [
            automation_id.into(),
            inbox_message_id.into(),
            message_at.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn set_status(
    db: &DatabaseConnection,
    automation_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        update echo_automation
        set
            status = $2,
            last_error = $3,
            updated_at = now() at time zone 'utc'
        where id = $1
        "#,
        vec![
            automation_id.into(),
            status.into(),
            error.map(str::to_string).into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn set_error(
    db: &DatabaseConnection,
    automation_id: i64,
    error: &str,
) -> Result<()> {
    set_status(db, automation_id, "error", Some(error))
        .await
        .c(h!())
}

struct AutomationFilter {
    keyword_tokens: Vec<String>,
    frequency_tokens: Vec<String>,
    stale_message_cutoff_minutes: i32,
    coordinate_presence_mode: CoordinatePresenceMode,
    polygon_filter_mode: PolygonFilterMode,
    polygon: Vec<Point>,
}

fn message_matches_filters(
    automation: &AutomationFilter,
    body: &str,
    message_at: NaiveDateTime,
    now: NaiveDateTime,
    coords: &[Point],
) -> MatchDecision {
    if is_stale(message_at, now, automation.stale_message_cutoff_minutes) {
        return MatchDecision::Skip("message is older than cutoff");
    }
    if (!automation.keyword_tokens.is_empty()
        || !automation.frequency_tokens.is_empty())
        && !matches_any_token(
            body,
            &automation.keyword_tokens,
            &automation.frequency_tokens,
        )
    {
        return MatchDecision::Skip("keyword/frequency filters did not match");
    }
    let has_coords = !coords.is_empty();
    match automation.coordinate_presence_mode {
        CoordinatePresenceMode::Any => {}
        CoordinatePresenceMode::SkipWithCoordinates if has_coords => {
            return MatchDecision::Skip("message has coordinates");
        }
        CoordinatePresenceMode::SkipWithoutCoordinates if !has_coords => {
            return MatchDecision::Skip("message has no coordinates");
        }
        _ => {}
    }
    match automation.polygon_filter_mode {
        PolygonFilterMode::None => MatchDecision::Send,
        PolygonFilterMode::Inside => {
            if !has_coords {
                return MatchDecision::Skip(
                    "polygon filter requires coordinates",
                );
            }
            if coords
                .iter()
                .any(|point| point_in_polygon(*point, &automation.polygon))
            {
                MatchDecision::Skip("message coordinates are inside polygon")
            } else {
                MatchDecision::Send
            }
        }
        PolygonFilterMode::Outside => {
            if !has_coords {
                return MatchDecision::Skip(
                    "polygon filter requires coordinates",
                );
            }
            if coords
                .iter()
                .any(|point| point_in_polygon(*point, &automation.polygon))
            {
                MatchDecision::Send
            } else {
                MatchDecision::Skip("message coordinates are outside polygon")
            }
        }
    }
}

fn is_stale(
    message_at: NaiveDateTime,
    now: NaiveDateTime,
    cutoff_minutes: i32,
) -> bool {
    cutoff_minutes > 0
        && message_at < now - ChronoDuration::minutes(i64::from(cutoff_minutes))
}

fn matches_any_token(
    body: &str,
    keyword_tokens: &[String],
    frequency_tokens: &[String],
) -> bool {
    let body = normalize_text(body);
    keyword_tokens.iter().any(|token| body.contains(token))
        || frequency_tokens
            .iter()
            .any(|token| contains_word_starting_with(&body, token))
}

fn contains_word_starting_with(body: &str, prefix: &str) -> bool {
    body.match_indices(prefix).any(|(start, _)| {
        body[..start]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
    })
}

async fn extract_points(body: &str) -> Vec<Point> {
    let body = prepare_body_for_coords(body);
    milgeo_rs::coordinates::rer_extract_coords(&body)
        .await
        .into_iter()
        .map(|coords| Point {
            lat: coords.lat,
            lng: coords.lng,
        })
        .collect()
}

async fn parse_polygon(tokens: &[String]) -> Result<Vec<Point>> {
    let mut points = Vec::new();
    for token in tokens {
        let mut coords =
            milgeo_rs::coordinates::rer_extract_coords(token).await;
        if coords.is_empty() {
            return Err(bad_request(format!(
                "Некоректна координата району: {token}."
            )));
        }
        let coords = coords.remove(0);
        points.push(Point {
            lat: coords.lat,
            lng: coords.lng,
        });
    }
    Ok(points)
}

fn polygon_has_crossing_sides(polygon: &[Point]) -> bool {
    for first_side in 0..polygon.len() {
        for second_side in (first_side + 1)..polygon.len() {
            if polygon_sides_are_adjacent(
                first_side,
                second_side,
                polygon.len(),
            ) {
                continue;
            }
            if segments_intersect(
                polygon[first_side],
                polygon[(first_side + 1) % polygon.len()],
                polygon[second_side],
                polygon[(second_side + 1) % polygon.len()],
            ) {
                return true;
            }
        }
    }
    false
}

fn polygon_sides_are_adjacent(
    first_side: usize,
    second_side: usize,
    point_count: usize,
) -> bool {
    (first_side + 1) % point_count == second_side
        || (second_side + 1) % point_count == first_side
}

fn segments_intersect(
    first_start: Point,
    first_end: Point,
    second_start: Point,
    second_end: Point,
) -> bool {
    let first_start_side = cross_product(first_start, first_end, second_start);
    let first_end_side = cross_product(first_start, first_end, second_end);
    let second_start_side =
        cross_product(second_start, second_end, first_start);
    let second_end_side = cross_product(second_start, second_end, first_end);

    if first_start_side == 0.0
        && point_is_on_segment(second_start, first_start, first_end)
    {
        return true;
    }
    if first_end_side == 0.0
        && point_is_on_segment(second_end, first_start, first_end)
    {
        return true;
    }
    if second_start_side == 0.0
        && point_is_on_segment(first_start, second_start, second_end)
    {
        return true;
    }
    if second_end_side == 0.0
        && point_is_on_segment(first_end, second_start, second_end)
    {
        return true;
    }
    first_start_side.is_sign_positive() != first_end_side.is_sign_positive()
        && second_start_side.is_sign_positive()
            != second_end_side.is_sign_positive()
}

fn cross_product(start: Point, end: Point, point: Point) -> f64 {
    (end.lng - start.lng) * (point.lat - start.lat)
        - (end.lat - start.lat) * (point.lng - start.lng)
}

fn point_is_on_segment(point: Point, start: Point, end: Point) -> bool {
    point.lng >= start.lng.min(end.lng)
        && point.lng <= start.lng.max(end.lng)
        && point.lat >= start.lat.min(end.lat)
        && point.lat <= start.lat.max(end.lat)
}

fn point_in_polygon(point: Point, polygon: &[Point]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = polygon.len() - 1;
    for i in 0..polygon.len() {
        let pi = polygon[i];
        let pj = polygon[j];
        let intersects = ((pi.lat > point.lat) != (pj.lat > point.lat))
            && (point.lng
                < (pj.lng - pi.lng) * (point.lat - pi.lat) / (pj.lat - pi.lat)
                    + pi.lng);
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn prepare_body_for_coords(body: &str) -> String {
    let mut result = String::with_capacity(body.len());
    for line in body.lines() {
        if !is_non_coordinate_header_line(line) {
            result.push_str(line);
        }
        result.push('\n');
    }
    result
}

fn is_non_coordinate_header_line(line: &str) -> bool {
    if line_mentions_coordinates(line) {
        return false;
    }
    is_dmr_metadata_line(line)
        || is_callsign_map_line(line)
        || is_received_from_post_line(line)
}

fn line_mentions_coordinates(line: &str) -> bool {
    let line = line.to_lowercase();
    line.contains("координат")
        || line.contains("coordinate")
        || line.contains("coords")
        || line.contains("mgrs")
        || line.contains("wgs")
}

fn is_dmr_metadata_line(line: &str) -> bool {
    static RE_CC: OnceLock<Regex> = OnceLock::new();
    static RE_ID: OnceLock<Regex> = OnceLock::new();
    static RE_CG: OnceLock<Regex> = OnceLock::new();
    RE_CC
        .get_or_init(|| {
            Regex::new(r#"(?i)^\s*(?:[cс]{2}\s*:?\s*|код\s+кольору\s*:?\s*)"#)
                .unwrap()
        })
        .is_match(line)
        || RE_ID
            .get_or_init(|| {
                Regex::new(
                    r#"(?i)^\s*(?:[iі]d\s*➡️?|source\s+id|[iі]d\s+відправника|[iі]d)\s*:?\s+"#,
                )
                .unwrap()
            })
            .is_match(line)
        || RE_CG
            .get_or_init(|| {
                Regex::new(
                    r#"(?i)^\s*(?:[iі]d\s*\(\s*[cс]g\s*\)\s*⬅️?|[iі]d\s*⬅️?(?:\s*\(\s*[cс]g\s*\))?|[iі]d\s+отримувача|group\s+id|код\s+групи|[cс]g)\s*:?\s+"#,
                )
                .unwrap()
            })
            .is_match(line)
}

fn is_callsign_map_line(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)^\s*(?:позивні|позывные|callsigns?)\s*:"#).unwrap()
    })
    .is_match(line)
}

fn is_received_from_post_line(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)^\s*отримано\s+з\s+поста\s+"#).unwrap())
        .is_match(line)
}

fn normalize_tokens(tokens: Vec<String>) -> Vec<String> {
    tokens
        .into_iter()
        .map(|token| normalize_text(&token))
        .filter(|token| !token.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_polygon_coordinates(coordinates: Vec<String>) -> Vec<String> {
    coordinates
        .into_iter()
        .map(|coordinate| coordinate.trim().to_string())
        .filter(|coordinate| !coordinate.is_empty())
        .collect()
}

fn normalize_text(value: &str) -> String {
    value.trim().to_lowercase()
}

fn json_vec(value: Option<&Json>) -> Vec<String> {
    value
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn messenger_kind_from_db(kind: &str) -> Result<MessengerKind> {
    match kind {
        "signal" => Ok(MessengerKind::Signal),
        "whatsapp" => Ok(MessengerKind::Whatsapp),
        _ => bail!("unsupported messenger kind: {kind}"),
    }
}

fn public_client_name(client_name: &str) -> String {
    client_name
        .strip_prefix(OWNED_CLIENT_PREFIX)
        .unwrap_or(client_name)
        .to_string()
}

fn automation_view(row: AutomationListRow) -> AutomationView {
    AutomationView {
        id: row.id,
        name: row.name,
        source_account_id: row.source_account_id,
        source_account_name: row.source_account_name,
        source_account_phone: row.source_account_phone,
        source_account_is_linked: row.source_account_is_linked,
        source_group_id: row.source_group_id,
        source_group_name: row.source_group_name,
        source_messenger_kind: row.source_messenger_kind,
        target_account_id: row.target_account_id,
        target_account_name: row.target_account_name,
        target_account_phone: row.target_account_phone,
        target_account_is_linked: row.target_account_is_linked,
        target_group_id: row.target_group_id,
        target_group_name: row.target_group_name,
        target_messenger_kind: row.target_messenger_kind,
        keyword_tokens: json_vec(Some(&row.keyword_tokens)),
        frequency_tokens: json_vec(Some(&row.frequency_tokens)),
        stale_message_cutoff_minutes: row.stale_message_cutoff_minutes,
        resend_attachments: row.resend_attachments,
        coordinates_screenshot: row.coordinates_screenshot,
        coordinate_presence_mode: row.coordinate_presence_mode,
        polygon_filter_mode: row.polygon_filter_mode,
        polygon_id: row.polygon_id,
        polygon_name: row.polygon_name,
        polygon_coordinates: json_vec(row.polygon_coordinates.as_ref()),
        is_paused: row.is_paused,
        status: row.status,
        last_error: row.last_error,
        checkpoint_at: row.checkpoint_at.and_utc().timestamp_millis(),
        usage: UsageCounters {
            last_24h: row.usage_24h,
            last_7d: row.usage_7d,
            all_time: row.usage_all,
        },
        created_at: row.created_at.and_utc().timestamp_millis(),
        updated_at: row.updated_at.and_utc().timestamp_millis(),
    }
}

async fn polygon_view(row: PolygonListRow) -> Result<PolygonView> {
    let coordinates = json_vec(Some(&row.coordinates));
    let points = parse_polygon(&coordinates)
        .await
        .c(h!())?
        .into_iter()
        .map(|point| PolygonPointView {
            lat: point.lat,
            lng: point.lng,
        })
        .collect();
    Ok(PolygonView {
        id: row.id,
        name: row.name,
        coordinates,
        points,
        automation_count: row.automation_count,
        created_at: row.created_at.and_utc().timestamp_millis(),
        updated_at: row.updated_at.and_utc().timestamp_millis(),
    })
}

async fn load_polygon_view(
    db: &DatabaseConnection,
    id: i64,
) -> Result<PolygonView> {
    let rows = PolygonListRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        select
            polygon.id,
            polygon.name,
            polygon.coordinates,
            count(automation.id)::bigint as automation_count,
            polygon.created_at,
            polygon.updated_at
        from echo_automation_polygon polygon
        left join echo_automation automation on automation.polygon_id = polygon.id
        where polygon.id = $1
        group by polygon.id
        "#,
        [id.into()],
    ))
    .all(db)
    .await
    .c(h!())?;
    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| {
            not_found(format!(
                "Район інтересу {id} не знайдено. Оновіть сторінку та повторіть спробу."
            ))
        })
        .c(h!())?;
    polygon_view(row).await.c(h!())
}

async fn normalize_polygon_req(
    req: SavePolygonReq,
) -> Result<(String, Vec<String>)> {
    let name = req.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(bad_request("Вкажіть назву району інтересу."));
    }
    let coordinates = normalize_polygon_coordinates(req.coordinates);
    if coordinates.len() < 3 {
        return Err(bad_request(
            "Для району інтересу потрібно щонайменше 3 координати.",
        ));
    }
    let polygon = parse_polygon(&coordinates).await.c(h!())?;
    if polygon.len() < 3 {
        return Err(bad_request(
            "Для району інтересу потрібно щонайменше 3 коректні координати.",
        ));
    }
    if polygon_has_crossing_sides(&polygon) {
        return Err(bad_request(
            "Сторони району інтересу не мають перетинатися.",
        ));
    }
    Ok((name, coordinates))
}

fn list_sql_head() -> &'static str {
    r#"
    select
        a.id,
        a.name,
        a.source_account_id,
        coalesce(nullif(source_client.display_name, ''), regexp_replace(source_client.name, '^echo-swapp-', '')) as source_account_name,
        source_account.phone_number as source_account_phone,
        source_account.is_linked as source_account_is_linked,
        a.source_group_id,
        coalesce(nullif(source_group.name, ''), source_group.group_id) as source_group_name,
        source_account.source::text as source_messenger_kind,
        a.target_account_id,
        coalesce(nullif(target_client.display_name, ''), regexp_replace(target_client.name, '^echo-swapp-', '')) as target_account_name,
        target_account.phone_number as target_account_phone,
        target_account.is_linked as target_account_is_linked,
        a.target_group_id,
        coalesce(nullif(target_group.name, ''), target_group.group_id) as target_group_name,
        target_account.source::text as target_messenger_kind,
        a.keyword_tokens,
        a.frequency_tokens,
        a.stale_message_cutoff_minutes,
        a.resend_attachments,
        a.coordinates_screenshot,
        a.coordinate_presence_mode,
        a.polygon_filter_mode,
        a.polygon_id,
        polygon.name as polygon_name,
        polygon.coordinates as polygon_coordinates,
        a.is_paused,
        a.status,
        a.last_error,
        count(delivery.id) filter (
            where delivery.status = 'sent'
                and delivery.sent_at >= (now() at time zone 'utc') - interval '24 hours'
        )::bigint as usage_24h,
        count(delivery.id) filter (
            where delivery.status = 'sent'
                and delivery.sent_at >= (now() at time zone 'utc') - interval '7 days'
        )::bigint as usage_7d,
        count(delivery.id) filter (where delivery.status = 'sent')::bigint as usage_all,
        a.checkpoint_at,
        a.created_at,
        a.updated_at
    from echo_automation a
    join echo_account source_account on source_account.id = a.source_account_id
    join echo_client_lock source_lock on source_lock.account_id = source_account.id
    join echo_client source_client
        on source_client.id = source_lock.client_id
        and source_client.deleted = false
    join echo_group source_group
        on source_group.id = a.source_group_id
        and source_group.account_id = source_account.id
    join echo_account target_account on target_account.id = a.target_account_id
    join echo_client_lock target_lock on target_lock.account_id = target_account.id
    join echo_client target_client
        on target_client.id = target_lock.client_id
        and target_client.deleted = false
    join echo_group target_group
        on target_group.id = a.target_group_id
        and target_group.account_id = target_account.id
    left join echo_automation_polygon polygon
        on polygon.id = a.polygon_id
    left join echo_automation_delivery delivery
        on delivery.automation_id = a.id
    "#
}

fn list_sql_tail() -> &'static str {
    r#"
    group by
        a.id,
        source_account.id,
        source_client.id,
        source_group.id,
        target_account.id,
        target_client.id,
        target_group.id,
        polygon.id
    order by a.created_at desc, a.id desc
    "#
}

fn list_sql() -> String {
    format!("{} {}", list_sql_head(), list_sql_tail())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, Value};

    static DB_TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());
    const DEFAULT_TEST_DATABASE_URL: &str =
        "postgres://wd:fee_-_-_-FnoeKFBeebu87bf@localhost:5432/wd";

    struct TestFixture {
        namespace: String,
        phone_number: String,
        account_id: i32,
        source_group_id: i32,
        target_group_id: i32,
        automation_id: i64,
    }

    #[derive(FromQueryResult)]
    struct TestSendLogRow {
        automation_id: i64,
        source_inbox_message_id: i32,
        source_group_id: i32,
        target_group_id: i32,
        planned_at: NaiveDateTime,
        sent_at: Option<NaiveDateTime>,
        created_at: NaiveDateTime,
    }

    #[derive(FromQueryResult)]
    struct TestDeliveryRow {
        status: String,
        error: Option<String>,
        sent_at: Option<NaiveDateTime>,
    }

    fn filter() -> AutomationFilter {
        AutomationFilter {
            keyword_tokens: vec!["alpha".to_string()],
            frequency_tokens: vec![],
            stale_message_cutoff_minutes: 60,
            coordinate_presence_mode: CoordinatePresenceMode::Any,
            polygon_filter_mode: PolygonFilterMode::None,
            polygon: vec![],
        }
    }

    fn save_automation_req(
        polygon_filter_mode: Option<&str>,
        polygon_id: Option<i64>,
    ) -> SaveAutomationReq {
        SaveAutomationReq {
            name: None,
            source_account_id: 1,
            source_group_id: 2,
            target_account_id: 3,
            target_group_id: 4,
            keyword_tokens: vec!["alpha".to_string()],
            frequency_tokens: vec![],
            stale_message_cutoff_minutes: 60,
            resend_attachments: false,
            coordinates_screenshot: false,
            coordinate_presence_mode: None,
            polygon_filter_mode: polygon_filter_mode.map(str::to_string),
            polygon_id,
        }
    }

    async fn test_db() -> Result<DatabaseConnection> {
        let url = std::env::var("ECHO_SWAPP_TEST_DATABASE_URL")
            .unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_string());
        let db = Database::connect(url).await.c(h!())?;
        crate::automation::ensure_schema(&db).await.c(h!())?;
        crate::messenger::ensure_schema(&db).await.c(h!())?;
        Ok(db)
    }

    fn test_namespace() -> String {
        let suffix = Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| Utc::now().timestamp_micros())
            % 1_000_000_000_000;
        format!("swapp-test-{}", suffix.abs())
    }

    async fn cleanup_test_namespace(
        db: &DatabaseConnection,
        namespace: &str,
        phone_number: &str,
    ) -> Result<()> {
        execute_test_sql(
            db,
            r#"
            delete from echo_automation_send_log
            where automation_id in (
                select id from echo_automation where name = $1
            )
                or source_internal_id like ($1 || ':%')
            "#,
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            "delete from echo_automation where name = $1",
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            "delete from echo_inbox_message where internal_id like ($1 || ':%')",
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            "delete from echo_group where group_id like ($1 || ':%')",
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            r#"
            delete from echo_client_lock
            where client_id in (
                select id from echo_client where name = $1
            )
            "#,
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            "delete from echo_account where phone_number = $1",
            vec![phone_number.to_string().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            "delete from echo_client where name = $1",
            vec![namespace.to_string().into()],
        )
        .await
        .c(h!())?;
        Ok(())
    }

    async fn execute_test_sql(
        db: &DatabaseConnection,
        sql: &str,
        values: Vec<Value>,
    ) -> Result<()> {
        db.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            values,
        ))
        .await
        .c(h!())?;
        Ok(())
    }

    async fn query_i32(
        db: &DatabaseConnection,
        sql: &str,
        values: Vec<Value>,
    ) -> Result<i32> {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                values,
            ))
            .await
            .c(h!())?
            .context("query did not return a row")
            .c(h!())?;
        row.try_get("", "id").c(h!())
    }

    async fn query_i64(
        db: &DatabaseConnection,
        sql: &str,
        values: Vec<Value>,
    ) -> Result<i64> {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                values,
            ))
            .await
            .c(h!())?
            .context("query did not return a row")
            .c(h!())?;
        row.try_get("", "id").c(h!())
    }

    async fn create_fixture(db: &DatabaseConnection) -> Result<TestFixture> {
        let namespace = test_namespace();
        let phone_number = format!(
            "+{}",
            namespace
                .rsplit('-')
                .next()
                .context("test namespace has no suffix")
                .c(h!())?
        );
        cleanup_test_namespace(db, &namespace, &phone_number)
            .await
            .c(h!())?;
        let account_id = query_i32(
            db,
            r#"
            insert into echo_account (source, phone_number, is_linked)
            values ('signal'::echo_message_source, $1, true)
            returning id
            "#,
            vec![phone_number.clone().into()],
        )
        .await
        .c(h!())?;
        let client_id = query_i32(
            db,
            "insert into echo_client (name) values ($1) returning id",
            vec![namespace.clone().into()],
        )
        .await
        .c(h!())?;
        execute_test_sql(
            db,
            r#"
            insert into echo_client_lock (client_id, account_id)
            values ($1, $2)
            "#,
            vec![client_id.into(), account_id.into()],
        )
        .await
        .c(h!())?;
        let source_group_id =
            insert_group(db, &namespace, account_id, "source")
                .await
                .c(h!())?;
        let target_group_id =
            insert_group(db, &namespace, account_id, "target")
                .await
                .c(h!())?;
        let automation_id = query_i64(
            db,
            r#"
            insert into echo_automation (
                name,
                source_account_id,
                source_group_id,
                target_account_id,
                target_group_id,
                keyword_tokens,
                frequency_tokens,
                stale_message_cutoff_minutes,
                resend_attachments,
                coordinate_presence_mode,
                polygon_filter_mode,
                polygon_id
            )
            values ($1, $2, $3, $4, $5, '["alpha"]'::jsonb, '[]'::jsonb, 60, false, 'any', 'none', null)
            returning id
            "#,
            vec![
                namespace.clone().into(),
                account_id.into(),
                source_group_id.into(),
                account_id.into(),
                target_group_id.into(),
            ],
        )
        .await
        .c(h!())?;
        Ok(TestFixture {
            namespace,
            phone_number,
            account_id,
            source_group_id,
            target_group_id,
            automation_id,
        })
    }

    async fn insert_test_automation(
        db: &DatabaseConnection,
        fixture: &TestFixture,
    ) -> Result<i64> {
        query_i64(
            db,
            r#"
            insert into echo_automation (
                name,
                source_account_id,
                source_group_id,
                target_account_id,
                target_group_id,
                keyword_tokens,
                frequency_tokens,
                stale_message_cutoff_minutes,
                resend_attachments,
                coordinate_presence_mode,
                polygon_filter_mode,
                polygon_id
            )
            values ($1, $2, $3, $2, $4, '["alpha"]'::jsonb, '[]'::jsonb, 60, false, 'any', 'none', null)
            returning id
            "#,
            vec![
                fixture.namespace.clone().into(),
                fixture.account_id.into(),
                fixture.source_group_id.into(),
                fixture.target_group_id.into(),
            ],
        )
        .await
        .c(h!())
    }

    async fn send_log_exists(
        db: &DatabaseConnection,
        send_log_id: i64,
    ) -> Result<bool> {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
                select exists (
                    select 1
                    from echo_automation_send_log
                    where id = $1
                ) as value
                "#,
                [send_log_id.into()],
            ))
            .await
            .c(h!())?
            .context("send-log existence query did not return a row")
            .c(h!())?;
        row.try_get("", "value").c(h!())
    }

    async fn load_test_send_log(
        db: &DatabaseConnection,
        send_log_id: i64,
    ) -> Result<TestSendLogRow> {
        TestSendLogRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select
                automation_id,
                source_inbox_message_id,
                source_group_id,
                target_group_id,
                planned_at,
                sent_at,
                created_at
            from echo_automation_send_log
            where id = $1
            "#,
            [send_log_id.into()],
        ))
        .one(db)
        .await
        .c(h!())?
        .context("send log was not found")
        .c(h!())
    }

    async fn load_test_delivery(
        db: &DatabaseConnection,
        automation_id: i64,
        message_id: i32,
    ) -> Result<TestDeliveryRow> {
        TestDeliveryRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select status, error, sent_at
            from echo_automation_delivery
            where automation_id = $1
                and source_inbox_message_id = $2
            "#,
            [automation_id.into(), message_id.into()],
        ))
        .one(db)
        .await
        .c(h!())?
        .context("delivery was not found")
        .c(h!())
    }

    async fn plan_fixture_send(
        db: &DatabaseConnection,
        fixture: &TestFixture,
        message: &InboxMessageRow,
    ) -> Result<i64> {
        plan_send(
            db,
            fixture.automation_id,
            fixture.source_group_id,
            fixture.target_group_id,
            message,
        )
        .await
        .c(h!())?
        .context("send log was not planned")
        .c(h!())
    }

    async fn claim_send_once(
        db: &DatabaseConnection,
        fixture: &TestFixture,
        second_automation_id: i64,
        message: &InboxMessageRow,
    ) -> Result<(i64, i64)> {
        let (first, second) = tokio::join!(
            plan_send(
                db,
                fixture.automation_id,
                fixture.source_group_id,
                fixture.target_group_id,
                message,
            ),
            plan_send(
                db,
                second_automation_id,
                fixture.source_group_id,
                fixture.target_group_id,
                message,
            ),
        );
        match (first.c(h!())?, second.c(h!())?) {
            (Some(send_log_id), None) => {
                Ok((send_log_id, fixture.automation_id))
            }
            (None, Some(send_log_id)) => {
                Ok((send_log_id, second_automation_id))
            }
            claims => bail!("expected exactly one send claim: {claims:?}"),
        }
    }

    async fn insert_group(
        db: &DatabaseConnection,
        namespace: &str,
        account_id: i32,
        label: &str,
    ) -> Result<i32> {
        let group_id = format!("{namespace}:{label}");
        query_i32(
            db,
            r#"
            insert into echo_group (group_id, internal_id, name, account_id)
            values ($1, $1, $2, $3)
            returning id
            "#,
            vec![
                group_id.into(),
                format!("{namespace} {label}").into(),
                account_id.into(),
            ],
        )
        .await
        .c(h!())
    }

    async fn insert_message(
        db: &DatabaseConnection,
        fixture: &TestFixture,
        internal_id: &str,
        message_at: NaiveDateTime,
    ) -> Result<InboxMessageRow> {
        insert_message_with_body(db, fixture, internal_id, message_at, "alpha")
            .await
            .c(h!())
    }

    async fn insert_message_with_body(
        db: &DatabaseConnection,
        fixture: &TestFixture,
        internal_id: &str,
        message_at: NaiveDateTime,
        body: &str,
    ) -> Result<InboxMessageRow> {
        let internal_id = format!("{}:{internal_id}", fixture.namespace);
        let id = query_i32(
            db,
            r#"
            insert into echo_inbox_message (
                body,
                internal_id,
                group_id,
                account_id,
                "timestamp",
                created_at,
                updated_at
            )
            values ($1, $2, $3, $4, $5, $5, $5)
            returning id
            "#,
            vec![
                body.to_string().into(),
                internal_id.clone().into(),
                fixture.source_group_id.into(),
                fixture.account_id.into(),
                message_at.into(),
            ],
        )
        .await
        .c(h!())?;
        Ok(InboxMessageRow {
            id,
            internal_id: Some(internal_id),
            body: body.to_string(),
            account_id: fixture.account_id,
            message_at,
        })
    }

    async fn insert_sent_delivery(
        db: &DatabaseConnection,
        fixture: &TestFixture,
        message: &InboxMessageRow,
        sent_at: NaiveDateTime,
    ) -> Result<()> {
        execute_test_sql(
            db,
            r#"
            insert into echo_automation_delivery (
                automation_id,
                source_inbox_message_id,
                source_internal_id,
                source_message_at,
                status,
                sent_at
            )
            values ($1, $2, $3, $4, 'sent', $5)
            "#,
            vec![
                fixture.automation_id.into(),
                message.id.into(),
                message.internal_id.clone().into(),
                message.message_at.into(),
                sent_at.into(),
            ],
        )
        .await
        .c(h!())
    }

    #[test]
    fn normalizes_tokens() {
        assert_eq!(
            normalize_tokens(vec![
                " Alpha ".to_string(),
                "alpha".to_string(),
                "".to_string(),
                "BRAVO".to_string(),
            ]),
            vec!["alpha".to_string(), "bravo".to_string()]
        );
    }

    #[tokio::test]
    async fn preserves_polygon_coordinate_order() {
        let coordinates = vec![
            " 47.900000, 35.900000 ".to_string(),
            "47.900000, 35.100000".to_string(),
            "47.100000, 35.100000".to_string(),
            "47.100000, 35.900000".to_string(),
        ];
        let (_, coordinates) = normalize_polygon_req(SavePolygonReq {
            name: Some("test".to_string()),
            coordinates,
        })
        .await
        .unwrap();

        assert_eq!(
            coordinates,
            vec![
                "47.900000, 35.900000",
                "47.900000, 35.100000",
                "47.100000, 35.100000",
                "47.100000, 35.900000",
            ]
        );
    }

    #[test]
    fn detects_crossing_polygon_sides() {
        let ordered = vec![
            Point {
                lat: 47.0,
                lng: 35.0,
            },
            Point {
                lat: 47.0,
                lng: 36.0,
            },
            Point {
                lat: 48.0,
                lng: 36.0,
            },
            Point {
                lat: 48.0,
                lng: 35.0,
            },
        ];
        let crossing = vec![ordered[0], ordered[2], ordered[1], ordered[3]];

        assert!(!polygon_has_crossing_sides(&ordered));
        assert!(polygon_has_crossing_sides(&crossing));
    }

    #[tokio::test]
    async fn rejects_polygon_with_crossing_sides() {
        let err = normalize_polygon_req(SavePolygonReq {
            name: Some("test".to_string()),
            coordinates: vec![
                "47.000000, 35.000000".to_string(),
                "48.000000, 36.000000".to_string(),
                "47.000000, 36.000000".to_string(),
                "48.000000, 35.000000".to_string(),
            ],
        })
        .await
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "Сторони району інтересу не мають перетинатися."
        );
    }

    #[tokio::test]
    async fn polygon_view_projects_coordinate_tokens_to_points() -> Result<()> {
        let now = Utc::now().naive_utc();
        let coordinates = vec![
            "47.421350, 35.621970".to_string(),
            "47.422000, 35.623000".to_string(),
            "47.420000, 35.624000".to_string(),
        ];
        let polygon = polygon_view(PolygonListRow {
            id: 1,
            name: "test".to_string(),
            coordinates: serde_json::json!(coordinates.clone()),
            automation_count: 0,
            created_at: now,
            updated_at: now,
        })
        .await
        .c(h!())?;

        assert_eq!(polygon.coordinates, coordinates);
        assert_eq!(polygon.points.len(), 3);
        assert!((polygon.points[0].lat - 47.42135).abs() < f64::EPSILON);
        assert!((polygon.points[0].lng - 35.62197).abs() < f64::EPSILON);
        Ok(())
    }

    #[tokio::test]
    async fn missing_polygon_selection_disables_polygon_filter() -> Result<()> {
        let mut req = save_automation_req(Some("inside"), None);
        req.coordinate_presence_mode =
            Some("skip_with_coordinates".to_string());

        let automation = normalize_req(req).await.c(h!())?;

        assert_eq!(
            automation.coordinate_presence_mode,
            CoordinatePresenceMode::SkipWithCoordinates
        );
        assert_eq!(automation.polygon_filter_mode, PolygonFilterMode::None);
        assert_eq!(automation.polygon_id, None);
        Ok(())
    }

    #[tokio::test]
    async fn empty_keyword_and_frequency_filters_are_allowed() -> Result<()> {
        let mut req = save_automation_req(None, None);
        req.keyword_tokens = vec![];
        req.frequency_tokens = vec![];

        let automation = normalize_req(req).await.c(h!())?;

        assert_eq!(automation.keyword_tokens, Vec::<String>::new());
        assert_eq!(automation.frequency_tokens, Vec::<String>::new());
        Ok(())
    }

    #[tokio::test]
    async fn preserves_coordinate_screenshot_setting() -> Result<()> {
        let mut req = save_automation_req(None, None);
        req.coordinates_screenshot = true;

        let automation = normalize_req(req).await.c(h!())?;

        assert!(automation.coordinates_screenshot);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_coordinate_screenshot_when_coordinates_are_ignored() {
        let mut req = save_automation_req(None, None);
        req.coordinates_screenshot = true;
        req.coordinate_presence_mode =
            Some("skip_with_coordinates".to_string());

        let err = normalize_req(req).await.unwrap_err();

        assert_eq!(
            err.to_string(),
            "Не можна створювати знімок координат, коли повідомлення з координатами ігноруються."
        );
    }

    #[test]
    fn empty_keyword_and_frequency_filters_match_message() {
        let automation = AutomationFilter {
            keyword_tokens: vec![],
            frequency_tokens: vec![],
            ..filter()
        };
        let now = Utc::now().naive_utc();

        let decision = message_matches_filters(
            &automation,
            "No configured token filters",
            now,
            now,
            &[],
        );

        assert_eq!(decision, MatchDecision::Send);
    }

    #[test]
    fn matches_keywords_case_insensitively() {
        let decision = message_matches_filters(
            &filter(),
            "Contact ALPHA reported",
            Utc::now().naive_utc(),
            Utc::now().naive_utc(),
            &[],
        );
        assert_eq!(decision, MatchDecision::Send);
    }

    #[test]
    fn matches_keyword_inside_word() {
        let automation = AutomationFilter {
            keyword_tokens: vec!["apple".to_string()],
            ..filter()
        };
        let now = Utc::now().naive_utc();
        let decision = message_matches_filters(
            &automation,
            "I love apples.",
            now,
            now,
            &[],
        );
        assert_eq!(decision, MatchDecision::Send);
    }

    #[test]
    fn matches_frequency_at_start_of_word() {
        let automation = AutomationFilter {
            keyword_tokens: vec![],
            frequency_tokens: vec!["134.50".to_string()],
            ..filter()
        };
        let now = Utc::now().naive_utc();

        for body in ["134.5005", "Frequency: 134.509999", "(134.500)"] {
            let decision =
                message_matches_filters(&automation, body, now, now, &[]);
            assert_eq!(decision, MatchDecision::Send, "{body}");
        }
    }

    #[test]
    fn skips_frequency_inside_word() {
        let automation = AutomationFilter {
            keyword_tokens: vec![],
            frequency_tokens: vec!["134.50".to_string()],
            ..filter()
        };
        let now = Utc::now().naive_utc();
        let decision = message_matches_filters(
            &automation,
            "Frequency: 1134.5005",
            now,
            now,
            &[],
        );

        assert_eq!(
            decision,
            MatchDecision::Skip("keyword/frequency filters did not match")
        );
    }

    #[test]
    fn skips_stale_messages() {
        let now = Utc::now().naive_utc();
        let decision = message_matches_filters(
            &filter(),
            "alpha",
            now - ChronoDuration::minutes(61),
            now,
            &[],
        );
        assert_eq!(
            decision,
            MatchDecision::Skip("message is older than cutoff")
        );
    }

    #[test]
    fn skips_messages_without_required_coordinates() {
        let automation = AutomationFilter {
            coordinate_presence_mode:
                CoordinatePresenceMode::SkipWithoutCoordinates,
            ..filter()
        };
        let now = Utc::now().naive_utc();
        let decision =
            message_matches_filters(&automation, "alpha", now, now, &[]);
        assert_eq!(decision, MatchDecision::Skip("message has no coordinates"));
    }

    #[test]
    fn skips_inside_polygon_when_configured() {
        let automation = AutomationFilter {
            polygon_filter_mode: PolygonFilterMode::Inside,
            polygon: vec![
                Point { lat: 0.0, lng: 0.0 },
                Point {
                    lat: 0.0,
                    lng: 10.0,
                },
                Point {
                    lat: 10.0,
                    lng: 10.0,
                },
                Point {
                    lat: 10.0,
                    lng: 0.0,
                },
            ],
            ..filter()
        };
        let now = Utc::now().naive_utc();
        let decision = message_matches_filters(
            &automation,
            "alpha",
            now,
            now,
            &[Point { lat: 5.0, lng: 5.0 }],
        );
        assert_eq!(
            decision,
            MatchDecision::Skip("message coordinates are inside polygon")
        );
    }

    #[test]
    fn sends_inside_polygon_when_outside_is_skipped() {
        let automation = AutomationFilter {
            polygon_filter_mode: PolygonFilterMode::Outside,
            polygon: vec![
                Point { lat: 0.0, lng: 0.0 },
                Point {
                    lat: 0.0,
                    lng: 10.0,
                },
                Point {
                    lat: 10.0,
                    lng: 10.0,
                },
                Point {
                    lat: 10.0,
                    lng: 0.0,
                },
            ],
            ..filter()
        };
        let now = Utc::now().naive_utc();
        let decision = message_matches_filters(
            &automation,
            "alpha",
            now,
            now,
            &[Point { lat: 5.0, lng: 5.0 }],
        );
        assert_eq!(decision, MatchDecision::Send);
    }

    #[tokio::test]
    async fn send_plan_is_claimed_once_across_automations() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let second_automation_id =
                insert_test_automation(&db, &fixture).await.c(h!())?;
            let message =
                insert_message(&db, &fixture, "shared", Utc::now().naive_utc())
                    .await
                    .c(h!())?;
            assert!(!send_is_planned(
                &db,
                fixture.source_group_id,
                fixture.target_group_id,
                &message,
            )
            .await
            .c(h!())?);
            let (send_log_id, automation_id) =
                claim_send_once(&db, &fixture, second_automation_id, &message)
                    .await
                    .c(h!())?;
            assert!(send_is_planned(
                &db,
                fixture.source_group_id,
                fixture.target_group_id,
                &message,
            )
            .await
            .c(h!())?);
            let send_log =
                load_test_send_log(&db, send_log_id).await.c(h!())?;
            assert_eq!(send_log.automation_id, automation_id);
            assert_eq!(send_log.source_inbox_message_id, message.id);
            assert_eq!(send_log.source_group_id, fixture.source_group_id);
            assert_eq!(send_log.target_group_id, fixture.target_group_id);
            assert!(send_log.planned_at <= Utc::now().naive_utc());
            assert!(send_log.created_at <= Utc::now().naive_utc());
            assert_eq!(send_log.sent_at, None);

            mark_send_sent(&db, send_log_id).await.c(h!())?;
            assert!(load_test_send_log(&db, send_log_id)
                .await
                .c(h!())?
                .sent_at
                .is_some());
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn rolled_back_send_plan_can_be_reclaimed() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let message = insert_message(
                &db,
                &fixture,
                "rollback",
                Utc::now().naive_utc(),
            )
            .await
            .c(h!())?;
            let txn = db.begin().await.c(h!())?;
            assert!(plan_send(
                &txn,
                fixture.automation_id,
                fixture.source_group_id,
                fixture.target_group_id,
                &message,
            )
            .await
            .c(h!())?
            .is_some());
            txn.rollback().await.c(h!())?;

            assert!(plan_send(
                &db,
                fixture.automation_id,
                fixture.source_group_id,
                fixture.target_group_id,
                &message,
            )
            .await
            .c(h!())?
            .is_some());
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn send_plan_deduplicates_stable_internal_id() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let second_automation_id =
                insert_test_automation(&db, &fixture).await.c(h!())?;
            let now = Utc::now().naive_utc();
            let original =
                insert_message(&db, &fixture, "stable-internal-id", now)
                    .await
                    .c(h!())?;
            let duplicate =
                insert_message(&db, &fixture, "stable-internal-id", now)
                    .await
                    .c(h!())?;
            assert_ne!(original.id, duplicate.id);
            assert!(
                plan_fixture_send(&db, &fixture, &original).await.c(h!())? > 0
            );
            assert!(plan_send(
                &db,
                second_automation_id,
                fixture.source_group_id,
                fixture.target_group_id,
                &duplicate,
            )
            .await
            .c(h!())?
            .is_none());
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn send_log_retention_hard_deletes_only_expired_rows() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let now = Utc::now().naive_utc();
            let old_message =
                insert_message(&db, &fixture, "old-send-log", now)
                    .await
                    .c(h!())?;
            let current_message =
                insert_message(&db, &fixture, "current-send-log", now)
                    .await
                    .c(h!())?;
            let old_send_log_id =
                plan_fixture_send(&db, &fixture, &old_message)
                    .await
                    .c(h!())?;
            let current_send_log_id =
                plan_fixture_send(&db, &fixture, &current_message)
                    .await
                    .c(h!())?;
            execute_test_sql(
                &db,
                r#"
                update echo_automation_send_log
                set created_at = (now() at time zone 'utc') - interval '31 days'
                where id = $1
                "#,
                vec![old_send_log_id.into()],
            )
            .await
            .c(h!())?;

            assert!(delete_expired_send_log(&db).await.c(h!())? >= 1);
            assert!(!send_log_exists(&db, old_send_log_id).await.c(h!())?);
            assert!(send_log_exists(&db, current_send_log_id).await.c(h!())?);
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn already_sent_matches_original_internal_id() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let now = Utc::now().naive_utc();
            let message = insert_message(&db, &fixture, "original", now)
                .await
                .c(h!())?;
            insert_sent_delivery(&db, &fixture, &message, now)
                .await
                .c(h!())?;

            assert!(already_sent(&db, fixture.automation_id, &message)
                .await
                .c(h!())?);

            let duplicate_message = insert_message(
                &db,
                &fixture,
                "original",
                now + ChronoDuration::seconds(1),
            )
            .await
            .c(h!())?;
            assert!(already_sent(
                &db,
                fixture.automation_id,
                &duplicate_message
            )
            .await
            .c(h!())?);

            let unrelated_message =
                insert_message(&db, &fixture, "unrelated", now)
                    .await
                    .c(h!())?;
            assert!(!already_sent(
                &db,
                fixture.automation_id,
                &unrelated_message
            )
            .await
            .c(h!())?);
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn late_skip_preserves_sent_delivery() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let now = Utc::now().naive_utc();
            let message = insert_message(&db, &fixture, "late-skip", now)
                .await
                .c(h!())?;
            insert_sent_delivery(&db, &fixture, &message, now)
                .await
                .c(h!())?;
            let sent_delivery =
                load_test_delivery(&db, fixture.automation_id, message.id)
                    .await
                    .c(h!())?;

            record_delivery(
                &db,
                fixture.automation_id,
                &message,
                "skipped",
                Some("message is already planned for this target group"),
                false,
            )
            .await
            .c(h!())?;

            let delivery =
                load_test_delivery(&db, fixture.automation_id, message.id)
                    .await
                    .c(h!())?;
            assert_eq!(delivery.status, "sent");
            assert_eq!(delivery.error, None);
            assert_eq!(delivery.sent_at, sent_delivery.sent_at);
            assert!(already_sent(&db, fixture.automation_id, &message)
                .await
                .c(h!())?);
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn list_counts_sent_delivery_windows() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let now = Utc::now().naive_utc();
            let message_24h =
                insert_message(&db, &fixture, "24h", now).await.c(h!())?;
            let message_7d =
                insert_message(&db, &fixture, "7d", now).await.c(h!())?;
            let message_old =
                insert_message(&db, &fixture, "old", now).await.c(h!())?;
            insert_sent_delivery(
                &db,
                &fixture,
                &message_24h,
                now - ChronoDuration::hours(1),
            )
            .await
            .c(h!())?;
            insert_sent_delivery(
                &db,
                &fixture,
                &message_7d,
                now - ChronoDuration::days(2),
            )
            .await
            .c(h!())?;
            insert_sent_delivery(
                &db,
                &fixture,
                &message_old,
                now - ChronoDuration::days(8),
            )
            .await
            .c(h!())?;

            let view = load_view(&db, fixture.automation_id).await.c(h!())?;
            assert_eq!(view.usage.last_24h, 1);
            assert_eq!(view.usage.last_7d, 2);
            assert_eq!(view.usage.all_time, 3);
            assert_eq!(view.target_group_id, fixture.target_group_id);
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn candidate_messages_advance_through_non_matching_backlog(
    ) -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let now = Utc::now().naive_utc();
            for index in 0..(WORKER_MESSAGE_LIMIT + 1) {
                insert_message_with_body(
                    &db,
                    &fixture,
                    &format!("non-match-{index}"),
                    now + ChronoDuration::seconds(index),
                    "banana",
                )
                .await
                .c(h!())?;
            }
            let apple = insert_message_with_body(
                &db,
                &fixture,
                "apple",
                now + ChronoDuration::seconds(WORKER_MESSAGE_LIMIT + 2),
                "I love apples.",
            )
            .await
            .c(h!())?;
            let mut automation = AutomationWorkerRow {
                id: fixture.automation_id,
                source_account_id: fixture.account_id,
                source_group_id: fixture.source_group_id,
                target_account_id: fixture.account_id,
                target_group_id: fixture.target_group_id,
                keyword_tokens: serde_json::json!(["apple"]),
                frequency_tokens: serde_json::json!([]),
                stale_message_cutoff_minutes: 0,
                resend_attachments: false,
                coordinates_screenshot: false,
                coordinate_presence_mode: CoordinatePresenceMode::Any
                    .as_str()
                    .to_string(),
                polygon_filter_mode: PolygonFilterMode::None
                    .as_str()
                    .to_string(),
                polygon_coordinates: None,
                last_error: None,
                checkpoint_at: now - ChronoDuration::seconds(1),
                last_processed_inbox_message_id: 0,
            };

            let messages =
                load_candidate_messages(&db, &automation).await.c(h!())?;
            assert_eq!(messages.len(), WORKER_MESSAGE_LIMIT as usize);
            assert!(messages.iter().all(|message| message.body == "banana"));

            let last_message =
                messages.last().context("first batch is empty").c(h!())?;
            update_checkpoint(
                &db,
                automation.id,
                last_message.id,
                last_message.message_at,
            )
            .await
            .c(h!())?;
            automation.checkpoint_at = last_message.message_at;
            automation.last_processed_inbox_message_id = last_message.id;

            let messages =
                load_candidate_messages(&db, &automation).await.c(h!())?;
            assert!(messages.iter().any(|message| message.id == apple.id));
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }

    #[tokio::test]
    async fn empty_scan_advances_checkpoint_to_stale_boundary() -> Result<()> {
        let _guard = DB_TEST_LOCK.lock().await;
        let db = test_db().await.c(h!())?;
        let fixture = create_fixture(&db).await.c(h!())?;
        let result = async {
            let automation = AutomationWorkerRow {
                id: fixture.automation_id,
                source_account_id: fixture.account_id,
                source_group_id: fixture.source_group_id,
                target_account_id: fixture.account_id,
                target_group_id: fixture.target_group_id,
                keyword_tokens: serde_json::json!(["apple"]),
                frequency_tokens: serde_json::json!([]),
                stale_message_cutoff_minutes: 60,
                resend_attachments: false,
                coordinates_screenshot: false,
                coordinate_presence_mode: CoordinatePresenceMode::Any
                    .as_str()
                    .to_string(),
                polygon_filter_mode: PolygonFilterMode::None
                    .as_str()
                    .to_string(),
                polygon_coordinates: None,
                last_error: None,
                checkpoint_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
                last_processed_inbox_message_id: 0,
            };

            advance_empty_checkpoint(&db, &automation).await.c(h!())?;

            let view = load_view(&db, fixture.automation_id).await.c(h!())?;
            assert!(view.checkpoint_at > 0);
            Ok(())
        }
        .await;
        cleanup_test_namespace(&db, &fixture.namespace, &fixture.phone_number)
            .await
            .c(h!())?;
        result
    }
}
