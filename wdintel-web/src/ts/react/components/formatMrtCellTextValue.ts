import { NO_DATA_LABEL } from '../utils/misc';

export function formatMrtCellTextValue(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? NO_DATA_LABEL : normalized;
}
