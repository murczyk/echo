import type { DeviceFilesState } from '../../device-files/use-device-files';
import { deviceFileLocationHref } from '../../device-files/use-device-file-link';
import { Skeleton } from '@mui/material';

import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import { DeviceDetailsSection, deviceSectionHref } from '../page-route';

const sectionLabels = {
  [DeviceDetailsSection.Overview]: 'Пристрій',
  [DeviceDetailsSection.Files]: 'Файли',
  [DeviceDetailsSection.Journal]: 'Журнал',
  [DeviceDetailsSection.Audio]: 'Аудіо',
} satisfies Record<DeviceDetailsSection, string>;

const linkClassName =
  'text-inherit! no-underline! hover:underline! focus-visible:outline-2 focus-visible:outline-echo-focus';

export function DeviceBreadcrumbs({
  deviceId,
  deviceName,
  section,
  files,
}: {
  deviceId: string;
  deviceName: string | null;
  section: DeviceDetailsSection;
  files?: DeviceFilesState;
}) {
  const homeHref = deviceSectionHref(
    deviceId,
    DeviceDetailsSection.Overview,
    window.location.search,
  );
  const sectionHref = files
    ? deviceFileLocationHref(null, null, null)
    : deviceSectionHref(deviceId, section, window.location.search);
  const isOverview = section === DeviceDetailsSection.Overview;

  return (
    <nav aria-label="Навігаційний шлях пристрою" className="min-w-0 flex-1">
      <ol className="m-0! min-w-0 list-none! truncate p-0!">
        <li className="inline">
          <h1 className="m-0! inline [font:inherit]!">
            {deviceName === null ? (
              <Skeleton width={240} className="max-w-full" />
            ) : (
              <a
                href={homeHref}
                aria-current={isOverview ? 'page' : undefined}
                onClick={(event) => handleNavigateWithinSpaClick(event, homeHref)}
                className={linkClassName}
                title={deviceName}
              >
                {deviceName}
              </a>
            )}
          </h1>
        </li>
        {!isOverview ? (
          <li className="inline">
            <span aria-hidden="true" className="mx-echo-sm">
              /
            </span>
            <a
              href={sectionHref}
              aria-current={files?.selectedDirectory || files?.selectedFile ? undefined : 'page'}
              onClick={(event) => handleNavigateWithinSpaClick(event, sectionHref)}
              className={linkClassName}
            >
              {sectionLabels[section]}
            </a>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
