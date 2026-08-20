import { Box } from '@mui/material';
import { CheckboxProps } from '@mui/material/Checkbox';
import { MenuItem } from '@mui/material';
import { Theme } from '@mui/material';
import { TextField } from '@mui/material';
import { TextFieldProps } from '@mui/material/TextField';
import { TableRowProps } from '@mui/material/TableRow';
import {
  MRT_Column,
  MRT_ColumnDef,
  MRT_ColumnOrderState,
  MRT_Row,
  MRT_RowData,
  MRT_TableInstance,
  MRT_TableOptions,
} from 'material-react-table';
import { MRT_Localization_UK } from 'material-react-table/locales/uk';
import type { MouseEvent, ReactNode } from 'react';
import type { SxProps } from '@mui/material/styles';
import { isNullOrUndefined } from '../../../utils/misc';

import { TableEmptyState } from '../../TableEmptyState';
import { CUSTOM_STYLES } from './custom-styles';
import { windowWidth } from '../../../utils/browser';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../../routes/shared/empty-state-text';
import { useMaterialReactTable as useMaterialReactTableImpl } from 'material-react-table';
import { MrtOverflowItems, MrtOverflowText, type MrtOverflowMode } from './mrt-overflow';

function onSharedSelectFilterMouseDown(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  if (target.closest('.MuiIconButton-root')) {
    return;
  }

  if (target.closest('.MuiSelect-select[role="combobox"]')) {
    return;
  }

  const selectDisplay = event.currentTarget.querySelector<HTMLElement>(
    '.MuiSelect-select[role="combobox"]',
  );
  if (!selectDisplay) return;

  selectDisplay.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );
}

type ExplicitSelectFilterOption = {
  text: string;
  value: string;
};

export const EXPLICIT_SELECT_ALL_OPTION: ExplicitSelectFilterOption = {
  text: 'Усі',
  value: 'Усі',
};

export function withExplicitSelectAllOption(
  options: readonly ExplicitSelectFilterOption[],
): ExplicitSelectFilterOption[] {
  return [EXPLICIT_SELECT_ALL_OPTION, ...options];
}

type MrtEmptyStateProps<TData extends MRT_RowData> = {
  table: MRT_TableInstance<TData>;
  externalHasFilters?: boolean;
  hasFilters?: boolean;
  noDataMessage?: string;
  noDataActionLabel?: string;
  onNoDataAction?: () => void;
  filteredMessage?: string;
  clearFiltersLabel?: string;
  onClearFilters?: () => void;
};

export function renderDefaultMrtEmptyRowsFallback<TData extends MRT_RowData>({
  table,
  externalHasFilters,
  hasFilters,
  noDataMessage = 'Немає даних',
  noDataActionLabel,
  onNoDataAction,
  filteredMessage = EMPTY_STATE_NO_RESULTS_TEXT,
  clearFiltersLabel = 'Очистити фільтри',
  onClearFilters,
}: MrtEmptyStateProps<TData>) {
  const hasMrtFilters =
    Boolean(table.getState().globalFilter) || Boolean(table.getState().columnFilters?.length);
  const resolvedHasFilters = hasFilters ?? (hasMrtFilters || externalHasFilters || false);
  const clearFilters =
    onClearFilters ??
    (() => {
      table.setColumnFilters([]);
      table.setGlobalFilter('');
    });

  return (
    <Box sx={{ py: 6, minHeight: '100%', display: 'flex', flex: 1 }}>
      <TableEmptyState
        message={resolvedHasFilters ? filteredMessage : noDataMessage}
        actionLabel={resolvedHasFilters ? clearFiltersLabel : noDataActionLabel}
        onAction={resolvedHasFilters ? clearFilters : onNoDataAction}
      />
    </Box>
  );
}

export function getFilterModeHelperText(filterVariant?: string): string | null {
  if (filterVariant === 'multi-select') {
    return 'Режим фільтрації: Включає деякі';
  }

  if (filterVariant === 'select' || filterVariant === 'checkbox') {
    return 'Режим фільтрації: Дорівнює';
  }

  if (
    isNullOrUndefined(filterVariant) ||
    filterVariant === 'text' ||
    filterVariant === 'autocomplete'
  ) {
    return 'Режим фільтрації: Нечіткий';
  }

  return null;
}

