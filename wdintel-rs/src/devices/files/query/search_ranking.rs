use super::super::{DirectoryScope, EntrySortKey};
use crate::file_registry::entities::file_entry;
use sea_orm::sea_query::{Expr, Order};
use sea_orm::{QueryFilter, QueryOrder, Select, Value};

pub(in crate::devices::files) fn key_sql(
    alias: &str,
    term: &str,
    path: &str,
) -> String {
    format!("case when lower({alias}.name)=lower({term}) then 0 when left(lower({alias}.name),char_length({term}))=lower({term}) then 1 else 2 end, nlevel({alias}.hierarchy_path::ltree)+nlevel({path}::ltree)-2*nlevel(lca({alias}.hierarchy_path::ltree||'search'::ltree,{path}::ltree||'search'::ltree)), convert_to({alias}.name,'UTF8'), {alias}.id")
}

pub(super) fn apply(
    mut query: Select<file_entry::Entity>,
    scope: &DirectoryScope,
    term: &str,
    after: Option<&EntrySortKey>,
) -> Select<file_entry::Entity> {
    let key = key_sql("file_entry", "$1", "$2");
    if let Some(after) = after {
        let boundary = key_sql("boundary", "$1", "$2");
        query = query.filter(Expr::cust_with_values(
            format!("row({key}) > (select {boundary} from file_entry boundary where boundary.device_id=$3 and boundary.id=$4)"),
            [Value::from(term), Value::from(scope.hierarchy_path()), Value::from(scope.device_id()), Value::from(after.entry_id())],
        ));
    }
    query.order_by(
        Expr::cust_with_values(
            format!("row({key})"),
            [term, scope.hierarchy_path()],
        ),
        Order::Asc,
    )
}
