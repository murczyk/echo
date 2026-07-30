use super::{
    classify_transaction_error, map_database_error, map_transaction_body_error,
    mutation, query, Breadcrumb, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileJournalEntry, FileJournalSortKey, FileMutationResult,
    FileSearchFilters, FilesystemError, KeysetPage, KeysetPageRequest,
    PreparedFileMutation, RootEntry, SearchEntry, SubtreeFileCount,
    TransactionErrorClass, TreeEntry,
};
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseTransaction, DbBackend,
    IsolationLevel, Statement, TransactionTrait,
};
use uuid::Uuid;

pub(in crate::devices) struct FilesystemRepository<'db> {
    file_registry_db: &'db FileRegistryDb,
}

pub(super) async fn capture_transaction_id(
    transaction: &DatabaseTransaction,
) -> Result<String, FilesystemError> {
    let row = transaction
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "select pg_current_xact_id()::text as transaction_id".to_string(),
        ))
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or_else(|| {
            map_transaction_body_error(anyhow::anyhow!(
                "pg_current_xact_id returned no row"
            ))
        })?;
    row.try_get("", "transaction_id")
        .c(h!())
        .map_err(map_transaction_body_error)
}

pub(super) async fn handle_commit_error(
    repository: &FilesystemRepository<'_>,
    result: FileMutationResult,
    transaction_id: String,
    error: anyhow::Error,
) -> Result<FileMutationResult, FilesystemError> {
    match classify_transaction_error(&error) {
        TransactionErrorClass::Retryable => Err(FilesystemError::Conflict),
        TransactionErrorClass::DatabaseFailure => {
            Err(map_database_error(error))
        }
        TransactionErrorClass::OutcomeUncertain => {
            let reconciled = mutation::reconcile_file_mutation(
                repository.file_registry_db.connection(),
                &result,
                &transaction_id,
            )
            .await;
            if matches!(reconciled, Ok(true)) {
                Ok(result)
            } else {
                Err(FilesystemError::CommitUncertain(error))
            }
        }
    }
}

impl<'db> FilesystemRepository<'db> {
    pub(in crate::devices) fn new(
        file_registry_db: &'db FileRegistryDb,
    ) -> Self {
        Self { file_registry_db }
    }

    async fn begin_read_snapshot(
        &self,
    ) -> Result<DatabaseTransaction, FilesystemError> {
        self.file_registry_db
            .connection()
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await
            .map_err(|error| {
                map_database_error(anyhow::Error::new(error).context(h!()))
            })
    }

