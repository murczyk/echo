import { MRT_RowData, MRT_TableInstance, MRT_ToggleFullScreenButton } from 'material-react-table';
import React from 'react';

import { ClearFiltersButton } from './components/clear-filters-button';
import { ColumnsVisibilityButton } from './components/columns-visibility-button';
import { DensityToggleButton } from './components/density-toggle-button';
import { useTableStateContext } from '../../../../table-state-provider';

type IntrernalTableActionsProps<T extends MRT_RowData> = {
  table?: MRT_TableInstance<T> | null;
  children?: React.ReactNode;
  densityDisabled?: boolean;
  densityHidden?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  columnsVisibilityDisabled?: boolean;
  filtersDisabled?: boolean;
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
      {!props.filtersHidden && <ClearFiltersButton disabled={props.filtersDisabled} />}
      {props.fullScreenEnabled && table ? <MRT_ToggleFullScreenButton table={table} disabled={props.fullScreenDisabled} /> : null}
      <ColumnsVisibilityButton
        disabled={props.columnsVisibilityDisabled || tableControlsDisabled}
        rowNumberAppearanceControl={props.rowNumberAppearanceControl}
      />
      {!props.densityHidden && <DensityToggleButton disabled={props.densityDisabled || tableControlsDisabled} />}
    </div>
  );
}
