import { Stack } from '@mui/material';
import React from 'react';

import { PageHeader } from './PageHeader';
import { TableToolbarControls } from './TableToolbarControls';
import { InternalTableActions } from './mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  title: React.ReactNode;
  titleInfo?: React.ReactNode;
  actions?: React.ReactNode;
  withGlobalTextFilter?: boolean;
  filter?: React.ReactNode;
  densityDisabled?: boolean;
  densityHidden?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  colOrderDisabled?: boolean;
  filtersDisabled?: boolean;
  columnsVisibilityDisabled?: boolean;
  additionalInternalActions?: React.ReactNode;
  rowNumberAppearanceControl?: boolean;
};

export function TablePageToolbar(props: Props) {
  const tableStateContext = useTableStateContext();
  const hasControls = Boolean(props.withGlobalTextFilter || props.filter);

  const headerActions = (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      justifyContent={{ xs: 'flex-start', md: 'flex-end' }}
      flexWrap="wrap"
    >
      {props.actions}
      {tableStateContext.tableInstance ? (
        <InternalTableActions
          table={tableStateContext.tableInstance}
          densityDisabled={props.densityDisabled}
          densityHidden={props.densityHidden}
          filtersHidden={props.filtersHidden}
          colOrderHidden={props.colOrderHidden}
          columnsVisibilityDisabled={props.columnsVisibilityDisabled}
          colOrderDisabled={props.colOrderDisabled}
          filtersDisabled={props.filtersDisabled}
          rowNumberAppearanceControl={props.rowNumberAppearanceControl}
        >
          {props.additionalInternalActions}
        </InternalTableActions>
      ) : null}
    </Stack>
  );

  return (
    <Stack spacing={hasControls ? 2 : 0}>
      <PageHeader title={props.title} titleInfo={props.titleInfo} actions={headerActions} />
      {hasControls ? <TableToolbarControls withGlobalTextFilter={props.withGlobalTextFilter} filter={props.filter} /> : null}
    </Stack>
  );
}
