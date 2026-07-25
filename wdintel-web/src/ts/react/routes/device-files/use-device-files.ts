import { useCallback } from 'react';

import { useDeviceFileTree } from './use-device-file-tree';
import { useDeviceFilesLoad } from './use-device-files.load';
import { useDeviceFilesSync } from './use-device-files.sync';

export function useDeviceFiles({
  deviceId,
  enabled,
  canSync,
}: {
  deviceId: string;
  enabled: boolean;
  canSync: boolean;
}) {
  const load = useDeviceFilesLoad({ deviceId, enabled });
  const tree = useDeviceFileTree({
    deviceId,
    enabled,
    roots: load.roots,
    onDirectoryMissing: load.handleDirectoryMissing,
  });
  const refreshVisible = useCallback(
    async () => Promise.all([load.refreshVisible(), tree.refreshExpanded()]).then(() => undefined),
    [load.refreshVisible, tree.refreshExpanded],
  );
  const sync = useDeviceFilesSync({
    deviceId,
    canSync,
    onCommitted: refreshVisible,
  });

  return { ...load, tree, refreshVisible, sync };
}

export type DeviceFilesState = ReturnType<typeof useDeviceFiles>;
