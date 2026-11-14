use super::{date_range, DailyMessageStatsReq};
use crate::{config::ANALYSIS_STATS_UNDEFINED_UNIT_ID, h, types::ShortContext};
use sea_orm::Value;

#[derive(Clone)]
pub(crate) struct Access {
    pub groups: Vec<String>,
    pub organism_id: Option<i64>,
}

impl Access {
    pub fn for_organism(groups: Vec<String>, organism_id: Option<i64>) -> Self {
        Self {
            groups: if organism_id.is_some() {
                groups
            } else {
                vec![]
            },
            organism_id,
        }
    }

    pub fn with_groups(mut self, groups: Vec<String>) -> Self {
        self.groups = groups;
        self
    }
}

#[cfg(test)]
impl From<Vec<String>> for Access {
    fn from(groups: Vec<String>) -> Self {
        Self {
            groups,
            organism_id: None,
        }
    }
}

pub(super) fn groups(
    filter: &DailyMessageStatsReq,
    allowed: &[String],
) -> Vec<String> {
    match &filter.selected_groups {
        None => allowed.to_vec(),
        Some(selected) => allowed
            .iter()
            .filter(|key| selected.contains(key))
            .cloned()
            .collect(),
    }
}

pub(super) fn empty(filter: &DailyMessageStatsReq, groups: &[String]) -> bool {
    groups.is_empty()
        || filter.selected_unit_ids.as_ref().is_some_and(Vec::is_empty)
        || filter.selected_senders.as_ref().is_some_and(Vec::is_empty)
}

pub(super) struct Scope {
    message: String,
    association: String,
    pub values: Vec<Value>,
}

impl Scope {
    pub fn new(
        filter: &DailyMessageStatsReq,
        access: impl Into<Access>,
    ) -> anyhow::Result<Self> {
        let access = access.into();
        let (_, since, till) = date_range(filter).c(h!())?;
        let mut scope = Self {
            message: "not m.deleted and m.created_at >= $2 and m.created_at < $3 and exists (select 1 from sigint_inbox_item i where i.id=m.id)".into(),
            association: "g.group_master_key=any($1::text[])".into(),
            values: vec![access.groups.into(), since.into(), till.into()],
        };
        scope.units(filter);
        scope.senders(filter);
        scope.label(filter);
        if let Some(organism_id) = access.organism_id {
            let organism = scope.bind(organism_id);
            let mapping = crate::organism::labels::sender_mapping_sql();
            scope.association.push_str(&format!(" and coalesce(g.sender,g.login_id::text) in (select sender from ({mapping}) identities where organism_id={organism}::bigint)"));
        }
        Ok(scope)
    }

    pub fn bind(&mut self, value: impl Into<Value>) -> String {
        self.values.push(value.into());
        format!("${}", self.values.len())
    }

    fn units(&mut self, filter: &DailyMessageStatsReq) {
        let Some(ids) = &filter.selected_unit_ids else {
            return;
        };
        let mut predicates = vec![];
        let linked: Vec<_> = ids
            .iter()
            .copied()
            .filter(|id| *id != ANALYSIS_STATS_UNDEFINED_UNIT_ID)
            .collect();
        if !linked.is_empty() {
            let parameter = self.bind(linked);
            predicates.push(format!("exists (select 1 from sigint_inbox_item_unit iu join sigint_unit u on u.id=iu.unit_id and not u.deleted where iu.item_id=m.id and iu.unit_id=any({parameter}::bigint[]))"));
        }
        if ids.contains(&ANALYSIS_STATS_UNDEFINED_UNIT_ID) {
            predicates.push("not exists (select 1 from sigint_inbox_item_unit iu join sigint_unit u on u.id=iu.unit_id and not u.deleted where iu.item_id=m.id)".into());
        }
        self.message.push_str(&format!(
            " and ({})",
            if predicates.is_empty() {
                "false".into()
            } else {
                predicates.join(" or ")
            }
        ));
    }

    fn senders(&mut self, filter: &DailyMessageStatsReq) {
        let Some(senders) = &filter.selected_senders else {
            return;
        };
        let mut predicates = vec![];
        let known: Vec<_> = senders
            .iter()
            .filter_map(|sender| sender.sender.clone())
            .collect();
        if !known.is_empty() {
            let parameter = self.bind(known);
            predicates.push(format!(
                "coalesce(g.sender,g.login_id::text)=any({parameter}::text[])"
            ));
        }
        if senders.iter().any(|sender| sender.sender.is_none()) {
            predicates
                .push("coalesce(g.sender,g.login_id::text) is null".into());
        }
        self.association.push_str(&format!(
            " and ({})",
            if predicates.is_empty() {
                "false".into()
            } else {
                predicates.join(" or ")
            }
        ));
    }

    fn label(&mut self, filter: &DailyMessageStatsReq) {
        let Some(label_id) = filter.user_label_id else {
            return;
        };
        let mapping = crate::organism::labels::sender_mapping_sql();
        let sender = "coalesce(g.sender,g.login_id::text)";
        if label_id == crate::config::USER_LABEL_UNASSIGNED_ID {
            self.association.push_str(&format!(" and ({sender} is null or {sender} not in (select ls.sender from ({mapping}) ls where ls.label_id is not null))"));
        } else {
            let label = self.bind(label_id);
            self.association.push_str(&format!(" and {sender} in (select ls.sender from ({mapping}) ls where ls.label_id={label}::bigint)"));
        }
    }

    pub fn messages(&self) -> String {
        format!("select m.id from signal_message m where {} and exists (select 1 from signal_message_group g where g.signal_message_id=m.id and {})", self.message, self.association)
    }

    pub fn associations(&self, columns: &str) -> String {
        format!("select distinct {columns} from signal_message m join signal_message_group g on g.signal_message_id=m.id where {} and {}", self.message, self.association)
    }
}
