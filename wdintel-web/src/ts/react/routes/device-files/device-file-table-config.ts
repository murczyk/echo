import type { DeviceFileSortBy } from '../../../../Bindings';

export const DEVICE_FILE_TABLE_COLUMNS = [
  { id: 'name', label: 'Назва', sortBy: 'name', width: 16, minWidth: 10 },
  { id: 'viewed', label: 'Перегляд', width: 7, minWidth: 5 },
  { id: 'favorite', label: 'Обране', width: 6, minWidth: 4 },
  { id: 'uploaded', label: 'Дата завантаження', sortBy: 'uploaded_at', width: 13, minWidth: 6 },
  { id: 'created', label: 'Дата створення', sortBy: 'created_at', width: 13, minWidth: 6 },
  { id: 'modified', label: 'Дата зміни', sortBy: 'modified_at', width: 13, minWidth: 6 },
  { id: 'size', label: 'Розмір', sortBy: 'size', width: 6, minWidth: 4 },
  { id: 'type', label: 'Тип', width: 8, minWidth: 5 },
  { id: 'tags', label: 'Теги', width: 16, minWidth: 6 },
] as const satisfies readonly {
  id: string;
  label: string;
  sortBy?: DeviceFileSortBy;
  width: number;
  minWidth: number;
}[];

export type DeviceFileTableColumnId = (typeof DEVICE_FILE_TABLE_COLUMNS)[number]['id'];
export type DeviceFileTableColumnWidths = Record<DeviceFileTableColumnId, number>;

export const DEVICE_FILE_TABLE_WIDTHS_STORAGE_KEY = 'echo.device-files.column-widths.v1';
export const DEVICE_FILE_TABLE_COLUMN_MAX_WIDTH_REM = 256;
export const DEVICE_FILE_TABLE_COLUMN_KEYBOARD_STEP_PX = 10;

export const DEVICE_FILE_TABLE_VISIBLE_TAGS_LIMIT = 3;
