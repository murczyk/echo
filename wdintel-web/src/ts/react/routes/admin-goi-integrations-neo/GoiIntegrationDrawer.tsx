import CloseIcon from '@mui/icons-material/Close';
import { Box, Drawer, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { PowerIconButton } from '../../components/PowerIconButton';
import { pageDrawerBackdropSx } from '../../components/loadingOverlayStyles';

type Props = {
  open: boolean;
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
};

export function GoiIntegrationDrawer({ open, title, busy, onClose, children, footer }: Props) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      ModalProps={{ BackdropProps: { sx: (theme) => pageDrawerBackdropSx(theme) } }}
      slotProps={{
        paper: {
          'aria-labelledby': 'goi-integration-drawer-title',
          sx: {
            width: { xs: '100vw', sm: 760 },
            maxWidth: '100vw',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, flexShrink: 0, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" id="goi-integration-drawer-title">
            {title}
          </Typography>
          <PowerIconButton aria-label="Закрити форму" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </PowerIconButton>
        </Stack>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>{children}</Box>
      <Box sx={{ p: 2.5, flexShrink: 0, borderTop: 1, borderColor: 'divider' }}>{footer}</Box>
    </Drawer>
  );
}
