import { Box, Stack } from '@mui/material';
import React from 'react';

import { GlobalFilterTextField } from './mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  withGlobalTextFilter?: boolean;
  filter?: React.ReactNode;
};

export function TableToolbarControls(props: Props) {
  const tableStateContext = useTableStateContext();

  if (!props.withGlobalTextFilter && !props.filter) {
    return null;
  }

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }}>
      {props.withGlobalTextFilter ? (
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
  );
}
