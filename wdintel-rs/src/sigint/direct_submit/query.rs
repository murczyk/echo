use super::types::DirectSubmitPayload;
use crate::entities::{
    datasource_group, device_name, intel_prod, login, sigint_inbox_item,
    signal_group, signal_message, signal_message_group, signal_message_media,
    signal_profile, tag,
};
use crate::error::AppError;
use crate::types::*;
use chrono::Utc;
use sea_orm::sea_query::{Expr, LockType};
use sea_orm::*;
use std::collections::{BTreeSet, HashSet};
use uuid::Uuid;

pub struct CopySignalMessageInputs {
    pub inbox_item: sigint_inbox_item::Model,
    pub tag_labels: Vec<String>,
    pub media: Vec<signal_message_media::Model>,
}

pub async fn find_available_signal_group<C>(
    dbx: &C,
    login: &uuid::Uuid,
    signal_group_master_key: &str,
) -> Result<signal_group::Model, AppError>
where
    C: ConnectionTrait,
{
    let signal_group = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.eq(signal_group_master_key))
        .filter(signal_group::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;

    crate::messenger::group::ensure_identity_group_available(
        dbx,
        login,
        &signal_group.master_key,
    )
    .await?;

    Ok(signal_group)
}

pub async fn find_editable_signal_message<C>(
    dbx: &C,
    signal_message_id: i64,
    allowed_groups: &[String],
    login: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    let message = signal_message::Entity::find_by_id(signal_message_id)
        .filter(signal_message::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let login = login.to_string();
    if message.datasource_group_id.is_none()
        && (message.sender.as_deref() == Some(login.as_str())
            || message.sender.as_deref().is_some_and(|sender| {
                Uuid::parse_str(sender).ok().is_some_and(|sender_id| {
                    organism_logins.contains(&sender_id)
                })
            }))
    {
        return Ok(message);
    }
    let groups = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message_id),
        )
        .all(dbx)
        .await
        .c(h!())?;
    if groups.iter().any(|group| {
        group
            .group_master_key
            .as_ref()
            .is_some_and(|key| allowed_groups.contains(key))
    }) {
        return Ok(message.clone());
    }
    if !groups.is_empty() {
        return Err(AppError::NotFound);
    }
    let parent_ids = find_intel_prod_parent_ids(dbx, signal_message_id)
        .await
        .c(h!())?;
    let has_parent_access = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.is_in(parent_ids))
        .filter(
            signal_message_group::Column::GroupMasterKey
                .is_in(allowed_groups.to_vec()),
        )
        .one(dbx)
        .await
        .c(h!())?
        .is_some();
    if has_parent_access {
        Ok(message)
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn find_intel_prod_parent_ids<C>(
    dbx: &C,
    signal_message_id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    Ok(intel_prod::Entity::find()
        .filter(intel_prod::Column::SignalMessageId.eq(signal_message_id))
        .filter(
            intel_prod::Column::RelationKind
                .eq(intel_prod::RELATION_KIND_REPORT),
        )
        .order_by_asc(intel_prod::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| link.parent_signal_message_id)
        .collect())
}

pub async fn normalize_copy_parent_signal_message_ids<C>(
    dbx: &C,
    signal_message_ids: &[i64],
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    if signal_message_ids.is_empty() {
        return Ok(vec![]);
    }
    let links = intel_prod::Entity::find()
        .filter(
            intel_prod::Column::SignalMessageId
                .is_in(signal_message_ids.to_vec()),
        )
        .filter(
            intel_prod::Column::RelationKind
                .eq(intel_prod::RELATION_KIND_REPORT),
        )
        .order_by_asc(intel_prod::Column::CreatedAt)
        .order_by_asc(intel_prod::Column::ParentSignalMessageId)
        .all(dbx)
        .await
        .c(h!())?;
    let mut parents_by_message = HashMap::<i64, Vec<i64>>::new();
    for link in links {
        parents_by_message
            .entry(link.signal_message_id)
            .or_default()
            .push(link.parent_signal_message_id);
    }
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for signal_message_id in signal_message_ids {
        let parent_ids = parents_by_message
            .get(signal_message_id)
            .map(Vec::as_slice)
            .unwrap_or(std::slice::from_ref(signal_message_id));
        for parent_id in parent_ids {
            if seen.insert(*parent_id) {
                normalized.push(*parent_id);
            }
        }
    }
    Ok(normalized)
}

pub async fn resolve_parent_datasource_id<C>(
    dbx: &C,
    parent_signal_message_ids: &[i64],
    allowed_groups: &[String],
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    resolve_parent_datasource_id_or_none(
        dbx,
        parent_signal_message_ids,
        allowed_groups,
    )
    .await?
    .ok_or(AppError::NotFound)
}

pub async fn resolve_parent_datasource_id_or_none<C>(
    dbx: &C,
    parent_signal_message_ids: &[i64],
    allowed_groups: &[String],
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    let parent_group = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId
                .is_in(parent_signal_message_ids.to_vec()),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .is_in(allowed_groups.to_vec()),
        )
        .one(dbx)
        .await
        .c(h!())?;
    let Some(parent_group) = parent_group else {
        let has_grouped_parent = signal_message::Entity::find()
            .filter(
                signal_message::Column::Id
                    .is_in(parent_signal_message_ids.to_vec()),
            )
            .filter(signal_message::Column::DatasourceGroupId.is_not_null())
            .one(dbx)
            .await
            .c(h!())?
            .is_some()
            || signal_message_group::Entity::find()
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .is_in(parent_signal_message_ids.to_vec()),
                )
                .one(dbx)
                .await
                .c(h!())?
                .is_some();
        if has_grouped_parent {
            return Err(AppError::NotFound);
        }
        return Ok(None);
    };
    if let Some(datasource_group_id) = parent_group.datasource_group_id {
        if let Some(datasource_group) =
            datasource_group::Entity::find_by_id(datasource_group_id)
                .one(dbx)
                .await
                .c(h!())?
        {
            return Ok(Some(datasource_group.datasource_id));
        }
    }
    match parent_group.group_master_key.as_deref() {
        Some(group_master_key) => {
            resolve_datasource_id_for_group(dbx, group_master_key)
                .await
                .map(Some)
        }
        None => Err(AppError::NotFound),
    }
}

