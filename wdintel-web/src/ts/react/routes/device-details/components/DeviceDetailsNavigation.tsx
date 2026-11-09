import AudioFileIcon from '@mui/icons-material/AudioFile';
import FolderIcon from '@mui/icons-material/Folder';
import CalendarViewMonthIcon from '@mui/icons-material/CalendarViewMonth';

import type { ReactElement } from 'react';

import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import type { DeviceAnalyticsTagFilter } from '../../device-files/types';
import { DeviceDetailsSection, deviceSectionHref } from '../page-route';
import {
  DeviceSidebarHeader,
  deviceSidebarClassName,
  deviceSidebarRowClassName,
} from './DeviceSidebar';

export function DeviceDetailsNavigation({
  deviceId,
  search,
  tagFilter,
}: {
  deviceId: string;
  search: string;
  tagFilter: DeviceAnalyticsTagFilter;
}) {
  const items = [
    { value: DeviceDetailsSection.Files, label: 'Файли', icon: <FolderIcon /> },
    { value: DeviceDetailsSection.Journal, label: 'Журнал', icon: <CalendarViewMonthIcon /> },
    { value: DeviceDetailsSection.Audio, label: 'Аудіо', icon: <AudioFileIcon /> },
  ] satisfies Array<{ value: DeviceDetailsSection; label: string; icon: ReactElement }>;

  return (
    <nav
      aria-label="Меню пристрою"
      data-testid="device-details-navigation"
      className={`${deviceSidebarClassName} shrink-0 overflow-auto`}
    >
      <DeviceSidebarHeader title="Меню" />
      <ul className="m-0 grid list-none grid-cols-2 gap-echo-xs p-0 echo-lg:grid-cols-1">
        {items.map(({ value, label, icon }) => {
          const href = deviceSectionHref(deviceId, value, search, tagFilter);
          return (
            <li key={value} className="min-w-0">
              <a
                href={href}
                onClick={(event) => handleNavigateWithinSpaClick(event, href)}
                className={`${deviceSidebarRowClassName} flex items-center gap-echo-sm rounded-echo-sm px-echo-sm py-echo-sm text-echo-text! no-underline! hover:bg-echo-primary/10 focus-visible:outline-2 focus-visible:outline-echo-focus`}
              >
                {icon}
                <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
