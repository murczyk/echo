import { useCallback, useEffect, useState } from 'react';

import type { BrowseDeviceFilesReq } from '../../../../Bindings';
import type { DeviceFileSelection } from './device-file-archive';

import { useDeviceFileCounts } from './use-device-file-counts';
import { useDeviceFileTree } from './use-device-file-tree';
import { useDeviceFilesLoad } from './use-device-files.load';
import type { DeviceAnalyticsTagFilter } from './types';
import { locateDeviceFile } from '../../services/api/devices';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { redirectToLogin } from '../../auth-redirect';
import { toDeviceFileLoadError } from './helpers';
import { setDeviceFileLink } from './use-device-file-link';

export function useDeviceFiles({
  deviceId,
  syncId = null,
  enabled,
  tagFilter,
  linkedFile = null,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
  linkedFile?: { fileId: string; revision: number | null } | null;
}) {
  const [contentFilter, setContentFilter] = useState<BrowseDeviceFilesReq['hasContent']>(null);
  const [archiveEpoch, setArchiveEpoch] = useState(0);
  const [selection, setSelection] = useState<{
    deviceId: string;
    syncId: string | null;
    file: DeviceFileSelection;
    revisionPinned: boolean;
  } | null>(null);
  const selectedFile =
    enabled && selection?.deviceId === deviceId && selection.syncId === syncId
      ? selection.file
      : null;
  const [linkError, setLinkError] = useState<string | null>(null);
  const clearSelectedFile = useCallback(() => {
    setSelection(null);
    setDeviceFileLink(null, null);
  }, []);
  const selectFile = useCallback(
    (file: DeviceFileSelection) => {
      setSelection({ deviceId, syncId, file, revisionPinned: false });
      if (!file.archiveMember && syncId === null) setDeviceFileLink(file.fileId, file.revision);
    },
    [deviceId, syncId],
  );
  useEffect(() => setSelection(null), [deviceId, syncId, enabled]);
  const load = useDeviceFilesLoad({ deviceId, syncId, enabled, tagFilter });
  const counts = useDeviceFileCounts({ deviceId, syncId, enabled });
  const enqueueLoadedDirectories = useCallback(
    (parentEntryId: string, directoryEntryIds: string[]) =>
      counts.enqueue({ parentEntryId, directoryEntryIds }),
    [counts.enqueue],
  );
  const tree = useDeviceFileTree({
    deviceId,
    syncId,
    enabled,
    roots: load.roots,
    hasContent: contentFilter,
    onDirectoryMissing: load.handleDirectoryMissing,
    tagFilter,
    onDirectoriesLoaded: enqueueLoadedDirectories,
  });
  const linkedFileId = linkedFile?.fileId;
  const linkedRevision = linkedFile?.revision ?? null;
  useEffect(() => {
    setSelection((previous) =>
      linkedFileId &&
      previous?.file.fileId === linkedFileId &&
      (linkedRevision === null || previous.file.revision === linkedRevision)
        ? previous
        : null,
    );
  }, [linkedFileId, linkedRevision]);
  const rootsKey = load.roots.map((root) => root.entryId).join('|');
  useEffect(() => {
    setLinkError(null);
    if (!enabled || syncId !== null || !linkedFileId || !rootsKey || load.rootsLoading) return;
    if (
      selection?.deviceId === deviceId &&
      selection.syncId === syncId &&
      selection.file.fileId === linkedFileId &&
      (linkedRevision === null || selection.file.revision === linkedRevision)
    )
      return;
    const controller = new AbortController();
    void (async () => {
      try {
        const located = await locateDeviceFile(
          { deviceId, fileId: linkedFileId, revision: linkedRevision },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        await tree.revealFile(located, controller.signal);
        if (!controller.signal.aborted)
          setSelection({
            deviceId,
            syncId,
            file: located.file,
            revisionPinned: linkedRevision !== null,
          });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) redirectToLogin();
        setLinkError(
          toDeviceFileLoadError(error, 'Не вдалося відкрити файл за посиланням').message,
        );
      }
    })();
    return () => controller.abort();
  }, [
    deviceId,
    syncId,
    enabled,
    linkedFileId,
    linkedRevision,
    rootsKey,
    load.rootsLoading,
    tree.revealFile,
    selection,
  ]);

  useEffect(() => {
    counts.enqueue({
      parentEntryId: null,
      directoryEntryIds: load.roots.map((root) => root.entryId),
    });
  }, [counts.enqueue, load.roots]);
  const refreshVisible = useCallback(async () => {
    setSelection(null);
    setArchiveEpoch((value) => value + 1);
    counts.reset();
    counts.enqueue({
      parentEntryId: null,
      directoryEntryIds: load.roots.map((root) => root.entryId),
    });
    await Promise.all([load.refreshVisible(), tree.refreshExpanded()]);
  }, [counts.enqueue, counts.reset, load.refreshVisible, load.roots, tree.refreshExpanded]);

  return {
    ...load,
    deviceId,
    archiveEpoch,
    contentFilter,
    setContentFilter,
    tree,
    counts,
    refreshVisible,
    selectedFile,
    revisionPinned: selectedFile !== null && (selection?.revisionPinned ?? false),
    linkError,
    selectFile,
    clearSelectedFile,
  };
}

export type DeviceFilesState = ReturnType<typeof useDeviceFiles>;
