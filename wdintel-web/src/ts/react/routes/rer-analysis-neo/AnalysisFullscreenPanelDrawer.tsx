import CloseIcon from '@mui/icons-material/Close';
import { Box, Drawer, IconButton, Typography } from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  anchor: 'left' | 'right';
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  maxPanelWidth?: number;
};

export function AnalysisFullscreenPanelDrawer({
  anchor,
  title,
  open,
  onClose,
  children,
  maxPanelWidth,
}: Props) {
  const closeLabel = anchor === 'left' ? 'Закрити ліву панель' : 'Закрити праву панель';

  return (
    <Drawer
      anchor={anchor}
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: maxPanelWidth ? { xs: '100vw', sm: maxPanelWidth } : '100vw',
            maxWidth: '100vw',
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box
        sx={{
          minHeight: 56,
          px: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <IconButton aria-label={closeLabel} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</Box>
    </Drawer>
  );
}
