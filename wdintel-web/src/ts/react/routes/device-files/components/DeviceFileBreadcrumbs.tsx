import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import SearchIcon from '@mui/icons-material/Search';
import { ButtonBase, Menu, MenuItem } from '@mui/material';
import { useId, useState } from 'react';
import type { FileBreadcrumb } from '../../../../../Bindings';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
import { useDeviceFileBreadcrumbCollapse } from '../use-device-file-breadcrumb-collapse';
import {
  deviceFileLocationHref,
  deviceFileSearchHref,
  useDeviceFileSearchLink,
} from '../use-device-file-link';

function segmentLabel(name: string) {
  return /^[a-z]:[\\/]*$/i.test(name) ? name[0] : name;
}

export function DeviceFileBreadcrumbItems({
  breadcrumbs,
  fileName,
  leadingSeparator = false,
  measurement = false,
}: {
  breadcrumbs: FileBreadcrumb[];
  fileName?: string;
  leadingSeparator?: boolean;
  measurement?: boolean;
}) {
  return (
    <>
      {breadcrumbs.map((segment, index) => {
        const href = deviceFileLocationHref(
          null,
          null,
          segment.entryId,
          segment.archiveRevision ?? null,
        );
        return (
          <li key={segment.entryId} className="flex min-w-0 shrink-0 items-center last:shrink">
            {leadingSeparator || index > 0 ? (
              <span aria-hidden="true" className="mx-echo-sm shrink-0">
                /
              </span>
            ) : null}
            {measurement ? (
              <span>{segmentLabel(segment.name)}</span>
            ) : (
              <a
                href={href}
                onClick={(event) => handleNavigateWithinSpaClick(event, href)}
                aria-current={
                  index === breadcrumbs.length - 1 && fileName === undefined ? 'page' : undefined
                }
                className="min-w-0 truncate text-inherit! no-underline! hover:underline! focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-echo-focus"
                title={segment.name}
              >
                {segmentLabel(segment.name)}
              </a>
            )}
          </li>
        );
      })}
      {fileName !== undefined ? (
        <li className="flex min-w-0 shrink items-center">
          {leadingSeparator || breadcrumbs.length > 0 ? (
            <span aria-hidden="true" className="mx-echo-sm shrink-0">
              /
            </span>
          ) : null}
          <span
            aria-current={measurement ? undefined : 'page'}
            title={fileName}
            className="truncate"
          >
            {fileName}
          </span>
        </li>
      ) : null}
    </>
  );
}

