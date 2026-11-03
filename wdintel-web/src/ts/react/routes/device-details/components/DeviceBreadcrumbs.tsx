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
  'text-inherit! no-underline! [overflow-wrap:anywhere] hover:underline! focus-visible:outline-2 focus-visible:outline-echo-focus';

export function DeviceBreadcrumbs({
  deviceId,
  deviceName,
  section,
}: {
  deviceId: string;
  deviceName: string | null;
  section: DeviceDetailsSection;
}) {
  const homeHref = deviceSectionHref(
    deviceId,
    DeviceDetailsSection.Overview,
    window.location.search,
  );
  const sectionHref = deviceSectionHref(deviceId, section, window.location.search);
  const isOverview = section === DeviceDetailsSection.Overview;

  return (
    <nav aria-label="Навігаційний шлях пристрою" className="min-w-0">
      <ol className="m-0! flex min-w-0 list-none! flex-wrap items-baseline gap-x-echo-sm gap-y-echo-xs p-0!">
        <li className="min-w-0">
          <h1 className="m-0! [font:inherit]!">
            {deviceName === null ? (
              <Skeleton width={240} className="max-w-full" />
            ) : (
              <a
                href={homeHref}
                aria-current={isOverview ? 'page' : undefined}
                onClick={(event) => handleNavigateWithinSpaClick(event, homeHref)}
                className={linkClassName}
              >
                {deviceName}
              </a>
            )}
          </h1>
        </li>
        {!isOverview ? (
          <li className="flex min-w-0 items-baseline gap-echo-sm">
            <span aria-hidden="true">/</span>
            <a
              href={sectionHref}
              aria-current="page"
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
