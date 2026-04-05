import { Box } from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

export function FormPageLayout({ children }: Props) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
      <Box sx={{ width: '100%', maxWidth: { md: 'lg' } }}>{children}</Box>
    </Box>
  );
}
