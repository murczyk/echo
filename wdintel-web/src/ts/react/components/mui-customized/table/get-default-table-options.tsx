import { Theme } from '@mui/material';
import { TableRowProps } from '@mui/material/TableRow';
import { MRT_ColumnOrderState, MRT_Row, MRT_RowData, MRT_TableInstance, MRT_TableOptions } from 'material-react-table';
import { MRT_Localization_UK } from 'material-react-table/locales/uk';

import { CUSTOM_STYLES } from './custom-styles';
import { windowWidth } from '../../../utils/browser';

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
  internalColumnMenuItems: React.ReactNode[];
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
