use super::*;

pub(super) fn sender_labels(source: &str) -> String {
    format!(
        r#"select e.key,coalesce(nullif(l.display_name,''),l.login,
        nullif(trim(concat_ws(' ',p.given_name,p.family_name)),''),s.name,e.key,'Невідомий відправник') as label
        from ({source}) e
        left join login l on l.id::text=e.key
        left join signal_profile p on p.uuid=e.key
        left join (select uuid,min(nullif(name,'')) as name from echo_sender
            where uuid in (select key from ({source}) candidates) group by uuid) s on s.uuid=e.key"#
    )
}

pub(crate) async fn load(
    env: &Env,
    req: &DailyMessageStatsCatalogReq,
    allowed: impl Into<filters::Access>,
    access_revision: String,
) -> anyhow::Result<DailyMessageStatsCatalogRsp> {
    let allowed = allowed.into();
    let groups = DailyMessageStatsGroupLabel::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select master_key as key,coalesce(nullif(name,''),master_key) as label from signal_group where master_key=any($1::text[]) order by coalesce(nullif(name,''),master_key) collate \"C\",master_key collate \"C\"",
        [allowed.groups.clone().into()],
    )).all(&crate::read_query::connection(&env.dbx)).await.c(h!())?;
    let hierarchy = crate::sigint::unit::hierarchy::load(env).await.c(h!())?;
    let sender_labels =
        selected_labels(&env.dbx, &req.selected_senders, allowed)
            .await
            .c(h!())?;
    Ok(DailyMessageStatsCatalogRsp {
        access_revision,
        groups,
        unit_hierarchy: (req.known_hierarchy_revision.as_deref()
            != Some(hierarchy.revision.as_str()))
        .then_some(hierarchy),
        sender_labels,
    })
}

async fn selected_labels(
    db: &DatabaseConnection,
    selected: &[DailyMessageSenderKey],
    allowed: filters::Access,
) -> anyhow::Result<Vec<DailyMessageStatsSenderLabel>> {
    let include_unknown = allowed.organism_id.is_none()
        && !allowed.groups.is_empty()
        && selected.iter().any(|key| key.sender.is_none());
    let keys: Vec<_> = selected
        .iter()
        .filter_map(|key| key.sender.clone())
        .collect();
    let mut labels = if keys.is_empty() || allowed.groups.is_empty() {
        vec![]
    } else {
        let mapping = crate::organism::labels::sender_mapping_sql();
        let source = format!("select distinct coalesce(g.sender,g.login_id::text) as key from signal_message_group g join signal_message m on m.id=g.signal_message_id and not m.deleted where g.group_master_key=any($1::text[]) and coalesce(g.sender,g.login_id::text)=any($2::text[]) and exists(select 1 from sigint_inbox_item i where i.id=m.id) and ($3::bigint is null or coalesce(g.sender,g.login_id::text) in (select sender from ({mapping}) identities where organism_id=$3::bigint))");
        DailyMessageStatsSenderLabel::find_by_statement(
            Statement::from_sql_and_values(
                DbBackend::Postgres,
                sender_labels(&source),
                [
                    allowed.groups.into(),
                    keys.into(),
                    allowed.organism_id.into(),
                ],
            ),
        )
        .all(&crate::read_query::connection(db))
        .await
        .c(h!())?
    };
    if include_unknown {
        labels.push(DailyMessageStatsSenderLabel {
            key: None,
            label: "Невідомий відправник".into(),
        });
    }
    Ok(labels)
}
