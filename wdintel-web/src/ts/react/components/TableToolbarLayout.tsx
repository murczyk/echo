import type { ReactNode } from 'react';

type Props = {
  leading: ReactNode;
  trailing?: ReactNode;
};

export function TableToolbarLayout({ leading, trailing }: Props) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-echo-md">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-echo-md">{leading}</div>
      {trailing ? (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-echo-md">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