pub async fn delete_signal_message_groups<C>(
    dbx: &C,
    signal_message_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    signal_message_group::Entity::delete_many()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message_id),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn find_copyable_signal_message<C>(
    dbx: &C,
    signal_message_id: i64,
    allowed_groups: &[String],
) -> Result<signal_message::Model, AppError>
where
    C: ConnectionTrait,
{
    ensure_copy_sources_are_not_reports(dbx, &[signal_message_id])
        .await
        .c(h!())?;
    signal_message::Entity::find_by_id(signal_message_id)
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(allowed_groups.to_vec()),
        )
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub async fn find_copyable_signal_messages<C>(
    dbx: &C,
    signal_message_ids: &[i64],
    allowed_groups: &[String],
    login_id: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
) -> Result<Vec<signal_message::Model>, AppError>
where
    C: ConnectionTrait,
{
    find_copyable_signal_messages_inner(
        dbx,
        signal_message_ids,
        allowed_groups,
        login_id,
        organism_logins,
        true,
    )
    .await
}

pub async fn find_copyable_signal_messages_for_copy<C>(
    dbx: &C,
    signal_message_ids: &[i64],
    allowed_groups: &[String],
    login_id: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
) -> Result<Vec<signal_message::Model>, AppError>
where
    C: ConnectionTrait,
{
    find_copyable_signal_messages_inner(
        dbx,
        signal_message_ids,
        allowed_groups,
        login_id,
        organism_logins,
        false,
    )
    .await
}

