import { Box, Stack } from '@mui/material';
import React from 'react';

import { GlobalFilterTextField } from './mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  withGlobalTextFilter?: boolean;
  filter?: React.ReactNode;
  hideGlobalTextFilter?: boolean;
  trailingActionsBeforeInternal?: React.ReactNode;
  trailingActions?: React.ReactNode;
  trailingActionsAfterInternal?: React.ReactNode;
};

export function TableToolbarControls(props: Props) {
  const tableStateContext = useTableStateContext();
  const hasLeadingControls = Boolean((props.withGlobalTextFilter && !props.hideGlobalTextFilter) || props.filter);
  const hasTrailingActions = Boolean(
    props.trailingActionsBeforeInternal || props.trailingActions || props.trailingActionsAfterInternal,
  );

  if (!hasLeadingControls && !hasTrailingActions) {
    return null;
  }

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      justifyContent="space-between"
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ flex: 1, minWidth: 0 }}>
        {props.withGlobalTextFilter && !props.hideGlobalTextFilter ? (
          <Box sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%' }}>
            <GlobalFilterTextField
              className="!min-w-0 !w-full"
              globalFilter={tableStateContext.globalFilter}
              setGlobalFilter={tableStateContext.onChangeGlobalFilter}
            />
          </Box>
        ) : null}
        {props.filter}
      </Stack>
      {hasTrailingActions ? (
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          useFlexGap
          sx={{ ml: { sm: 'auto' }, alignSelf: { xs: 'flex-end', sm: 'auto' } }}
        >
          {props.trailingActionsBeforeInternal}
          {props.trailingActions}
          {props.trailingActionsAfterInternal}
        </Stack>
      ) : null}
    </Stack>
  );
}
