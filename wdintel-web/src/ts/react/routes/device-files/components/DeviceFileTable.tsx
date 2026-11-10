import { ButtonBase, TableSortLabel } from '@mui/material';
import { memo, type ComponentProps } from 'react';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { formatDeviceFileSize } from '../helpers';
import { isDeviceFolder } from '../device-file-archive';
import { attachmentTypeLabel } from '../../../components/attachment-files';
import { normalizeFilePreviewMetadata } from '../../shared/message-card/attachment-preview/file-preview-source';
import { formatDeviceDateTime } from '../../devices/helpers';
import type { DeviceFileCards } from './DeviceFileCards';
import { FileFavoriteButton, FileViewedButton } from './DeviceFileEntryControls';
import { DeviceFileTagSummary } from './DeviceFileTagSummary';
import { DeviceFileIcon } from './DeviceFileIcon';
import { DeviceFileTableSkeletons } from './DeviceFileLoadingSkeletons';

import { DEVICE_FILE_TABLE_COLUMNS } from '../device-file-table-config';
import { useDeviceFileColumnWidths } from '../use-device-file-column-widths';

function fileType(entry: DeviceFileTreeEntry) {
  if (entry.kind === 'directory') return 'Папка';
  if (entry.isArchive) return 'Архіви';
  const metadata = normalizeFilePreviewMetadata({
    fileName: entry.name,
    extension: entry.extension,
    contentType: entry.mimeType,
  });
  return attachmentTypeLabel(
    metadata.extension ? `file.${metadata.extension}` : metadata.fileName,
    metadata.contentType,
  );
}

