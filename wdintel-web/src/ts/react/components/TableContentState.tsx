import { CircularProgress } from '@mui/material';

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
      <div className="relative flex w-full min-w-0 flex-1 min-h-0 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <CircularProgress size={32} />
        </div>
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
    return (
      <div className={containerClassName}>
        <TableLoadingSlot fillAvailableHeight={fillAvailableHeight} />
      </div>
    );
  }

  return <div className={containerClassName}>{children}</div>;
}
