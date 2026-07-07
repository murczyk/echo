import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DeviceFileEntry } from '../../../../Bindings';
import {
  createDeviceFiles,
  deleteDeviceFile,
  listDeviceFiles,
  restoreDeviceFile,
} from '../../services/api/devices';
import {
  buildCreateDeviceFilesReq,
  createDeviceFileDraft,
  parseDeviceServerFieldErrors,
  validateDeviceFileRows,
  type DeviceFileDraft,
  type DeviceServerFieldErrors,
} from '../devices/device-form';
import { formatDeviceErrorMessage } from '../devices/helpers';
import {
  DEVICE_FILES_PAGE_SIZE,
  buildDeviceFilesListReq,
  hasActiveFileFilters,
  type DeviceFilesDeletedFilterValue,
} from './helpers';
import type { DeviceDetailsUiMessage } from './use-device-details-page';

function replaceFile(files: DeviceFileEntry[], file: DeviceFileEntry): DeviceFileEntry[] {
  if (!files.some((item) => item.fileId === file.fileId)) return files;
  return files.map((item) => (item.fileId === file.fileId ? file : item));
}

export function useDeviceFiles({
  deviceId,
  canRead,
  canEdit,
  parentArchived,
}: {
  deviceId: string;
  canRead: boolean;
  canEdit: boolean;
  parentArchived: boolean;
}) {
  const [files, setFiles] = useState<DeviceFileEntry[]>([]);
  const [deletedFilter, setDeletedFilter] = useState<DeviceFilesDeletedFilterValue>('active');
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<DeviceDetailsUiMessage>(null);
  const [mutatingFileId, setMutatingFileId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createRows, setCreateRows] = useState<DeviceFileDraft[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createServerFieldErrors, setCreateServerFieldErrors] = useState<DeviceServerFieldErrors>(
    {},
  );
  const [creatingFiles, setCreatingFiles] = useState(false);
  const [deleteDialogFile, setDeleteDialogFile] = useState<DeviceFileEntry | null>(null);

  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const filesLengthRef = useRef(0);
  const latestDeletedFilterRef = useRef(deletedFilter);

  useEffect(() => {
    filesLengthRef.current = files.length;
  }, [files.length]);

  useEffect(() => {
    latestDeletedFilterRef.current = deletedFilter;
  }, [deletedFilter]);

  useEffect(() => {
    if (!parentArchived) return;
    setCreateDialogOpen(false);
    setDeleteDialogFile(null);
  }, [parentArchived]);

  const loadFiles = useCallback(
    async ({ append, preserveData }: { append: boolean; preserveData: boolean }) => {
      if (!canRead) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
        setStatus({ kind: 'error', text: 'Немає доступу до файлів пристрою.' });
        return;
      }

      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      const controller = new AbortController();

      if (append) {
        loadMoreAbortRef.current?.abort();
        loadMoreAbortRef.current = controller;
        setLoadingMore(true);
      } else {
        abortRef.current?.abort();
        abortRef.current = controller;
        if (preserveData) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
      }
      setStatus(null);

      try {
        const rsp = await listDeviceFiles(
          buildDeviceFilesListReq({
            deviceId,
            deletedFilter: latestDeletedFilterRef.current,
            limit: DEVICE_FILES_PAGE_SIZE,
            offset: append ? filesLengthRef.current : 0,
          }),
          { signal: controller.signal },
        );
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;
        setFiles((current) => (append ? [...current, ...rsp.list] : rsp.list));
        setTotal(rsp.total);
        setHasMore(rsp.hasMore);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({
          kind: 'error',
          text: `Помилка завантаження файлів: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [canRead, deviceId],
  );

  useEffect(() => {
    setFiles([]);
    setTotal(0);
    setHasMore(false);
    void loadFiles({ append: false, preserveData: false });
    return () => {
      abortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, [deviceId, deletedFilter, loadFiles]);

  const reload = useCallback(
    () => loadFiles({ append: false, preserveData: filesLengthRef.current > 0 }),
    [loadFiles],
  );

  const loadMore = useCallback(() => loadFiles({ append: true, preserveData: true }), [loadFiles]);

  const assertParentActive = useCallback(() => {
    if (!parentArchived) return true;
    setStatus({
      kind: 'warning',
      text: 'Відновіть пристрій перед зміною життєвого циклу файлів.',
    });
    return false;
  }, [parentArchived]);

  const openCreateDialog = useCallback(() => {
    if (!canEdit || !assertParentActive()) return;
    setCreateRows([createDeviceFileDraft()]);
    setCreateError(null);
    setCreateServerFieldErrors({});
    setCreateDialogOpen(true);
  }, [assertParentActive, canEdit]);

  const closeCreateDialog = useCallback(() => {
    if (creatingFiles) return;
    setCreateDialogOpen(false);
    setCreateRows([]);
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, [creatingFiles]);

  const changeCreateRows = useCallback((rows: DeviceFileDraft[]) => {
    setCreateRows(rows);
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, []);

  const submitCreateFiles = useCallback(
    async (rows: DeviceFileDraft[]) => {
      if (!canEdit || creatingFiles || !assertParentActive()) return;
      const validation = validateDeviceFileRows(rows, { rejectEmpty: true });
      if (validation.files !== undefined || Object.keys(validation.fileRows).length > 0) {
        setCreateError('Перевірте поля форми.');
        return;
      }

      setCreatingFiles(true);
      setCreateError(null);
      setCreateServerFieldErrors({});
      setStatus(null);
      try {
        const rsp = await createDeviceFiles(buildCreateDeviceFilesReq(deviceId, rows));
        setFiles((current) => [...rsp.list, ...current]);
        setTotal((current) => current + rsp.list.length);
        await reload();
        setCreateDialogOpen(false);
        setCreateRows([]);
        setStatus({ kind: 'success', text: 'Файли додано.' });
      } catch (error) {
        const fieldErrors = parseDeviceServerFieldErrors(error);
        setCreateServerFieldErrors(fieldErrors);
        setCreateError(
          Object.keys(fieldErrors).length > 0
            ? null
            : `Помилка додавання файлів: ${formatDeviceErrorMessage(error)}`,
        );
      } finally {
        setCreatingFiles(false);
      }
    },
    [assertParentActive, canEdit, creatingFiles, deviceId, reload],
  );

  const deleteFile = useCallback(
    (file: DeviceFileEntry) => {
      if (!canEdit || mutatingFileId !== null || !assertParentActive()) return;
      setDeleteDialogFile(file);
    },
    [assertParentActive, canEdit, mutatingFileId],
  );

  const closeDeleteDialog = useCallback(() => {
    if (mutatingFileId !== null) return;
    setDeleteDialogFile(null);
  }, [mutatingFileId]);

  const confirmDeleteFile = useCallback(async () => {
    if (!canEdit || mutatingFileId !== null || deleteDialogFile === null || !assertParentActive()) {
      return;
    }

    setMutatingFileId(deleteDialogFile.fileId);
    setStatus(null);
    try {
      const nextFile = await deleteDeviceFile({ deviceId, fileId: deleteDialogFile.fileId });
      setFiles((current) => replaceFile(current, nextFile));
      await reload();
      setDeleteDialogFile(null);
      setStatus({ kind: 'success', text: 'Файл видалено.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Помилка видалення файлу: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      setMutatingFileId(null);
    }
  }, [assertParentActive, canEdit, deleteDialogFile, deviceId, mutatingFileId, reload]);

  const restoreFile = useCallback(
    async (file: DeviceFileEntry) => {
      if (!canEdit || mutatingFileId !== null || !assertParentActive()) return;

      setMutatingFileId(file.fileId);
      setStatus(null);
      try {
        const nextFile = await restoreDeviceFile({ deviceId, fileId: file.fileId });
        setFiles((current) => replaceFile(current, nextFile));
        await reload();
        setStatus({ kind: 'success', text: 'Файл відновлено.' });
      } catch (error) {
        setStatus({
          kind: 'error',
          text: `Помилка відновлення файлу: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        setMutatingFileId(null);
      }
    },
    [assertParentActive, canEdit, deviceId, mutatingFileId, reload],
  );

  const hasFilters = useMemo(() => hasActiveFileFilters(deletedFilter), [deletedFilter]);
  const initialLoadFailed = !loading && files.length === 0 && status?.kind === 'error';

  return {
    files,
    deletedFilter,
    total,
    hasMore,
    loading,
    refreshing,
    loadingMore,
    status,
    mutatingFileId,
    createDialogOpen,
    createRows,
    createError,
    createServerFieldErrors,
    creatingFiles,
    deleteDialogFile,
    hasFilters,
    initialLoadFailed,
    setDeletedFilter,
    reload,
    loadMore,
    openCreateDialog,
    closeCreateDialog,
    setCreateRows: changeCreateRows,
    submitCreateFiles,
    deleteFile,
    closeDeleteDialog,
    confirmDeleteFile,
    restoreFile,
  };
}
