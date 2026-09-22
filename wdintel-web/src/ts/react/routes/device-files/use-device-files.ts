import { useCallback, useEffect, useState } from 'react';

import type { DeviceFileTreeEntry } from '../../../../Bindings';

import { useDeviceFileCounts } from './use-device-file-counts';
import { useDeviceFileTree } from './use-device-file-tree';
import { useDeviceFilesLoad } from './use-device-files.load';
import type { DeviceAnalyticsTagFilter } from './types';

export function useDeviceFiles({
  deviceId,
  syncId = null,
  enabled,
  tagFilter,
}: {
  deviceId: string;
  syncId?: string | null;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
}) {
  const [selection, setSelection] = useState<{
    deviceId: string;
    syncId: string | null;
    file: DeviceFileTreeEntry;
  } | null>(null);
  const selectedFile =
    enabled && selection?.deviceId === deviceId && selection.syncId === syncId
      ? selection.file
      : null;
  const selectFile = useCallback(
    (file: DeviceFileTreeEntry) => setSelection({ deviceId, syncId, file }),
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
    onDirectoryMissing: load.handleDirectoryMissing,
    tagFilter,
    onDirectoriesLoaded: enqueueLoadedDirectories,
  });
  useEffect(() => {
    counts.enqueue({
      parentEntryId: null,
      directoryEntryIds: load.roots.map((root) => root.entryId),
    });
  }, [counts.enqueue, load.roots]);
  const refreshVisible = useCallback(async () => {
    setSelection(null);
    counts.reset();
    counts.enqueue({
      parentEntryId: null,
      directoryEntryIds: load.roots.map((root) => root.entryId),
    });
    await Promise.all([load.refreshVisible(), tree.refreshExpanded()]);
  }, [counts.enqueue, counts.reset, load.refreshVisible, load.roots, tree.refreshExpanded]);

  return { ...load, tree, counts, refreshVisible, selectedFile, selectFile };
}

export type DeviceFilesState = ReturnType<typeof useDeviceFiles>;
