import type { DeviceDetails } from '../../../../Bindings';
import { formatAorsLabel, formatDeviceDateTime } from '../devices/helpers';

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