export function DeviceFileTable({
  entries,
  onOpen,
  onFavorite,
  favoritePending,
  onViewed,
  viewedPending,
  showPath = false,
  sorting,
  onSort,
  footer,
  loadingMore,
}: Omit<ComponentProps<typeof DeviceFileCards>, 'viewMode' | 'deviceId'>) {
  const { tableRef, widths, resizing, resizeHandleProps } = useDeviceFileColumnWidths();
  return (
    <div
      data-device-file-scroll-viewport
      className="-mr-[var(--device-files-scroll-gutter,0px)] min-h-0 min-w-0 flex-1 overflow-auto pr-[var(--device-files-scroll-gutter,0px)]"
    >
      <table
        ref={tableRef}
        aria-label="Файли та папки"
        style={
          widths
            ? { width: `${Object.values(widths).reduce((sum, width) => sum + width, 0)}rem` }
            : undefined
        }
        className={`table-fixed border-separate border-spacing-0 text-[length:var(--echo-typography-font-size-base)] ${widths ? '' : 'w-full min-w-[98rem]'} ${resizing ? 'select-none [&_*]:cursor-col-resize' : ''}`}
      >
        <colgroup>
          {DEVICE_FILE_TABLE_COLUMNS.map((column) => (
            <col
              key={column.id}
              style={{
                width: widths
                  ? `${widths[column.id]}rem`
                  : column.id === 'name'
                    ? undefined
                    : `${column.width}rem`,
              }}
            />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-echo-background">
          <tr className="text-echo-text-muted">
            {DEVICE_FILE_TABLE_COLUMNS.map((column) => {
              const { id, label } = column;
              const sortBy = 'sortBy' in column ? column.sortBy : undefined;
              return (
                <th
                  key={label}
                  scope="col"
                  aria-label={label}
                  aria-sort={sorting && sorting.by === sortBy ? sorting.direction : undefined}
                  className={`relative whitespace-nowrap border-b border-echo-border px-echo-sm py-echo-sm font-bold ${label === 'Розмір' ? 'text-right' : label === 'Перегляд' || label === 'Обране' ? 'text-center' : 'text-left'}`}
                >
                  {sortBy && sorting && onSort ? (
                    <TableSortLabel
                      component="button"
                      type="button"
                      active={sorting.by === sortBy}
                      direction={
                        sorting.by === sortBy && sorting.direction === 'descending' ? 'desc' : 'asc'
                      }
                      onClick={() => onSort(sortBy)}
                      className="rounded-echo-sm! max-w-full! min-w-0! text-[length:var(--echo-typography-font-size-base)]! font-bold! focus-visible:outline focus-visible:outline-echo-focus"
                    >
                      <span className="truncate" title={label}>
                        {label}
                      </span>
                    </TableSortLabel>
                  ) : (
                    <span className="block truncate" title={label}>
                      {label}
                    </span>
                  )}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Змінити ширину колонки «${label}»`}
                    tabIndex={0}
                    title="Перетягніть для зміни ширини. Подвійне натискання — стандартна ширина."
                    {...resizeHandleProps(id)}
                    className="group absolute inset-y-0 right-0 z-10 flex w-echo-sm touch-none cursor-col-resize select-none items-center justify-center outline-none hover:bg-echo-primary/10 focus-visible:bg-echo-primary/10 active:bg-echo-primary/15"
                  >
                    <span
                      aria-hidden
                      className="h-2/3 w-px bg-echo-border group-hover:bg-echo-primary group-focus-visible:bg-echo-primary"
                    />
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <DeviceFileTableRow
              key={entry.entryId}
              entry={entry}
              onOpen={onOpen}
              onFavorite={onFavorite}
              favoritePending={favoritePending}
              onViewed={onViewed}
              viewedPending={viewedPending}
              showPath={showPath}
            />
          ))}
        </tbody>
        {(footer || loadingMore) && (
          <tfoot>
            {loadingMore && <DeviceFileTableSkeletons columns={DEVICE_FILE_TABLE_COLUMNS.length} />}
            {footer && (
              <tr>
                <td colSpan={DEVICE_FILE_TABLE_COLUMNS.length} className="p-0">
                  {footer}
                </td>
              </tr>
            )}
          </tfoot>
        )}
      </table>
    </div>
  );
}

const DeviceFileTableRow = memo(function DeviceFileTableRow({
  entry,
  onOpen,
  onFavorite,
  favoritePending,
  onViewed,
  viewedPending,
  showPath,
}: Omit<
  ComponentProps<typeof DeviceFileTable>,
  'entries' | 'sorting' | 'onSort' | 'footer' | 'loadingMore'
> & {
  entry: DeviceFileTreeEntry;
}) {
  const directory = isDeviceFolder(entry);
  const type = fileType(entry);
  const path = entry.absolutePath ?? entry.pathComponents.join(' / ');
  return (
    <tr
      data-entry-id={entry.entryId}
      className={`even:bg-echo-surface/50 hover:bg-echo-primary/10 ${directory || entry.hasContent ? '' : 'opacity-55'}`}
    >
      <td className="rounded-l-echo-md">
        <div className="flex min-w-0 items-center gap-echo-xs pr-echo-sm">
          <ButtonBase
            onClick={() => onOpen(entry)}
            aria-label={`Відкрити ${directory ? 'папку' : 'файл'} ${entry.name}`}
            aria-description={directory || entry.hasContent ? undefined : 'Контент файлу відсутній'}
            className="min-h-echo-control-md! min-w-0! flex-1! justify-start! gap-echo-sm! rounded-echo-sm! px-echo-sm! py-echo-xs! text-left! max-echo-lg:min-h-echo-control-lg! focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-echo-focus"
          >
            <DeviceFileIcon entry={entry} className="size-echo-icon-md! shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={entry.name}>
                {entry.name}
              </span>
              {showPath && (
                <span className="block truncate text-echo-xs text-echo-text-muted" title={path}>
                  {path}
                </span>
              )}
            </span>
          </ButtonBase>
        </div>
      </td>
      <td className="px-echo-sm text-center">
        {directory ? (
          <span className="text-echo-text-muted">—</span>
        ) : (
          <span className="inline-flex align-middle">
            <FileViewedButton
              entry={entry}
              onViewed={onViewed}
              pending={viewedPending?.has(`${entry.fileId}/${entry.revision}`)}
            />
          </span>
        )}
      </td>
      <td className="px-echo-sm text-center">
        <FileFavoriteButton
          entry={entry}
          onFavorite={onFavorite}
          pending={favoritePending?.has(entry.entryId)}
          className="shrink-0!"
        />
      </td>
      <td
        className="truncate px-echo-sm tabular-nums text-echo-text-muted"
        title={formatDeviceDateTime(entry.contentUploadedAt)}
      >
        {formatDeviceDateTime(entry.contentUploadedAt)}
      </td>
      <td
        className="truncate px-echo-sm tabular-nums text-echo-text-muted"
        title={formatDeviceDateTime(entry.fileMetadataCreatedAt)}
      >
        {formatDeviceDateTime(entry.fileMetadataCreatedAt)}
      </td>
      <td
        className="truncate px-echo-sm tabular-nums text-echo-text-muted"
        title={formatDeviceDateTime(entry.fileMetadataModifiedAt)}
      >
        {formatDeviceDateTime(entry.fileMetadataModifiedAt)}
      </td>
      <td
        className="truncate px-echo-sm text-right tabular-nums text-echo-text-muted"
        title={formatDeviceFileSize(entry.sizeBytes)}
      >
        {formatDeviceFileSize(entry.sizeBytes)}
      </td>
      <td className="truncate px-echo-sm text-echo-text-muted" title={type}>
        {type}
      </td>
      <td className="rounded-r-echo-md px-echo-sm py-echo-xs">
        {entry.tags.length ? (
          <DeviceFileTagSummary tags={entry.tags} />
        ) : (
          <span className="text-echo-text-muted">—</span>
        )}
      </td>
    </tr>
  );
});