async fn find_copyable_signal_messages_inner<C>(
    dbx: &C,
    signal_message_ids: &[i64],
    allowed_groups: &[String],
    login_id: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
    reject_reports: bool,
) -> Result<Vec<signal_message::Model>, AppError>
where
    C: ConnectionTrait,
{
    if signal_message_ids.is_empty() {
        return Ok(vec![]);
    }
    if reject_reports {
        ensure_copy_sources_are_not_reports(dbx, signal_message_ids)
            .await
            .c(h!())?;
    }
    let sources = signal_message::Entity::find()
        .filter(signal_message::Column::Id.is_in(signal_message_ids.to_vec()))
        .filter(signal_message::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    let sources = sources.into_iter().fold(Vec::new(), |mut unique, source| {
        if !unique
            .iter()
            .any(|item: &signal_message::Model| item.id == source.id)
        {
            unique.push(source);
        }
        unique
    });
    for source in &sources {
        if !message_has_copy_access(
            dbx,
            source,
            allowed_groups,
            login_id,
            organism_logins,
        )
        .await
        .c(h!())?
        {
            return Err(AppError::NotFound);
        }
    }
    let requested_ids = signal_message_ids.iter().collect::<HashSet<_>>();
    if sources.len() != requested_ids.len() {
        return Err(AppError::NotFound);
    }
    Ok(signal_message_ids
        .iter()
        .map(|id| {
            sources
                .iter()
                .find(|source| source.id == *id)
                .cloned()
                .ok_or(AppError::NotFound)
        })
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?)
}

async fn message_has_copy_access<C>(
    dbx: &C,
    message: &signal_message::Model,
    allowed_groups: &[String],
    login_id: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    if message_has_direct_copy_access(
        dbx,
        message,
        allowed_groups,
        login_id,
        organism_logins,
    )
    .await
    .c(h!())?
    {
        return Ok(true);
    }

    let parent_ids =
        find_intel_prod_parent_ids(dbx, message.id).await.c(h!())?;
    for parent_id in parent_ids {
        let Some(parent) = signal_message::Entity::find_by_id(parent_id)
            .filter(signal_message::Column::Deleted.eq(false))
            .one(dbx)
            .await
            .c(h!())?
        else {
            continue;
        };
        if message_has_direct_copy_access(
            dbx,
            &parent,
            allowed_groups,
            login_id,
            organism_logins,
        )
        .await
        .c(h!())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn message_has_direct_copy_access<C>(
    dbx: &C,
    message: &signal_message::Model,
    allowed_groups: &[String],
    login_id: &uuid::Uuid,
    organism_logins: &[uuid::Uuid],
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    if let Some(datasource_group_id) = message.datasource_group_id {
        let has_datasource_group_access =
            datasource_group::Entity::find_by_id(datasource_group_id)
                .filter(
                    datasource_group::Column::GroupMasterKey
                        .is_in(allowed_groups.to_vec()),
                )
                .one(dbx)
                .await
                .c(h!())?
                .is_some();
        if has_datasource_group_access {
            return Ok(true);
        }
    }

    let groups = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message.id))
        .all(dbx)
        .await
        .c(h!())?;
    if groups.iter().any(|group| {
        group
            .group_master_key
            .as_ref()
            .is_some_and(|key| allowed_groups.contains(key))
    }) {
        return Ok(true);
    }

    let login = login_id.to_string();
    Ok(message.datasource_group_id.is_none()
        && groups.is_empty()
        && (message.sender.as_deref() == Some(login.as_str())
            || message.sender.as_deref().is_some_and(|sender| {
                Uuid::parse_str(sender).ok().is_some_and(|sender_id| {
                    organism_logins.contains(&sender_id)
                })
            })))
}

async fn ensure_copy_sources_are_not_reports<C>(
    dbx: &C,
    signal_message_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let report_count = intel_prod::Entity::find()
        .filter(
            intel_prod::Column::SignalMessageId
                .is_in(signal_message_ids.to_vec()),
        )
        .filter(
            intel_prod::Column::RelationKind
                .eq(intel_prod::RELATION_KIND_REPORT),
        )
        .count(dbx)
        .await
        .c(h!())?;
    if report_count > 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn find_copy_signal_message_inputs<C>(
    dbx: &C,
    signal_message_id: i64,
    tag_ids: &[i64],
) -> Result<CopySignalMessageInputs, AppError>
where
    C: ConnectionTrait,
{
    let inbox_item = sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;

    let tag_labels = tag::Entity::find()
        .filter(tag::Column::Id.is_in(tag_ids.to_vec()))
        .select_only()
        .column(tag::Column::Label)
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;

    let media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .order_by_asc(signal_message_media::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;

    Ok(CopySignalMessageInputs {
        inbox_item,
        tag_labels,
        media,
    })
}

pub async fn find_signal_message_media<C>(
    dbx: &C,
    signal_message_id: i64,
) -> Result<Vec<signal_message_media::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .order_by_asc(signal_message_media::Column::Id)
        .all(dbx)
        .await
        .c(h!())?)
}

pub async fn find_signal_messages_media<C>(
    dbx: &C,
    signal_message_ids: &[i64],
) -> Result<Vec<signal_message_media::Model>, AppError>
where
    C: ConnectionTrait,
{
    if signal_message_ids.is_empty() {
        return Ok(vec![]);
    }
    Ok(signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .is_in(signal_message_ids.to_vec()),
        )
        .order_by_asc(signal_message_media::Column::Id)
        .lock(LockType::Update)
        .all(dbx)
        .await
        .c(h!())?)
}

pub async fn find_inbox_item_device_name_id<C>(
    dbx: &C,
    inbox_item_id: i64,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_inbox_item::Entity::find_by_id(inbox_item_id)
        .one(dbx)
        .await
        .c(h!())?
        .and_then(|item| item.device_name_id))
}

pub async fn find_unreferenced_media<C>(
    dbx: &C,
    media: &[signal_message_media::Model],
) -> Result<Vec<signal_message_media::Model>, AppError>
where
    C: ConnectionTrait,
{
    let mut unreferenced = Vec::new();
    for media in media {
        let Some(storage_key) = media.storage_key.as_deref() else {
            unreferenced.push(media.clone());
            continue;
        };
        let references = signal_message_media::Entity::find()
            .select_only()
            .column(signal_message_media::Column::Id)
            .filter(signal_message_media::Column::StorageKey.eq(storage_key))
            .lock(LockType::Update)
            .all(dbx)
            .await
            .c(h!())?
            .len();
        if references == 0 {
            unreferenced.push(media.clone());
        }
    }
    Ok(unreferenced)
}

