import { CircularProgress } from '@mui/material';
import React from 'react';

import { PageErrorState } from './PageErrorState';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type Props = {
  status: LoadingStatus;
  errorMessage: string;
  children: React.ReactNode;
  fillAvailableHeight?: boolean;
};

function TableLoadingSlot(props: { fillAvailableHeight: boolean }) {
  if (props.fillAvailableHeight) {
    return (
      <div className="flex h-full w-full min-w-0 min-h-0 items-center justify-center overflow-hidden">
        <CircularProgress size={32} />
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center justify-center py-12">
      <CircularProgress size={32} />
    </div>
  );
}

export function TableContentState({
  status,
  errorMessage,
  children,
  fillAvailableHeight = true,
}: Props) {
  if (status === 'error') {
    return <PageErrorState message={errorMessage} minHeight={fillAvailableHeight ? 0 : 240} />;
  }

  if (status !== 'success') {
    return <TableLoadingSlot fillAvailableHeight={fillAvailableHeight} />;
  }

  return <>{children}</>;
}
