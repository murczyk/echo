import type { MRT_RowData, MRT_TableInstance } from 'material-react-table';
import type { MRT_ColumnFiltersState } from 'material-react-table';

export type ActiveFilterDescriptor = {
  id: string;
  label: string;
  value: unknown;
  valuePreview: string;
  isGlobalFilter: boolean;
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatPreviewItem(value: unknown): string {
  if ((value === null || value === undefined) || value === '') {
    return 'Порожньо';
  }

  if (typeof value === 'string') {
    return truncateText(value, 40);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toLocaleDateString('uk-UA');
  }

  if (Array.isArray(value)) {
    return formatFilterValuePreview(value);
  }

  return 'Складене значення';
}

export function formatFilterValuePreview(value: unknown): string {
  if ((value === null || value === undefined) || value === '') {
    return 'Порожньо';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'Порожньо';
    }

    const previewItems = value.slice(0, 3).map(formatPreviewItem);
    const suffix = value.length > 3 ? ` +${value.length - 3}` : '';
    return `${previewItems.join(', ')}${suffix}`;
  }

  return formatPreviewItem(value);
}

export function resolveFilterLabel<TData extends MRT_RowData>(
  table: MRT_TableInstance<TData>,
  filterId: string,
): string {
  const column = table.getColumn(filterId);
  const header = column?.columnDef.header;

  if (typeof header === 'string' || typeof header === 'number') {
    return String(header);
  }

  return filterId;
}

export function getActiveTableFilters<TData extends MRT_RowData>(
  table: MRT_TableInstance<TData> | null | undefined,
  columnFilters: MRT_ColumnFiltersState,
  globalFilter: unknown,
): ActiveFilterDescriptor[] {
  if (!table) {
    const activeFilters = columnFilters.map((filter) => ({
      id: filter.id,
      label: filter.id,
      value: filter.value,
      valuePreview: formatFilterValuePreview(filter.value),
      isGlobalFilter: false,
    }));

    const hasGlobalFilter =
      typeof globalFilter === 'string' ? globalFilter.trim() !== '' : (globalFilter !== null && globalFilter !== undefined) && globalFilter !== '';

    if (hasGlobalFilter) {
      activeFilters.push({
        id: '__global_filter__',
        label: 'Глобальний пошук',
        value: globalFilter,
        valuePreview: formatFilterValuePreview(globalFilter),
        isGlobalFilter: true,
      });
    }

    return activeFilters;
  }

  const activeFilters = columnFilters.map((filter) => ({
    id: filter.id,
    label: resolveFilterLabel(table, filter.id),
    value: filter.value,
    valuePreview: formatFilterValuePreview(filter.value),
    isGlobalFilter: false,
  }));

  const hasGlobalFilter =
    typeof globalFilter === 'string' ? globalFilter.trim() !== '' : (globalFilter !== null && globalFilter !== undefined) && globalFilter !== '';

  if (hasGlobalFilter) {
    activeFilters.push({
      id: '__global_filter__',
      label: 'Глобальний пошук',
      value: globalFilter,
      valuePreview: formatFilterValuePreview(globalFilter),
      isGlobalFilter: true,
    });
  }

  return activeFilters;
}