pub async fn copy_signal_message_media<C>(
    dbx: &C,
    signal_message_id: i64,
    source_media: &[signal_message_media::Model],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let media_models = source_media
        .iter()
        .map(|media| {
            let storage_key = media.storage_key.clone().unwrap_or_else(|| {
                crate::messenger::media::media_object_key(media)
            });
            signal_message_media::ActiveModel {
                id: Set(Uuid::now_v7()),
                signal_message_id: Set(signal_message_id),
                content_type: Set(media.content_type.clone()),
                file_ext: Set(media.file_ext.clone()),
                file_name: Set(media.file_name.clone()),
                size_bytes: Set(media.size_bytes),
                created_at: NotSet,
                is_encrypted: Set(media.is_encrypted),
                storage_key: Set(Some(storage_key)),
            }
        })
        .collect::<Vec<_>>();
    if !media_models.is_empty() {
        signal_message_media::Entity::insert_many(media_models)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn copy_signal_message_comments(
    env: &crate::types::Env,
    dbx: &DatabaseTransaction,
    source_signal_message_ids: &[i64],
    signal_message_id: i64,
    login: &uuid::Uuid,
    logins: &[uuid::Uuid],
    comment: Option<&str>,
) -> Result<(), AppError> {
    let comments = crate::sigint::comments::find_linked_message_comments(
        dbx,
        source_signal_message_ids,
    )
    .await
    .c(h!())?;

    crate::rer_importer::inbox::bl::delete_editable_linked_message_comments(
        dbx,
        signal_message_id,
        login,
        logins,
    )
    .await
    .c(h!())?;

    let mut copied_ids = std::collections::HashSet::new();
    for comment_model in comments {
        if !copied_ids.insert(comment_model.signal_message_id) {
            continue;
        }
        let Some(comment_login) = comment_model.login_id else {
            continue;
        };
        crate::sigint::comments::create_linked_message_comment(
            env,
            dbx,
            signal_message_id,
            &comment_login,
            &[comment_login],
            &comment_model.comment,
            Some(comment_model.created_at.and_utc()),
            comment_model.post_id,
        )
        .await
        .c(h!())?;
    }
    if let Some(comment) = comment.filter(|comment| !comment.trim().is_empty())
    {
        crate::sigint::comments::create_linked_message_comment(
            env,
            dbx,
            signal_message_id,
            login,
            logins,
            comment,
            None,
            None,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn copy_signal_message_relations<C>(
    dbx: &C,
    source_signal_message_ids: &[i64],
    target_inbox_item_id: i64,
    actor_id: &uuid::Uuid,
    payload: &DirectSubmitPayload,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    copy_matching_tags(dbx, source_signal_message_ids, target_inbox_item_id)
        .await
        .c(h!())?;
    copy_matching_callsigns(
        dbx,
        source_signal_message_ids,
        target_inbox_item_id,
        actor_id,
    )
    .await
    .c(h!())?;
    let target_inbox_item =
        sigint_inbox_item::Entity::find_by_id(target_inbox_item_id)
            .one(dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
    let mut unit_source_ids = Vec::new();
    let mut peleng_source_ids = Vec::new();
    let mut network_source_ids = Vec::new();
    let mut metadata_source_ids = Vec::new();
    for source_signal_message_id in source_signal_message_ids {
        let source_inbox_item =
            sigint_inbox_item::Entity::find_by_id(*source_signal_message_id)
                .one(dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .c(h!())?;
        let source_message =
            signal_message::Entity::find_by_id(*source_signal_message_id)
                .one(dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .c(h!())?;
        if payload.unit.as_deref() == source_inbox_item.unit_v2.as_deref() {
            unit_source_ids.push(*source_signal_message_id);
        }
        if payload.full_body.as_deref() == source_message.body.as_deref()
            && source_inbox_item.lat == target_inbox_item.lat
            && source_inbox_item.lng == target_inbox_item.lng
        {
            peleng_source_ids.push(*source_signal_message_id);
            if payload
                .network
                .as_ref()
                .and_then(|network| network.name.as_deref())
                == source_inbox_item.network.as_deref()
            {
                network_source_ids.push(*source_signal_message_id);
            }
        }
        let network_is_unchanged =
            payload.network.as_ref().is_none_or(|network| {
                network.signal_name.is_none() && network.cc.is_none()
            }) && payload
                .network
                .as_ref()
                .and_then(|network| network.name.as_deref())
                == source_inbox_item.network.as_deref();
        if payload.dmr.is_empty()
            && payload.full_body.as_deref() == source_message.body.as_deref()
            && network_is_unchanged
        {
            metadata_source_ids.push(*source_signal_message_id);
        }
    }
    if !unit_source_ids.is_empty() {
        copy_inbox_units(dbx, &unit_source_ids, target_inbox_item_id)
            .await
            .c(h!())?;
    }
    if !peleng_source_ids.is_empty() {
        copy_pelengs(dbx, &peleng_source_ids, target_inbox_item_id)
            .await
            .c(h!())?;
    }
    if !network_source_ids.is_empty() {
        copy_inbox_networks(dbx, &network_source_ids, target_inbox_item_id)
            .await
            .c(h!())?;
    }
    if !metadata_source_ids.is_empty() {
        copy_metadata(dbx, &metadata_source_ids, target_inbox_item_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn insert_intel_prod_links<C>(
    dbx: &C,
    signal_message_id: i64,
    parent_signal_message_ids: &[i64],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let links = parent_signal_message_ids
        .iter()
        .map(|parent_signal_message_id| {
            crate::entities::intel_prod::ActiveModel {
                signal_message_id: Set(signal_message_id),
                parent_signal_message_id: Set(*parent_signal_message_id),
                relation_kind: Set(
                    crate::entities::intel_prod::RELATION_KIND_REPORT,
                ),
                created_at: NotSet,
            }
        })
        .collect::<Vec<_>>();
    if !links.is_empty() {
        crate::entities::intel_prod::Entity::insert_many(links)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn copy_matching_tags<C>(
    dbx: &C,
    source_signal_message_ids: &[i64],
    target_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let target_tags = crate::entities::sigint_inbox_item_tag::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq(target_inbox_item_id),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let target_tag_ids = target_tags
        .iter()
        .map(|tag| tag.tag_id)
        .collect::<HashSet<_>>();
    if target_tag_ids.is_empty() {
        return Ok(());
    }
    let source_tags = crate::entities::sigint_inbox_item_tag::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_tag::Column::SigintInboxItemId
                .is_in(source_signal_message_ids.to_vec()),
        )
        .filter(
            crate::entities::sigint_inbox_item_tag::Column::TagId
                .is_in(target_tag_ids),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let source_tags = source_tags.into_iter().fold(
        Vec::new(),
        |mut unique: Vec<crate::entities::sigint_inbox_item_tag::Model>,
         source_tag| {
            if let Some(existing) = unique.iter_mut().find(|existing| {
                existing.tag_id == source_tag.tag_id
                    && existing.login_id == source_tag.login_id
                    && existing.model == source_tag.model
            }) {
                existing.confidence =
                    existing.confidence.max(source_tag.confidence);
            } else {
                unique.push(source_tag);
            }
            unique
        },
    );
    let source_tag_ids = source_tags
        .iter()
        .map(|tag| tag.tag_id)
        .collect::<HashSet<_>>();
    if source_tag_ids.is_empty() {
        return Ok(());
    }
    crate::entities::sigint_inbox_item_tag::Entity::delete_many()
        .filter(
            crate::entities::sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq(target_inbox_item_id),
        )
        .filter(
            crate::entities::sigint_inbox_item_tag::Column::TagId
                .is_in(source_tag_ids),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let tag_models = source_tags
        .into_iter()
        .map(|tag| crate::entities::sigint_inbox_item_tag::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(target_inbox_item_id),
            tag_id: Set(tag.tag_id),
            confidence: Set(tag.confidence),
            login_id: Set(tag.login_id),
            model: Set(tag.model),
        })
        .collect::<Vec<_>>();
    if !tag_models.is_empty() {
        crate::entities::sigint_inbox_item_tag::Entity::insert_many(tag_models)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn copy_matching_callsigns<C>(
    dbx: &C,
    source_signal_message_ids: &[i64],
    target_inbox_item_id: i64,
    actor_id: &uuid::Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let source = crate::entities::sigint_inbox_item_callsign::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_callsign::Column::SigintInboxItemId
                .is_in(source_signal_message_ids.to_vec()),
        )
        .filter(
            crate::entities::sigint_inbox_item_callsign::Column::Deleted
                .eq(false),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let target = crate::entities::sigint_inbox_item_callsign::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_callsign::Column::SigintInboxItemId
                .eq(target_inbox_item_id),
        )
        .all(dbx)
        .await
        .c(h!())?;
    let source_names = source
        .iter()
        .map(|callsign| callsign.callsign.to_lowercase())
        .collect::<BTreeSet<_>>();
    let target_names = target
        .iter()
        .filter(|callsign| !callsign.deleted)
        .map(|callsign| callsign.callsign.to_lowercase())
        .collect::<BTreeSet<_>>();
    if source_names.is_empty() || target_names.is_empty() {
        return Ok(());
    }
    if source_names != target_names {
        return Ok(());
    }
    let deleted_ids = target
        .iter()
        .filter(|target| {
            !target.deleted
                && !source.iter().any(|source| {
                    source.source == target.source
                        && source.callsign == target.callsign
                })
        })
        .map(|target| target.id)
        .collect::<Vec<_>>();
    if !deleted_ids.is_empty() {
        crate::entities::sigint_inbox_item_callsign::Entity::update_many()
            .col_expr(
                crate::entities::sigint_inbox_item_callsign::Column::Deleted,
                Expr::value(true),
            )
            .col_expr(
                crate::entities::sigint_inbox_item_callsign::Column::DeletedAt,
                Expr::value(Utc::now().naive_utc()),
            )
            .col_expr(
                crate::entities::sigint_inbox_item_callsign::Column::DeletedById,
                Expr::value(*actor_id),
            )
            .filter(
                crate::entities::sigint_inbox_item_callsign::Column::Id
                    .is_in(deleted_ids),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    let mut new_callsigns = Vec::new();
    let mut new_callsign_keys = Vec::new();
    for callsign in source.into_iter().filter(|callsign| {
        target_names.contains(&callsign.callsign.to_lowercase())
    }) {
        let Some(existing) = target.iter().find(|target| {
            target.source == callsign.source
                && target.callsign == callsign.callsign
        }) else {
            let key = (callsign.source.clone(), callsign.callsign.clone());
            if new_callsign_keys.contains(&key) {
                continue;
            }
            new_callsign_keys.push(key);
            new_callsigns.push(
                crate::entities::sigint_inbox_item_callsign::ActiveModel {
                    id: NotSet,
                    sigint_inbox_item_id: Set(target_inbox_item_id),
                    callsign: Set(callsign.callsign),
                    source: Set(callsign.source),
                    ordering: Set(callsign.ordering),
                    created_at: NotSet,
                    deleted_at: Set(None),
                    deleted: Set(false),
                    created_by_id: Set(callsign.created_by_id),
                    deleted_by_id: Set(None),
                },
            );
            continue;
        };
        if existing.deleted || existing.ordering != callsign.ordering {
            let mut existing = existing.clone().into_active_model();
            existing.ordering = Set(callsign.ordering);
            existing.deleted = Set(false);
            existing.deleted_at = Set(None);
            existing.deleted_by_id = Set(None);
            existing.update(dbx).await.c(h!())?;
        }
    }
    if !new_callsigns.is_empty() {
        crate::entities::sigint_inbox_item_callsign::Entity::insert_many(
            new_callsigns,
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_inbox_units<C>(
    dbx: &C,
    source_inbox_item_ids: &[i64],
    target_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let source = crate::entities::sigint_inbox_item_unit::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_unit::Column::ItemId
                .is_in(source_inbox_item_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    crate::entities::sigint_inbox_item_unit::Entity::delete_many()
        .filter(
            crate::entities::sigint_inbox_item_unit::Column::ItemId
                .eq(target_inbox_item_id),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let mut units = Vec::new();
    for unit in source {
        if !units.iter().any(
            |existing: &crate::entities::sigint_inbox_item_unit::Model| {
                existing.unit_id == unit.unit_id && existing.kind == unit.kind
            },
        ) {
            units.push(unit);
        }
    }
    let unit_models = units
        .into_iter()
        .map(
            |unit| crate::entities::sigint_inbox_item_unit::ActiveModel {
                id: NotSet,
                created_at: NotSet,
                item_id: Set(target_inbox_item_id),
                unit_id: Set(unit.unit_id),
                kind: Set(unit.kind),
            },
        )
        .collect::<Vec<_>>();
    if !unit_models.is_empty() {
        crate::entities::sigint_inbox_item_unit::Entity::insert_many(
            unit_models,
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_pelengs<C>(
    dbx: &C,
    source_inbox_item_ids: &[i64],
    target_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let source = crate::entities::sigint_peleng::Entity::find()
        .filter(
            crate::entities::sigint_peleng::Column::SourceInboxItemId
                .is_in(source_inbox_item_ids.to_vec()),
        )
        .filter(crate::entities::sigint_peleng::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    crate::entities::sigint_peleng::Entity::delete_many()
        .filter(
            crate::entities::sigint_peleng::Column::SourceInboxItemId
                .eq(target_inbox_item_id),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let source = source.into_iter().fold(
        Vec::new(),
        |mut unique: Vec<crate::entities::sigint_peleng::Model>, peleng| {
            if !unique.iter().any(|existing| {
                existing.lat == peleng.lat
                    && existing.lng == peleng.lng
                    && existing.settlement == peleng.settlement
                    && existing.locality_direction == peleng.locality_direction
                    && existing.distance_m == peleng.distance_m
                    && existing.country_code == peleng.country_code
                    && existing.pelengation_object == peleng.pelengation_object
            }) {
                unique.push(peleng);
            }
            unique
        },
    );
    let peleng_models = source
        .into_iter()
        .map(|peleng| crate::entities::sigint_peleng::ActiveModel {
            id: NotSet,
            source_inbox_item_id: Set(target_inbox_item_id),
            lat: Set(peleng.lat),
            lng: Set(peleng.lng),
            settlement: Set(peleng.settlement),
            locality_direction: Set(peleng.locality_direction),
            distance_m: Set(peleng.distance_m),
            country_code: Set(peleng.country_code),
            deleted: Set(false),
            created_at: NotSet,
            updated_at: Set(peleng.updated_at),
            pelengation_object: Set(peleng.pelengation_object),
        })
        .collect::<Vec<_>>();
    if !peleng_models.is_empty() {
        crate::entities::sigint_peleng::Entity::insert_many(peleng_models)
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn copy_inbox_networks<C>(
    dbx: &C,
    source_inbox_item_ids: &[i64],
    target_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let source = crate::entities::sigint_inbox_item_network::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(source_inbox_item_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    crate::entities::sigint_inbox_item_network::Entity::delete_many()
        .filter(
            crate::entities::sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(target_inbox_item_id),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let mut networks = Vec::new();
    for network in source {
        if !networks.iter().any(
            |existing: &crate::entities::sigint_inbox_item_network::Model| {
                existing.sigint_network_id == network.sigint_network_id
            },
        ) {
            networks.push(network);
        }
    }
    let network_models = networks
        .into_iter()
        .map(|network| {
            crate::entities::sigint_inbox_item_network::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(target_inbox_item_id),
                sigint_network_id: Set(network.sigint_network_id),
                created_at: NotSet,
            }
        })
        .collect::<Vec<_>>();
    if !network_models.is_empty() {
        crate::entities::sigint_inbox_item_network::Entity::insert_many(
            network_models,
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_metadata<C>(
    dbx: &C,
    source_inbox_item_ids: &[i64],
    target_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let source = crate::entities::sigint_inbox_item_metadata::Entity::find()
        .filter(
            crate::entities::sigint_inbox_item_metadata::Column::SigintInboxItemId
                .is_in(source_inbox_item_ids.to_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    crate::entities::sigint_inbox_item_metadata::Entity::delete_many()
        .filter(
            crate::entities::sigint_inbox_item_metadata::Column::SigintInboxItemId
                .eq(target_inbox_item_id),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let source = source.into_iter().fold(
        Vec::new(),
        |mut unique: Vec<
            crate::entities::sigint_inbox_item_metadata::Model,
        >,
         metadata| {
            if !unique.iter().any(|existing| {
                existing.color_code == metadata.color_code
                    && existing.sender_id == metadata.sender_id
                    && existing.sender_name == metadata.sender_name
                    && existing.call_group_id == metadata.call_group_id
                    && existing.call_group_name == metadata.call_group_name
                    && existing.hash_id == metadata.hash_id
                    && existing.color_code_start_index
                        == metadata.color_code_start_index
                    && existing.color_code_end_index
                        == metadata.color_code_end_index
                    && existing.call_group_id_start_index
                        == metadata.call_group_id_start_index
                    && existing.call_group_id_end_index
                        == metadata.call_group_id_end_index
                    && existing.call_group_name_start_index
                        == metadata.call_group_name_start_index
                    && existing.call_group_name_end_index
                        == metadata.call_group_name_end_index
                    && existing.sender_id_start_index
                        == metadata.sender_id_start_index
                    && existing.sender_id_end_index
                        == metadata.sender_id_end_index
                    && existing.sender_name_start_index
                        == metadata.sender_name_start_index
                    && existing.sender_name_end_index
                        == metadata.sender_name_end_index
                    && existing.hash_id_start_index
                        == metadata.hash_id_start_index
                    && existing.hash_id_end_index == metadata.hash_id_end_index
            }) {
                unique.push(metadata);
            }
            unique
        },
    );
    let metadata_models = source
        .into_iter()
        .map(|metadata| {
            crate::entities::sigint_inbox_item_metadata::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(target_inbox_item_id),
                color_code: Set(metadata.color_code),
                sender_id: Set(metadata.sender_id),
                sender_name: Set(metadata.sender_name),
                call_group_id: Set(metadata.call_group_id),
                call_group_name: Set(metadata.call_group_name),
                hash_id: Set(metadata.hash_id),
                created_at: NotSet,
                color_code_start_index: Set(metadata.color_code_start_index),
                color_code_end_index: Set(metadata.color_code_end_index),
                call_group_id_start_index: Set(
                    metadata.call_group_id_start_index
                ),
                call_group_id_end_index: Set(metadata.call_group_id_end_index),
                call_group_name_start_index: Set(
                    metadata.call_group_name_start_index
                ),
                call_group_name_end_index: Set(
                    metadata.call_group_name_end_index
                ),
                sender_id_start_index: Set(metadata.sender_id_start_index),
                sender_id_end_index: Set(metadata.sender_id_end_index),
                sender_name_start_index: Set(metadata.sender_name_start_index),
                sender_name_end_index: Set(metadata.sender_name_end_index),
                hash_id_start_index: Set(metadata.hash_id_start_index),
                hash_id_end_index: Set(metadata.hash_id_end_index),
            }
        })
        .collect::<Vec<_>>();
    if !metadata_models.is_empty() {
        crate::entities::sigint_inbox_item_metadata::Entity::insert_many(
            metadata_models,
        )
        .exec(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn ensure_current_user_sender<C>(
    dbx: &C,
    login: &uuid::Uuid,
) -> Result<String, AppError>
where
    C: ConnectionTrait,
{
    let sender = login.to_string();
    let login_name = login::Entity::find_by_id(*login)
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    match signal_profile::Entity::find_by_id(*login)
        .one(dbx)
        .await
        .c(h!())?
    {
        None => {
            signal_profile::ActiveModel {
                uuid: Set(sender.clone()),
                given_name: Set(Some(login_name)),
                family_name: Set(None),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        Some(signal_profile)
            if signal_profile.given_name.as_deref()
                == Some(sender.as_str()) =>
        {
            let mut signal_profile = signal_profile.into_active_model();
            signal_profile.given_name = Set(Some(login_name));
            signal_profile.update(dbx).await.c(h!())?;
        }
        Some(_) => {}
    }
    Ok(sender)
}

pub async fn validate_device_name_id<C>(
    dbx: &C,
    device_name_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let count = device_name::Entity::find()
        .filter(device_name::Column::Id.eq(device_name_id))
        .count(dbx)
        .await
        .c(h!())?;
    if count == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_inbox_items_device_name<C>(
    dbx: &C,
    inbox_item_ids: Vec<i64>,
    device_name_id: Option<i64>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if inbox_item_ids.is_empty() {
        return Ok(());
    }
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::DeviceNameId,
            Expr::value(device_name_id),
        )
        .filter(sigint_inbox_item::Column::Id.is_in(inbox_item_ids))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn set_inbox_item_network<C>(
    dbx: &C,
    inbox_item_id: i64,
    network: Option<String>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    sigint_inbox_item::Entity::update_many()
        .col_expr(sigint_inbox_item::Column::Network, Expr::value(network))
        .filter(sigint_inbox_item::Column::Id.eq(inbox_item_id))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn resolve_datasource_id_for_group<C>(
    dbx: &C,
    signal_group_master_key: &str,
) -> Result<i64, AppError>
where
    C: ConnectionTrait,
{
    Ok(datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(signal_group_master_key),
        )
        .order_by_desc(datasource_group::Column::CreatedAt)
        .one(dbx)
        .await
        .map(|m| m.map(|dg| dg.datasource_id))
        .unwrap_or(None)
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID))
}

pub async fn delete_signal_message_media<C>(
    dbx: &C,
    signal_message_id: i64,
    media_ids: &[Uuid],
) -> Result<Vec<signal_message_media::Model>, AppError>
where
    C: ConnectionTrait,
{
    if media_ids.is_empty() {
        return Ok(vec![]);
    }
    let media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_media::Column::Id.is_in(media_ids.iter().copied()),
        )
        .all(dbx)
        .await
        .c(h!())?;
    if media.len() != media_ids.len() {
        return Err(AppError::NotFound);
    }
    signal_message_media::Entity::delete_many()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .filter(
            signal_message_media::Column::Id.is_in(media_ids.iter().copied()),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(media)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::delta_login;
    use crate::functest::tests::{cleanup, mk_login};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn current_user_sender_profile_uses_echo_login_name() {
        let env = cleanup().await.unwrap();
        let regular_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("regular-sender".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let delta_login = delta_login::ActiveModel {
            id: NotSet,
            login: Set("delta-auth-name".to_string()),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let delta_linked_login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("delta-linked-sender".to_string()),
                delta_login_id: Set(Some(delta_login.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_profile::ActiveModel {
            uuid: Set(delta_linked_login.id.to_string()),
            given_name: Set(Some(delta_linked_login.id.to_string())),
            family_name: Set(None),
            created_at: NotSet,
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        for login in [regular_login, delta_linked_login] {
            let sender = ensure_current_user_sender(&env.dbx, &login.id)
                .await
                .unwrap();
            let signal_profile =
                signal_profile::Entity::find_by_id(sender.clone())
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap();

            assert_eq!(sender, login.id.to_string());
            assert_eq!(
                signal_profile.given_name.as_deref(),
                Some(login.login.as_str())
            );
        }
    }
}
