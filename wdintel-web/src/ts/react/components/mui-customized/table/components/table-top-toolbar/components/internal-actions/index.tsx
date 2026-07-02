import { MRT_RowData, MRT_TableInstance, MRT_ToggleFullScreenButton } from 'material-react-table';
import type { ReactNode } from 'react';

import { ActiveFiltersButton } from './components/active-filters-button';
import { ColumnsVisibilityButton } from './components/columns-visibility-button';
import { useTableStateContext } from '../../../../table-state-provider';
import type { ActiveFilterDescriptor } from './components/active-filters-utils';

type IntrernalTableActionsProps<T extends MRT_RowData> = {
  table?: MRT_TableInstance<T> | null;
  children?: ReactNode;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  columnsVisibilityDisabled?: boolean;
  filtersDisabled?: boolean;
  additionalActiveFilters?: ActiveFilterDescriptor[];
  onClearAdditionalActiveFilter?: (filterId: string) => void;
  onClearAdditionalActiveFilters?: () => void;
  colOrderDisabled?: boolean;
  rowNumberAppearanceControl?: boolean;
  fullScreenEnabled?: boolean;
  fullScreenDisabled?: boolean;
};

export function InternalTableActions<T extends MRT_RowData>(props: IntrernalTableActionsProps<T>) {
  const tableStateContext = useTableStateContext();
  const table = props.table ?? tableStateContext.tableInstance;
  const tableControlsDisabled = !table;

  return (
    <div className="flex items-center gap-1">
      {props.children}
      {!props.filtersHidden && (
        <ActiveFiltersButton
          table={table}
          columnFilters={tableStateContext.columnFilters}
          globalFilter={tableStateContext.globalFilter}
          additionalActiveFilters={props.additionalActiveFilters}
          onClearAdditionalActiveFilter={props.onClearAdditionalActiveFilter}
          onClearAdditionalActiveFilters={props.onClearAdditionalActiveFilters}
          disabled={props.filtersDisabled || tableControlsDisabled}
        />
      )}
      {props.fullScreenEnabled && table ? (
        <MRT_ToggleFullScreenButton table={table} disabled={props.fullScreenDisabled} />
      ) : null}
      <ColumnsVisibilityButton
        disabled={props.columnsVisibilityDisabled || tableControlsDisabled}
        rowNumberAppearanceControl={props.rowNumberAppearanceControl}
      />
    </div>
  );
}