export function resolveExplicitSelectFilterValue(
  value: unknown,
  allowedValues: readonly string[],
  fallbackValue: string,
): string {
  if (Array.isArray(value)) {
    return resolveExplicitSelectFilterValue(value[0], allowedValues, fallbackValue);
  }

  if (typeof value === 'string' && allowedValues.includes(value)) {
    return value;
  }

  return fallbackValue;
}

export function buildExplicitSingleSelectColumnFilter<TData extends MRT_RowData>({
  options,
  fallbackValue,
  label,
  helperText,
  getValue,
  onChange,
}: {
  options: readonly ExplicitSelectFilterOption[];
  fallbackValue: string;
  label?: string;
  helperText?: string | null;
  getValue?: (column: MRT_Column<TData>) => unknown;
  onChange: (column: MRT_Column<TData>, nextValue: string) => void;
}): NonNullable<MRT_ColumnDef<TData>['Filter']> {
  const allowedValues = options.map((option) => option.value);

  return ({ column }) => (
    <TextField
      select
      fullWidth
      margin="none"
      variant="standard"
      label={label}
      helperText={helperText ?? undefined}
      value={resolveExplicitSelectFilterValue(
        getValue?.(column) ?? column.getFilterValue(),
        allowedValues,
        fallbackValue,
      )}
      onChange={(event) => onChange(column, event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      slotProps={{
        inputLabel: { shrink: true },
        select: {
          displayEmpty: true,
          MenuProps: { disableScrollLock: true },
          SelectDisplayProps: {
            style: {
              cursor: 'pointer',
              width: '100%',
            },
          },
        },
      }}
      sx={{
        '& .MuiInputBase-root': {
          cursor: 'pointer',
        },
        '& .MuiSelect-select': {
          cursor: 'pointer',
          width: '100%',
        },
      }}
    >
      {options.map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.text}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function getSharedFilterTextFieldProps(filterVariant?: string): TextFieldProps {
  const sharedProps: TextFieldProps = {
    sx: {
      '& .MuiInput-root': {
        pb: 0.75,
      },
      '& .MuiFormHelperText-root': {
        mt: 1,
      },
    },
    slotProps: {
      formHelperText: {
        sx: {
          mt: 0.25,
        },
      },
    },
  };

  if (filterVariant === 'select' || filterVariant === 'multi-select') {
    return {
      ...sharedProps,
      sx: {
        ...sharedProps.sx,
        '& .MuiInputBase-root': {
          cursor: 'pointer',
        },
        '& .MuiInputAdornment-positionEnd': {
          cursor: 'pointer',
          pointerEvents: 'none',
        },
        '& .MuiInputAdornment-positionEnd .MuiIconButton-root': {
          pointerEvents: 'auto',
        },
        '& .MuiSelect-select': {
          cursor: 'pointer',
          width: '100%',
        },
      },
      slotProps: {
        ...sharedProps.slotProps,
        input: {
          onMouseDown: onSharedSelectFilterMouseDown,
        },
        select: {
          SelectDisplayProps: {
            style: {
              cursor: 'pointer',
              width: '100%',
            },
          },
        },
      },
    };
  }

  return {
    ...sharedProps,
    placeholder: isNullOrUndefined(filterVariant) || filterVariant === 'text' ? 'Пошук' : undefined,
  };
}

export function getSharedSelectAllCheckboxProps<TData extends MRT_RowData>({
  table,
}: {
  table: MRT_TableInstance<TData>;
}): CheckboxProps {
  const hasSelectableRows = table.getRowModel().rows.some((row) => row.getCanSelect());

  return {
    disabled: !hasSelectableRows,
  };
}

export const getDefaultMRTOptions = <TData extends MRT_RowData>(): Partial<
  MRT_TableOptions<TData>
> => ({
  layoutMode: 'grid',
  enableStickyHeader: true,
  enableSorting: false,
  enablePagination: false,
  enableTableFooter: false,
  enableTopToolbar: false,
  enableBottomToolbar: false,
  enableRowVirtualization: true,
  getRowId: (row) => row.id,
  localization: MRT_Localization_UK,
  positionToolbarAlertBanner: 'bottom',
  muiFilterTextFieldProps: ({ column }) =>
    getSharedFilterTextFieldProps(column.columnDef.filterVariant),
  muiSelectAllCheckboxProps: getSharedSelectAllCheckboxProps,
  renderEmptyRowsFallback: ({ table }) => renderDefaultMrtEmptyRowsFallback({ table }),
  ...CUSTOM_STYLES,
});

export type MrtColumnMeta = {
  overflowMode?: MrtOverflowMode;
  overflowOwner?: 'shared-text' | 'domain-hover' | 'structured-layout';
  interactive?: boolean;
  [key: string]: unknown;
};

/**
 * The application column shape deliberately owns the recursive `columns`
 * property.  Keeping it separate from MRT's type makes policy checks apply to
 * grouped columns too, rather than only to the table's top level.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;

type AppMrtColumnBase<TData extends MRT_RowData> = DistributiveOmit<
  MRT_ColumnDef<TData>,
  'Cell' | 'columns' | 'meta'
> & {
  columns?: AppMrtColumnDef<TData>[];
};

export type AppMrtTableOptions<TData extends MRT_RowData> = Omit<
  MRT_TableOptions<TData>,
  'columns'
> & {
  columns: AppMrtColumnDef<TData>[];
};

const MRT_TEXT_CELL = Symbol('mrtTextCell');
const MRT_ITEMS_CELL = Symbol('mrtItemsCell');
const MRT_CUSTOM_CELL = Symbol('mrtCustomCell');
const MRT_CUSTOM_OWNERS = new Set(['shared-text', 'domain-hover', 'structured-layout']);
export type MrtTextCellRenderer<TData extends MRT_RowData> = NonNullable<
  MRT_ColumnDef<TData>['Cell']
> & {
  [MRT_TEXT_CELL]: true;
};
export type MrtItemsCellRenderer<TData extends MRT_RowData> = NonNullable<
  MRT_ColumnDef<TData>['Cell']
> & { [MRT_ITEMS_CELL]: true };
export type MrtCustomCellRenderer<TData extends MRT_RowData> = NonNullable<
  MRT_ColumnDef<TData>['Cell']
> & { [MRT_CUSTOM_CELL]: true };

export type AppMrtColumnDef<TData extends MRT_RowData> =
  | (AppMrtColumnBase<TData> & { Cell?: never; meta?: MrtColumnMeta })
  | (AppMrtColumnBase<TData> & {
      Cell: MrtTextCellRenderer<TData>;
      meta: MrtColumnMeta & { overflowMode: 'text' };
    })
  | (AppMrtColumnBase<TData> & {
      Cell: MrtItemsCellRenderer<TData>;
      meta: MrtColumnMeta & { overflowMode: 'items' };
    })
  | (AppMrtColumnBase<TData> & {
      Cell: MrtCustomCellRenderer<TData>;
      meta: MrtColumnMeta & {
        overflowMode: 'custom';
        overflowOwner: 'shared-text' | 'domain-hover' | 'structured-layout';
      };
    })
  | (AppMrtColumnBase<TData> & {
      Cell: NonNullable<MRT_ColumnDef<TData>['Cell']>;
      meta: MrtColumnMeta & { overflowMode: 'wrap' | 'none' };
    });

export function mrtTextCell<TData extends MRT_RowData>({
  displayValue,
  fullValue = (props) => toMrtScalarText(props.cell.getValue()),
  displaySx,
  interactive = false,
}: {
  displayValue: (props: any) => string | number;
  fullValue?: (props: any) => string | null | undefined;
  displaySx?: SxProps<Theme>;
  interactive?: boolean;
}): MrtTextCellRenderer<TData> {
  const renderer = ((props) => (
    <MrtOverflowText
      displayValue={displayValue(props)}
      fullValue={fullValue(props)}
      interactive={interactive}
      sx={displaySx}
    />
  )) as MrtTextCellRenderer<TData>;
  renderer[MRT_TEXT_CELL] = true;
  return renderer;
}

export function mrtCustomCell<TData extends MRT_RowData>(
  renderer: NonNullable<MRT_ColumnDef<TData>['Cell']>,
): MrtCustomCellRenderer<TData> {
  const branded = renderer as MrtCustomCellRenderer<TData>;
  branded[MRT_CUSTOM_CELL] = true;
  return branded;
}

export function mrtItemsCell<TData extends MRT_RowData, TItem>({
  items,
  renderItem,
  renderCompactItem,
  renderMeasurementItem,
  getItemKey,
  getItemText,
  getItemMeasurementKey,
  emptyValue,
  containerProps,
}: {
  items: (props: any) => readonly TItem[];
  renderItem: (item: TItem, index: number) => ReactNode;
  renderCompactItem?: (item: TItem, index: number) => ReactNode;
  renderMeasurementItem?: (item: TItem, index: number) => ReactNode;
  getItemKey?: (item: TItem, index: number) => string | number;
  getItemText?: (item: TItem, index: number) => string;
  getItemMeasurementKey?: (item: TItem, index: number) => string | number;
  emptyValue?: ReactNode;
  containerProps?: (props: any) => Record<string, unknown>;
}): MrtItemsCellRenderer<TData> {
  const renderer = ((props) => (
    <MrtOverflowItems
      items={items(props)}
      renderItem={renderItem}
      renderCompactItem={renderCompactItem}
      renderMeasurementItem={renderMeasurementItem}
      getItemKey={getItemKey}
      getItemText={getItemText}
      getItemMeasurementKey={getItemMeasurementKey}
      emptyValue={emptyValue}
      containerProps={containerProps?.(props)}
    />
  )) as MrtItemsCellRenderer<TData>;
  renderer[MRT_ITEMS_CELL] = true;
  return renderer;
}

function mergeMrtProps(base: unknown, local: unknown): unknown {
  if (typeof base !== 'object' || base === null || typeof local !== 'object' || local === null) {
    return local ?? base;
  }

  const baseProps = base as Record<string, unknown>;
  const localProps = local as Record<string, unknown>;
  return {
    ...baseProps,
    ...localProps,
    ...(baseProps.sx || localProps.sx
      ? { sx: { ...(baseProps.sx as object), ...(localProps.sx as object) } }
      : {}),
  };
}

function mergeDefaultColumn(base: unknown, local: unknown) {
  return mergeMrtProps(base, local);
}

function mergeDisplayColumnDefOptions(
  base: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
) {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [columnId, localColumn] of Object.entries(local ?? {})) {
    const baseColumn = merged[columnId] as Record<string, unknown> | undefined;
    merged[columnId] = {
      ...(baseColumn ?? {}),
      ...(localColumn as Record<string, unknown>),
      ...(baseColumn?.muiTableHeadCellProps || (localColumn as any).muiTableHeadCellProps
        ? {
            muiTableHeadCellProps: mergeMrtProps(
              baseColumn?.muiTableHeadCellProps,
              (localColumn as any).muiTableHeadCellProps,
            ),
          }
        : {}),
      ...(baseColumn?.muiTableBodyCellProps || (localColumn as any).muiTableBodyCellProps
        ? {
            muiTableBodyCellProps: mergeMrtProps(
              baseColumn?.muiTableBodyCellProps,
              (localColumn as any).muiTableBodyCellProps,
            ),
          }
        : {}),
    };
  }
  return merged;
}

function mergeMrtOptions<TData extends MRT_RowData>(
  shared: Partial<MRT_TableOptions<TData>>,
  local: MRT_TableOptions<TData>,
): MRT_TableOptions<TData> {
  return {
    ...shared,
    ...local,
    defaultColumn: mergeDefaultColumn(
      shared.defaultColumn,
      local.defaultColumn,
    ) as MRT_TableOptions<TData>['defaultColumn'],
    muiTableBodyCellProps: mergeMrtProps(
      shared.muiTableBodyCellProps,
      local.muiTableBodyCellProps,
    ) as MRT_TableOptions<TData>['muiTableBodyCellProps'],
    muiTableHeadCellProps: mergeMrtProps(
      shared.muiTableHeadCellProps,
      local.muiTableHeadCellProps,
    ) as MRT_TableOptions<TData>['muiTableHeadCellProps'],
    displayColumnDefOptions: mergeDisplayColumnDefOptions(
      shared.displayColumnDefOptions as Record<string, unknown> | undefined,
      local.displayColumnDefOptions as Record<string, unknown> | undefined,
    ),
  };
}

export function toMrtScalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function columnOverflowMode<TData extends MRT_RowData>(
  column: MRT_ColumnDef<TData>,
): MrtOverflowMode {
  return (column.meta as MrtColumnMeta | undefined)?.overflowMode ?? 'text';
}

export function validateMrtColumnPolicies<TData extends MRT_RowData>(
  columns: AppMrtColumnDef<TData>[],
  parentPath = '',
): string[] {
  return columns.flatMap((column, index) => {
    const ownId = column.id ?? String(column.accessorKey ?? `children[${index}]`);
    const columnId = parentPath ? `${parentPath}.${ownId}` : ownId;
    const mode = (column.meta as MrtColumnMeta | undefined)?.overflowMode;
    const ownViolation = column.Cell && !mode ? [columnId] : [];
    const unwrappedTextViolation =
      column.Cell && mode === 'text' && !(column.Cell as MrtTextCellRenderer<TData>)[MRT_TEXT_CELL]
        ? [`${columnId} (text Cell must use mrtTextCell)`]
        : [];
    const unwrappedItemsViolation =
      column.Cell &&
      mode === 'items' &&
      !(column.Cell as MrtItemsCellRenderer<TData>)[MRT_ITEMS_CELL]
        ? [`${columnId} (items Cell must use mrtItemsCell)`]
        : [];
    const unwrappedCustomViolation =
      column.Cell &&
      mode === 'custom' &&
      !(column.Cell as MrtCustomCellRenderer<TData>)[MRT_CUSTOM_CELL]
        ? [`${columnId} (custom Cell must use mrtCustomCell)`]
        : [];
    const customOwner = (column.meta as MrtColumnMeta | undefined)?.overflowOwner;
    const invalidCustomOwnerViolation =
      column.Cell && mode === 'custom' && !MRT_CUSTOM_OWNERS.has(customOwner ?? '')
        ? [`${columnId} (custom Cell must declare a valid overflowOwner)`]
        : [];
    const nestedViolations = column.columns
      ? validateMrtColumnPolicies(column.columns, columnId)
      : [];
    return [
      ...ownViolation,
      ...unwrappedTextViolation,
      ...unwrappedItemsViolation,
      ...unwrappedCustomViolation,
      ...invalidCustomOwnerViolation,
      ...nestedViolations,
    ];
  });
}

export function assertMrtColumnPolicies<TData extends MRT_RowData>(
  columns: AppMrtColumnDef<TData>[],
) {
  const violations = validateMrtColumnPolicies(columns);
  if (violations.length > 0) {
    throw new Error(`MRT custom cells require an overflow policy: ${violations.join(', ')}`);
  }
}

function addScalarOverflow<TData extends MRT_RowData>(
  columns: MRT_ColumnDef<TData>[],
): MRT_ColumnDef<TData>[] {
  return columns.map((column) => {
    const nextColumn = column.columns
      ? { ...column, columns: addScalarOverflow(column.columns as MRT_ColumnDef<TData>[]) }
      : { ...column };
    if (column.Cell || columnOverflowMode(column) !== 'text') return nextColumn;

    if (column.accessorKey === undefined && !column.accessorFn) return nextColumn;
    nextColumn.Cell = ({ cell }) => {
      const fullValue = toMrtScalarText(cell.getValue<unknown>());
      return (
        <MrtOverflowText displayValue={fullValue?.trim() ? fullValue : '—'} fullValue={fullValue} />
      );
    };
    return nextColumn;
  });
}

export function useAppMaterialReactTable<TData extends MRT_RowData>(
  options: AppMrtTableOptions<TData>,
) {
  assertMrtColumnPolicies(options.columns);
  const mergedOptions = mergeMrtOptions(getDefaultMRTOptions<TData>(), options);
  return useMaterialReactTableImpl({
    ...mergedOptions,
    columns: addScalarOverflow(mergedOptions.columns as MRT_ColumnDef<TData>[]),
  });
}

export function buildDefaultColumnOrder({
  dataColumnIds,
  withRowSelection = false,
  withRowActions = false,
  withRowNumbers = false,
}: {
  dataColumnIds: string[];
  withRowSelection?: boolean;
  withRowActions?: boolean;
  withRowNumbers?: boolean;
}): MRT_ColumnOrderState {
  const leading: string[] = [];

  if (withRowSelection) {
    leading.push('mrt-row-select');
  }
  if (withRowNumbers) {
    leading.push('mrt-row-numbers');
  }
  if (withRowActions) {
    leading.push('mrt-row-actions');
  }

  return [...leading, ...dataColumnIds];
}

export function renderColumnActionsMenuItems({
  internalColumnMenuItems,
}: {
  internalColumnMenuItems: ReactNode[];
}) {
  return (internalColumnMenuItems || []).filter(
    (i) => !((i as any).props?.label || '').includes('Показати всі'),
  );
}

type UnitSeparatorStyles = {
  lineBorder: string;
  unitSeparatorColor: string;
  unitSeparatorBorder: string;
  unitSeparatorBackgroundColor: string;
};

export function unitSeparatorStyles(isDarkMode: boolean, theme: Theme): UnitSeparatorStyles {
  return {
    lineBorder: `1.5px solid ${theme.palette.text.primary}`,
    unitSeparatorColor: theme.palette.text.primary,
    unitSeparatorBorder: `1.5px solid ${theme.palette.text.primary}`,
    unitSeparatorBackgroundColor: isDarkMode ? '#444' : '#e1e1e1',
  };
}

const DEFAULT_TABLE_WIDTH = windowWidth() - 40; // screen width minus page padding (can be calculated better)
/**
 * Draws a separator when the next visible row has a different battle_unit_id.
 * Skip separators when user has active sorting (keeps grouping meaningful).
 * @param getUnitId
 * @param isDarkColorMode
 */
export function addUnitSeparatorStyles<T extends Record<string, any>>({
  showUnitSeparator,
  getUnitId,
  getUnitName,
  lineBorder,
  unitSeparatorColor,
  unitSeparatorBorder,
  unitSeparatorBackgroundColor,
}: {
  showUnitSeparator: boolean;
  getUnitId: (row: T) => string | undefined;
  getUnitName: (row: T) => string | undefined;
} & UnitSeparatorStyles) {
  return (props: {
    row: MRT_Row<T>;
    staticRowIndex: number;
    table: MRT_TableInstance<T>;
  }): TableRowProps => {
    if (props.table.getState().sorting?.length) return {};

    const prev =
      props.staticRowIndex > 0 ? props.table.getRowModel().rows[props.staticRowIndex - 1] : null;
    const differentUnit = prev && getUnitId(props.row.original) !== getUnitId(prev.original);

    // якщо ввімкнено "showUnitSeparator" - показуємо назву підрозділу у випадку якщо це перший рядок
    // або попередній рядок - інший підрозділ
    if (showUnitSeparator) {
      if (!prev || differentUnit) {
        const unitName = getUnitName(props.row.original);

        if (unitName) {
          return {
            sx: {
              paddingTop: '28px',
              '&:before': {
                content: `"${unitName}"`,
                display: 'block',
                height: '28px',
                lineHeight: '28px',
                fontSize: '14px',
                fontWeight: '600',
                borderTop: unitSeparatorBorder,
                borderBottom: unitSeparatorBorder,
                position: 'absolute',
                top: 0,
                left: 0,
                paddingLeft: `${DEFAULT_TABLE_WIDTH / 2 - unitName.length * 3}px`,
                width: '100%',
                color: unitSeparatorColor,
                backgroundColor: unitSeparatorBackgroundColor,
              },
            },
          };
        }
      }
    } else {
      // якщо не ввімкнено "showUnitSeparator" - показуємо просто лінію розділення між різними підрозділами
      if (differentUnit) {
        return {
          sx: {
            borderTop: lineBorder,
          },
        };
      }
    }

    return {};
  };
}
