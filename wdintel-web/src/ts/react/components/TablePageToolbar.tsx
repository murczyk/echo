import { Stack } from '@mui/material';
import type { ReactNode } from 'react';

import { PageHeader } from './PageHeader';
import { TableToolbarControls } from './TableToolbarControls';
import { InternalTableActions } from './mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  title: ReactNode;
  titleInfo?: ReactNode;
  actions?: ReactNode;
  withGlobalTextFilter?: boolean;
  filter?: ReactNode;
  hideGlobalTextFilter?: boolean;
  trailingActionsBeforeInternal?: ReactNode;
  internalActionsHidden?: boolean;
  internalActionsDisabled?: boolean;
  densityDisabled?: boolean;
  densityHidden?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  colOrderDisabled?: boolean;
  filtersDisabled?: boolean;
  columnsVisibilityDisabled?: boolean;
  additionalInternalActions?: ReactNode;
  rowNumberAppearanceControl?: boolean;
};

export function TablePageToolbar(props: Props) {
  const tableStateContext = useTableStateContext();
  const shouldRenderInternalActions = !props.internalActionsHidden;
  const internalActions =
    shouldRenderInternalActions ? (
      <InternalTableActions
        table={tableStateContext.tableInstance}
        densityDisabled={props.internalActionsDisabled || props.densityDisabled}
        densityHidden={props.densityHidden}
        filtersHidden={props.filtersHidden}
        colOrderHidden={props.colOrderHidden}
        columnsVisibilityDisabled={props.internalActionsDisabled || props.columnsVisibilityDisabled}
        colOrderDisabled={props.internalActionsDisabled || props.colOrderDisabled}
        filtersDisabled={props.internalActionsDisabled || props.filtersDisabled}
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
      <PageHeader title={props.title} titleInfo={props.titleInfo} actions={headerActions} />
      {hasControls ? (
        <TableToolbarControls
          hideGlobalTextFilter={props.hideGlobalTextFilter}
          withGlobalTextFilter={props.withGlobalTextFilter}
          filter={props.filter}
          trailingActionsBeforeInternal={props.trailingActionsBeforeInternal}
          trailingActions={internalActions}
        />
      ) : null}
    </Stack>
  );
}
