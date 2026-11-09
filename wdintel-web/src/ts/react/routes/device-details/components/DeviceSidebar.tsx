import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

export const deviceSidebarClassName =
  'min-h-0 min-w-0 p-echo-xs echo-lg:border-r echo-lg:border-solid echo-lg:border-echo-text/12';

export const deviceSidebarRowClassName =
  'min-h-echo-control-md! text-[length:var(--echo-typography-font-size-base)]! font-normal!';

export function DeviceSidebarHeader({
  id,
  title,
  actions,
}: {
  id?: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-echo-sm">
      <Typography
        component="h2"
        id={id}
        variant="body1"
        color="text.secondary"
        className="m-0! min-w-0 truncate px-echo-lg py-echo-sm font-normal!"
      >
        {title}
      </Typography>
      {actions ? (
        <div className="flex shrink-0 items-center gap-echo-xs pr-echo-sm">{actions}</div>
      ) : null}
    </header>
  );
}
