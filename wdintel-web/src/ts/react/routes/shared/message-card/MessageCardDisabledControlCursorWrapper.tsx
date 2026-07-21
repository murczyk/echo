import { Box } from '@mui/material';
import type { ReactNode } from 'react';

export function MessageCardDisabledControlCursorWrapper({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      component="span"
      data-disabled-control-cursor-wrapper
      sx={{
        display: 'inline-flex',
        ...(disabled
          ? {
              cursor: 'not-allowed',
              '& .Mui-disabled, & .Mui-disabled *': {
                cursor: 'not-allowed',
              },
            }
          : {}),
      }}
    >
      {children}
    </Box>
  );
}
