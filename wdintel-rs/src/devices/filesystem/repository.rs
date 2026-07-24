use super::{
    classify_transaction_error, map_database_error, map_transaction_body_error,
    mutation, query, Breadcrumb, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileMutationResult, FileSearchFilters, FilesystemError, KeysetPage,
    KeysetPageRequest, PreparedFileMutation, RootEntry, SearchEntry,
    TransactionErrorClass, TreeEntry,
};
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ConnectionTrait, DatabaseTransaction, DbBackend, Statement,
    TransactionTrait,
};
use uuid::Uuid;

pub(in crate::devices) struct FilesystemRepository<'db> {
    file_registry_db: &'db FileRegistryDb,
    #[cfg(test)]
    test_control: Option<&'db mutation::MutationAttemptTestControl>,
}

struct MutationAttemptResult {
    result: FileMutationResult,
    transaction_id: String,
}

impl<'db> FilesystemRepository<'db> {
    pub(in crate::devices) fn new(
        file_registry_db: &'db FileRegistryDb,
    ) -> Self {
        Self {
            file_registry_db,
            #[cfg(test)]
            test_control: None,
        }
    }

    #[cfg(test)]
    pub(in crate::devices::filesystem) fn with_test_control(
        file_registry_db: &'db FileRegistryDb,
        test_control: &'db mutation::MutationAttemptTestControl,
    ) -> Self {
        Self {
            file_registry_db,
            test_control: Some(test_control),
        }
    }

    #[allow(dead_code)]
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
        let result = match mutation::mutate_file(
            &transaction,
            mutation,
            #[cfg(test)]
            self.test_control,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                return Err(Self::rollback_after_body_error(
                    transaction,
                    error,
                )
                .await);
            }
        };
        let transaction_id =
            match Self::capture_transaction_id(&transaction).await {
                Ok(transaction_id) => transaction_id,
                Err(error) => {
                    return Err(Self::rollback_after_body_error(
                        transaction,
                        error,
                    )
                    .await);
                }
            };
        let attempt = MutationAttemptResult {
            result,
            transaction_id,
        };

        #[cfg(test)]
        if let Some(test_control) = self.test_control {
            match test_control.commit_fault(mutation) {
                Some(
                    mutation::MutationCommitFault::LoseCommitAcknowledgement,
                ) => {
                    let committed = transaction.commit().await;
                    return match committed {
                        Ok(()) => {
                            self.handle_commit_error(
                                attempt,
                                anyhow::anyhow!(
                                    "test commit acknowledgement lost"
                                ),
                            )
                            .await
                        }
                        Err(error) => {
                            self.handle_commit_error(
                                attempt,
                                anyhow::Error::new(error).context(h!()),
                            )
                            .await
                        }
                    };
                }
                Some(mutation::MutationCommitFault::UnknownWithoutCommit {
                    after_rollback,
                }) => {
                    let rollback = transaction.rollback().await;
                    rollback.map_err(|error| {
                        map_database_error(
                            anyhow::Error::new(error).context(h!()),
                        )
                    })?;
                    if let Some(after_rollback) = after_rollback {
                        after_rollback.entered.wait().await;
                        after_rollback.resume.wait().await;
                    }
                    return self
                        .handle_commit_error(
                            attempt,
                            anyhow::anyhow!(
                                "test commit outcome unknown without commit"
                            ),
                        )
                        .await;
                }
                None => {}
            }
        }

        let committed = transaction.commit().await;
        match committed {
            Ok(()) => Ok(attempt.result),
            Err(error) => {
                self.handle_commit_error(
                    attempt,
                    anyhow::Error::new(error).context(h!()),
                )
                .await
            }
        }
    }

    async fn capture_transaction_id(
        transaction: &DatabaseTransaction,
    ) -> Result<String, FilesystemError> {
        let row = transaction
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "select pg_current_xact_id()::text as transaction_id"
                    .to_string(),
            ))
            .await
            .map_err(|error| {
                map_transaction_body_error(
                    anyhow::Error::new(error).context(h!()),
                )
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

    async fn handle_commit_error(
        &self,
        attempt: MutationAttemptResult,
        error: anyhow::Error,
    ) -> Result<FileMutationResult, FilesystemError> {
        let transaction_error_class = classify_transaction_error(&error);
        match transaction_error_class {
            TransactionErrorClass::Retryable => Err(FilesystemError::Conflict),
            TransactionErrorClass::DatabaseFailure => {
                Err(map_database_error(error))
            }
            TransactionErrorClass::OutcomeUncertain => {
                let reconciled = mutation::reconcile_file_mutation(
                    self.file_registry_db.connection(),
                    &attempt.result,
                    &attempt.transaction_id,
                )
                .await;
                if matches!(reconciled, Ok(true)) {
                    Ok(attempt.result)
                } else {
                    Err(FilesystemError::CommitUncertain(error))
                }
            }
        }
    }

    #[cfg(test)]
    pub(in crate::devices::filesystem) async fn handle_commit_error_for_test(
        &self,
        result: FileMutationResult,
        transaction_id: String,
        error: anyhow::Error,
    ) -> Result<FileMutationResult, FilesystemError> {
        self.handle_commit_error(
            MutationAttemptResult {
                result,
                transaction_id,
            },
            error,
        )
        .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn list_roots(
        &self,
        device_id: Uuid,
    ) -> Result<Vec<RootEntry>, FilesystemError> {
        query::list_roots(self.file_registry_db.connection(), device_id).await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn list_children(
        &self,
        scope: &DirectoryScope,
        page: KeysetPageRequest<EntrySortKey>,
    ) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
        query::list_children(self.file_registry_db.connection(), scope, page)
            .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn load_path_components(
        &self,
        entries: &[TreeEntry],
    ) -> Result<Vec<Vec<String>>, FilesystemError> {
        query::load_path_components(self.file_registry_db.connection(), entries)
            .await
    }

    #[allow(dead_code)]
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

    #[allow(dead_code)]
    pub(in crate::devices) async fn list_breadcrumbs(
        &self,
        scope: &DirectoryScope,
    ) -> Result<Vec<Breadcrumb>, FilesystemError> {
        query::list_breadcrumbs(self.file_registry_db.connection(), scope).await
    }

    #[allow(dead_code)]
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

    #[allow(dead_code)]
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
