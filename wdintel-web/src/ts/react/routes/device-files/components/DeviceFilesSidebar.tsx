import { CircularProgress } from '@mui/material';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAnalyticsTagFilter } from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFileTree } from './DeviceFileTree';
import { DeviceArchiveActivityContext } from '../use-device-archive';
import {
  DeviceSidebarHeader,
  deviceSidebarClassName,
} from '../../device-details/components/DeviceSidebar';

export function DeviceFilesSidebar({
  files,
  fullHeight = false,
  active = true,
}: {
  fullHeight?: boolean;
  active?: boolean;
  files: DeviceFilesState;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  return (
    <aside
      aria-labelledby="device-files-sidebar-title"
      data-testid="device-files-sidebar"
      aria-busy={files.rootsLoading || files.rootsRefreshing}
      className={`${deviceSidebarClassName} flex flex-col overflow-hidden ${fullHeight ? 'h-full' : 'max-h-[50vh] echo-lg:h-full echo-lg:max-h-none'}`}
    >
      <DeviceSidebarHeader id="device-files-sidebar-title" title="Файли" />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {files.rootsError && (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={<PowerButton onClick={() => void files.reloadRoots()}>Повторити</PowerButton>}
          >
            {files.rootsError.message}
          </PowerAlert>
        )}
        {files.rootsLoading ? (
          <div className="grid place-items-center p-echo-lg">
            <CircularProgress size={24} aria-label="Завантаження папок" />
          </div>
        ) : (
          <DeviceArchiveActivityContext.Provider value={active}>
            <DeviceFileTree files={files} />
          </DeviceArchiveActivityContext.Provider>
        )}
      </div>
    </aside>
  );
}
