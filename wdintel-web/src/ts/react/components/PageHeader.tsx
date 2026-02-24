import { Stack } from '@mui/material';
import React from 'react';

type Props = {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  titleClassName?: string;
};

const defaultTitleClassName = 'm-0 text-[var(--text-color)]';

export function PageHeader({ title, actions, className, titleClassName }: Props) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      flexWrap="wrap"
      gap={2}
      className={className}
    >
      <h1 className={titleClassName ? `${defaultTitleClassName} ${titleClassName}` : defaultTitleClassName}>
        {title}
      </h1>
      {actions ?? null}
    </Stack>
  );
}