    async fn commit_read_snapshot(
        transaction: DatabaseTransaction,
    ) -> Result<(), FilesystemError> {
        transaction.commit().await.map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })
    }

    pub(in crate::devices) async fn mutate_file(
        &self,
        mutation: &PreparedFileMutation,
    ) -> Result<FileMutationResult, FilesystemError> {
        let transaction =
            self.file_registry_db.connection().begin().await.map_err(
                |error| {
                    map_database_error(anyhow::Error::new(error).context(h!()))
                },
            )?;
        let result = match mutation::mutate_file(&transaction, mutation).await {
            Ok(result) => result,
            Err(error) => {
                return Err(Self::rollback_after_body_error(
                    transaction,
                    error,
                )
                .await);
            }
        };
        let transaction_id = match capture_transaction_id(&transaction).await {
            Ok(transaction_id) => transaction_id,
            Err(error) => {
                return Err(Self::rollback_after_body_error(
                    transaction,
                    error,
                )
                .await);
            }
        };

        match transaction.commit().await {
            Ok(()) => Ok(result),
            Err(error) => {
                handle_commit_error(
                    self,
                    result,
                    transaction_id,
                    anyhow::Error::new(error).context(h!()),
                )
                .await
            }
        }
    }

    async fn rollback_after_body_error(
        transaction: DatabaseTransaction,
        error: FilesystemError,
    ) -> FilesystemError {
        let rollback_error = transaction.rollback().await.err().map(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        });
        if matches!(&error, FilesystemError::Conflict) {
            return error;
        }

        rollback_error.unwrap_or(error)
    }

    pub(in crate::devices) async fn list_roots(
        &self,
        device_id: Uuid,
    ) -> Result<Vec<RootEntry>, FilesystemError> {
        query::list_roots(self.file_registry_db.connection(), device_id).await
    }

    pub(in crate::devices) async fn count_file_subtrees(
        &self,
        device_id: Uuid,
        parent_entry_id: Option<Uuid>,
        directory_entry_ids: &[Uuid],
    ) -> Result<Vec<SubtreeFileCount>, FilesystemError> {
        let transaction = self.begin_read_snapshot().await?;
        let counts = query::count_file_subtrees(
            &transaction,
            device_id,
            parent_entry_id,
            directory_entry_ids,
        )
        .await?;
        if counts.len() != directory_entry_ids.len() {
            return Err(FilesystemError::NotFound);
        }
        Self::commit_read_snapshot(transaction).await?;
        Ok(counts)
    }

    pub(in crate::devices) async fn list_file_journal_with_total(
        &self,
        device_id: Uuid,
        page: KeysetPageRequest<FileJournalSortKey>,
    ) -> Result<
        (KeysetPage<FileJournalEntry, FileJournalSortKey>, u64),
        FilesystemError,
    > {
        let transaction = self.begin_read_snapshot().await?;
        let total_count =
            query::count_device_files(&transaction, device_id).await?;
        let page =
            query::list_file_journal(&transaction, device_id, page).await?;
        Self::commit_read_snapshot(transaction).await?;
        Ok((page, total_count))
    }

    pub(in crate::devices) async fn resolve_file_journal_cursor(
        &self,
        device_id: Uuid,
        boundary_file_id: Uuid,
    ) -> Result<FileJournalSortKey, FilesystemError> {
        query::resolve_file_journal_cursor(
            self.file_registry_db.connection(),
            device_id,
            boundary_file_id,
        )
        .await
    }

    pub(in crate::devices) async fn list_children(
        &self,
        scope: &DirectoryScope,
        page: KeysetPageRequest<EntrySortKey>,
    ) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
        query::list_children(self.file_registry_db.connection(), scope, page)
            .await
    }

    pub(in crate::devices) async fn load_path_components(
        &self,
        entries: &[TreeEntry],
    ) -> Result<Vec<Vec<String>>, FilesystemError> {
        query::load_path_components(self.file_registry_db.connection(), entries)
            .await
    }

    pub(in crate::devices) async fn search_entries(
        &self,
        scope: &DirectoryScope,
        filters: &FileSearchFilters,
        page: KeysetPageRequest<EntrySortKey>,
    ) -> Result<KeysetPage<SearchEntry, EntrySortKey>, FilesystemError> {
        query::search_entries(
            self.file_registry_db.connection(),
            scope,
            filters,
            page,
        )
        .await
    }

    pub(in crate::devices) async fn list_breadcrumbs(
        &self,
        scope: &DirectoryScope,
    ) -> Result<Vec<Breadcrumb>, FilesystemError> {
        query::list_breadcrumbs(self.file_registry_db.connection(), scope).await
    }

    pub(in crate::devices) async fn find_directory_scope(
        &self,
        device_id: Uuid,
        entry_id: Uuid,
    ) -> Result<DirectoryScope, FilesystemError> {
        query::find_directory_scope(
            self.file_registry_db.connection(),
            device_id,
            entry_id,
        )
        .await
    }

    pub(in crate::devices) async fn resolve_cursor_entry_sort_key(
        &self,
        boundary_entry_id: Uuid,
        scope: &EntryQueryScope<'_>,
    ) -> Result<EntrySortKey, FilesystemError> {
        query::resolve_cursor_entry_sort_key(
            self.file_registry_db.connection(),
            boundary_entry_id,
            scope,
        )
        .await
    }
}
