import { Stack } from '@mui/material';
import type { ReactNode } from 'react';

import { PageHeader } from './PageHeader';
import { TableToolbarControls } from './TableToolbarControls';
import { InternalTableActions } from './mui-customized/table/components/table-top-toolbar/components/internal-actions';
import type { ActiveFilterDescriptor } from './mui-customized/table/components/table-top-toolbar/components/internal-actions/components/active-filters-utils';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  title: ReactNode;
  titleInfo?: ReactNode;
  titleLeadingActions?: ReactNode;
  titleLeadingGap?: number | string;
  titleActions?: ReactNode;
  titleActionsGap?: number | string;
  middleGap?: number | string;
  actions?: ReactNode;
  withGlobalTextFilter?: boolean;
  filter?: ReactNode;
  hideGlobalTextFilter?: boolean;
  trailingActionsBeforeInternal?: ReactNode;
  internalActionsHidden?: boolean;
  internalActionsDisabled?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  colOrderDisabled?: boolean;
  filtersDisabled?: boolean;
  columnsVisibilityDisabled?: boolean;
  additionalInternalActions?: ReactNode;
  additionalActiveFilters?: ActiveFilterDescriptor[];
  onClearAdditionalActiveFilter?: (filterId: string) => void;
  onClearAdditionalActiveFilters?: () => void;
  trailingActionsAfterInternal?: ReactNode;
  rowNumberAppearanceControl?: boolean;
};

export function TablePageToolbar(props: Props) {
  const tableStateContext = useTableStateContext();
  const shouldRenderInternalActions = !props.internalActionsHidden;
  const internalActions = shouldRenderInternalActions ? (
    <InternalTableActions
      table={tableStateContext.tableInstance}
      filtersHidden={props.filtersHidden}
      colOrderHidden={props.colOrderHidden}
      columnsVisibilityDisabled={props.internalActionsDisabled || props.columnsVisibilityDisabled}
      colOrderDisabled={props.internalActionsDisabled || props.colOrderDisabled}
      filtersDisabled={props.internalActionsDisabled || props.filtersDisabled}
      additionalActiveFilters={props.additionalActiveFilters}
      onClearAdditionalActiveFilter={props.onClearAdditionalActiveFilter}
      onClearAdditionalActiveFilters={props.onClearAdditionalActiveFilters}
      rowNumberAppearanceControl={props.rowNumberAppearanceControl}
    >
      {props.additionalInternalActions}
    </InternalTableActions>
  ) : null;
  const hasControls = Boolean(props.withGlobalTextFilter || props.filter || internalActions);

  const headerActions = (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      justifyContent={{ xs: 'flex-start', md: 'flex-end' }}
      flexWrap="wrap"
    >
      {props.actions}
    </Stack>
  );

  return (
    <Stack spacing={hasControls ? 2 : 0}>
      <PageHeader
        title={props.title}
        titleInfo={props.titleInfo}
        titleLeadingActions={props.titleLeadingActions}
        titleLeadingGap={props.titleLeadingGap}
        titleActions={props.titleActions}
        titleActionsGap={props.titleActionsGap}
        middleGap={props.middleGap}
        actions={headerActions}
      />
      {hasControls ? (
        <TableToolbarControls
          hideGlobalTextFilter={props.hideGlobalTextFilter}
          withGlobalTextFilter={props.withGlobalTextFilter}
          filter={props.filter}
          trailingActionsBeforeInternal={props.trailingActionsBeforeInternal}
          trailingActions={internalActions}
          trailingActionsAfterInternal={props.trailingActionsAfterInternal}
        />
      ) : null}
    </Stack>
  );
}
