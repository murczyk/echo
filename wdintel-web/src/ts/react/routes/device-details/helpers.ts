import type {
  DeviceDeletedFilter,
  DeviceDetails,
  DeviceFileEntry,
  ListDeviceFilesReq,
} from '../../../../Bindings';
import { formatDeviceDateTime } from '../devices/helpers';

export type DeviceFilesDeletedFilterValue = 'active' | 'deleted' | 'all';

export const DEVICE_FILES_PAGE_SIZE = 50;

export function mapDeviceDeletedFilter(value: DeviceFilesDeletedFilterValue): DeviceDeletedFilter {
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

export function formatAorLabel(id: number | null, name: string | null): string {
  if (name?.trim()) return name.trim();
  if (id !== null) return `AOR #${id} — назва недоступна`;
  return '—';
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

export function formatDeviceLifecycleLabel(deleted: boolean): string {
  return deleted ? 'Видалено' : 'Активний';
}

export function formatDeviceSummaryRows(device: DeviceDetails) {
  return [
    { label: 'Створив', value: device.createdBy },
    { label: 'Створено', value: formatDeviceDateTime(device.createdAtMs) },
    { label: 'Оновлено', value: formatDeviceDateTime(device.updatedAtMs) },
    ...(device.deleted
      ? [{ label: 'Видалено', value: formatDeviceDateTime(device.deletedAtMs) }]
      : []),
    { label: 'Район', value: formatAorLabel(device.aorId, device.aorName) },
    { label: 'Підрозділ', value: formatUnitLabel(device.unitId, device.unitName) },
  ];
}

export function fileDisplayName(file: DeviceFileEntry): string {
  return file.originalName?.trim() || file.originalAbsolutePath?.trim() || `Файл ${file.fileId}`;
}

export function hasActiveFileFilters(deletedFilter: DeviceFilesDeletedFilterValue): boolean {
  return deletedFilter !== 'active';
}
