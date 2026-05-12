import { Box } from '@mui/material';
import { CheckboxProps } from '@mui/material/Checkbox';
import { MenuItem } from '@mui/material';
import { Theme } from '@mui/material';
import { TextField } from '@mui/material';
import { TextFieldProps } from '@mui/material/TextField';
import { TableRowProps } from '@mui/material/TableRow';
import { MRT_Column, MRT_ColumnDef, MRT_ColumnOrderState, MRT_Row, MRT_RowData, MRT_TableInstance, MRT_TableOptions } from 'material-react-table';
import { MRT_Localization_UK } from 'material-react-table/locales/uk';
import type { MouseEvent, ReactNode } from 'react';
import { isNullOrUndefined } from '../../../utils/misc';


import { TableEmptyState } from '../../TableEmptyState';
import { CUSTOM_STYLES } from './custom-styles';
import { windowWidth } from '../../../utils/browser';

function onSharedSelectFilterMouseDown(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  if (target.closest('.MuiIconButton-root')) {
    return;
  }

  if (target.closest('.MuiSelect-select[role="combobox"]')) {
    return;
  }

  const selectDisplay = event.currentTarget.querySelector<HTMLElement>('.MuiSelect-select[role="combobox"]');
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
  noDataMessage?: string;
  noDataActionLabel?: string;
  onNoDataAction?: () => void;
  filteredMessage?: string;
  clearFiltersLabel?: string;
  onClearFilters?: () => void;
};

export function renderDefaultMrtEmptyRowsFallback<TData extends MRT_RowData>({
  table,
  noDataMessage = 'Немає даних',
  noDataActionLabel,
  onNoDataAction,
  filteredMessage = 'Нічого не знайдено',
  clearFiltersLabel = 'Очистити фільтри',
  onClearFilters,
}: MrtEmptyStateProps<TData>) {
  const hasFilters = Boolean(table.getState().globalFilter) || Boolean(table.getState().columnFilters?.length);
  const clearFilters = onClearFilters ?? (() => {
    table.setColumnFilters([]);
    table.setGlobalFilter('');
  });

  return (
    <Box sx={{ py: 6 }}>
      <TableEmptyState
        message={hasFilters ? filteredMessage : noDataMessage}
        actionLabel={hasFilters ? clearFiltersLabel : noDataActionLabel}
        onAction={hasFilters ? clearFilters : onNoDataAction}
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

  if (isNullOrUndefined(filterVariant) || filterVariant === 'text' || filterVariant === 'autocomplete') {
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
  helperText,
  onChange,
}: {
  options: readonly ExplicitSelectFilterOption[];
  fallbackValue: string;
  helperText?: string | null;
  onChange: (column: MRT_Column<TData>, nextValue: string) => void;
}): NonNullable<MRT_ColumnDef<TData>['Filter']> {
  const allowedValues = options.map((option) => option.value);

  return ({ column }) => (
    <TextField
      select
      fullWidth
      margin="none"
      variant="standard"
      helperText={helperText ?? undefined}
      value={resolveExplicitSelectFilterValue(column.getFilterValue(), allowedValues, fallbackValue)}
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

export const getDefaultMRTOptions = <TData extends MRT_RowData>(): Partial<MRT_TableOptions<TData>> => ({
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
  muiFilterTextFieldProps: ({ column }) => getSharedFilterTextFieldProps(column.columnDef.filterVariant),
  muiSelectAllCheckboxProps: getSharedSelectAllCheckboxProps,
  renderEmptyRowsFallback: ({ table }) => renderDefaultMrtEmptyRowsFallback({ table }),
  ...CUSTOM_STYLES,
});

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
  return (internalColumnMenuItems || []).filter((i) => !((i as any).props?.label || '').includes('Показати всі'));
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
  return (props: { row: MRT_Row<T>; staticRowIndex: number; table: MRT_TableInstance<T> }): TableRowProps => {
    if (props.table.getState().sorting?.length) return {};

    const prev = props.staticRowIndex > 0 ? props.table.getRowModel().rows[props.staticRowIndex - 1] : null;
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
