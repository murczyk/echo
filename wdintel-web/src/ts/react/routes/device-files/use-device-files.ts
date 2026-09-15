import { useCallback, useEffect, useState } from 'react';

import type { DeviceFileTreeEntry } from '../../../../Bindings';

import { useDeviceFileCounts } from './use-device-file-counts';
import { useDeviceFileTree } from './use-device-file-tree';
import { useDeviceFilesLoad } from './use-device-files.load';
import type { DeviceAnalyticsTagFilter } from './types';

export function useDeviceFiles({
  deviceId,
  enabled,
  tagFilter,
}: {
  deviceId: string;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
}) {
  const [selection, setSelection] = useState<{
    deviceId: string;
    file: DeviceFileTreeEntry;
  } | null>(null);
  const selectedFile = enabled && selection?.deviceId === deviceId ? selection.file : null;
  const selectFile = useCallback(
    (file: DeviceFileTreeEntry) => setSelection({ deviceId, file }),
    [deviceId],
  );
  useEffect(() => setSelection(null), [deviceId, enabled]);
  const load = useDeviceFilesLoad({ deviceId, enabled, tagFilter });
  const counts = useDeviceFileCounts({ deviceId, enabled });
  const enqueueLoadedDirectories = useCallback(
    (parentEntryId: string, directoryEntryIds: string[]) =>
      counts.enqueue({ parentEntryId, directoryEntryIds }),
    [counts.enqueue],
  );
  const tree = useDeviceFileTree({
    deviceId,
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