export function DeviceFileBreadcrumbs({
  breadcrumbs,
  fileName,
}: {
  breadcrumbs: FileBreadcrumb[];
  fileName?: string;
}) {
  const search = useDeviceFileSearchLink();
  const searchRootIndex = breadcrumbs.findIndex((segment) => segment.entryId === search?.rootId);
  const visibleBreadcrumbs = search
    ? search.view === 'results'
      ? []
      : breadcrumbs.slice(searchRootIndex >= 0 ? searchRootIndex : -1)
    : breadcrumbs;
  const searchHref = search
    ? deviceFileSearchHref(search.query, search.scopeId, search.scopeRevision, search.global)
    : null;
  const results = searchHref && search && (
    <li className="flex min-w-6 max-w-64 shrink items-center">
      <span aria-hidden className="mx-echo-sm shrink-0">
        /
      </span>
      <a
        href={searchHref}
        onClick={(event) => handleNavigateWithinSpaClick(event, searchHref)}
        aria-label="Результати пошуку"
        title={`Результати пошуку: ${search.query}`}
        className="inline-flex min-w-0 items-center gap-echo-xs text-inherit! no-underline! hover:underline!"
      >
        <SearchIcon className="size-echo-icon-sm! echo-sm:hidden!" />
        <span className="truncate max-echo-sm:hidden">Результати пошуку: «{search.query}»</span>
      </a>
    </li>
  );
  const rootHref = deviceFileLocationHref(null, null, null);
  const path = [
    ...visibleBreadcrumbs.map((segment) => segmentLabel(segment.name)),
    ...(fileName !== undefined ? [fileName] : []),
  ].join(' / ');
  const { viewportRef, measurementRef, hiddenCount } = useDeviceFileBreadcrumbCollapse(
    `${search?.query ?? ''}:${path}`,
    Math.max(0, visibleBreadcrumbs.length - (fileName === undefined ? 1 : 0)),
  );
  return (
    <nav
      ref={viewportRef}
      aria-label={fileName !== undefined ? 'Шлях до файлу' : 'Шлях до папки'}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden"
      title={path}
    >
      <ol className="col-start-1 row-start-1 m-0! flex min-w-0 list-none! items-center overflow-hidden whitespace-nowrap p-0!">
        <li className="flex shrink-0 items-center">
          <a
            href={rootHref}
            onClick={(event) => handleNavigateWithinSpaClick(event, rootHref)}
            aria-label="До початку шляху"
            aria-current={
              visibleBreadcrumbs.length === 0 && fileName === undefined ? 'page' : undefined
            }
            title="До початку шляху"
            className="inline-flex items-center align-text-bottom text-inherit! no-underline! focus-visible:outline-2 focus-visible:outline-echo-focus"
          >
            <ComputerOutlinedIcon className="size-echo-icon-sm!" />
          </a>
        </li>
        {results}
        {hiddenCount > 0 && (
          <DeviceFileBreadcrumbMenu
            key={`${path}:${hiddenCount}`}
            breadcrumbs={visibleBreadcrumbs.slice(0, hiddenCount)}
          />
        )}
        <DeviceFileBreadcrumbItems
          breadcrumbs={visibleBreadcrumbs.slice(hiddenCount)}
          fileName={fileName}
          leadingSeparator
        />
      </ol>
      <ol
        ref={measurementRef}
        aria-hidden="true"
        className="pointer-events-none invisible col-start-1 row-start-1 m-0! flex w-max max-w-none list-none! items-center whitespace-nowrap p-0!"
      >
        <li className="flex shrink-0 items-center">
          <ComputerOutlinedIcon className="size-echo-icon-sm!" />
          {search && (
            <span className="inline-flex max-w-64 items-center gap-echo-xs">
              <span> / </span>
              <SearchIcon className="size-echo-icon-sm! echo-sm:hidden!" />
              <span className="truncate max-echo-sm:hidden">
                Результати пошуку: «{search.query}»
              </span>
            </span>
          )}
        </li>
        <li className="absolute flex shrink-0 items-center">
          <span className="mx-echo-sm">/</span>
          <span className="inline-flex px-echo-xs">…</span>
        </li>
        <DeviceFileBreadcrumbItems
          breadcrumbs={visibleBreadcrumbs}
          fileName={fileName}
          leadingSeparator
          measurement
        />
      </ol>
    </nav>
  );
}

function DeviceFileBreadcrumbMenu({ breadcrumbs }: { breadcrumbs: FileBreadcrumb[] }) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  return (
    <li className="flex shrink-0 items-center">
      <span aria-hidden="true" className="mx-echo-sm">
        /
      </span>
      <ButtonBase
        aria-label="Приховані папки шляху"
        aria-haspopup="menu"
        aria-expanded={menuAnchor !== null}
        aria-controls={menuAnchor !== null ? menuId : undefined}
        onClick={(event) => setMenuAnchor(event.currentTarget)}
        className="rounded-echo-sm! px-echo-xs! focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-echo-focus"
      >
        …
      </ButtonBase>
      <Menu
        elevation={3}
        open={menuAnchor !== null}
        anchorEl={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        MenuListProps={{ id: menuId, 'aria-label': 'Приховані папки шляху' }}
      >
        {breadcrumbs.map((segment) => {
          const href = deviceFileLocationHref(
            null,
            null,
            segment.entryId,
            segment.archiveRevision ?? null,
          );
          return (
            <MenuItem
              key={segment.entryId}
              component="a"
              href={href}
              title={segment.name}
              className="whitespace-normal! [overflow-wrap:anywhere]"
              onClick={(event) => {
                setMenuAnchor(null);
                handleNavigateWithinSpaClick(event, href);
              }}
            >
              {segmentLabel(segment.name)}
            </MenuItem>
          );
        })}
      </Menu>
    </li>
  );
}
