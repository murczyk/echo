use super::*;

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    FromQueryResult,
)]
pub struct DailyMessageStatsPanel {
    pub label_id: i64,
    pub name: String,
    pub color: String,
    pub organism_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DailyMessageStatsPanelsRsp {
    pub panels: Vec<DailyMessageStatsPanel>,
    pub access_revision: String,
}

#[post("/api/rer/analysis/stats/daily-messages/panels")]
pub async fn daily_panels(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsReq>,
) -> Result<Json<DailyMessageStatsPanelsRsp>, AppError> {
    let (_, groups, revision) = api::access(&user, &env).await.c(h!())?;
    let panels = load(&env.dbx, &req, groups).await.c(h!())?;
    Ok(Json(DailyMessageStatsPanelsRsp {
        panels,
        access_revision: revision,
    }))
}

pub(crate) async fn load(
    db: &DatabaseConnection,
    filter: &DailyMessageStatsReq,
    allowed: filters::Access,
) -> anyhow::Result<Vec<DailyMessageStatsPanel>> {
    let Some(organism_id) = allowed.organism_id else {
        return Ok(vec![]);
    };
    let mut filter = filter.clone();
    filter.user_label_id = None;
    let groups = filters::groups(&filter, &allowed.groups);
    let mut scope =
        filters::Scope::new(&filter, allowed.with_groups(groups)).c(h!())?;
    let organism = scope.bind(organism_id);
    let senders =
        scope.associations("coalesce(g.sender,g.login_id::text) as sender");
    let mapping = crate::organism::labels::sender_mapping_sql();
    let sql = format!(
        r#"with senders as materialized ({senders}), mapping as materialized ({mapping})
        select l.id as label_id,l.name,l.color,o.name as organism_name
        from organism_user_label l join organism o on o.id=l.organism_id
        where l.organism_id={organism}::bigint
          and exists (select 1 from senders s join mapping m on m.sender=s.sender where m.label_id=l.id)
        order by lower(l.name),l.organism_id,l.id"#
    );
    let mut panels = DailyMessageStatsPanel::find_by_statement(
        Statement::from_sql_and_values(DbBackend::Postgres, sql, scope.values),
    )
    .all(&crate::read_query::connection(db))
    .await
    .c(h!())?;
    panels.push(DailyMessageStatsPanel {
        label_id: crate::config::USER_LABEL_UNASSIGNED_ID,
        name: "Без лейбла".into(),
        color: "#87d7f1".into(),
        organism_name: None,
    });
    Ok(panels)
}
