import { MRT_RowData, MRT_TableInstance } from 'material-react-table';
import React from 'react';

import { ClearFiltersButton } from './components/clear-filters-button';
import { ColumnsVisibilityButton } from './components/columns-visibility-button';
import { DensityToggleButton } from './components/density-toggle-button';

type IntrernalTableActionsProps<T extends MRT_RowData> = {
  table: MRT_TableInstance<T>;
  children?: React.ReactNode;
  densityDisabled?: boolean;
  densityHidden?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  columnsVisibilityDisabled?: boolean;
  filtersDisabled?: boolean;
  colOrderDisabled?: boolean;
  rowNumberAppearanceControl?: boolean;
};

export function InternalTableActions<T extends MRT_RowData>(props: IntrernalTableActionsProps<T>) {
  return (
    <div className="flex items-center gap-1">
      {props.children}
      {!props.filtersHidden && <ClearFiltersButton disabled={props.filtersDisabled} />}
      <ColumnsVisibilityButton
        disabled={props.columnsVisibilityDisabled}
        rowNumberAppearanceControl={props.rowNumberAppearanceControl}
      />
      {!props.densityHidden && <DensityToggleButton disabled={props.densityDisabled} />}
    </div>
  );
}
