import type {
  DeviceFileDeletedFilter,
  DeviceDetails,
  DeviceFileEntry,
  ListDeviceFilesReq,
} from '../../../../Bindings';
import { formatAorsLabel, formatDeviceDateTime } from '../devices/helpers';

export type DeviceFilesDeletedFilterValue = 'active' | 'deleted' | 'all';

export const DEVICE_FILES_PAGE_SIZE = 50;

export function mapDeviceDeletedFilter(
  value: DeviceFilesDeletedFilterValue,
): DeviceFileDeletedFilter {
  switch (value) {
    case 'deleted':
      return 'deleted_only';
    case 'all':
      return 'all';
    case 'active':
      return 'active_only';
  }
}

export function buildDeviceFilesListReq(params: {
  deviceId: string;
  deletedFilter: DeviceFilesDeletedFilterValue;
  limit: number | null;
  offset: number | null;
}): ListDeviceFilesReq {
  return {
    deviceId: params.deviceId,
    deletedFilter: mapDeviceDeletedFilter(params.deletedFilter),
    limit: params.limit,
    offset: params.offset,
  };
}

export function formatUnitLabel(id: number | null, name: string | null): string {
  if (name?.trim()) return name.trim();
  if (id !== null) return `Підрозділ #${id} — назва недоступна`;
  return '—';
}

export function formatOptionalText(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  return text === '' ? '—' : text;
}

export function formatDeviceLifecycleLabel(archived: boolean): string {
  return archived ? 'Архівний' : 'Активний';
}

export function formatDeviceSummaryRows(device: DeviceDetails) {
  return [
    { label: 'Створив', value: device.createdBy },
    { label: 'Створено', value: formatDeviceDateTime(device.createdAtMs) },
    { label: 'Оновлено', value: formatDeviceDateTime(device.updatedAtMs) },
    ...(device.archived
      ? [{ label: 'Архівовано', value: formatDeviceDateTime(device.archivedAtMs) }]
      : []),
    { label: 'Смуги', value: formatAorsLabel(device.aorIds, device.aorNames) },
    { label: 'Підрозділ', value: formatUnitLabel(device.unitId, device.unitName) },
  ];
}

export function fileDisplayName(file: DeviceFileEntry): string {
  return file.originalName?.trim() || file.originalAbsolutePath?.trim() || `Файл ${file.fileId}`;
}

export function hasActiveFileFilters(deletedFilter: DeviceFilesDeletedFilterValue): boolean {
  return deletedFilter !== 'active';
}
