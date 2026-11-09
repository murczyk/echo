use super::types::{DeviceFileSortBy, DeviceFileSortDirection};
use super::EntrySortKey;
use crate::file_registry::entities::file_entry;
use crate::{error::AppError, h, types::ShortContext};
use sea_orm::sea_query::{Expr, NullOrdering, Order};
use sea_orm::{QueryFilter, QueryOrder, Select, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::devices) struct FileListingSort {
    pub by: DeviceFileSortBy,
    pub direction: DeviceFileSortDirection,
}

impl FileListingSort {
    pub fn new(
        by: Option<DeviceFileSortBy>,
        direction: Option<DeviceFileSortDirection>,
    ) -> Self {
        Self {
            by: by.unwrap_or_default(),
            direction: direction.unwrap_or_default(),
        }
    }

    pub fn value_sql(self, alias: &str) -> String {
        match self.by {
            DeviceFileSortBy::FileSortName => format!("convert_to({alias}.name, 'UTF8')"),
            DeviceFileSortBy::FileSortSize => format!("{alias}.size_bytes"),
            DeviceFileSortBy::FileSortUploadedAt => format!("case when {alias}.kind::text='directory' then {alias}.created_at at time zone 'UTC' else (select content.created_at from file_content content where content.file_id={alias}.id and content.revision={alias}.revision) end"),
            DeviceFileSortBy::FileSortCreatedAt => format!("{alias}.file_metadata_created_at"),
            DeviceFileSortBy::FileSortModifiedAt => format!("{alias}.file_metadata_modified_at"),
        }
    }

    fn current_value_sql(self, alias: &str) -> String {
        match self.by {
            DeviceFileSortBy::FileSortSize => super::query::sizes::value_sql(
                alias,
                &format!("{alias}.revision"),
            ),
            DeviceFileSortBy::FileSortCreatedAt => {
                super::query::dates::value_sql(alias, true)
            }
            DeviceFileSortBy::FileSortModifiedAt => {
                super::query::dates::value_sql(alias, false)
            }
            _ => self.value_sql(alias),
        }
    }

    fn direction_sql(self) -> &'static str {
        match self.direction {
            DeviceFileSortDirection::FileSortAscending => "asc",
            DeviceFileSortDirection::FileSortDescending => "desc",
        }
    }

    pub fn order_sql(self, alias: &str) -> String {
        let value = self.value_sql(alias);
        let direction = self.direction_sql();
        let tie = if self.by == DeviceFileSortBy::FileSortName {
            String::new()
        } else {
            format!(",convert_to({alias}.name,'UTF8') asc")
        };
        format!("{value} {direction} nulls last{tie},{alias}.id asc")
    }

    pub fn after_sql(
        self,
        alias: &str,
        source: &str,
        name: &str,
        id: &str,
    ) -> String {
        let value = if source == "file_entry" {
            self.current_value_sql(alias)
        } else {
            self.value_sql(alias)
        };
        let boundary = if self.by == DeviceFileSortBy::FileSortName {
            format!("convert_to({name},'UTF8')")
        } else {
            format!(
                "(select {} from {source} boundary where boundary.id={id} and boundary.name={name} order by boundary.revision desc nulls last limit 1)",
                if source == "file_entry" { self.current_value_sql("boundary") } else { self.value_sql("boundary") }
            )
        };
        let operator =
            if self.direction == DeviceFileSortDirection::FileSortAscending {
                ">"
            } else {
                "<"
            };
        let tie = if self.by == DeviceFileSortBy::FileSortName {
            format!("{alias}.id > {id}")
        } else {
            format!("(convert_to({alias}.name,'UTF8'),{alias}.id) > (convert_to({name},'UTF8'),{id})")
        };
        format!("({value} {operator} {boundary} or ({value} is null and {boundary} is not null) or ({value} is not distinct from {boundary} and {tie}))")
    }

    pub fn apply(
        self,
        mut query: Select<file_entry::Entity>,
        after: Option<&EntrySortKey>,
    ) -> Select<file_entry::Entity> {
        let direction = match self.direction {
            DeviceFileSortDirection::FileSortAscending => Order::Asc,
            DeviceFileSortDirection::FileSortDescending => Order::Desc,
        };
        query = query.order_by_with_nulls(
            Expr::cust(self.current_value_sql("file_entry")),
            direction,
            NullOrdering::Last,
        );
        if self.by != DeviceFileSortBy::FileSortName {
            query = query
                .order_by_asc(Expr::cust("convert_to(file_entry.name,'UTF8')"));
        }
        query = query.order_by_asc(file_entry::Column::Id);
        if let Some(after) = after {
            query = query.filter(Expr::cust_with_values(
                self.after_sql("file_entry", "file_entry", "$1", "$2"),
                [Value::from(after.name()), Value::from(after.entry_id())],
            ));
        }
        query
    }

    pub fn decode_cursor(
        self,
        value: Option<String>,
        scope: &str,
    ) -> Result<Option<String>, AppError> {
        if self == Default::default() {
            return Ok(value);
        }
        Ok(value
            .map(|value| {
                super::sessions::cursor::decode(&value, scope)
                    .map(super::cursor::encode)
            })
            .transpose()
            .c(h!())?)
    }

    pub fn encode_cursor(
        self,
        value: &mut Option<String>,
        scope: &str,
    ) -> Result<(), AppError> {
        if self == Default::default() {
            return Ok(());
        }
        if let Some(boundary) = value.take() {
            let id = super::cursor::decode(&boundary)
                .map_err(super::bl::map_read_error)
                .c(h!())?;
            *value = Some(super::sessions::cursor::encode(scope, id).c(h!())?);
        }
        Ok(())
    }
}
