import type { ReactNode } from 'react';
import { Box, Skeleton, Stack } from '@mui/material';

import { PageErrorState } from './PageErrorState';
import { SectionLoadingOverlay } from './SectionLoadingOverlay';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type Props = {
  status: LoadingStatus;
  errorMessage: string;
  children: ReactNode;
  fillAvailableHeight?: boolean;
  loadingContent?: ReactNode;
};

function TableLoadingSlot(props: { fillAvailableHeight: boolean }) {
  if (props.fillAvailableHeight) {
    return (
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, width: '100%', p: 2 }}>
        <Stack spacing={1.5} sx={{ width: '100%', minWidth: 0 }}>
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} variant="rounded" height={48} />
          ))}
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', minWidth: 0, p: 2 }}>
      <Stack spacing={1.5}>
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={48} />
        ))}
      </Stack>
    </Box>
  );
}

export function TableContentState({
  status,
  errorMessage,
  children,
  fillAvailableHeight = true,
  loadingContent,
}: Props) {
  const containerClassName = fillAvailableHeight
    ? 'flex w-full min-w-0 flex-1 min-h-0 overflow-hidden'
    : 'w-full min-w-0';

  if (status === 'error') {
    return (
      <div className={containerClassName}>
        <PageErrorState message={errorMessage} minHeight={fillAvailableHeight ? 0 : 240} />
      </div>
    );
  }

  if (status !== 'success') {
    if (loadingContent) {
      return (
        <div className={`${containerClassName} relative`} aria-busy="true">
          {loadingContent}
          <SectionLoadingOverlay open ariaLabel="Завантаження таблиці" sx={{ zIndex: 12 }} />
        </div>
      );
    }

    return (
      <div className={containerClassName}>
        <TableLoadingSlot fillAvailableHeight={fillAvailableHeight} />
      </div>
    );
  }

  return <div className={containerClassName}>{children}</div>;
}
