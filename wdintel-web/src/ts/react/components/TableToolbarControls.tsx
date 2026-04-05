import { Box, Stack } from '@mui/material';
import type { ReactNode } from 'react';

import { GlobalFilterTextField } from './mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { useTableStateContext } from './mui-customized/table/table-state-provider';

type Props = {
  withGlobalTextFilter?: boolean;
  filter?: ReactNode;
  hideGlobalTextFilter?: boolean;
  trailingActionsBeforeInternal?: ReactNode;
  trailingActions?: ReactNode;
  trailingActionsAfterInternal?: ReactNode;
  desktopBreakpoint?: 'sm' | 'md' | 'lg' | 'xl';
  leadingDesktopBreakpoint?: 'sm' | 'md' | 'lg' | 'xl';
};

export function TableToolbarControls(props: Props) {
  const tableStateContext = useTableStateContext();
  const desktopBreakpoint = props.desktopBreakpoint ?? 'lg';
  const leadingDesktopBreakpoint = props.leadingDesktopBreakpoint ?? desktopBreakpoint;
  const hasLeadingControls = Boolean((props.withGlobalTextFilter && !props.hideGlobalTextFilter) || props.filter);
  const hasTrailingActions = Boolean(
    props.trailingActionsBeforeInternal || props.trailingActions || props.trailingActionsAfterInternal,
  );

  if (!hasLeadingControls && !hasTrailingActions) {
    return null;
  }

  return (
    <Stack
      direction={{ xs: 'column', [desktopBreakpoint]: 'row' }}
      spacing={2}
      alignItems={{ xs: 'stretch', [desktopBreakpoint]: 'center' }}
      justifyContent="space-between"
    >
      <Stack
        direction={{ xs: 'column', [leadingDesktopBreakpoint]: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', [leadingDesktopBreakpoint]: 'center' }}
        sx={{ flex: 1, minWidth: 0 }}
      >
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
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          useFlexGap
          sx={{
            ml: { [desktopBreakpoint]: 'auto' },
            alignSelf: { xs: 'stretch', sm: 'auto' },
            width: { xs: '100%', [desktopBreakpoint]: '100%' },
            flex: { [desktopBreakpoint]: 1 },
            minWidth: 0,
            justifyContent: { xs: 'flex-start', [desktopBreakpoint]: 'space-between' },
          }}
        >
          {props.trailingActionsBeforeInternal ? (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              alignItems={{ xs: 'stretch', sm: 'center' }}
              useFlexGap
              sx={{
                flexWrap: { xs: 'wrap', [desktopBreakpoint]: 'nowrap' },
                minWidth: 0,
                flexShrink: 0,
              }}
            >
              {props.trailingActionsBeforeInternal}
            </Stack>
          ) : null}
          {(props.trailingActions || props.trailingActionsAfterInternal) ? (
            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              useFlexGap
              sx={{
                flexWrap: 'wrap',
                ml: { [desktopBreakpoint]: 'auto' },
                justifyContent: { xs: 'flex-start', [desktopBreakpoint]: 'flex-end' },
                flexShrink: 0,
              }}
            >
              {props.trailingActions}
              {props.trailingActionsAfterInternal}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
