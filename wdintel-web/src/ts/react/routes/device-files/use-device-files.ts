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
  const sync = useDeviceFilesSync({
    deviceId,
    canSync,
    onCommitted: load.refreshVisible,
  });

  return { ...load, sync };
}
